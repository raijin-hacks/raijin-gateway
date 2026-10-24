// Chunk 2-owned. One orchestrator: claim -> admission/precontact -> quote -> Tier 0
// -> reservation -> trust/grants -> judge -> human -> committed approval -> payment.
import { randomBytes } from 'node:crypto';
import {
  REASON_ACTION,
  type ApprovalRequest,
  type JudgeOutput,
  type PayRequest,
  type PayResponse,
  type PaymentsModule,
  type JudgeModule,
  type Quote,
  type ReasonCode,
  type Stage,
} from '@apf/contracts';
import type { AgentContext, Deps } from '../deps.js';
import { createCanonicalizer } from '../catalog/index.js';
import { createGatewayAdmission, runGatewayJudge, type AdmittedRoute } from '../judge/gateway.js';
import { newId } from '../ids.js';
import { bindingSecret, catalogRevision, claim, workflow, type Workflow } from './idempotency.js';
import { precontact } from './precontact.js';
import { withRenewal } from './renewal.js';
import { containsSecret, urlSecretFacts } from './secrets.js';
import {
  active,
  grantHit,
  issueGrant,
  loadAgent,
  newPayeeLimit,
  payeeFacts,
  releaseUnsigned,
  roleFor,
  tier0,
  updateTrust,
} from './policy.js';

interface Decision {
  id: string;
  created_at: number;
  mandate_id: string;
  session_id: string;
  stage: Stage;
  outcome: 'approved' | 'denied' | 'pending';
  reasons_json: string;
  explanation: string | null;
  price: number | null;
}
interface Payment {
  id: string;
  state: string;
  amount: number;
  payee: Quote['payee'];
  tx_hash: string | null;
  response_json: string | null;
}
export interface PipelineDependencies extends Deps {
  payments: PaymentsModule;
  judge: JudgeModule;
}
export function createPipeline(deps: PipelineDependencies) {
  const sql = deps.db.sqlite;
  if (deps.catalogAdmission && deps.catalogAdmission.catalog !== deps.catalog)
    throw new Error('CATALOG_SNAPSHOT_MISMATCH');
  const admission = deps.catalogAdmission ?? createGatewayAdmission(deps.catalog);
  const canonicalize = createCanonicalizer(deps.catalog);
  const revision = catalogRevision(deps.catalog);
  const secret = bindingSecret(deps.db);
  const decision = (id: string) =>
    sql.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision | undefined;
  const payment = (id: string) =>
    sql.prepare('SELECT * FROM payments WHERE decision_id = ?').get(id) as Payment | undefined;
  const owns = (id: string, owner: string) => {
    const w = workflow(deps.db, id);
    return w?.owner === owner && w.state === 'PROCESSING';
  };
  const pending = (id: string): PayResponse => ({
    status: 'pending',
    decision_id: id,
    poll_after_ms: 2000,
  });

  function publish(id: string, includeTrust = false): void {
    const d = decision(id)!;
    deps.bus.publish({
      type: 'decision',
      decision_id: id,
      mandate_id: d.mandate_id,
      stage: d.stage,
      outcome: d.outcome,
      reasons: JSON.parse(d.reasons_json) as ReasonCode[],
      price: d.price,
      latency_ms: Math.max(0, deps.clock.now() - d.created_at),
      at: deps.clock.now(),
    });
    if (workflow(deps.db, id)?.state === 'REVIEW')
      deps.bus.publish({
        type: 'approval_needed',
        decision_id: id,
        mandate_id: d.mandate_id,
        explanation: d.explanation,
        at: deps.clock.now(),
      });
    const p = payment(id);
    if (p)
      deps.bus.publish({
        type: 'payment',
        payment_id: p.id,
        state: p.state as 'RESERVED',
        amount: p.amount,
        at: deps.clock.now(),
      });
    const t = sql
      .prepare(
        'SELECT s.trust AS session_trust, a.trust AS agent_trust, a.id AS agent_id, s.id AS session_id, e.cause FROM trust_events e JOIN sessions s ON s.id = e.session_id JOIN agents a ON a.id = e.agent_id WHERE e.decision_id = ?',
      )
      .get(id) as
      | {
          session_trust: number;
          agent_trust: number;
          agent_id: string;
          session_id: string;
          cause: string;
        }
      | undefined;
    if (t && includeTrust) deps.bus.publish({ type: 'trust', ...t, at: deps.clock.now() });
  }
  function replay(id: string): PayResponse {
    const d = decision(id);
    const w = workflow(deps.db, id);
    if (!d || !w) throw new Error('MISSING_OPERATION');
    const p = payment(id);
    if (p?.state === 'SETTLED') {
      return {
        status: 'approved',
        decision_id: id,
        payment_id: p.id,
        stage: d.stage,
        amount: p.amount,
        payee: p.payee,
        response: p.response_json
          ? (JSON.parse(p.response_json) as Extract<
              PayResponse,
              { status: 'approved' }
            >['response'])
          : null,
      };
    }
    if (p && ['SIGNED', 'SUBMITTED', 'UNKNOWN'].includes(p.state))
      return { status: 'payment_unknown', decision_id: id, payment_id: p.id, poll_after_ms: 5000 };
    if (p?.state === 'FAILED' && d.outcome === 'approved') {
      const response: PayResponse = {
        status: 'denied',
        decision_id: id,
        stage: 'tier0',
        reasons: ['INTERNAL_ERROR'],
        explanation: null,
      };
      sql
        .transaction(() => {
          sql
            .prepare(
              "UPDATE decisions SET outcome = 'denied', stage = 'tier0', reasons_json = '[\"INTERNAL_ERROR\"]', explanation = NULL WHERE id = ? AND outcome = 'approved'",
            )
            .run(id);
          sql
            .prepare(
              "UPDATE pay_workflows SET state = 'TERMINAL', response_json = ? WHERE decision_id = ?",
            )
            .run(JSON.stringify(response), id);
        })
        .immediate();
      return response;
    }
    if (w.response_json) return JSON.parse(w.response_json) as PayResponse;
    return pending(id);
  }
  function finish(
    id: string,
    owner: string,
    stage: Stage,
    reasons: ReasonCode[],
    hold = false,
    explanation: string | null = null,
    quarantine = false,
    emit = true,
  ): PayResponse {
    const changed = sql
      .transaction(() => {
        if (!owns(id, owner)) return false;
        const d = decision(id)!;
        const agent = loadAgent(deps, d.mandate_id, d.session_id);
        if (!hold) releaseUnsigned(deps, id);
        const response: PayResponse = hold
          ? pending(id)
          : { status: 'denied', decision_id: id, stage, reasons, explanation };
        if (!hold) {
          sql.prepare('UPDATE decisions SET request_json = NULL WHERE id = ?').run(id);
          sql.prepare("UPDATE pay_workflows SET request_json = '{}' WHERE decision_id = ?").run(id);
          if (reasons.includes('SECRET_IN_URL') || reasons.includes('QUERY_TOO_LONG'))
            sql.prepare("UPDATE decisions SET canonical_url = '[redacted]' WHERE id = ?").run(id);
        }
        sql
          .prepare(
            'UPDATE decisions SET stage = ?, outcome = ?, reasons_json = ?, explanation = ? WHERE id = ?',
          )
          .run(stage, hold ? 'pending' : 'denied', JSON.stringify(reasons), explanation, id);
        sql
          .prepare(
            'UPDATE pay_workflows SET state = ?, response_json = ?, deadline = ? WHERE decision_id = ? AND owner = ?',
          )
          .run(
            hold ? 'REVIEW' : 'TERMINAL',
            JSON.stringify(response),
            hold ? deps.clock.now() + 600000 : workflow(deps.db, id)!.deadline,
            id,
            owner,
          );
        if (quarantine)
          updateTrust(deps, agent, id, 'JUDGE_INJECTION_SUSPECTED', 'judgeInjection', true);
        else if (!hold && reasons.includes('JUDGE_OFF_TASK'))
          updateTrust(deps, agent, id, 'JUDGE_OFF_TASK', 'judgeOffTask');
        else if (!hold && reasons.includes('HUMAN_REJECTED'))
          updateTrust(deps, agent, id, 'HUMAN_REJECTED', 'humanRejected');
        else if (!hold && stage === 'tier0' && !reasons.includes('INTERNAL_ERROR'))
          updateTrust(deps, agent, id, reasons[0]!, 'tier0Denial');
        return true;
      })
      .immediate();
    if (changed && emit) publish(id, true);
    return replay(id);
  }
  async function approve(
    id: string,
    owner: string,
    route: AdmittedRoute,
    quote: Quote,
    stage: Stage,
    grant?: JudgeOutput['grant'],
  ): Promise<PayResponse> {
    let refusal: ReasonCode = 'NO_MANDATE';
    const committed = sql
      .transaction(() => {
        if (!owns(id, owner)) return false;
        const d = decision(id)!;
        const agent = loadAgent(deps, d.mandate_id, d.session_id);
        if (!active(agent, deps.clock.now())) return false;
        const reviewed = JSON.parse(workflow(deps.db, id)!.reviewed_json) as ReasonCode[];
        if (stage !== 'human' && agent.session.trust < 40) {
          refusal = 'TRUST_REQUIRES_HUMAN';
          return false;
        }
        if (newPayeeLimit(deps, agent, quote.payee, reviewed)) {
          refusal = 'NEW_PAYEE_LIMIT';
          return false;
        }
        const role = roleFor(deps, agent);
        if (quote.amount > role.per_call_cap) {
          refusal = 'PER_CALL_CAP';
          return false;
        }
        if (quote.payee !== route.match.merchant.payee) {
          refusal = 'PAYEE_SWAP';
          return false;
        }
        if (quote.network !== 'eip155:84532') {
          refusal = 'NETWORK';
          return false;
        }
        const reference = sql
          .prepare(
            'SELECT price FROM reference_prices WHERE tenant_id = ? AND payee = ? AND endpoint_id = ?',
          )
          .get(agent.mandate.tenant_id, quote.payee, route.match.endpoint.id) as
          { price: number } | undefined;
        if (
          reference &&
          quote.amount > reference.price * 2 &&
          !(JSON.parse(workflow(deps.db, id)!.reviewed_json) as ReasonCode[]).includes(
            'REFERENCE_PRICE',
          )
        ) {
          refusal = 'REFERENCE_PRICE';
          return false;
        }
        sql
          .prepare(
            'INSERT OR IGNORE INTO reference_prices (tenant_id, payee, endpoint_id, price, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            agent.mandate.tenant_id,
            quote.payee,
            route.match.endpoint.id,
            quote.amount,
            deps.clock.now(),
          );
        if (grant)
          issueGrant(deps, agent, role, route, quote, grant, stage === 'human' ? 'human' : 'judge');
        sql
          .prepare(
            "UPDATE decisions SET stage = ?, outcome = 'approved', reasons_json = ? WHERE id = ?",
          )
          .run(
            stage,
            JSON.stringify([
              stage === 'human'
                ? 'HUMAN_APPROVED'
                : stage === 'tier1'
                  ? 'GRANT_HIT'
                  : 'JUDGE_APPROVED',
            ]),
            id,
          );
        sql
          .prepare(
            "UPDATE pay_workflows SET state = 'AUTHORIZED', response_json = NULL WHERE decision_id = ? AND owner = ?",
          )
          .run(id, owner);
        updateTrust(
          deps,
          agent,
          id,
          stage === 'human' ? 'HUMAN_APPROVED' : 'APPROVED',
          stage === 'human' ? 'humanApproved' : 'approved',
        );
        return true;
      })
      .immediate();
    const refusalCode = refusal as ReasonCode; // Assigned within SQLite's synchronous transaction callback.
    if (!committed)
      return finish(
        id,
        owner,
        refusalCode === 'NO_MANDATE'
          ? 'precontact'
          : refusalCode === 'TRUST_REQUIRES_HUMAN'
            ? 'human'
            : 'tier0',
        [refusalCode],
        REASON_ACTION[refusalCode] === 'escalate',
      );
    publish(id, true); // Approval is durable before the only invocation of pay.
    const p = payment(id)!;
    try {
      const result = await deps.payments.pay(p.id, quote);
      // The store is authoritative. A success result alone never moves budget.
      if (result.state === 'SETTLED' && payment(id)?.state === 'SETTLED') {
        sql
          .prepare("UPDATE payments SET response_json = ? WHERE id = ? AND state = 'SETTLED'")
          .run(JSON.stringify(result.response), p.id);
      } else if (payment(id)?.state === 'RESERVED') releaseUnsigned(deps, id);
    } catch {
      // Signing/submission might have happened: release only an atomically unsigned hold.
      releaseUnsigned(deps, id);
    }
    const result = replay(id);
    sql
      .prepare(
        "UPDATE pay_workflows SET state = ?, response_json = ? WHERE decision_id = ? AND owner = ? AND state = 'AUTHORIZED'",
      )
      .run(
        result.status === 'payment_unknown' ? 'UNKNOWN' : 'TERMINAL',
        JSON.stringify(result),
        id,
        owner,
      );
    publish(id);
    return result;
  }
  async function execute(
    id: string,
    owner: string,
    request: PayRequest,
    human = false,
    humanGrant = false,
  ): Promise<PayResponse> {
    try {
      if (!owns(id, owner)) return replay(id);
      const d = decision(id)!;
      let agent = loadAgent(deps, d.mandate_id, d.session_id);
      if (!active(agent, deps.clock.now()))
        return finish(id, owner, 'precontact', [
          agent.session.status === 'quarantined' || agent.session.trust < 20
            ? 'QUARANTINED'
            : 'NO_MANDATE',
        ]);
      const saved = workflow(deps.db, id)!;
      if (saved.catalog_revision !== revision)
        return finish(id, owner, 'tier0', ['INTERNAL_ERROR']);
      const reviewed = JSON.parse(saved.reviewed_json) as ReasonCode[];
      const result = await admission.run(request.url, request.method, async (route) => {
        if (!owns(id, owner)) return replay(id);
        const pre = precontact(
          agent,
          route,
          request.url,
          deps.clock.now(),
          deps.config.denylistHosts,
        );
        if (
          pre &&
          !(
            reviewed.includes(pre) &&
            ['PARAM_NOT_IN_SCHEMA', 'SUBJECT_NOT_IN_MANDATE'].includes(pre)
          )
        )
          return finish(id, owner, 'precontact', [pre], REASON_ACTION[pre] === 'escalate');
        let quote: Quote;
        try {
          quote = structuredClone(
            await deps.payments.getQuote(route.canonical.url, request.method),
          );
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
          return finish(id, owner, 'tier0', [
            code === 'NOT_402' || code === 'QUOTE_INVALID' ? code : 'QUOTE_FAILED',
          ]);
        }
        if (!owns(id, owner)) return replay(id);
        if (
          !Number.isSafeInteger(quote.amount) ||
          quote.amount < 0 ||
          quote.url !== route.canonical.url ||
          quote.method !== route.method
        )
          return finish(id, owner, 'tier0', ['QUOTE_INVALID']);
        agent = loadAgent(deps, d.mandate_id, d.session_id);
        const role = roleFor(deps, agent);
        if (saved.quote_json && human) {
          const old = JSON.parse(saved.quote_json) as Quote;
          if (old.payee !== quote.payee) return finish(id, owner, 'tier0', ['PAYEE_SWAP']);
          if (old.amount !== quote.amount || old.network !== quote.network)
            return finish(id, owner, 'tier0', ['PRICE_MISMATCH']);
        }
        sql
          .prepare(
            'UPDATE decisions SET canonical_url = ?, endpoint_id = ?, payee = ?, price = ? WHERE id = ?',
          )
          .run(route.canonical.url, route.match.endpoint.id, quote.payee, quote.amount, id);
        sql
          .prepare('UPDATE pay_workflows SET quote_json = ? WHERE decision_id = ?')
          .run(JSON.stringify(quote), id);
        const existing = payment(id);
        if (!existing) {
          const t0 = tier0(deps, agent, role, id, route, quote, request.expected_price, reviewed);
          if ('reason' in t0)
            return finish(id, owner, 'tier0', [t0.reason], REASON_ACTION[t0.reason] === 'escalate');
        } else {
          // Post-reservation review cannot loosen immutable quote or current hard caps.
          if (!active(agent, deps.clock.now()))
            return finish(id, owner, 'precontact', ['NO_MANDATE']);
          if (quote.network !== 'eip155:84532') return finish(id, owner, 'tier0', ['NETWORK']);
          if (quote.payee !== route.match.merchant.payee)
            return finish(id, owner, 'tier0', ['PAYEE_SWAP']);
          if (quote.amount > role.per_call_cap) return finish(id, owner, 'tier0', ['PER_CALL_CAP']);
          const reference = sql
            .prepare(
              'SELECT price FROM reference_prices WHERE tenant_id = ? AND payee = ? AND endpoint_id = ?',
            )
            .get(agent.mandate.tenant_id, quote.payee, route.match.endpoint.id) as
            { price: number } | undefined;
          if (
            reference &&
            quote.amount > reference.price * 2 &&
            !reviewed.includes('REFERENCE_PRICE')
          )
            return finish(id, owner, 'tier0', ['REFERENCE_PRICE'], true);
          if (Math.abs(quote.amount - request.expected_price) > request.expected_price * 0.1)
            return finish(id, owner, 'tier0', ['PRICE_MISMATCH']);
        }
        if (human && (d.stage === 'judge' || d.stage === 'human')) {
          return approve(
            id,
            owner,
            route,
            quote,
            'human',
            humanGrant
              ? { max_per_call: quote.amount, max_total: quote.amount, ttl_ms: 600000 }
              : undefined,
          );
        }
        if (agent.session.trust < 40)
          return finish(id, owner, 'human', ['TRUST_REQUIRES_HUMAN'], true);
        return withRenewal(
          deps.db,
          JSON.stringify([
            agent.mandate.id,
            route.match.endpoint.id,
            route.method,
            route.canonical.origin,
            route.match.params.filter((p) => p.kind === 'option'),
          ]),
          async () => {
            if (!owns(id, owner)) return replay(id);
            agent = loadAgent(deps, d.mandate_id, d.session_id);
            if (!active(agent, deps.clock.now()))
              return finish(id, owner, 'precontact', [
                agent.session.status === 'quarantined' ? 'QUARANTINED' : 'NO_MANDATE',
              ]);
            if (agent.session.trust < 40)
              return finish(id, owner, 'human', ['TRUST_REQUIRES_HUMAN'], true);
            if (grantHit(deps, agent, roleFor(deps, agent), route, quote))
              return approve(id, owner, route, quote, 'tier1');
            const judged = await runGatewayJudge(deps.judge, {
              mandate: {
                task: agent.mandate.task,
                subjects: JSON.parse(agent.mandate.subjects_json) as string[],
                allowed_merchant_ids: JSON.parse(agent.mandate.allowed_merchants_json) as string[],
                budget_remaining:
                  agent.mandate.budget - agent.mandate.spent - agent.mandate.reserved,
                expires_in_ms: Math.max(0, agent.mandate.expires_at - deps.clock.now()),
              },
              role_policy: role.policy_text,
              price: quote.amount,
              purpose: request.purpose,
              method: route.method,
              match: route.match,
              payee_facts: payeeFacts(deps, agent, quote.payee),
            });
            if (!owns(id, owner)) return replay(id);
            if (judged.kind === 'deny')
              return finish(
                id,
                owner,
                'judge',
                [
                  judged.quarantine
                    ? 'JUDGE_INJECTION_SUSPECTED'
                    : (judged.reason as 'JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT'),
                ],
                false,
                null,
                judged.quarantine,
              );
            if (judged.output.decision === 'approve')
              return approve(id, owner, route, quote, 'judge', judged.output.grant);
            return finish(
              id,
              owner,
              'judge',
              judged.output.reasons,
              judged.output.decision === 'escalate',
              judged.output.explanation,
            );
          },
        );
      });
      if ('kind' in result)
        return finish(
          id,
          owner,
          'precontact',
          [result.kind === 'deny' ? result.reason : 'UNCATALOGED_ENDPOINT'],
          result.kind === 'escalate',
        );
      return result;
    } catch {
      return finish(id, owner, 'tier0', ['INTERNAL_ERROR']);
    }
  }
  async function run(
    agent: AgentContext,
    request: PayRequest,
  ): Promise<{ response: PayResponse; processing: boolean } | { conflict: true }> {
    const canonical = canonicalize(request.url);
    const claimed = claim(
      deps.db,
      agent,
      request,
      canonical.ok ? canonical.url : request.url,
      revision,
      secret,
      deps.clock.now(),
      containsSecret(canonical.ok ? urlSecretFacts(canonical) : request.url),
    );
    if (claimed.kind === 'conflict') return { conflict: true };
    if (claimed.kind === 'replay')
      return {
        response: replay(claimed.id),
        processing: workflow(deps.db, claimed.id)?.state === 'PROCESSING',
      };
    const current = loadAgent(deps, agent.mandate.id, agent.session.id);
    if (!active(current, deps.clock.now()))
      return {
        response: finish(claimed.id, claimed.owner, 'precontact', [
          current.session.status === 'quarantined' || current.session.trust < 20
            ? 'QUARANTINED'
            : 'NO_MANDATE',
        ]),
        processing: false,
      };
    // Quarantine and secrets also block unknown routes; the interceptor runs before any contact.
    if (containsSecret(canonical.ok ? urlSecretFacts(canonical) : request.url))
      return {
        response: finish(claimed.id, claimed.owner, 'precontact', ['SECRET_IN_URL']),
        processing: false,
      };
    return { response: await execute(claimed.id, claimed.owner, request), processing: false };
  }
  async function review(id: string, input: ApprovalRequest): Promise<boolean> {
    const owner = randomBytes(16).toString('hex');
    const claimed = sql
      .transaction(() => {
        const w = workflow(deps.db, id);
        if (!w || w.state !== 'REVIEW' || w.deadline <= deps.clock.now()) return false;
        const d = decision(id)!;
        sql
          .prepare(
            'INSERT OR IGNORE INTO approvals (id, decision_id, reviewer, outcome, note, issue_grant, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            newId('approval', deps.clock.now()),
            id,
            'admin',
            input.outcome,
            input.note,
            input.issue_grant ? 1 : 0,
            deps.clock.now(),
          );
        sql
          .prepare(
            'INSERT INTO pay_review_events (id, decision_id, outcome, note, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            newId('approval', deps.clock.now()),
            id,
            input.outcome,
            input.note,
            d.reasons_json,
            deps.clock.now(),
          );
        const reviewed = [
          ...new Set([
            ...(JSON.parse(w.reviewed_json) as ReasonCode[]),
            ...(JSON.parse(d.reasons_json) as ReasonCode[]),
          ]),
        ];
        sql
          .prepare(
            "UPDATE pay_workflows SET state = 'PROCESSING', owner = ?, reviewed_json = ?, deadline = ? WHERE decision_id = ? AND state = 'REVIEW'",
          )
          .run(owner, JSON.stringify(reviewed), deps.clock.now() + 600000, id);
        return true;
      })
      .immediate();
    if (!claimed) {
      await sweep();
      return false;
    }
    const w = workflow(deps.db, id)!;
    if (input.outcome === 'rejected') finish(id, owner, 'human', ['HUMAN_REJECTED']);
    else
      await execute(id, owner, JSON.parse(w.request_json) as PayRequest, true, input.issue_grant);
    return true;
  }
  async function sweep(): Promise<void> {
    const rows = sql
      .prepare(
        "SELECT * FROM pay_workflows WHERE state IN ('PROCESSING','REVIEW') AND deadline <= ?",
      )
      .all(deps.clock.now()) as Workflow[];
    for (const w of rows) {
      sql
        .transaction(() => {
          const current = workflow(deps.db, w.decision_id);
          if (
            !current ||
            !['PROCESSING', 'REVIEW'].includes(current.state) ||
            current.deadline > deps.clock.now()
          )
            return;
          sql
            .prepare(
              "INSERT OR IGNORE INTO approvals (id, decision_id, reviewer, outcome, note, issue_grant, created_at) VALUES (?, ?, 'system', 'timeout', 'Review deadline expired', 0, ?)",
            )
            .run(newId('approval', deps.clock.now()), w.decision_id, deps.clock.now());
          sql
            .prepare("UPDATE pay_workflows SET state = 'PROCESSING' WHERE decision_id = ?")
            .run(w.decision_id);
          sql
            .prepare(
              'INSERT INTO pay_review_events (id, decision_id, outcome, note, reasons_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              newId('approval', deps.clock.now()),
              w.decision_id,
              'timeout',
              'Review deadline expired',
              '["HUMAN_TIMEOUT"]',
              deps.clock.now(),
            );
          finish(w.decision_id, w.owner, 'human', ['HUMAN_TIMEOUT'], false, null, false, false);
        })
        .immediate();
      publish(w.decision_id, true);
    }
    // Close/expiry revokes unsigned pending work, while submitted work stays reserved.
    const revoked = sql
      .prepare(
        "SELECT w.* FROM pay_workflows w JOIN decisions d ON d.id = w.decision_id JOIN mandates m ON m.id = d.mandate_id WHERE w.state IN ('PROCESSING','REVIEW') AND (m.status <> 'active' OR m.expires_at <= ?)",
      )
      .all(deps.clock.now()) as Workflow[];
    for (const w of revoked) {
      sql
        .prepare(
          "UPDATE pay_workflows SET state = 'PROCESSING' WHERE decision_id = ? AND state = 'REVIEW'",
        )
        .run(w.decision_id);
      finish(w.decision_id, w.owner, 'precontact', ['NO_MANDATE']);
    }
  }
  function recover(): void {
    // Run once before serving requests. Never restart authorization after a crash.
    const rows = sql
      .prepare(
        "SELECT w.decision_id FROM pay_workflows w JOIN payments p ON p.decision_id = w.decision_id WHERE w.state = 'AUTHORIZED' AND p.state = 'RESERVED'",
      )
      .all() as { decision_id: string }[];
    for (const row of rows) {
      sql
        .transaction(() => {
          releaseUnsigned(deps, row.decision_id);
          sql
            .prepare(
              "UPDATE pay_workflows SET state = 'TERMINAL', response_json = ? WHERE decision_id = ? AND state = 'AUTHORIZED'",
            )
            .run(
              JSON.stringify({
                status: 'denied',
                decision_id: row.decision_id,
                stage: 'tier0',
                reasons: ['INTERNAL_ERROR'],
                explanation: null,
              }),
              row.decision_id,
            );
        })
        .immediate();
    }
  }
  return { run, review, sweep, replay, recover };
}
export type Pipeline = ReturnType<typeof createPipeline>;
