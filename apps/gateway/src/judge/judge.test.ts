import { describe, expect, it, vi } from 'vitest';
import { createInjectedJudge, createStubJudge, JudgeError, validateOutput } from './index';
import type { JudgeInput, JudgeModule } from '@apf/contracts';
import cases from '../../../../eval/paper/cases.json';

const input = cases.find(c => c.id === 'L1')!.input as JudgeInput;
const approval = { decision: 'approve', reasons: ['JUDGE_APPROVED'], explanation: 'Needed for the task.', injection_suspected: false };

describe('strict output validation', () => {
  it('accepts valid decisions and optional numeric grants', () => {
    for (const decision of ['approve', 'deny', 'escalate']) {
      expect(validateOutput({ ...approval, decision }).decision).toBe(decision);
    }
    expect(validateOutput({ ...approval, grant: { max_per_call: 1, max_total: 1, ttl_ms: 1 } }).grant).toBeDefined();
  });
  it.each([
    null, 'not JSON', JSON.stringify(approval), {},
    { ...approval, payee: '0x123' },
    { ...approval, decision: 'allow' },
    { ...approval, reasons: [] },
    { ...approval, reasons: ['GRANT_HIT'] },
    { ...approval, explanation: 'x'.repeat(201) },
    { ...approval, injection_suspected: 'false' },
    ...['deny', 'escalate'].map(decision => ({ ...approval, decision, grant: { max_per_call: 1, max_total: 1, ttl_ms: 1 } })),
    ...['max_per_call', 'max_total', 'ttl_ms'].flatMap(field => [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...approval, grant: { max_per_call: 1, max_total: 1, ttl_ms: 1, [field]: value } }))),
    { ...approval, grant: { max_per_call: 1, max_total: 1, ttl_ms: 0 } },
    { ...approval, grant: { max_per_call: 1, max_total: 1, ttl_ms: 1, endpoint: 'redirect' } },
  ])('rejects invalid output %#', value => {
    expect(() => validateOutput(value)).toThrowError(new JudgeError('JUDGE_INVALID_OUTPUT'));
  });
});

describe('explicit modes and injected seam', () => {
  it.each(['stub-approve', 'stub-escalate'] as const)('%s satisfies JudgeModule without credentials', async mode => {
    const module: JudgeModule = createStubJudge(mode);
    const result = await module.judge(input);
    expect(result.decision).toBe(mode === 'stub-approve' ? 'approve' : 'escalate');
    expect(result.grant).toBeUndefined();
    expect(() => module.buildInput({} as never)).toThrowError(new JudgeError('JUDGE_ERROR'));
  });
  it('rejects implicit or real stub modes', () => {
    expect(() => createStubJudge('real' as never)).toThrow(JudgeError);
  });
  it('validates provider output without fallback', async () => {
    const judge = createInjectedJudge({ judge: async () => ({ ...approval, decision: 'oops' }) });
    await expect(judge.judge(input)).rejects.toMatchObject({ code: 'JUDGE_INVALID_OUTPUT' });
    const broken = createInjectedJudge({ judge: async () => { throw new Error('secret provider detail'); } });
    await expect(broken.judge(input)).rejects.toMatchObject({ code: 'JUDGE_ERROR', message: 'JUDGE_ERROR' });
  });
  it('rejects malformed and unknown inputs before provider invocation', async () => {
    const provider = { judge: vi.fn(async (_input: JudgeInput) => approval) };
    const module = createInjectedJudge(provider);
    for (const bad of [ { ...input, agent_text: 'untrusted' }, { ...input, payment: { ...input.payment, endpoint: { known: false, method: 'GET' } } }, { ...input, payment: { ...input.payment, merchant: { known: false, selected_for_mandate: false } } } ]) {
      await expect(module.judge(bad as JudgeInput)).rejects.toMatchObject({ code: 'JUDGE_ERROR' });
    }
    expect(provider.judge).not.toHaveBeenCalled();
  });
  it('passes a validated independent input to the provider', async () => {
    const provider = { judge: vi.fn(async (_input: JudgeInput) => approval) };
    await createInjectedJudge(provider).judge(input);
    expect(provider.judge).toHaveBeenCalledExactlyOnceWith(input);
    expect(provider.judge.mock.calls[0]?.[0]).not.toBe(input);
  });
});
