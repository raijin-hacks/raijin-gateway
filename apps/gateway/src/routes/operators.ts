import {
  AgentsResponseSchema,
  RestoreAgentRequestSchema,
  type RestrictionState,
  type RestoreAgentResponse,
  ApprovalsQuerySchema,
  PendingApprovalsResponseSchema,
  type ReasonCode,
} from '@apf/contracts';
import type { Handler } from 'hono';
import type { AppEnv, Deps } from '../deps.js';
import { randomUUID } from 'node:crypto';
import type { Pipeline } from '../pipeline/index.js';
import { restrictionFor } from '../pipeline/restrictions.js';
import { badRequest, readJson, notFound } from '../http.js';

interface AgentDbRow {
  id: string;
  name: string;
  role: string;
  trust: number;
  restriction: RestrictionState;
}

interface PendingApprovalDbRow {
  decision_id: string;
  mandate_id: string;
  task: string;
  agent_id: string;
  agent_name: string;
  agent_role: string;
  merchant_id: string | null;
  merchant_name: string | null;
  endpoint_id: string | null;
  endpoint_method: 'GET' | 'POST' | null;
  endpoint_path: string | null;
  canonical_url: string;
  price: number | null;
  reasons_json: string;
  judge_explanation: string | null;
  stage: 'precontact' | 'tier0' | 'tier1' | 'judge' | 'human';
  deadline: number;
}

export function agentsRoute(deps: Deps): Handler<AppEnv> {
  return (c) => {
    // agents.trust is the persistent agent score. sessions.trust is scoped to one mandate
    // session, so it is intentionally not used for this agent-level dashboard listing.
    const agents = deps.db.sqlite
      .prepare(
        `SELECT a.id, a.name, r.name AS role, a.trust, a.restriction
         FROM agents a
         JOIN roles r ON r.id = a.role_id
         ORDER BY a.id`,
      )
      .all() as AgentDbRow[];
    return c.json(
      AgentsResponseSchema.parse(
        agents.map((agent) => ({
          ...agent,
          recent_incidents: deps.db.sqlite
            .prepare(
              'SELECT decision_id, mandate_id, cause, previous, restriction, created_at FROM agent_incidents WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10',
            )
            .all(agent.id),
          recent_restorations: deps.db.sqlite
            .prepare(
              'SELECT id, previous, restriction, reason, operator, created_at FROM agent_restorations WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10',
            )
            .all(agent.id),
        })),
      ),
    );
  };
}

export function approvalsRoute(deps: Deps, pipeline?: Pipeline): Handler<AppEnv> {
  return async (c) => {
    const params = new URL(c.req.url).searchParams;
    const queryParams = Object.fromEntries(params);
    const hasDuplicateKeys = [...params.keys()].some((key) => params.getAll(key).length > 1);
    const query = ApprovalsQuerySchema.safeParse(hasDuplicateKeys ? {} : queryParams);
    if (!query.success) {
      return badRequest(
        c,
        query.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }

    // Same expiry as pipeline.sweep(): deadline <= now. Refreshing the dashboard
    // queue must expire and release, not wait for a worker poll.
    await pipeline?.sweep();
    const rows = deps.db.sqlite
      .prepare(
        `SELECT
          d.id AS decision_id,
          d.mandate_id,
          m.task,
          a.id AS agent_id,
          a.name AS agent_name,
          r.name AS agent_role,
          mer.id AS merchant_id,
          mer.name AS merchant_name,
          e.id AS endpoint_id,
          e.method AS endpoint_method,
          e.path AS endpoint_path,
          d.canonical_url,
          d.price,
          d.reasons_json,
          d.explanation AS judge_explanation,
          d.stage,
          w.deadline
        FROM pay_workflows w
        JOIN decisions d ON d.id = w.decision_id
        JOIN mandates m ON m.id = d.mandate_id
        JOIN agents a ON a.id = m.agent_id
        JOIN roles r ON r.id = a.role_id
        LEFT JOIN endpoints e ON e.id = d.endpoint_id
        LEFT JOIN merchants mer ON mer.id = e.merchant_id
        WHERE w.state = 'REVIEW'
          AND w.deadline > ?
        ORDER BY w.deadline, d.id`,
      )
      .all(deps.clock.now()) as PendingApprovalDbRow[];

    const approvals = rows.map((row) => ({
      decision_id: row.decision_id,
      mandate_id: row.mandate_id,
      task: row.task,
      agent: { id: row.agent_id, name: row.agent_name, role: row.agent_role },
      merchant:
        row.merchant_id === null || row.merchant_name === null
          ? null
          : { id: row.merchant_id, name: row.merchant_name },
      endpoint:
        row.endpoint_id === null || row.endpoint_method === null || row.endpoint_path === null
          ? null
          : { id: row.endpoint_id, method: row.endpoint_method, path: row.endpoint_path },
      canonical_url: row.canonical_url,
      price: row.price,
      reasons: JSON.parse(row.reasons_json) as ReasonCode[],
      judge_explanation: row.judge_explanation,
      stage: row.stage,
      deadline: row.deadline,
    }));

    return c.json(PendingApprovalsResponseSchema.parse(approvals));
  };
}

/** The only upward policy transition. Admin auth is attached by app.ts. */
export function restoreAgentRoute(deps: Deps): Handler<AppEnv, '/agents/:id/restore'> {
  return async (c) => {
    const body = await readJson(c, RestoreAgentRequestSchema);
    if (!body.ok) return body.response;
    const agentId = c.req.param('id');
    const sql = deps.db.sqlite;
    const result = sql
      .transaction(() => {
        if (!sql.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) return null;
        const { restriction: previous } = restrictionFor(deps, agentId);
        const { target, reason, operator } = body.value;
        const rank = { normal: 0, review_required: 1, suspended: 2 };
        // Nonincident score penalties can leave a normal agent requiring review/quarantined.
        // Allow an audited score recovery at the same state; never allow a downward target.
        const needsScoreRecovery = sql
          .prepare(
            `SELECT 1 FROM agents a JOIN roles r ON r.id = a.role_id
          WHERE a.id = ? AND (a.trust < r.baseline_trust OR EXISTS (
            SELECT 1 FROM sessions s JOIN mandates m ON m.id = s.mandate_id
            WHERE s.agent_id = a.id AND s.status <> 'ended' AND m.status = 'active' AND m.expires_at > ?
            AND (s.trust < r.baseline_trust OR s.status = 'quarantined')))`,
          )
          .get(agentId, deps.clock.now());
        if (rank[target] > rank[previous] || (target === previous && !needsScoreRecovery))
          return 'conflict' as const;
        const audit: RestoreAgentResponse = {
          id: randomUUID(),
          agent_id: agentId,
          previous,
          restriction: target,
          reason: reason.trim(),
          operator: operator.trim(),
          created_at: deps.clock.now(),
        };
        sql
          .prepare(
            'INSERT INTO agent_restorations (id, agent_id, previous, restriction, reason, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(audit.id, agentId, previous, target, audit.reason, audit.operator, audit.created_at);
        // Explicit restoration also clears heuristic quarantine/scores, never a mandate's caps.
        sql
          .prepare(
            'UPDATE agents SET restriction = ?, restriction_epoch = restriction_epoch + 1, trust = (SELECT baseline_trust FROM roles WHERE id = agents.role_id) WHERE id = ?',
          )
          .run(target, agentId);
        sql
          .prepare(
            "UPDATE sessions SET trust = (SELECT trust FROM agents WHERE id = ?), status = 'active' WHERE agent_id = ? AND status <> 'ended' AND mandate_id IN (SELECT id FROM mandates WHERE status = 'active' AND expires_at > ?)",
          )
          .run(agentId, agentId, deps.clock.now());
        return audit;
      })
      .immediate();
    if (!result) return notFound(c);
    if (result === 'conflict') return c.json({ error: 'restoration_must_loosen_restriction' }, 409);
    deps.log.info('agent restored', { ...result, principal: 'admin' });
    deps.bus.publish({
      type: 'agent_restored',
      agent_id: agentId,
      restoration_id: result.id,
      previous: result.previous,
      restriction: result.restriction,
      reason: result.reason,
      operator: result.operator,
      at: result.created_at,
    });
    return c.json(result);
  };
}
