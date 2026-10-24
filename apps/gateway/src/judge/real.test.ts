import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JudgeInput } from '@apf/contracts';
import cases from '../../../../eval/paper/cases.json';
import { createJudge, MAX_RESPONSE_BYTES, MAX_TOKENS } from './real';
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from './prompt';
const input = cases.find(c => c.id === 'L1')!.input as JudgeInput;
const approval = { decision: 'approve', reasons: ['JUDGE_APPROVED'], explanation: 'Needed.', injection_suspected: false };
const message = (text = JSON.stringify(approval), extra = {}) => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });
const config = { model: 'claude-sonnet-4-5-20250929', apiKey: 'FAKE_KEY', timeoutMs: 5000 };
const response = (raw = message()) => new Response(JSON.stringify(raw));
afterEach(() => vi.useRealTimers());

describe('real judge boundary', () => {
  it.each([{ model: 'latest' }, { model: 'claude-opus-4-6' }, { apiKey: '' }, { apiKey: 'x\ny' }, { timeoutMs: 5001 }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 1.5 }])('rejects unsupported configuration %#', patch => {
    expect(() => createJudge({ ...config, ...patch })).toThrow('JUDGE_ERROR');
  });
  it('captures exactly the fixed prompt, sanitized input and settings; snapshots config', async () => {
    const transport = vi.fn<typeof fetch>(async () => response());
    const mutable = { ...config };
    const judge = createJudge(mutable, { fetch: transport });
    mutable.model = 'unverified'; mutable.apiKey = 'CHANGED'; mutable.timeoutMs = 1;
    expect(await judge.judge(input)).toEqual(approval);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': 'FAKE_KEY', 'anthropic-version': '2023-06-01' } });
    expect(JSON.parse(init!.body as string)).toEqual({ model: config.model, temperature: 0, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input) }], output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } } });
    expect(JSON.stringify(init!.body)).not.toContain('FAKE_KEY');
  });
  it.each([
    message('{broken'), message('```json\n{}\n```'), message(JSON.stringify({ ...approval, payee: 'attacker' })),
    message(JSON.stringify({ ...approval, reasons: ['GRANT_HIT'] })),
    message('', { stop_reason: 'max_tokens' }), message('', { stop_reason: 'refusal' }),
    message('', { content: [] }), message('', { content: [{ type: 'tool_use' }] }),
    message('', { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }),
  ])('fails invalid or partial outputs closed %#', async raw => {
    const transport = vi.fn<typeof fetch>(async () => response(raw));
    await expect(createJudge(config, { fetch: transport }).judge(input)).rejects.toMatchObject({ code: 'JUDGE_INVALID_OUTPUT' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 302])('never retries HTTP %i or exposes errors', async status => {
    const transport = vi.fn<typeof fetch>(async () => new Response('SECRET_DETAIL', { status }));
    await expect(createJudge(config, { fetch: transport }).judge(input)).rejects.toMatchObject({ code: 'JUDGE_ERROR', message: 'JUDGE_ERROR' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('redacts transport failures without falling back', async () => {
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('SECRET'); });
    await expect(createJudge(config, { fetch: transport }).judge(input)).rejects.toThrow('JUDGE_ERROR');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized and malformed envelopes', async () => {
    for (const body of ['x'.repeat(MAX_RESPONSE_BYTES + 1), '{bad', 'null']) {
      await expect(createJudge(config, { fetch: async () => new Response(body) }).judge(input)).rejects.toMatchObject({ code: 'JUDGE_INVALID_OUTPUT' });
    }
  });
  it('rejects unknown routes and extra untrusted fields before network', async () => {
    const transport = vi.fn<typeof fetch>(async () => response());
    for (const candidate of [{ ...input, token: 'CANARY' }, { ...input, payment: { ...input.payment, endpoint: { known: false, method: 'GET' } } }]) {
      await expect(createJudge(config, { fetch: transport }).judge(candidate as JudgeInput)).rejects.toThrow('JUDGE_ERROR');
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('aborts a genuinely hanging transport at five seconds and ignores a late approval', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const transport = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const pending = createJudge(config, { fetch: transport }).judge(input);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'JUDGE_ERROR' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(response());
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('includes hanging body consumption in the same total deadline', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() { /* intentionally never finishes */ } })));
    const pending = createJudge(config, { fetch: transport }).judge(input);
    const assertion = expect(pending).rejects.toThrow('JUDGE_ERROR');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
