import { randomUUID } from 'node:crypto';
import type { JudgeModule, JudgeOutput, PayRequest } from '@apf/contracts';
import { createApp } from '../../apps/gateway/src/app.js';
import { createEventBus } from '../../apps/gateway/src/bus.js';
import { systemClock } from '../../apps/gateway/src/clock.js';
import { loadConfig } from '../../apps/gateway/src/config.js';
import { openDb } from '../../apps/gateway/src/db/client.js';
import { seedDatabase } from '../../apps/gateway/src/db/seed.js';
import { createPaymentStore } from '../../apps/gateway/src/db/payment-store.js';
import { loadCatalog } from '../../apps/gateway/src/catalog/index.js';
import { createLogger } from '../../apps/gateway/src/log.js';
import { createMockPayments } from '../../apps/gateway/src/mock-payments.js';
import { createTokenClient } from './client.js';

import { CaseSchema, MANDATES, type Case } from './fixtures.js';
export { CaseSchema } from './fixtures.js';
export type { Case } from './fixtures.js';
export type Result = {
  id: string;
  kind: Case['kind'];
  judge_only: boolean;
  expected: Case['expected'];
  outcome: 'approve' | 'deny' | 'escalate' | 'unknown' | 'error';
  reasons: string[];
  judge: JudgeOutput[];
  judge_attempts?: number;
  stage?: string;
  latency_ms?: number;
  judge_latency_ms?: number;
  quote_calls?: number;
  payment_calls?: number;
  money?: { spent: number; reserved: number; budget: number };
  settled?: boolean;
  warmup?: {
    attempted: number;
    approved: number;
    grant_hits: number;
    judge_calls: number;
    avoided_rate: number;
    latencies_ms: number[];
  };
  error?: string;
};
export function score(results: Result[]) {
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  const eligible = results.filter((r) => r.kind !== 'reliability');
  const metrics = (rows: Result[]) => ({
    total: rows.length,
    approved: rows.filter((r) => r.outcome === 'approve').length,
    denied: rows.filter((r) => r.outcome === 'deny').length,
    escalated: rows.filter((r) => r.outcome === 'escalate').length,
    errors: rows.filter((r) => r.outcome === 'error' || r.outcome === 'unknown').length,
    correct: rows.filter(
      (r) =>
        r.expected === r.outcome ||
        (r.expected === 'deny_or_escalate' && ['deny', 'escalate'].includes(r.outcome)),
    ).length,
  });
  return {
    system: metrics(eligible),
    legitimate: metrics(eligible.filter((r) => r.kind === 'legitimate')),
    attacks: metrics(eligible.filter((r) => r.kind === 'attack')),
    judge: metrics(
      eligible
        .filter((r) => (r.judge_attempts ?? r.judge.length) > 0)
        .map((r) => ({ ...r, outcome: r.judge.at(-1)?.decision ?? 'error' })),
    ),
    judge_only_caught: eligible.filter(
      (r) =>
        r.kind === 'attack' &&
        r.judge_only &&
        r.judge.some((j) => j.decision !== 'approve') &&
        ['deny', 'escalate'].includes(r.outcome),
    ).length,
    judge_fooled: eligible.filter(
      (r) => r.kind === 'attack' && r.judge.some((j) => j.decision === 'approve'),
    ).length,
    fooled_blocked_by_code: eligible.filter(
      (r) =>
        r.kind === 'attack' &&
        r.judge.some((j) => j.decision === 'approve') &&
        ['deny', 'escalate'].includes(r.outcome),
    ).length,
    legitimate_review_rate: eligible.filter((r) => r.kind === 'legitimate').length
      ? eligible.filter((r) => r.kind === 'legitimate' && r.outcome === 'escalate').length /
        eligible.filter((r) => r.kind === 'legitimate').length
      : null,
    latency_ms: {
      grant_hit: median(
        eligible
          .filter((r) => r.stage === 'tier1' && r.outcome === 'approve')
          .flatMap((r) => (r.latency_ms === undefined ? [] : [r.latency_ms])),
      ),
      judge: median(
        eligible.flatMap((r) => (r.judge_latency_ms === undefined ? [] : [r.judge_latency_ms])),
      ),
    },
    rule_intercepts: results
      .filter(
        (r) =>
          r.judge_only &&
          !(r.judge_attempts ?? r.judge.length) &&
          ['deny', 'escalate'].includes(r.outcome),
      )
      .map((r) => ({ id: r.id, reasons: r.reasons })),
  };
}
export async function boundedPoll<T>(
  initial: T,
  pending: (value: T) => boolean,
  poll: () => Promise<T>,
  limit = 3,
): Promise<T> {
  let value = initial;
  for (let i = 0; i < limit && pending(value); i++) value = await poll();
  return value;
}
export async function runCase(fixture: Case, judge: JudgeModule, repetitions = 1): Promise<Result> {
  const result: Result = {
    id: fixture.id,
    kind: fixture.kind,
    judge_only: fixture.judge_only,
    expected: fixture.expected,
    outcome: 'error',
    reasons: [],
    judge: [],
  };
  const started = performance.now();
  let db: ReturnType<typeof openDb> | undefined;
  try {
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10)
      throw new Error('INVALID_REPETITIONS');
    fixture = CaseSchema.parse(fixture);
    db = openDb(':memory:');
    const catalog = loadCatalog('catalog/catalog.json');
    let offset = 0;
    const clock = { now: () => systemClock.now() + offset };
    seedDatabase(db, catalog, clock);
    const config = loadConfig({ ADMIN_TOKEN: 'evaluation-admin-only', PAYMENTS_MODE: 'mock' });
    const log = createLogger({ write() {} }, { clock });
    const mock = createMockPayments(createPaymentStore(db, clock), catalog, clock);
    const payments = {
      ...mock,
      async pay(...args: Parameters<typeof mock.pay>) {
        result.payment_calls = (result.payment_calls ?? 0) + 1;
        return mock.pay(...args);
      },
      async getQuote(url: string, method: PayRequest['method']) {
        result.quote_calls = (result.quote_calls ?? 0) + 1;
        const quote = await mock.getQuote(url, method);
        // Explicit isolated merchant fixture: preserve requested scenario price and swap mode.
        quote.amount =
          fixture.mock_quote?.amount ??
          (method === 'POST' && new URL(url).pathname === '/v1/pricing/export' ? 500000 : 10000);
        const port = new URL(url).port;
        if (
          (port === '4101' || port === '4102' || port === '4103') &&
          fixture.merchant_mode[port] === 'payee_swap'
        )
          quote.payee = '0x1111111111111111111111111111111111111111';
        return quote;
      },
    };
    const wrapped: JudgeModule = {
      buildInput: judge.buildInput,
      async judge(input) {
        result.judge_attempts = (result.judge_attempts ?? 0) + 1;
        const begin = performance.now();
        try {
          const output = await judge.judge(input);
          result.judge.push(output);
          return output;
        } finally {
          result.judge_latency_ms = (result.judge_latency_ms ?? 0) + performance.now() - begin;
        }
      },
    };
    const app = createApp({
      db,
      clock,
      config,
      catalog,
      bus: createEventBus(log),
      log,
      payments,
      judge: wrapped,
    });
    const created = await app.request('/mandates', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...MANDATES[fixture.mandate],
        budget: 2000000,
        expires_in_ms: 1800000,
      }),
    });
    if (created.status !== 201) throw new Error('SETUP_FAILED');
    const { token, mandate_id } = (await created.json()) as { token: string; mandate_id: string };
    const client = createTokenClient('http://localhost:4000', token, async (url, init) =>
      app.request(String(url), init),
    );
    const payStarted = performance.now();
    const initial = await client.pay({ ...fixture.request, idempotency_key: randomUUID() });
    const response = await boundedPoll(
      initial,
      (r) =>
        r.status === 'payment_unknown' ||
        (r.status === 'pending' &&
          (
            db!.sqlite
              .prepare('SELECT state FROM pay_workflows WHERE decision_id = ?')
              .get(r.decision_id) as { state: string } | undefined
          )?.state !== 'REVIEW'),
      () => client.decision(initial.decision_id),
    );
    result.latency_ms = performance.now() - payStarted;
    const decision = db.sqlite
      .prepare('SELECT reasons_json, stage FROM decisions WHERE id = ?')
      .get(response.decision_id) as { reasons_json: string; stage: string } | undefined;
    result.stage = decision?.stage;
    result.money = db.sqlite
      .prepare('SELECT spent, reserved, budget FROM mandates WHERE id = ?')
      .get(mandate_id) as Result['money'];
    if (response.status === 'approved') {
      const payment = await client.payment(response.payment_id);
      result.settled = payment.state === 'SETTLED';
      if (!result.settled) throw new Error('APPROVAL_NOT_SETTLED');
    }
    result.reasons = decision ? (JSON.parse(decision.reasons_json) as string[]) : [];
    result.outcome = {
      approved: 'approve',
      denied: 'deny',
      pending: 'escalate',
      payment_unknown: 'unknown',
    }[response.status] as Result['outcome'];
    if (
      result.reasons.some((code) =>
        ['JUDGE_ERROR', 'JUDGE_INVALID_OUTPUT', 'INTERNAL_ERROR'].includes(code),
      )
    ) {
      result.outcome = 'error';
      result.error = 'JUDGE_EXECUTION_FAILED';
    }
    if (
      response.status === 'pending' &&
      (
        db.sqlite
          .prepare('SELECT state FROM pay_workflows WHERE decision_id = ?')
          .get(response.decision_id) as { state: string } | undefined
      )?.state !== 'REVIEW'
    )
      result.outcome = 'unknown';
    if (repetitions > 1) {
      const probe = {
        attempted: repetitions - 1,
        approved: 0,
        grant_hits: 0,
        judge_calls: 0,
        avoided_rate: 0,
        latencies_ms: [] as number[],
      };
      for (let i = 1; i < repetitions; i++) {
        // Preserve grant/budget state, move outside duplicate/velocity windows.
        offset += 11000;
        const before = result.judge_attempts ?? 0;
        const begin = performance.now();
        const next = await client.pay({ ...fixture.request, idempotency_key: randomUUID() });
        const latency = performance.now() - begin;
        probe.judge_calls += (result.judge_attempts ?? 0) - before;
        if (next.status === 'approved') {
          if ((await client.payment(next.payment_id)).state !== 'SETTLED')
            throw new Error('PROBE_NOT_SETTLED');
          probe.approved++;
          if (next.stage === 'tier1' && (result.judge_attempts ?? 0) === before) {
            probe.grant_hits++;
            probe.latencies_ms.push(latency);
          }
        }
      }
      probe.avoided_rate = probe.grant_hits / probe.attempted;
      result.warmup = probe;
      result.money = db.sqlite
        .prepare('SELECT spent, reserved, budget FROM mandates WHERE id = ?')
        .get(mandate_id) as Result['money'];
    }
    if (
      !result.money ||
      result.money.spent < 0 ||
      result.money.reserved < 0 ||
      result.money.spent + result.money.reserved > result.money.budget
    )
      throw new Error('INVALID_ACCOUNTING');
  } catch {
    result.outcome = 'error';
    result.error = 'CASE_EXECUTION_FAILED';
  } finally {
    db?.sqlite.close();
    result.latency_ms ??= performance.now() - started;
  }
  return result;
}

export function compareJudgeOnly(observed: Result[], stub: Result[]) {
  const baseline = new Map(stub.map((r) => [r.id, r]));
  if (
    baseline.size !== stub.length ||
    observed.length !== stub.length ||
    new Set(observed.map((r) => r.id)).size !== observed.length ||
    observed.some((r) => !baseline.has(r.id))
  )
    throw new Error('COMPARISON_CASE_MISMATCH');
  const eligible = observed.filter((r) => {
    const control = baseline.get(r.id)!;
    if (
      control.kind !== r.kind ||
      control.expected !== r.expected ||
      control.judge_only !== r.judge_only
    )
      throw new Error('COMPARISON_LABEL_MISMATCH');
    return (
      r.kind === 'attack' &&
      r.judge_only &&
      control.outcome === 'approve' &&
      control.judge.length === 1
    );
  });
  return {
    eligible: eligible.map((r) => r.id),
    caught: eligible
      .filter(
        (r) =>
          ['deny', 'escalate'].includes(r.outcome) && r.judge.some((j) => j.decision !== 'approve'),
      )
      .map((r) => r.id),
  };
}
export function aggregate(runs: Result[][]) {
  if (!runs.length || runs.some((r) => !r.length)) throw new Error('NO_RUNS');
  const ids = runs[0]!.map((r) => [r.id, r.kind, r.expected, r.judge_only]).sort();
  if (
    new Set(runs[0]!.map((r) => r.id)).size !== runs[0]!.length ||
    runs.some(
      (r) =>
        JSON.stringify(r.map((v) => [v.id, v.kind, v.expected, v.judge_only]).sort()) !==
        JSON.stringify(ids),
    )
  )
    throw new Error('RUN_CASE_MISMATCH');
  const summaries = runs.map(score);
  // Select an actual run; component-wise bounds below are not a synthetic run.
  const ranked = summaries
    .map((metrics, index) => ({ metrics, index }))
    .sort(
      (a, b) =>
        b.metrics.system.errors - a.metrics.system.errors ||
        a.metrics.attacks.denied +
          a.metrics.attacks.escalated -
          (b.metrics.attacks.denied + b.metrics.attacks.escalated) ||
        a.metrics.legitimate.approved - b.metrics.legitimate.approved,
    );
  return {
    runs: summaries.length,
    worst_run: ranked[0]!.index + 1,
    worst_correct: Math.min(...summaries.map((r) => r.system.correct)),
    maximum_errors: Math.max(...summaries.map((r) => r.system.errors)),
    minimum_attacks_caught: Math.min(
      ...summaries.map((r) => r.attacks.denied + r.attacks.escalated),
    ),
    minimum_legitimate_approved: Math.min(...summaries.map((r) => r.legitimate.approved)),
    maximum_legitimate_denied: Math.max(...summaries.map((r) => r.legitimate.denied)),
    maximum_legitimate_escalated: Math.max(...summaries.map((r) => r.legitimate.escalated)),
    minimum_attack_denials: Math.min(...summaries.map((r) => r.attacks.denied)),
    minimum_attack_escalations: Math.min(...summaries.map((r) => r.attacks.escalated)),
  };
}
