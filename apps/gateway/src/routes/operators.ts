import {
  AgentsResponseSchema,
  ApprovalsQuerySchema,
  PendingApprovalsResponseSchema,
  type ReasonCode,
} from '@apf/contracts';
import type { Handler } from 'hono';
import type { AppEnv, Deps } from '../deps.js';
import { badRequest } from '../http.js';

interface AgentDbRow {
  id: string;
  name: string;
  role: string;
  trust: number;
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
        `SELECT a.id, a.name, r.name AS role, a.trust
         FROM agents a
         JOIN roles r ON r.id = a.role_id
         ORDER BY a.id`,
      )
      .all() as AgentDbRow[];
    return c.json(AgentsResponseSchema.parse(agents));
  };
}

export function approvalsRoute(deps: Deps): Handler<AppEnv> {
  return (c) => {
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
        ORDER BY w.deadline, d.id`,
      )
      .all() as PendingApprovalDbRow[];

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
