import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpMethod, JudgeContext, JudgeModule } from '@apf/contracts';
import { loadCatalog } from '../catalog/index.js';
import { createInjectedJudge, createStubJudge, JudgeError } from './index.js';
import { createGatewayAdmission, runGatewayJudge } from './gateway.js';

const catalog = loadCatalog(new URL('../../../../catalog/catalog.json', import.meta.url).pathname);
const admission = createGatewayAdmission(catalog);
const url = 'http://localhost:4101/v1/pricing/Acme?period=30d';
const facts = {
  mandate: {
    task: 'Compare pricing',
    subjects: ['Acme'],
    allowed_merchant_ids: ['mer_pricing'],
    budget_remaining: 100,
    expires_in_ms: 1000,
  },
  role_policy: 'Research pricing',
  price: 10,
  purpose: 'fetch_data' as JudgeContext['purpose'],
  payee_facts: { first_seen: true, prior_calls: 0, recent_prices: [] },
};
async function context(): Promise<JudgeContext> {
  return admission.run(url, 'GET', async (route) => ({
    ...facts,
    method: route.method,
    match: route.match,
  })) as Promise<JudgeContext>;
}
const approval = {
  decision: 'approve',
  reasons: ['JUDGE_APPROVED'],
  explanation: 'Needed',
  injection_suspected: false,
};

afterEach(() => vi.useRealTimers());

describe('gateway composition boundary', () => {
  it('discards late completion after the gateway deadline', async () => {
    vi.useFakeTimers();
    const ctx = await context();
    let resolve!: (value: unknown) => void;
    const provider = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const pending = runGatewayJudge(createInjectedJudge({ judge: provider }), ctx);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toEqual({ kind: 'deny', reason: 'JUDGE_ERROR', quarantine: false });
    resolve(approval);
    await Promise.resolve();
    expect(await pending).toBe(result);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks unknown context even with a permissive injected builder', async () => {
    const judge = createStubJudge('stub-approve');
    judge.buildInput = vi.fn(judge.buildInput);
    judge.judge = vi.fn(judge.judge);
    const ctx = await context();
    ctx.match = { kind: 'unknown' } as never;
    expect(await runGatewayJudge(judge, ctx)).toMatchObject({
      kind: 'deny',
      reason: 'JUDGE_ERROR',
    });
    expect(judge.buildInput).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
  });
  it.each([
    ['https://attacker.test/steal', 'GET', 'escalate'],
    ['https://attacker.test/steal?secret=CANARY', 'GET', 'escalate'],
    ['http://localhost:4101/unknown', 'GET', 'escalate'],
    ['http://localhost:4101/unknown?secret=CANARY', 'GET', 'escalate'],
    [url, 'DELETE', 'escalate'],
    ['http://localhost:4199/steal', 'GET', 'deny'],
    ['https://merchant.test/a/../b', 'GET', 'deny'],
    [url + '&period=90d', 'GET', 'deny'],
  ])('holds %s %s before all downstream work', async (raw, method, kind) => {
    const downstream = vi.fn(async () => {
      throw new Error('quote/grant/judge/sign must not run');
    });
    expect(await admission.run(raw, method as HttpMethod, downstream)).toMatchObject({ kind });
    expect(downstream).not.toHaveBeenCalled();
  });

  it('uses operator-bound HTTP and passes trusted route objects without approving policy', async () => {
    const downstream = vi.fn(async (route) => route);
    const result = await admission.run(url, 'GET', downstream);
    expect(result).toMatchObject({
      method: 'GET',
      match: { kind: 'known', merchant: { id: 'mer_pricing' } },
    });
    expect(downstream).toHaveBeenCalledTimes(1);
    expect((await context()).match.kind).toBe('known');
  });

  it('rejects unvalidated catalog snapshots at composition', () => {
    expect(() => createGatewayAdmission(structuredClone(catalog))).toThrow();
  });

  it.each(['JUDGE_ERROR', 'JUDGE_INVALID_OUTPUT', 'unexpected'] as const)(
    'redacts %s and returns no approval',
    async (code) => {
      const judge = createStubJudge('stub-approve');
      judge.judge = vi.fn(async () => {
        throw code === 'unexpected' ? new Error('SECRET') : new JudgeError(code);
      });
      expect(await runGatewayJudge(judge, await context())).toEqual({
        kind: 'deny',
        reason: code === 'unexpected' ? 'JUDGE_ERROR' : code,
        quarantine: false,
      });
      expect(judge.judge).toHaveBeenCalledTimes(1);
    },
  );

  it('builder failures never invoke provider or raw fallback', async () => {
    const judge = createStubJudge('stub-approve');
    judge.buildInput = () => {
      throw new Error('CANARY');
    };
    judge.judge = vi.fn();
    expect(await runGatewayJudge(judge, await context())).toEqual({
      kind: 'deny',
      reason: 'JUDGE_ERROR',
      quarantine: false,
    });
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it.each(['approve', 'deny', 'escalate'])(
    'injection overrides %s and strips grant proposals',
    async (decision) => {
      const judge = createInjectedJudge({
        judge: async () => ({
          ...approval,
          decision,
          injection_suspected: true,
          ...(decision === 'approve'
            ? { grant: { max_per_call: 100, max_total: 100, ttl_ms: 100 } }
            : {}),
        }),
      });
      expect(await runGatewayJudge(judge, await context())).toEqual({
        kind: 'deny',
        reason: 'INJECTION_SUSPECTED',
        quarantine: true,
      });
    },
  );

  it('revalidates injected module output', async () => {
    const judge = createStubJudge('stub-approve');
    judge.judge = async () => ({ ...approval, secret: 'CANARY' }) as never;
    expect(await runGatewayJudge(judge, await context())).toMatchObject({
      kind: 'deny',
      reason: 'JUDGE_INVALID_OUTPUT',
    });
  });

  it('returns grant proposals only as judged output, never payment authority', async () => {
    const judge: JudgeModule = createInjectedJudge({
      judge: async () => ({
        ...approval,
        grant: {
          max_per_call: Number.MAX_SAFE_INTEGER,
          max_total: Number.MAX_SAFE_INTEGER,
          ttl_ms: 100,
        },
      }),
    });
    expect(await runGatewayJudge(judge, await context())).toMatchObject({
      kind: 'judged',
      output: { decision: 'approve', grant: { max_per_call: Number.MAX_SAFE_INTEGER } },
    });
  });
});
