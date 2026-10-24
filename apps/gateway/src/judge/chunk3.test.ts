import { describe, expect, it, vi } from 'vitest';
import { createInjectedJudge, createStubJudge, JudgeError } from './index';
import type { JudgeInput } from '@apf/contracts';
import cases from '../../../../eval/paper/cases.json';

const input = () => structuredClone(cases.find(c => c.id === 'L1')!.input!) as JudgeInput;
const approval = () => ({ decision: 'approve', reasons: ['JUDGE_APPROVED'],
  explanation: 'Needed for task.', injection_suspected: false });

describe('chunk3 provider isolation and failure behavior', () => {
  it.each(['merchant', 'endpoint', 'both'] as const)('blocks unknown %s with and without parameters', async unknown => {
    const provider = { judge: vi.fn(async () => approval()) };
    const judge = createInjectedJudge(provider);
    for (const params of [[], input().payment.params]) {
      const candidate = input();
      candidate.payment.params = params;
      if (unknown !== 'endpoint') candidate.payment.merchant = { known: false, selected_for_mandate: false };
      if (unknown !== 'merchant') candidate.payment.endpoint = { known: false, method: 'GET' };
      await expect(judge.judge(candidate)).rejects.toMatchObject({ code: 'JUDGE_ERROR' });
    }
    expect(provider.judge).not.toHaveBeenCalled();
  });

  it.each([
    [], ['mandate'], ['payment'], ['payment', 'merchant'], ['payment', 'endpoint'],
    ['payment', 'payee'], ['payment', 'params', '0'],
  ])('rejects a nested canary before any provider call at %j', async (...path) => {
    const provider = { judge: vi.fn(async () => approval()) };
    const candidate = input();
    let target: any = candidate;
    for (const key of path) target = target[key];
    target.agent_text = `CANARY_${path.join('_') || 'ROOT'}`;
    await expect(createInjectedJudge(provider).judge(candidate)).rejects.toMatchObject({ code: 'JUDGE_ERROR' });
    expect(provider.judge).not.toHaveBeenCalled();
  });

  it('deeply detaches provider input and validated output from caller-owned objects', async () => {
    const original = input();
    const before = structuredClone(original);
    const raw = { ...approval(), grant: { max_per_call: 10, max_total: 20, ttl_ms: 30 } };
    const provider = { judge: vi.fn(async (received: JudgeInput) => {
      received.mandate.subjects.push('provider mutation');
      received.payment.payee.recent_prices.push(999);
      received.payment.params[0]!.value = 'provider mutation';
      return raw;
    }) };
    const result = await createInjectedJudge(provider).judge(original);
    expect(original).toEqual(before);
    raw.reasons.push('JUDGE_ERROR');
    raw.grant.max_total = 999;
    expect(result.reasons).toEqual(['JUDGE_APPROVED']);
    expect(result.grant?.max_total).toBe(20);
  });

  it.each([new Error('SECRET_PROVIDER_DETAIL'), 'SECRET_PROVIDER_DETAIL', null,
    new JudgeError('JUDGE_INVALID_OUTPUT')])('maps provider rejection to a redacted error without retry %#', async failure => {
    const provider = { judge: vi.fn(async () => { throw failure; }) };
    await expect(createInjectedJudge(provider).judge(input())).rejects.toMatchObject({
      name: 'JudgeError', code: 'JUDGE_ERROR', message: 'JUDGE_ERROR',
    });
    expect(provider.judge).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '{bad json', JSON.stringify(approval()),
    { ...approval(), endpoint: '/attacker' },
    { ...approval(), reasons: ['BUDGET_EXCEEDED'] },
    { ...approval(), grant: { max_per_call: 1, max_total: 1, ttl_ms: 0 } },
  ])('rejects invalid resolved output without approval fallback %#', async output => {
    const provider = { judge: vi.fn(async () => output) };
    await expect(createInjectedJudge(provider).judge(input())).rejects.toMatchObject({ code: 'JUDGE_INVALID_OUTPUT' });
    expect(provider.judge).toHaveBeenCalledTimes(1);
  });

  it('preserves injection flags and grant proposals for gateway policy and clamping', async () => {
    const output = { ...approval(), injection_suspected: true,
      grant: { max_per_call: Number.MAX_SAFE_INTEGER, max_total: Number.MAX_SAFE_INTEGER, ttl_ms: Number.MAX_SAFE_INTEGER } };
    expect(await createInjectedJudge({ judge: async () => output }).judge(input())).toEqual(output);
  });

  it('fails closed for malformed raw contexts', () => {
    const provider = { judge: vi.fn(async () => approval()) };
    expect(() => createInjectedJudge(provider).buildInput({ agent_text: 'CANARY_RAW_CONTEXT' } as never))
      .toThrowError(new JudgeError('JUDGE_ERROR'));
    expect(provider.judge).not.toHaveBeenCalled();
  });
});

describe('paper fixtures through explicit local stub modes', () => {
  it.each(['stub-approve', 'stub-escalate'] as const)('%s runs all 18 judge-eligible fixtures', async mode => {
    const judge = createStubJudge(mode);
    for (const fixture of cases.filter(c => c.route === 'judge')) {
      const result = await judge.judge(fixture.input as JudgeInput);
      expect(result.decision, fixture.id).toBe(mode === 'stub-approve' ? 'approve' : 'escalate');
      expect(result.grant).toBeUndefined();
    }
    // Deliberately do not score these as model accuracy: stubs ignore task relevance.
  });
});
