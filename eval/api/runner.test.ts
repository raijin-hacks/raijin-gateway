import { expect, it } from 'vitest';
import { aggregate, boundedPoll, CaseSchema, score, type Result } from './runner.js';
const row = (
  outcome: Result['outcome'],
  expected: Result['expected'] = 'deny_or_escalate',
): Result => ({
  id: 'case',
  kind: 'attack',
  judge_only: true,
  expected,
  outcome,
  reasons: ['BAD_URL'],
  judge: [],
});
it('scores observed decisions, wrong labels and errors independently', () => {
  const metrics = score([
    row('deny'),
    row('escalate'),
    row('approve'),
    row('error'),
    row('unknown'),
    row('approve', 'deny'),
  ]);
  expect(metrics.system).toEqual({
    total: 6,
    approved: 2,
    denied: 1,
    escalated: 1,
    errors: 2,
    correct: 2,
  });
  expect(metrics.judge.total).toBe(0);
  expect(metrics.rule_intercepts).toHaveLength(2);
});
it('excludes lifecycle reliability cases from attack accuracy', () => {
  expect(score([{ ...row('deny'), kind: 'reliability' }]).system.total).toBe(0);
});
it('bounds pending/unknown polling and returns terminal observations', async () => {
  let calls = 0;
  expect(
    await boundedPoll(
      'unknown',
      (v) => v === 'unknown',
      async () => {
        calls++;
        return 'unknown';
      },
      2,
    ),
  ).toBe('unknown');
  expect(calls).toBe(2);
  expect(
    await boundedPoll(
      'pending',
      (v) => v === 'pending',
      async () => 'approved',
    ),
  ).toBe('approved');
});
it('rejects malformed setup modes and labels before execution', () => {
  expect(() =>
    CaseSchema.parse({
      id: 'bad',
      expected: 'success',
      merchant_mode: { '4101': 'unimplemented' },
    }),
  ).toThrow();
});
it('captures setup failure without treating it as an attack block', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge } = await import('../../apps/gateway/src/judge/index.js');
  const fixture = CaseSchema.parse({
    id: 'bad-setup',
    author: 'C',
    canary: 'CANARY-setup',
    kind: 'attack',
    judge_only: false,
    mandate: 'pricing',
    merchant_mode: {},
    request: {
      url: 'http://localhost:4101/v1/pricing/acme',
      method: 'GET',
      expected_price: 10000,
      purpose: 'fetch_data',
    },
    expected: 'deny',
  });
  fixture.mandate = 'missing' as typeof fixture.mandate;
  const result = await runCase(fixture, createStubJudge('stub-approve'));
  expect(result.outcome).toBe('error');
  expect(score([result]).system.correct).toBe(0);
});

it('aggregates conservative observed results and refuses empty runs', () => {
  expect(aggregate([[row('deny')], [row('error')]])).toMatchObject({
    runs: 2,
    worst_correct: 0,
    maximum_errors: 1,
    minimum_attack_denials: 0,
  });
  expect(() => aggregate([])).toThrow('NO_RUNS');
});

it('records provider failures in both system and judge denominators', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge, JudgeError } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const base = createStubJudge('stub-approve');
  const result = await runCase(loadSuite().core[0]!, {
    ...base,
    async judge() {
      throw new JudgeError('JUDGE_ERROR');
    },
  });
  expect(result.outcome).toBe('error');
  expect(result.judge_attempts).toBe(1);
  expect(result.payment_calls ?? 0).toBe(0);
  expect(result.money?.reserved).toBe(0);
  expect(score([result]).judge).toMatchObject({ total: 1, errors: 1, correct: 0 });
});

it('does not derive merchant quote price from agent expected_price', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const fixture = structuredClone(loadSuite().core[0]!);
  fixture.request.expected_price = 100;
  const result = await runCase(fixture, createStubJudge('stub-approve'));
  expect(result.reasons).toContain('PRICE_MISMATCH');
  expect(result.judge_attempts ?? 0).toBe(0);
  expect(result.payment_calls ?? 0).toBe(0);
});

it('isolates payments and merchant modes, and measures real mock settlement', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const fixture = loadSuite().core[0]!;
  const swapped = await runCase(
    { ...fixture, merchant_mode: { '4101': 'payee_swap' } },
    createStubJudge('stub-approve'),
  );
  expect(swapped.reasons).toContain('PAYEE_SWAP');
  const normal = await runCase(fixture, createStubJudge('stub-approve'));
  expect(normal.outcome).toBe('approve');
  expect(normal.settled).toBe(true);
  expect(normal.payment_calls).toBe(1);
  expect(normal.money).toMatchObject({ spent: fixture.mock_quote!.amount, reserved: 0 });
});

it('measures grant avoidance after warm-up without counting standing grants as model calls', async () => {
  const { runCase } = await import('./runner.js');
  const { createInjectedJudge } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const judge = createInjectedJudge({
    async judge() {
      return {
        decision: 'approve',
        reasons: ['JUDGE_APPROVED'],
        explanation: 'test',
        injection_suspected: false,
        grant: { max_per_call: 20000, max_total: 200000, ttl_ms: 300000 },
      };
    },
  });
  const result = await runCase(loadSuite().core[0]!, judge, 6);
  expect(result.warmup).toMatchObject({
    attempted: 5,
    approved: 5,
    grant_hits: 5,
    judge_calls: 0,
    avoided_rate: 1,
  });
  expect(result.payment_calls).toBe(6);
  expect(result.money?.spent).toBe(60000);
});

it('distinguishes real review from incomplete processing and keeps its unsigned hold', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const result = await runCase(loadSuite().core[0]!, createStubJudge('stub-escalate'));
  expect(result.outcome).toBe('escalate');
  expect(result.stage).toBe('judge');
  expect(result.money).toMatchObject({ spent: 0, reserved: 10000 });
  expect(result.payment_calls ?? 0).toBe(0);
  expect(score([result]).legitimate.approved).toBe(0);
});

it('never contacts a merchant or provider for a catalog-unknown route', async () => {
  const { runCase } = await import('./runner.js');
  const { createStubJudge } = await import('../../apps/gateway/src/judge/index.js');
  const { loadSuite } = await import('./fixtures.js');
  const result = await runCase(
    loadSuite().core.find((c) => c.id === 'M18')!,
    createStubJudge('stub-approve'),
  );
  expect(result.outcome).toBe('escalate');
  expect(result.reasons).toContain('UNCATALOGED_ENDPOINT');
  expect(result.quote_calls ?? 0).toBe(0);
  expect(result.payment_calls ?? 0).toBe(0);
  expect(result.judge_attempts ?? 0).toBe(0);
  expect(result.money).toMatchObject({ spent: 0, reserved: 0 });
});
