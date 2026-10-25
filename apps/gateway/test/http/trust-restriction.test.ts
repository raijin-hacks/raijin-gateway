import { describe, expect, it } from 'vitest';
import type { IncidentCode, JudgeOutput } from '@apf/contracts';
import { AgentsResponseSchema, RestoreAgentResponseSchema } from '@apf/contracts';
import { openDb } from '../../src/db/client.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { recordIncident } from '../../src/pipeline/restrictions.js';
import { JudgeError } from '../../src/judge/index.js';
import { createDecision } from '../harness/db.js';
import { trustFixture, type TrustFixture } from '../harness/trust.js';

const approved: JudgeOutput = {
  decision: 'approve',
  reasons: ['JUDGE_APPROVED'],
  injection_suspected: false,
  explanation: 'Within task',
};
const offTask: JudgeOutput = {
  decision: 'deny',
  reasons: ['JUDGE_OFF_TASK'],
  injection_suspected: false,
  explanation: 'Outside task',
};
function scores(h: TrustFixture) {
  return h.db.sqlite
    .prepare(
      'SELECT a.trust AS agent, s.trust AS session FROM agents a JOIN sessions s ON s.agent_id = a.id WHERE s.id = ?',
    )
    .get(h.mandate.session_id);
}
function incident(
  h: TrustFixture,
  cause: IncidentCode,
  severe = false,
  mandateId = h.mandate.mandate_id,
  sessionId = h.mandate.session_id,
) {
  const id = createDecision(h.db, h.clock, { mandateId, sessionId });
  h.db.sqlite.transaction(() => recordIncident(h.deps, id, cause, severe)).immediate();
  return id;
}

it('approvals, grant hits and replays never reward scores or produce trust events', async () => {
  const h = await trustFixture();
  h.db.sqlite.prepare('UPDATE agents SET trust = 65').run();
  h.db.sqlite.prepare('UPDATE sessions SET trust = 60').run();
  const before = scores(h);
  const request = h.purchase();
  expect((await h.pay(request)).status).toBe('approved');
  expect((await h.pay(request)).status).toBe('approved');
  h.clock.advance(11000);
  expect(await h.pay()).toMatchObject({ status: 'approved', stage: 'tier1' });
  expect(scores(h)).toEqual(before);
  expect(h.count('trust_events')).toBe(0);
});

it.each(['PAYEE_SWAP', 'PRICE_MISMATCH'] as const)(
  '%s creates one incident and retry cannot double count',
  async (cause) => {
    const h = await trustFixture();
    const getQuote = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await getQuote(...args)),
      ...(cause === 'PAYEE_SWAP'
        ? { payee: '0x9999999999999999999999999999999999999999' as const }
        : { amount: 15000 }),
    }));
    const request = h.purchase();
    const first = await h.pay(request);
    expect(first).toMatchObject({ status: 'denied', reasons: [cause] });
    expect(h.state()).toBe('review_required');
    expect(await h.pay(request)).toEqual(first);
    expect(h.count('agent_incidents')).toBe(1);
    expect(h.events.filter((e) => e.type === 'agent_incident')).toHaveLength(1);
    h.db.sqlite.transaction(() => recordIncident(h.deps, first.decision_id, cause)).immediate();
    expect(h.count('agent_incidents')).toBe(1);
    expect(h.state()).toBe('review_required');
    await h.pay();
    expect(h.state()).toBe('suspended');
  },
);

it('injection quarantines only the triggering session; durable restriction reaches other and new sessions', async () => {
  const h = await trustFixture();
  const other = await h.createMandate();
  h.judgeCall.mockResolvedValueOnce({ ...approved, injection_suspected: true });
  expect(await h.pay()).toMatchObject({ status: 'denied', reasons: ['JUDGE_INJECTION_SUSPECTED'] });
  expect(h.state()).toBe('review_required');
  expect(
    h.db.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(h.mandate.session_id),
  ).toEqual({ status: 'quarantined' });
  expect(await h.pay()).toMatchObject({ status: 'denied', reasons: ['QUARANTINED'] });
  for (const token of [other.token, (await h.createMandate()).token]) {
    expect((await h.pay(h.purchase(), token)).status).toBe('pending');
    expect(h.state()).toBe('review_required');
  }
  expect(h.judgeCall).toHaveBeenCalledTimes(1);
  expect(h.payments.pay).not.toHaveBeenCalled();
});

it('human rejection is an incident, repeated security incidents within a mandate suspend', async () => {
  const h = await trustFixture();
  h.judgeCall.mockResolvedValue({
    ...approved,
    decision: 'escalate',
    reasons: ['JUDGE_OVER_SCOPED'],
  });
  const first = await h.pay();
  await h.review(first.decision_id, 'rejected');
  expect(h.state()).toBe('review_required');
  expect(h.count('agent_incidents')).toBe(1);
  h.clock.advance(11000);
  const second = await h.pay();
  await h.review(second.decision_id, 'rejected');
  expect(h.state()).toBe('suspended');
});

it('off-task signals count only toward review, including escalation; repeated signals never suspend or quarantine', async () => {
  const h = await trustFixture();
  h.judgeCall.mockResolvedValueOnce({ ...offTask, decision: 'escalate' });
  const pending = await h.pay();
  expect(pending.status).toBe('pending');
  expect(h.state()).toBe('review_required');
  await h.review(pending.decision_id, 'rejected');
  // One incident per decision even when the same reviewed decision is rejected.
  expect(h.count('agent_incidents')).toBe(1);
  expect(h.state()).toBe('review_required');
  for (let i = 0; i < 8; i++) incident(h, 'JUDGE_OFF_TASK', true);
  expect(h.state()).toBe('review_required');
  // Security counting excludes the off-task rows.
  incident(h, 'PAYEE_SWAP');
  expect(h.state()).toBe('review_required');
  incident(h, 'PRICE_MISMATCH');
  expect(h.state()).toBe('suspended');
});

it('off-task score penalties cannot themselves push a low-score agent into quarantine', async () => {
  const h = await trustFixture();
  h.db.sqlite.prepare('UPDATE sessions SET trust = 25').run();
  // Exercise finish's off-task path from an already in-flight judge by lowering trust mid-call.
  h.db.sqlite.prepare('UPDATE sessions SET trust = 40').run();
  h.judgeCall.mockImplementation(async () => {
    h.db.sqlite.prepare('UPDATE sessions SET trust = 25').run();
    return offTask;
  });
  await h.pay();
  expect(scores(h)).toMatchObject({ session: 20 });
  expect(h.state()).toBe('review_required');
  expect((await h.pay()).status).toBe('pending');
});

it('security incident counts are mandate scoped and reset only by audited restoration', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const other = await h.createMandate();
  incident(h, 'PRICE_MISMATCH', false, other.mandate_id, other.session_id);
  expect(h.state()).toBe('review_required');
  expect((await h.restore()).status).toBe(200);
  incident(h, 'PAYEE_SWAP');
  expect(h.state()).toBe('review_required');
  incident(h, 'PRICE_MISMATCH');
  expect(h.state()).toBe('suspended');
});

it('a severe security incident suspends immediately; severity cannot turn off-task into suspension', async () => {
  const h = await trustFixture();
  incident(h, 'JUDGE_OFF_TASK', true);
  expect(h.state()).toBe('review_required');
  incident(h, 'PAYEE_SWAP', true);
  expect(h.state()).toBe('suspended');
});

it.each(['JUDGE_ERROR', 'JUDGE_INVALID_OUTPUT', 'transport'] as const)(
  '%s is not an incident or penalty',
  async (cause) => {
    const h = await trustFixture();
    const before = scores(h);
    h.judgeCall.mockRejectedValue(
      cause === 'transport' ? new Error('offline') : new JudgeError(cause),
    );
    expect((await h.pay()).status).toBe('denied');
    expect(scores(h)).toEqual(before);
    expect(h.state()).toBe('normal');
    expect(h.count('agent_incidents')).toBe(0);
  },
);

it.each(['QUOTE_FAILED', 'QUOTE_INVALID', 'NOT_402'])(
  '%s is not an incident or penalty',
  async (code) => {
    const h = await trustFixture();
    const before = scores(h);
    h.payments.getQuote.mockRejectedValue({ code });
    await h.pay();
    expect(scores(h)).toEqual(before);
    expect(h.count('agent_incidents')).toBe(0);
  },
);

it.each([
  'https://unknown.test/route',
  'garbage',
  'http://localhost:4101/v1/pricing/acme?token=sk-secret',
  'http://localhost:4101/v1/pricing/acme?period=30d&period=90d',
])('pre-contact %s never creates an incident or penalty', async (url) => {
  const h = await trustFixture();
  const before = scores(h);
  await h.pay(h.purchase({ url }));
  expect(scores(h)).toEqual(before);
  expect(h.state()).toBe('normal');
  expect(h.count('agent_incidents')).toBe(0);
  expect(h.payments.getQuote).not.toHaveBeenCalled();
});

it('malformed inputs and invalid quotes never penalize', async () => {
  const h = await trustFixture();
  expect((await h.request('/pay', {}, h.mandate.token)).status).toBe(400);
  const getQuote = h.payments.getQuote.getMockImplementation()!;
  h.payments.getQuote.mockImplementation(async (...args) => ({
    ...(await getQuote(...args)),
    amount: -1,
  }));
  await h.pay();
  expect(h.count('agent_incidents')).toBe(0);
  expect(h.count('trust_events')).toBe(0);
});

it('cached and standing grants, concurrent human approvals, and new mandates cannot restore', async () => {
  const h = await trustFixture();
  await h.pay(); // warm grant cache
  h.clock.advance(11000);
  const grants = h.count('grants');
  const grantUsed = h.db.sqlite.prepare('SELECT used_total FROM grants').all();
  incident(h, 'PAYEE_SWAP');
  const before = scores(h);
  const other = await h.createMandate();
  const [first, second] = await Promise.all([h.pay(), h.pay(h.purchase(), other.token)]);
  expect(first.status).toBe('pending');
  expect(second.status).toBe('pending');
  expect(h.db.sqlite.prepare('SELECT used_total FROM grants').all()).toEqual(grantUsed);
  expect(h.judgeCall).toHaveBeenCalledTimes(1);
  await Promise.all([
    h.review(first.decision_id, 'approved', true),
    h.review(second.decision_id, 'approved', true),
  ]);
  expect(h.pipeline.replay(first.decision_id).status).toBe('approved');
  expect(h.pipeline.replay(second.decision_id).status).toBe('approved');
  expect(scores(h)).toEqual(before);
  expect(h.state()).toBe('review_required');
  expect(h.count('grants')).toBe(grants);
  h.clock.advance(11000);
  expect((await h.pay()).status).toBe('pending');
});

it.each(['review_required', 'suspended'] as const)(
  'restriction committed mid-judge is honored at final authorization: %s',
  async (state) => {
    const h = await trustFixture();
    let resolve!: (value: JudgeOutput) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    h.judgeCall.mockImplementation(() => {
      entered();
      return new Promise((r) => {
        resolve = r;
      });
    });
    const pending = h.pay();
    await started;
    incident(h, 'PAYEE_SWAP', state === 'suspended');
    resolve(approved);
    const result = await pending;
    expect(result.status).toBe(state === 'suspended' ? 'denied' : 'pending');
    expect(h.payments.pay).not.toHaveBeenCalled();
    expect(h.count('grants')).toBe(0);
  },
);

it('suspended agents deny before contact on other/new sessions and human resume', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const waiting = await h.pay();
  incident(h, 'PRICE_MISMATCH');
  h.payments.getQuote.mockClear();
  h.judgeCall.mockClear();
  h.payments.pay.mockClear();
  for (const token of [h.mandate.token, (await h.createMandate()).token]) {
    expect(await h.pay(h.purchase(), token)).toMatchObject({
      status: 'denied',
      stage: 'precontact',
      reasons: ['AGENT_SUSPENDED'],
    });
  }
  await h.review(waiting.decision_id);
  expect(h.pipeline.replay(waiting.decision_id)).toMatchObject({
    status: 'denied',
    reasons: ['AGENT_SUSPENDED'],
  });
  expect(h.payments.getQuote).not.toHaveBeenCalled();
  expect(h.judgeCall).not.toHaveBeenCalled();
  expect(h.payments.pay).not.toHaveBeenCalled();
});

it('restart reloads restriction and closes suspended pending work without contacting or signing', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const waiting = await h.pay();
  incident(h, 'PRICE_MISMATCH');
  const db = openDb(h.db.sqlite.name);
  try {
    const pipeline = createPipeline({ ...h.deps, db });
    h.payments.getQuote.mockClear();
    pipeline.recover();
    expect(pipeline.replay(waiting.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['AGENT_SUSPENDED'],
    });
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    expect(h.payments.pay).not.toHaveBeenCalled();
  } finally {
    db.sqlite.close();
  }
});

it('signing guard checks durable restrictions even after authorization; human review only bypasses review_required', async () => {
  const h = await trustFixture();
  h.payments.pay.mockImplementation(async (id) => {
    incident(h, 'PAYEE_SWAP');
    expect(await h.store.canSign(id)).toBe(false);
    expect(
      await h.store.markSigned(id, {
        nonce: 'test',
        validBefore: h.clock.now() + 10000,
        authorizationJson: '{}',
      }),
    ).toBe(false);
    return { state: 'FAILED', reason: 'revoked' };
  });
  expect((await h.pay()).status).toBe('denied');
});

describe('audited restoration', () => {
  it('requires admin, target, reason and operator; only permits upward transitions', async () => {
    const h = await trustFixture();
    incident(h, 'PAYEE_SWAP', true);
    expect((await h.restore('normal', h.mandate.token)).status).toBe(403);
    expect((await h.app.request('/agents/agt_pricing/restore', { method: 'POST' })).status).toBe(
      401,
    );
    for (const patch of [
      { reason: ' ' },
      { operator: '' },
      { target: 'suspended' },
      { extra: true },
    ]) {
      expect(
        (
          await h.request('/agents/agt_pricing/restore', {
            target: 'normal',
            reason: 'Investigated',
            operator: 'Ada',
            ...patch,
          })
        ).status,
      ).toBe(400);
    }
    const result = await h.restore('review_required');
    expect(result.status).toBe(200);
    const audit = RestoreAgentResponseSchema.parse(await result.json());
    expect(audit).toMatchObject({
      previous: 'suspended',
      restriction: 'review_required',
      operator: 'Demo operator',
      created_at: h.clock.now(),
    });
    expect(h.state()).toBe('review_required');
    expect(h.events).toContainEqual({
      type: 'agent_restored',
      restoration_id: audit.id,
      agent_id: audit.agent_id,
      previous: audit.previous,
      restriction: audit.restriction,
      operator: audit.operator,
      reason: audit.reason,
      at: audit.created_at,
    });
    expect(h.logs.join('\n')).toContain('agent restored');
    expect((await h.restore('review_required')).status).toBe(409);
    expect((await h.restore()).status).toBe(200);
    expect((await h.restore()).status).toBe(409);
    const list = AgentsResponseSchema.parse(await (await h.request('/agents')).json());
    expect(list.find((a) => a.id === 'agt_pricing')).toMatchObject({
      restriction: 'normal',
      recent_incidents: [{ cause: 'PAYEE_SWAP' }],
      recent_restorations: [{ restriction: 'normal' }, { restriction: 'review_required' }],
    });
    expect(h.count('agent_restorations')).toBe(2);
    expect(() => h.db.sqlite.prepare('DELETE FROM agent_incidents').run()).toThrow('append-only');
    expect(() =>
      h.db.sqlite.prepare("UPDATE agent_restorations SET reason = 'changed'").run(),
    ).toThrow('append-only');
  });
});

it('standing grants are not consumed under review, even when explicitly enabled', async () => {
  const h = await trustFixture();
  h.deps.config.standingGrants = true;
  h.db.sqlite
    .prepare(
      "INSERT INTO standing_grants (id, role_id, endpoint_id, max_per_call, daily_total) VALUES ('grt_trust_test', 'rol_research', 'end_pricing_get', 10000, 100000)",
    )
    .run();
  incident(h, 'PAYEE_SWAP');
  expect((await h.pay()).status).toBe('pending');
  expect(h.count('standing_grant_usage')).toBe(0);
  expect(h.judgeCall).not.toHaveBeenCalled();
});

it('suspension during human re-quote blocks the final human approval', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const pending = await h.pay();
  const original = h.payments.getQuote.getMockImplementation()!;
  h.payments.getQuote.mockImplementation(async (...args) => {
    incident(h, 'PRICE_MISMATCH');
    return original(...args);
  });
  await h.review(pending.decision_id);
  expect(h.pipeline.replay(pending.decision_id)).toMatchObject({
    status: 'denied',
    reasons: ['AGENT_SUSPENDED'],
  });
  expect(h.payments.pay).not.toHaveBeenCalled();
});

it('restart preserves review and unsigned authorization fails closed with the suspension reason', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const pending = await h.pay();
  const restarted = createPipeline(h.deps);
  restarted.recover();
  expect(h.state()).toBe('review_required');
  expect(restarted.replay(pending.decision_id).status).toBe('pending');
  // Crash after the authorization commit but before payment invocation.
  h.db.sqlite
    .prepare("UPDATE decisions SET outcome = 'approved', stage = 'human' WHERE id = ?")
    .run(pending.decision_id);
  h.db.sqlite
    .prepare("UPDATE pay_workflows SET state = 'AUTHORIZED' WHERE decision_id = ?")
    .run(pending.decision_id);
  incident(h, 'PRICE_MISMATCH');
  restarted.recover();
  expect(restarted.replay(pending.decision_id)).toMatchObject({
    status: 'denied',
    stage: 'precontact',
    reasons: ['AGENT_SUSPENDED'],
  });
  expect(
    h.db.sqlite.prepare('SELECT reserved FROM mandates WHERE id = ?').get(h.mandate.mandate_id),
  ).toEqual({ reserved: 0 });
  expect(h.payments.pay).not.toHaveBeenCalled();
});

it('suspended signing guard refuses even an already human-approved reservation', async () => {
  const h = await trustFixture();
  incident(h, 'PAYEE_SWAP');
  const pending = await h.pay();
  let checked = false;
  h.payments.pay.mockImplementation(async (id) => {
    expect(await h.store.canSign(id)).toBe(true); // review_required permits this human approval
    incident(h, 'PRICE_MISMATCH');
    expect(await h.store.canSign(id)).toBe(false);
    expect(
      await h.store.markSigned(id, {
        nonce: 'test',
        validBefore: h.clock.now() + 10000,
        authorizationJson: '{}',
      }),
    ).toBe(false);
    checked = true;
    return { state: 'FAILED', reason: 'revoked' };
  });
  await h.review(pending.decision_id);
  expect(checked).toBe(true);
  expect(h.state()).toBe('suspended');
  expect(h.pipeline.replay(pending.decision_id).status).toBe('denied');
});

it('only explicit restoration recovers score-only penalties on a normal agent, without reviving closed mandates', async () => {
  const h = await trustFixture();
  h.db.sqlite.prepare('UPDATE agents SET trust = 15').run();
  h.db.sqlite.prepare('UPDATE sessions SET trust = 15').run();
  const closed = await h.createMandate();
  await h.closeMandate(closed.mandate_id);
  expect(await h.pay()).toMatchObject({ status: 'denied', reasons: ['QUARANTINED'] });
  expect(h.state()).toBe('normal');
  expect((await h.restore()).status).toBe(200);
  expect(scores(h)).toEqual({ agent: 70, session: 70 });
  expect(
    h.db.sqlite.prepare('SELECT status FROM mandates WHERE id = ?').get(closed.mandate_id),
  ).toEqual({ status: 'closed' });
  expect((await h.pay()).status).toBe('approved');
});
