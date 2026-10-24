import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { JudgeContext } from '@apf/contracts';
import { buildInput, createInjectedJudge, createStubJudge } from './index.js';
import { createJudge } from './real.js';
import { createCanonicalizer, loadCatalog, matchEndpoint } from '../catalog/index.js';
import { fileURLToPath } from 'node:url';

function context(): JudgeContext {
  const endpoint = {
    id: 'report',
    method: 'GET' as const,
    path: '/{subject}',
    category: 'report',
    description: 'Trusted endpoint',
    params: {
      subject: { in: 'path' as const, kind: 'subject' as const },
      format: {
        in: 'query' as const,
        kind: 'option' as const,
        type: 'enum' as const,
        values: ['summary', 'full'],
      },
      count: {
        in: 'query' as const,
        kind: 'option' as const,
        type: 'int' as const,
        min: 0,
        max: 10,
      },
      enabled: { in: 'query' as const, kind: 'option' as const, type: 'bool' as const },
      secret: { in: 'query' as const, kind: 'forbidden' as const },
    },
  };
  return {
    mandate: {
      task: 'Research Acme',
      subjects: ['Acme'],
      allowed_merchant_ids: ['merchant'],
      budget_remaining: 100,
      expires_in_ms: 500,
    },
    role_policy: 'Trusted policy',
    price: 10,
    purpose: 'fetch_report',
    method: 'GET',
    match: {
      kind: 'known',
      merchant: {
        id: 'merchant',
        name: 'Trusted merchant',
        category: 'data',
        description: 'Trusted catalog description',
        origin: 'https://merchant.example',
        payee: '0x123',
        endpoints: [endpoint],
      },
      endpoint,
      params: [
        { name: 'subject', kind: 'subject', value: '  ACME  ', violation: null },
        { name: 'format', kind: 'option', value: 'summary', violation: null },
        { name: 'count', kind: 'option', value: '5', violation: null },
        { name: 'enabled', kind: 'option', value: 'true', violation: null },
        { name: 'secret', kind: 'forbidden', value: 'secret', violation: 'PARAM_NOT_IN_SCHEMA' },
      ],
    },
    payee_facts: { first_seen: false, prior_calls: 2, recent_prices: [9, 10] },
  };
}
const approval = {
  decision: 'approve',
  reasons: ['JUDGE_APPROVED'],
  explanation: 'Needed.',
  injection_suspected: false,
};
const known = (ctx: JudgeContext) => {
  if (ctx.match.kind !== 'known') throw new Error('fixture');
  return ctx.match;
};

describe('safe context projection', () => {
  it('projects exactly trusted labels, mandate strings and constrained facts', () => {
    expect(buildInput(context())).toEqual({
      mandate: {
        task: 'Research Acme',
        subjects: ['Acme'],
        budget_remaining: 100,
        expires_in_ms: 500,
      },
      role_policy: 'Trusted policy',
      payment: {
        price: 10,
        purpose: 'fetch_report',
        merchant: {
          known: true,
          name: 'Trusted merchant',
          category: 'data',
          description: 'Trusted catalog description',
          selected_for_mandate: true,
        },
        endpoint: {
          known: true,
          method: 'GET',
          category: 'report',
          description: 'Trusted endpoint',
        },
        payee: { first_seen: false, prior_calls: 2, recent_prices: [9, 10] },
        params: [
          { name: 'subject', kind: 'subject', value: 'Acme' },
          { name: 'format', kind: 'option', value: 'summary' },
          { name: 'count', kind: 'option' },
          { name: 'enabled', kind: 'option' },
        ],
        url_shape: null,
      },
    });
  });
  it('computes selection from IDs and preserves POST and every purpose', () => {
    for (const purpose of [
      'fetch_data',
      'fetch_report',
      'verify_access',
      'subscribe',
      'other',
    ] as const) {
      const ctx = context();
      ctx.purpose = purpose;
      ctx.method = 'POST';
      known(ctx).endpoint.method = 'POST';
      ctx.mandate.allowed_merchant_ids = [];
      const result = buildInput(ctx);
      expect(result.payment.purpose).toBe(purpose);
      expect(result.payment.endpoint.method).toBe('POST');
      expect(result.payment.merchant.selected_for_mandate).toBe(false);
    }
  });
  it('projects real canonicalized matches, including unusual parameters after human review', async () => {
    const catalog = loadCatalog(
      fileURLToPath(new URL('../../../../catalog/catalog.json', import.meta.url)),
    );
    const canonicalize = createCanonicalizer(catalog);
    for (const query of [
      'period=30d',
      'period=CANARY_INVALID_ENUM',
      'CANARY_QUERY_NAME=CANARY_QUERY_VALUE',
    ]) {
      const canonical = canonicalize(`http://localhost:4101/v1/pricing/%20ACME%20?${query}`);
      if (!canonical.ok) throw new Error('fixture URL');
      const ctx = context();
      ctx.match = matchEndpoint(canonical, 'GET', catalog);
      ctx.mandate.allowed_merchant_ids = ['mer_pricing'];
      const provider = { judge: vi.fn(async () => approval) };
      const judge = createInjectedJudge(provider);
      const input = judge.buildInput(ctx);
      await judge.judge(input);
      expect(input.payment.params[0]).toEqual({ name: 'company', kind: 'subject', value: 'Acme' });
      expect(JSON.stringify(provider.judge.mock.calls)).not.toContain('CANARY');
      expect(input.payment.merchant).toMatchObject({
        name: 'PriceScope',
        description: 'Product pricing for named companies',
      });
    }
  });
  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '10'])(
    'rejects invalid numeric facts independently: %s',
    (value) => {
      const setters = [
        (ctx: any) => {
          ctx.price = value;
        },
        (ctx: any) => {
          ctx.mandate.budget_remaining = value;
        },
        (ctx: any) => {
          ctx.mandate.expires_in_ms = value;
        },
        (ctx: any) => {
          ctx.payee_facts.prior_calls = value;
        },
        (ctx: any) => {
          ctx.payee_facts.recent_prices = [value];
        },
      ];
      for (const set of setters) {
        const ctx = context();
        set(ctx);
        expect(() => buildInput(ctx)).toThrow('JUDGE_ERROR');
      }
    },
  );
  it.each([0, Number.MAX_SAFE_INTEGER])('accepts boundary numeric facts: %s', (value) => {
    const ctx = context();
    ctx.price = value;
    ctx.mandate.budget_remaining = value;
    ctx.mandate.expires_in_ms = value;
    ctx.payee_facts.prior_calls = value;
    ctx.payee_facts.recent_prices = [value];
    expect(buildInput(ctx).payment.price).toBe(value);
  });
  it.each([false, true])(
    'never calls the provider for unknown contexts (hasParams=%s)',
    async (hasParams) => {
      const ctx = context();
      ctx.match = {
        kind: 'unknown',
        origin: 'CANARY_UNKNOWN',
        hasParams,
        urlShape: {
          path_segments: [15],
          query_params: hasParams ? [{ type: 'string', length: 10 }] : [],
        },
      };
      const provider = { judge: vi.fn(async () => approval) };
      const judge = createInjectedJudge(provider);
      await expect(async () => judge.judge(judge.buildInput(ctx))).rejects.toThrow('JUDGE_ERROR');
      expect(provider.judge).not.toHaveBeenCalled();
    },
  );
  it('detaches arrays and nested objects in both directions', () => {
    const ctx = context();
    const result = buildInput(ctx);
    ctx.mandate.subjects.push('later');
    ctx.payee_facts.recent_prices.push(99);
    result.mandate.subjects.push('output');
    result.payment.payee.recent_prices.push(88);
    expect(ctx.mandate.subjects).toEqual(['Acme', 'later']);
    expect(result.payment.payee.recent_prices).toEqual([9, 10, 88]);
  });
  it.each([
    'unmatched',
    'invalid-enum',
    'violation',
    'wrong-kind',
    'duplicate',
    'missing',
    'inherited',
  ])('handles %s without exposing raw values', (mode) => {
    const ctx = context();
    const match = known(ctx);
    if (mode === 'unmatched') match.params[0]!.value = 'CANARY_unmatched';
    if (mode === 'invalid-enum') match.params[1]!.value = 'CANARY_enum';
    if (mode === 'violation') match.params[0]!.violation = 'PARAM_NOT_IN_SCHEMA';
    if (mode === 'wrong-kind') match.params[0]!.kind = 'option';
    if (mode === 'duplicate') match.params.push({ ...match.params[0]! });
    if (mode === 'missing') match.params = [];
    if (mode === 'inherited') {
      match.endpoint.params = Object.create({ attacker: { kind: 'subject', in: 'query' } });
      match.params = [
        { name: 'attacker', kind: 'subject', value: 'CANARY_inherited', violation: null },
      ];
    }
    const result = buildInput(ctx);
    expect(JSON.stringify(result)).not.toContain('CANARY');
    if (['violation', 'wrong-kind', 'unmatched'].includes(mode))
      expect(result.payment.params[0]).toEqual({ name: 'subject', kind: 'subject' });
    if (mode === 'invalid-enum')
      expect(result.payment.params[1]).toEqual({ name: 'format', kind: 'option' });
    if (['missing', 'inherited'].includes(mode)) expect(result.payment.params).toEqual([]);
    if (mode === 'duplicate')
      expect(result.payment.params.some((p) => p.name === 'subject')).toBe(false);
  });
  it.each([
    'price',
    'purpose',
    'method',
    'budget',
    'lifetime',
    'calls',
    'prices',
    'boolean',
    'unknown',
  ])('rejects invalid %s with a redacted error in every mode', (field) => {
    const ctx = context();
    if (field === 'price') ctx.price = NaN;
    if (field === 'purpose') ctx.purpose = 'CANARY' as never;
    if (field === 'method') ctx.method = 'POST';
    if (field === 'budget') ctx.mandate.budget_remaining = -1;
    if (field === 'lifetime') ctx.mandate.expires_in_ms = Infinity;
    if (field === 'calls') ctx.payee_facts.prior_calls = 0.5;
    if (field === 'prices') ctx.payee_facts.recent_prices = [Number.MAX_SAFE_INTEGER + 1];
    if (field === 'boolean') ctx.payee_facts.first_seen = 'CANARY' as never;
    if (field === 'unknown')
      ctx.match = {
        kind: 'unknown',
        origin: 'CANARY',
        hasParams: false,
        urlShape: { path_segments: [], query_params: [] },
      };
    for (const judge of [
      createStubJudge('stub-approve'),
      createStubJudge('stub-escalate'),
      createInjectedJudge({ judge: vi.fn() }),
    ]) {
      expect(() => judge.buildInput(ctx)).toThrow('JUDGE_ERROR');
    }
  });
});

// A10 is an isolation gate, not an accuracy evaluation or prompt-tuning corpus.
const attackLeaves: Array<[string, (ctx: any, canary: string) => void]> = [
  [
    'parameter kind',
    (ctx, c) => {
      ctx.match.params[0].kind = c;
    },
  ],
  [
    'parameter violation',
    (ctx, c) => {
      ctx.match.params[0].violation = c;
    },
  ],
  ...[
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
  ].map(
    (key) =>
      [
        key,
        (ctx: any, c: string) => {
          ctx[key] = c;
        },
      ] as [string, (ctx: any, c: string) => void],
  ),
  ...['mandate', 'payee_facts', 'match', 'match.merchant', 'match.endpoint', 'match.params.0'].map(
    (path) =>
      [
        path,
        (ctx: any, c: string) => {
          let leaf = ctx;
          for (const key of path.split('.')) leaf = leaf[key];
          leaf.merchant_metadata = { description: c, body: c };
        },
      ] as [string, (ctx: any, c: string) => void],
  ),
  [
    'path subject value',
    (ctx, c) => {
      ctx.match.params[0].value = c;
    },
  ],
  [
    'query enum value',
    (ctx, c) => {
      ctx.match.params[1].value = c;
    },
  ],
  [
    'integer value',
    (ctx, c) => {
      ctx.match.params[2].value = c;
    },
  ],
  [
    'boolean value',
    (ctx, c) => {
      ctx.match.params[3].value = c;
    },
  ],
  [
    'forbidden value',
    (ctx, c) => {
      ctx.match.params[4].value = c;
    },
  ],
  [
    'path name',
    (ctx, c) => {
      ctx.match.params[0].name = c;
    },
  ],
  [
    'query name',
    (ctx, c) => {
      ctx.match.params.push({ name: c, value: c, kind: 'subject', violation: null });
    },
  ],
  [
    'merchant origin',
    (ctx, c) => {
      ctx.match.merchant.origin = c;
    },
  ],
  [
    'merchant payee',
    (ctx, c) => {
      ctx.match.merchant.payee = c;
    },
  ],
  [
    'endpoint path',
    (ctx, c) => {
      ctx.match.endpoint.path = c;
    },
  ],
];
async function capture(ctx: JudgeContext, canary: string) {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(approval) }],
        }),
      ),
  );
  const judge = createJudge(
    { model: 'claude-sonnet-4-5-20250929', apiKey: 'TEST_PROVIDER_KEY', timeoutMs: 5000 },
    { fetch: transport },
  );
  const input = judge.buildInput(ctx);
  expect(JSON.stringify(input)).not.toContain(canary);
  await judge.judge(input);
  expect(transport).toHaveBeenCalledTimes(1);
  const body = transport.mock.calls[0]![1]!.body as string;
  expect(body).not.toContain(canary);
  expect(body).toContain('Trusted catalog description');
  expect(body).toContain('Trusted endpoint');
}
describe('A10 independent canary gate through the real builder and provider request', () => {
  it.each(attackLeaves)('%s', async (name, mutate) => {
    const ctx = context();
    const canary = `CANARY_A10_${name.replaceAll(' ', '_')}`;
    mutate(ctx, canary);
    await capture(ctx, canary);
  });
  const directory = new URL('../../../../eval/cases/variants/', import.meta.url);
  const variants = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map(
      (name) =>
        JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as {
          id: string;
          kind: string;
          canary?: string;
        },
    );
  it('requires a distinct canary for every existing attack fixture', () => {
    const attacks = variants.filter((v) => v.kind === 'attack');
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((v) => typeof v.canary === 'string' && v.canary.length > 0)).toBe(true);
    expect(new Set(attacks.map((v) => v.canary)).size).toBe(attacks.length);
  });
  it.each(variants.filter((v) => v.kind === 'attack'))(
    'isolates fixture $id canary at every untrusted leaf',
    async (variant) => {
      for (const [, mutate] of attackLeaves) {
        const ctx = context();
        mutate(ctx, variant.canary!);
        await capture(ctx, variant.canary!);
      }
    },
  );
});
