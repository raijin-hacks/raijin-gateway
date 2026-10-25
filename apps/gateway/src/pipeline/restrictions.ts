// Durable agent policy. recordIncident joins the decision's transaction or opens its own;
// publish its returned event only after commit. No network or cached session authority.
import {
  INCIDENT_CODES,
  type IncidentCode,
  type RestrictionState,
  type StreamEvent,
} from '@apf/contracts';
import type { Deps } from '../deps.js';

export interface RestrictionRow {
  restriction: RestrictionState;
  restriction_epoch: number;
}
export function restrictionFor(deps: Pick<Deps, 'db'>, agentId: string): RestrictionRow {
  const row = deps.db.sqlite
    .prepare('SELECT restriction, restriction_epoch FROM agents WHERE id = ?')
    .get(agentId) as RestrictionRow | undefined;
  if (!row) throw new Error('MISSING_AGENT');
  return row;
}

/** Exhaustive security taxonomy. Infrastructure and arbitrary denial codes never enter here. */
export function incidentCause(reasons: readonly string[]): IncidentCode | undefined {
  return INCIDENT_CODES.find((code) => reasons.includes(code));
}

export function recordIncident(
  deps: Deps,
  decisionId: string,
  cause: IncidentCode,
  severe = false,
): Extract<StreamEvent, { type: 'agent_incident' }> | undefined {
  const sql = deps.db.sqlite;
  return sql
    .transaction(() => {
      const d = sql
        .prepare(
          'SELECT m.agent_id, d.mandate_id FROM decisions d JOIN mandates m ON m.id = d.mandate_id WHERE d.id = ?',
        )
        .get(decisionId) as { agent_id: string; mandate_id: string };
      const current = restrictionFor(deps, d.agent_id);
      if (sql.prepare('SELECT 1 FROM agent_incidents WHERE decision_id = ?').get(decisionId))
        return;
      const security = cause !== 'JUDGE_OFF_TASK';
      const prior = sql
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_incidents WHERE agent_id = ? AND mandate_id = ? AND restriction_epoch = ? AND cause <> 'JUDGE_OFF_TASK'",
        )
        .get(d.agent_id, d.mandate_id, current.restriction_epoch) as { n: number };
      const restriction: RestrictionState =
        current.restriction === 'suspended' ||
        (security && (severe || (current.restriction === 'review_required' && prior.n >= 1)))
          ? 'suspended'
          : 'review_required';
      sql
        .prepare(
          'INSERT INTO agent_incidents (decision_id, agent_id, mandate_id, cause, previous, restriction, restriction_epoch, severe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          decisionId,
          d.agent_id,
          d.mandate_id,
          cause,
          current.restriction,
          restriction,
          current.restriction_epoch,
          security && severe ? 1 : 0,
          deps.clock.now(),
        );
      sql.prepare('UPDATE agents SET restriction = ? WHERE id = ?').run(restriction, d.agent_id);
      return {
        type: 'agent_incident' as const,
        agent_id: d.agent_id,
        mandate_id: d.mandate_id,
        decision_id: decisionId,
        cause,
        previous: current.restriction,
        restriction,
        at: deps.clock.now(),
      };
    })
    .immediate();
}
