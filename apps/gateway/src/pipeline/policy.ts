// Chunk 2-owned: synchronous policy/SQLite admission, no network in transactions.
import {
  NETWORK,
  TRUST_DELTAS,
  type JudgeOutput,
  type Quote,
  type ReasonCode,
} from '@apf/contracts';
import type { AgentContext, Deps } from '../deps.js';
import type { AdmittedRoute } from '../judge/gateway.js';
import { createFunds, utcDay } from '../db/funds.js';
import { restrictionFor } from './restrictions.js';
import { newId } from '../ids.js';
import { CONTRACT_SQL, EXTRA_SQL } from '../db/statements.js';

export interface Role {
  id: string;
  policy_text: string;
  per_call_cap: number;
  velocity_per_min: number;
  baseline_trust: number;
  grant_trust_threshold: number;
}
export function loadAgent(deps: Deps, mandateId: string, sessionId: string): AgentContext {
  const mandate = deps.db.sqlite
    .prepare('SELECT * FROM mandates WHERE id = ?')
    .get(mandateId) as AgentContext['mandate'];
  const session = deps.db.sqlite
    .prepare('SELECT * FROM sessions WHERE id = ? AND mandate_id = ?')
    .get(sessionId, mandateId) as AgentContext['session'];
  if (!mandate || !session) throw new Error('MISSING_AUTHORITY');
  return { mandate, session };
}
export function roleFor(deps: Deps, agent: AgentContext): Role {
  const role = deps.db.sqlite
    .prepare(
      'SELECT r.* FROM roles r JOIN agents a ON a.role_id = r.id WHERE a.id = ? AND a.tenant_id = ? AND r.tenant_id = a.tenant_id',
    )
    .get(agent.mandate.agent_id, agent.mandate.tenant_id) as Role | undefined;
  if (!role) throw new Error('MISSING_ROLE');
  return role;
}
export function active(agent: AgentContext, now: number): boolean {
  return (
    agent.mandate.status === 'active' &&
    agent.mandate.expires_at > now &&
    agent.session.status === 'active' &&
    agent.session.trust >= 20
  );
}
export function releaseUnsigned(deps: Deps, decisionId: string): void {
  deps.db.sqlite
    .transaction(() => {
      const p = deps.db.sqlite
        .prepare(
          "SELECT id, mandate_id, amount, day FROM payments WHERE decision_id = ? AND state = 'RESERVED'",
        )
        .get(decisionId) as
        { id: string; mandate_id: string; amount: number; day: string } | undefined;
      if (!p) return;
      if (
        deps.db.sqlite
          .prepare(
            "UPDATE payments SET state = 'FAILED', updated_at = ? WHERE id = ? AND state = 'RESERVED'",
          )
          .run(deps.clock.now(), p.id).changes !== 1
      )
        return;
      deps.db.sqlite
        .prepare(CONTRACT_SQL.failMandate)
        .run({ mandate_id: p.mandate_id, amount: p.amount });
      deps.db.sqlite
        .prepare(EXTRA_SQL.tenantRelease)
        .run({ mandate_id: p.mandate_id, amount: p.amount, day: p.day });
    })
    .immediate();
}
export function tier0(
  deps: Deps,
  agent: AgentContext,
  role: Role,
  id: string,
  route: AdmittedRoute,
  quote: Quote,
  expected: number,
  reviewed: readonly ReasonCode[],
): { reason: ReasonCode } | { paymentId: string } {
  return deps.db.sqlite
    .transaction((): { reason: ReasonCode } | { paymentId: string } => {
      const now = deps.clock.now();
      const sql = deps.db.sqlite;
      sql
        .prepare('UPDATE pay_workflows SET tier0_at = COALESCE(tier0_at, ?) WHERE decision_id = ?')
        .run(now, id);
      if (restrictionFor(deps, agent.mandate.agent_id).restriction === 'suspended')
        return { reason: 'AGENT_SUSPENDED' };
      if (!active(agent, now))
        return {
          reason:
            agent.session.status === 'quarantined' || agent.session.trust < 20
              ? 'QUARANTINED'
              : 'NO_MANDATE',
        };
      if (quote.network !== NETWORK) return { reason: 'NETWORK' };
      if (quote.payee !== route.match.merchant.payee) return { reason: 'PAYEE_SWAP' };
      if (quote.amount > role.per_call_cap) return { reason: 'PER_CALL_CAP' };
      const reference = sql
        .prepare(
          'SELECT price FROM reference_prices WHERE tenant_id = ? AND payee = ? AND endpoint_id = ?',
        )
        .get(agent.mandate.tenant_id, quote.payee, route.match.endpoint.id) as
        { price: number } | undefined;
      if (reference && quote.amount > reference.price * 2 && !reviewed.includes('REFERENCE_PRICE'))
        return { reason: 'REFERENCE_PRICE' };
      if (Math.abs(quote.amount - expected) > expected * 0.1) return { reason: 'PRICE_MISMATCH' };
      const exposure = sql
        .prepare(
          `SELECT COALESCE((SELECT committed FROM tenant_daily WHERE tenant_id = ? AND day = ?), 0) +
      COALESCE((SELECT SUM(p.amount) FROM payments p JOIN mandates m ON m.id = p.mandate_id WHERE m.tenant_id = ? AND p.day <> ? AND p.state IN ('RESERVED','SIGNED','SUBMITTED','UNKNOWN')), 0) AS total,
      (SELECT daily_cap FROM tenants WHERE id = ?) AS cap`,
        )
        .get(
          agent.mandate.tenant_id,
          utcDay(now),
          agent.mandate.tenant_id,
          utcDay(now),
          agent.mandate.tenant_id,
        ) as { total: number; cap: number };
      if (exposure.total + quote.amount > exposure.cap) return { reason: 'TENANT_DAILY' };
      const attempts = sql
        .prepare(
          `SELECT COUNT(*) AS n FROM decisions d JOIN pay_workflows w ON w.decision_id = d.id WHERE d.session_id = ? AND d.id <> ? AND w.tier0_at > ?`,
        )
        .get(agent.session.id, id, now - 60000) as { n: number };
      if (attempts.n >= role.velocity_per_min) return { reason: 'VELOCITY' };
      const duplicates = sql
        .prepare(
          `SELECT COUNT(*) AS n FROM decisions d JOIN pay_workflows w ON w.decision_id = d.id WHERE d.session_id = ? AND d.id <> ? AND d.canonical_url = ? AND d.price = ? AND w.tier0_at > ?`,
        )
        .get(agent.session.id, id, route.canonical.url, quote.amount, now - 10000) as { n: number };
      if (duplicates.n >= 2) return { reason: 'DUPLICATE' };
      if (newPayeeLimit(deps, agent, quote.payee, reviewed)) return { reason: 'NEW_PAYEE_LIMIT' };
      const hold = createFunds(deps.db, deps.clock).reserve({
        mandateId: agent.mandate.id,
        decisionId: id,
        amount: quote.amount,
        payee: quote.payee,
        quoteJson: JSON.stringify(quote),
      });
      return hold.ok ? { paymentId: hold.paymentId } : { reason: hold.code };
    })
    .immediate();
}
// Call inside the same transaction that commits the approval: judge calls do not serialize payees.
export function newPayeeLimit(
  deps: Deps,
  agent: AgentContext,
  payee: string,
  reviewed: readonly ReasonCode[],
): boolean {
  if (reviewed.includes('NEW_PAYEE_LIMIT') || !payeeFacts(deps, agent, payee).first_seen)
    return false;
  const approved = deps.db.sqlite
    .prepare(
      "SELECT COUNT(DISTINCT payee) AS n FROM decisions WHERE mandate_id = ? AND stage = 'judge' AND outcome = 'approved'",
    )
    .get(agent.mandate.id) as { n: number };
  return approved.n >= 3;
}
export function payeeFacts(deps: Deps, agent: AgentContext, payee: string) {
  const rows = deps.db.sqlite
    .prepare(
      "SELECT price FROM decisions WHERE mandate_id = ? AND payee = ? AND outcome = 'approved' ORDER BY created_at DESC LIMIT 10",
    )
    .all(agent.mandate.id, payee) as { price: number }[];
  return {
    first_seen: rows.length === 0,
    prior_calls: (
      deps.db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM decisions WHERE mandate_id = ? AND payee = ? AND outcome = 'approved'",
        )
        .get(agent.mandate.id, payee) as { n: number }
    ).n,
    recent_prices: rows.map((r) => r.price),
  };
}
function options(route: AdmittedRoute): string {
  return JSON.stringify(
    Object.fromEntries(
      route.match.params
        .filter((p) => p.kind === 'option')
        .map((p) => [p.name, p.value])
        .sort(([a], [b]) => a!.localeCompare(b!)),
    ),
  );
}
export function grantHit(
  deps: Deps,
  agent: AgentContext,
  role: Role,
  route: AdmittedRoute,
  quote: Quote,
): boolean {
  if (
    restrictionFor(deps, agent.mandate.agent_id).restriction !== 'normal' ||
    agent.session.trust < Math.max(60, role.grant_trust_threshold) ||
    route.match.params.some(
      (p) =>
        p.violation ||
        (p.kind === 'subject' &&
          !(JSON.parse(agent.mandate.subjects_json) as string[]).includes(
            p.value.trim().toLowerCase(),
          )),
    )
  )
    return false;
  const funds = createFunds(deps.db, deps.clock);
  const rows = deps.db.sqlite
    .prepare(
      `SELECT id FROM grants WHERE mandate_id = ? AND endpoint_id = ? AND payee = ? AND origin = ? AND method = ? AND path = ? AND option_values_json = ? AND max_per_call >= ? AND expires_at > ? ORDER BY created_at`,
    )
    .all(
      agent.mandate.id,
      route.match.endpoint.id,
      quote.payee,
      route.canonical.origin,
      route.method,
      route.match.endpoint.path,
      options(route),
      quote.amount,
      deps.clock.now(),
    ) as { id: string }[];
  for (const row of rows) if (funds.useGrant(row.id, quote.amount)) return true;
  if (
    !(JSON.parse(agent.mandate.allowed_merchants_json) as string[]).includes(
      route.match.merchant.id,
    )
  )
    return false;
  if (!deps.config.standingGrants) return false;
  const standing = deps.db.sqlite
    .prepare(
      'SELECT id FROM standing_grants WHERE role_id = ? AND endpoint_id = ? AND max_per_call >= ?',
    )
    .all(role.id, route.match.endpoint.id, quote.amount) as { id: string }[];
  return standing.some((row) => funds.useStandingGrant(row.id, quote.amount));
}
export function issueGrant(
  deps: Deps,
  agent: AgentContext,
  role: Role,
  route: AdmittedRoute,
  quote: Quote,
  proposal: NonNullable<JudgeOutput['grant']>,
  source: 'judge' | 'human',
): void {
  if (restrictionFor(deps, agent.mandate.agent_id).restriction !== 'normal') return;
  // Human approval of unusual subjects/parameters cannot broaden reusable mandate scope.
  if (
    route.match.params.some(
      (p) =>
        p.violation ||
        (p.kind === 'subject' &&
          !(JSON.parse(agent.mandate.subjects_json) as string[]).includes(
            p.value.trim().toLowerCase(),
          )),
    )
  )
    return;
  const reference = deps.db.sqlite
    .prepare(
      'SELECT price FROM reference_prices WHERE tenant_id = ? AND payee = ? AND endpoint_id = ?',
    )
    .get(agent.mandate.tenant_id, quote.payee, route.match.endpoint.id) as { price: number };
  const perCall = Math.min(
    proposal.max_per_call,
    role.per_call_cap,
    reference.price * 2,
    quote.amount * 2,
  );
  const total = Math.min(
    proposal.max_total,
    agent.mandate.budget - agent.mandate.spent - agent.mandate.reserved,
  );
  const expires = Math.min(
    deps.clock.now() + Math.min(proposal.ttl_ms, agent.mandate.expires_at - deps.clock.now()),
    agent.mandate.expires_at,
  );
  if (perCall < quote.amount || total <= 0 || expires <= deps.clock.now()) return;
  deps.db.sqlite
    .prepare(
      `INSERT INTO grants (id, mandate_id, endpoint_id, payee, method, origin, path, option_values_json, max_per_call, max_total, used_total, source, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      newId('grant', deps.clock.now()),
      agent.mandate.id,
      route.match.endpoint.id,
      quote.payee,
      route.method,
      route.canonical.origin,
      route.match.endpoint.path,
      options(route),
      perCall,
      total,
      source,
      expires,
      deps.clock.now(),
    );
}
export function updateTrust(
  deps: Deps,
  agent: AgentContext,
  id: string,
  cause: string,
  event: keyof typeof TRUST_DELTAS,
  quarantine = false,
): void {
  const sql = deps.db.sqlite;
  if (sql.prepare('SELECT id FROM trust_events WHERE decision_id = ?').get(id)) return;
  const delta = TRUST_DELTAS[event];
  if (delta.session === 0 && delta.agent === 0) return;
  // Off-task is a review signal: it cannot by itself drive scores into quarantine.
  const floor = event === 'judgeOffTask' ? 20 : 0;
  const role = roleFor(deps, agent);
  sql
    .prepare('UPDATE agents SET trust = MIN(trust, MAX(?, MIN(?, trust + ?))) WHERE id = ?')
    .run(floor, role.baseline_trust, delta.agent, agent.mandate.agent_id);
  const agentTrust = (
    sql.prepare('SELECT trust FROM agents WHERE id = ?').get(agent.mandate.agent_id) as {
      trust: number;
    }
  ).trust;
  sql
    .prepare(
      "UPDATE sessions SET trust = MIN(trust, MAX(?, MIN(?, trust + ?))), status = CASE WHEN ? THEN 'quarantined' ELSE status END WHERE id = ?",
    )
    .run(floor, agentTrust, delta.session, quarantine ? 1 : 0, agent.session.id);
  sql
    .prepare(
      'INSERT INTO trust_events (id, session_id, agent_id, delta_session, delta_agent, cause, decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      newId('trustEvent', deps.clock.now()),
      agent.session.id,
      agent.mandate.agent_id,
      delta.session,
      delta.agent,
      cause,
      id,
      deps.clock.now(),
    );
}
