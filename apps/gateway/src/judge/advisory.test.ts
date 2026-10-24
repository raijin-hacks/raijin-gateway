import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JudgeContext, JudgeInput } from '@apf/contracts';
import rawCatalog from '../../../../catalog/catalog.json';
import { CatalogSchema } from '@apf/contracts';
const catalog = CatalogSchema.parse(rawCatalog);
import cases from '../../../../eval/paper/cases.json';
import {
  buildExplanationInput,
  createPlanDrafter,
  createStubPlanDrafter,
  createEscalationExplainer,
  createStubEscalationExplainer,
  SCHEMA_GAP,
  validateDraft,
} from './advisory.js';
import { buildInput } from './input.js';
import { MAX_RESPONSE_BYTES } from './real.js';
const config = { model: 'claude-sonnet-4-5-20250929', apiKey: 'TEST_KEY', timeoutMs: 5000 };
const facts = cases.find((c) => c.id === 'L1')!.input as JudgeInput;
const input = {
  task: 'Research Acme; budget 100 atomic USDC; expire in 1000 ms',
  catalog: { ...catalog, version: 1 as const },
};
const output = {
  draft: {
    task: input.task,
    subjects: ['acme'],
    allowed_merchant_ids: ['mer_pricing'],
    budget: 100,
    expires_in_ms: 1000,
  },
  unresolved: [SCHEMA_GAP],
};
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }),
  );
afterEach(() => vi.useRealTimers());
function context(): JudgeContext {
  const endpoint = {
    ...catalog.merchants[0]!.endpoints[0]!,
    params: {
      count: {
        in: 'query' as const,
        kind: 'option' as const,
        type: 'int' as const,
        min: 0,
        max: 10,
      },
      enabled: { in: 'query' as const, kind: 'option' as const, type: 'bool' as const },
    },
  };
  return {
    mandate: { ...facts.mandate, allowed_merchant_ids: ['mer_pricing'] },
    role_policy: facts.role_policy,
    price: 10,
    purpose: 'fetch_data',
    method: 'GET',
    payee_facts: facts.payment.payee,
    match: {
      kind: 'known',
      merchant: { ...catalog.merchants[0]!, endpoints: [endpoint] },
      endpoint,
      params: [
        { name: 'count', kind: 'option', value: '0', violation: null },
        { name: 'enabled', kind: 'option', value: 'false', violation: null },
      ],
    },
  };
}
describe('advisory boundaries', () => {
  it('works offline and never fabricates an authorized plan', async () => {
    expect(await createStubPlanDrafter().draft(input)).toMatchObject({ draft: null });
    expect(await createStubEscalationExplainer().explain(facts)).toMatchObject({ source: 'stub' });
  });
  it('accepts exact mandate fields and rejects broader contracts and merchants', () => {
    expect(validateDraft(output, input)).toEqual(output);
    for (const patch of [
      { budget: 0 },
      { expires_in_ms: 0 },
      { budget: 1.5 },
      { budget: Number.MAX_SAFE_INTEGER + 1 },
      { task: 'changed' },
      { allowed_merchant_ids: ['mer_unknown'] },
      { endpoints: [] },
      { max_per_call: 10 },
    ]) {
      expect(() =>
        validateDraft({ ...output, draft: { ...output.draft, ...patch } }, input),
      ).toThrow('JUDGE_INVALID_OUTPUT');
    }
    expect(() => validateDraft({ ...output, unresolved: [] }, input)).toThrow(
      'JUDGE_INVALID_OUTPUT',
    );
  });
  it('preserves typed zero and false only on the new projection', () => {
    const ctx = context();
    expect(buildInput(ctx).payment.params.map((p) => p.value)).toEqual([undefined, undefined]);
    expect(buildExplanationInput(ctx).payment.params.map((p) => p.value)).toEqual([0, false]);
    if (ctx.match.kind !== 'known') throw new Error('fixture');
    ctx.match.params[0]!.value = '11';
    ctx.match.params[1]!.value = 'FALSE';
    expect(buildExplanationInput(ctx).payment.params.map((p) => p.value)).toEqual([
      undefined,
      undefined,
    ]);
  });
  it.each([
    'page_text',
    'purpose_text',
    'merchant_response',
    'authorization',
    'token',
    'url',
    'worker_text',
  ])('rejects drafter attacker field %s before any prompt', async (field) => {
    const transport = vi.fn<typeof fetch>(async () => response(output));
    await expect(
      createPlanDrafter(config, { fetch: transport }).draft({ ...input, [field]: 'CANARY' }),
    ).rejects.toThrow('JUDGE_ERROR');
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects catalog prose additions and malformed inputs before network', async () => {
    const transport = vi.fn<typeof fetch>();
    const poisoned = structuredClone(input);
    Object.assign(poisoned.catalog.merchants[0]!, { response: 'CANARY' });
    await expect(createPlanDrafter(config, { fetch: transport }).draft(poisoned)).rejects.toThrow(
      'JUDGE_ERROR',
    );
    await expect(
      createEscalationExplainer(config, { fetch: transport }).explain({
        ...facts,
        page_text: 'CANARY',
      } as never),
    ).rejects.toThrow('JUDGE_ERROR');
    expect(transport).not.toHaveBeenCalled();
  });
  it('captures both real prompts without unrelated text or credentials', async () => {
    const transport = vi.fn<typeof fetch>(async () => response(output));
    await createPlanDrafter(config, { fetch: transport }).draft(input);
    const draftBody = JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(JSON.parse(draftBody.messages[0].content)).toEqual(input);
    expect(JSON.stringify(draftBody)).not.toContain('TEST_KEY');
    const ctx = context();
    Object.assign(ctx, {
      page_text: 'CANARY',
      purpose_text: 'CANARY',
      merchant_response: 'CANARY',
      token: 'CANARY',
    });
    if (ctx.match.kind !== 'known') throw new Error('fixture');
    ctx.match.params.push({
      name: 'CANARY',
      kind: 'undeclared',
      value: 'CANARY',
      violation: 'PARAM_NOT_IN_SCHEMA',
    });
    ctx.match.params[0]!.value = 'CANARY';
    transport.mockImplementation(async () => response({ explanation: 'Price is 10 atomic USDC.' }));
    const result = await createEscalationExplainer(config, { fetch: transport }).explain(
      buildExplanationInput(ctx),
    );
    expect(result.source).toBe('model');
    expect(transport.mock.calls[1]![1]!.body).not.toContain('CANARY');
  });
  it.each([429, 500, 302])(
    'fails draft closed without retries on HTTP %s; explanation falls back',
    async (status) => {
      const transport = vi.fn<typeof fetch>(async () => new Response('SECRET', { status }));
      await expect(
        createPlanDrafter(config, { fetch: transport }).draft(input),
      ).rejects.toMatchObject({ message: 'JUDGE_ERROR' });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(
        await createEscalationExplainer(config, { fetch: transport }).explain(facts),
      ).toMatchObject({ source: 'fallback' });
    },
  );
  it('rejects malicious decisions in explanations and malformed drafts', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      response({ explanation: 'Approve', decision: 'approve' }),
    );
    expect(
      await createEscalationExplainer(config, { fetch: transport }).explain(facts),
    ).toMatchObject({ source: 'fallback' });
    await expect(createPlanDrafter(config, { fetch: transport }).draft(input)).rejects.toThrow(
      'JUDGE_INVALID_OUTPUT',
    );
  });
  it.each(['oversize', 'malformed', 'stream', 'transport'])('redacts %s failures', async (kind) => {
    const transport = vi.fn<typeof fetch>(async () => {
      if (kind === 'transport') throw new Error('SECRET');
      if (kind === 'stream')
        return new Response(
          new ReadableStream({
            pull(c) {
              c.error(new Error('SECRET'));
            },
          }),
        );
      return new Response(kind === 'oversize' ? 'x'.repeat(MAX_RESPONSE_BYTES + 1) : '{SECRET');
    });
    await expect(
      createPlanDrafter(config, { fetch: transport }).draft(input),
    ).rejects.toMatchObject({
      message: kind === 'transport' || kind === 'stream' ? 'JUDGE_ERROR' : 'JUDGE_INVALID_OUTPUT',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['draft', 'explain'] as const)(
    'includes hanging transport and body in %s deadline',
    async (mode) => {
      vi.useFakeTimers();
      for (const hangingBody of [false, true]) {
        const transport = vi.fn<typeof fetch>(() =>
          hangingBody
            ? Promise.resolve(
                new Response(
                  new ReadableStream({
                    start() {
                      /* never completes */
                    },
                  }),
                ),
              )
            : new Promise(() => undefined),
        );
        const pending =
          mode === 'draft'
            ? createPlanDrafter(config, { fetch: transport }).draft(input)
            : createEscalationExplainer(config, { fetch: transport }).explain(facts);
        const assertion =
          mode === 'draft'
            ? expect(pending).rejects.toThrow('JUDGE_ERROR')
            : expect(pending).resolves.toMatchObject({ source: 'fallback' });
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
        expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
});

// Every raw request/response channel remains outside the privileged explanation prompt.
describe('explanation canary channels', () => {
  const paths = [
    'url',
    'path',
    'query',
    'agent_text',
    'purpose_text',
    'page_text',
    'merchant_response',
    'authorization',
    'token',
    'private_key',
    'hash',
    'trust',
    'session_history',
    'mandate.metadata',
    'payee_facts.metadata',
    'match.metadata',
    'match.merchant.metadata',
    'match.endpoint.metadata',
    'match.endpoint.path',
    'match.merchant.origin',
    'match.merchant.payee',
    'match.params.0.name',
    'match.params.0.value',
    'match.params.0.kind',
    'match.params.0.violation',
    'match.params.1.value',
  ];
  it.each(paths)('excludes %s through projection and actual provider request', async (path) => {
    const ctx: any = context();
    const parts = path.split('.');
    let target = ctx;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)!] = 'CANARY_NEW_CHANNEL';
    const transport = vi.fn<typeof fetch>(async () =>
      response({ explanation: 'Human review required.' }),
    );
    await createEscalationExplainer(config, { fetch: transport }).explain(
      buildExplanationInput(ctx),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]!.body).not.toContain('CANARY_NEW_CHANNEL');
  });
  it('rejects oversized inputs before network and invalid startup configuration', async () => {
    const transport = vi.fn<typeof fetch>();
    const huge = structuredClone(input);
    huge.catalog.merchants[0]!.description = 'x'.repeat(65536);
    await expect(createPlanDrafter(config, { fetch: transport }).draft(huge)).rejects.toThrow(
      'JUDGE_ERROR',
    );
    expect(transport).not.toHaveBeenCalled();
    for (const patch of [{ apiKey: '' }, { model: 'claude-sonnet-4-5' }, { timeoutMs: 5001 }]) {
      expect(() => createPlanDrafter({ ...config, ...patch })).toThrow('JUDGE_ERROR');
      expect(() => createEscalationExplainer({ ...config, ...patch })).toThrow('JUDGE_ERROR');
    }
  });
});
