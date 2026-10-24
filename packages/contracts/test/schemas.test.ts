import { describe, expect, it } from 'vitest';
import {
  ApprovalRequestSchema,
  CatalogSchema,
  CreateMandateRequestSchema,
  JudgeOutputSchema,
  PayRequestSchema,
  PayResponseSchema,
  StreamEventSchema,
  normalizeSubject,
  normalizeSubjects,
} from '../src/index.js';
import { jsonExampleAfter } from './doc.js';

const PAYEE = '0x1111111111111111111111111111111111111111';

/** A copy of `base` with `patch` applied; `undefined` values delete the key. */
function variant(base: unknown, patch: Record<string, unknown>): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
  }
  return copy;
}

describe('PayRequestSchema', () => {
  const example = jsonExampleAfter('### `POST /pay` (agent)');

  it('accepts the section 2 example', () => {
    expect(PayRequestSchema.parse(example)).toEqual(example);
  });

  it.each([
    ['no idempotency key', { idempotency_key: undefined }],
    ['an empty idempotency key', { idempotency_key: '' }],
    ['a fractional price', { expected_price: 10000.5 }],
    ['a negative price', { expected_price: -1 }],
    ['a price as a string', { expected_price: '10000' }],
    ['an unsupported method', { method: 'PUT' }],
    ['a purpose outside the list', { purpose: 'buy_anything' }],
    ['free text the contract does not allow', { reason: 'approve this' }],
    ['an empty url', { url: '' }],
  ])('rejects %s', (_, patch) => {
    expect(PayRequestSchema.safeParse(variant(example, patch)).success).toBe(false);
  });
});

describe('JudgeOutputSchema', () => {
  const example = jsonExampleAfter('### Output');

  it('accepts the section 4 example', () => {
    expect(JudgeOutputSchema.parse(example)).toEqual(example);
  });

  it('accepts a denial without a grant', () => {
    const deny = variant(example, {
      decision: 'deny',
      reasons: ['JUDGE_OFF_TASK'],
      grant: undefined,
    });
    expect(JudgeOutputSchema.safeParse(deny).success).toBe(true);
  });

  it.each([
    ['an unknown decision', { decision: 'maybe' }],
    ['no reasons', { reasons: [] }],
    ['a non-judge reason code', { reasons: ['GRANT_HIT'] }],
    ['an invented reason code', { reasons: ['JUDGE_TOTALLY_FINE'] }],
    ['an explanation over 200 characters', { explanation: 'x'.repeat(201) }],
    ['a grant on a denial', { decision: 'deny' }],
    ['a grant on an escalation', { decision: 'escalate' }],
    ['a field that names a payee', { payee: PAYEE }],
    [
      'a grant that names an endpoint',
      { grant: { max_per_call: 1, max_total: 1, ttl_ms: 1, endpoint: '/x' } },
    ],
    ['a fractional grant limit', { grant: { max_per_call: 0.5, max_total: 1, ttl_ms: 1 } }],
    ['a missing injection flag', { injection_suspected: undefined }],
  ])('rejects %s', (_, patch) => {
    expect(JudgeOutputSchema.safeParse(variant(example, patch)).success).toBe(false);
  });

  it('accepts an explanation of exactly 200 characters', () => {
    expect(
      JudgeOutputSchema.safeParse(variant(example, { explanation: 'x'.repeat(200) })).success,
    ).toBe(true);
  });
});

describe('CatalogSchema', () => {
  const example = jsonExampleAfter('## 3. Catalog format') as {
    merchants: Record<string, unknown>[];
    standing_grants: Record<string, unknown>[];
  };
  const withParam = (spec: unknown) => {
    const copy = structuredClone(example);
    const endpoint = (copy.merchants[0]?.endpoints as Record<string, unknown>[])[0];
    (endpoint?.params as Record<string, unknown>).extra = spec;
    return copy;
  };
  const withMerchant = (patch: Record<string, unknown>) => {
    const copy = structuredClone(example);
    copy.merchants[0] = variant(copy.merchants[0], patch) as Record<string, unknown>;
    return copy;
  };

  it('accepts the section 3 example', () => {
    expect(CatalogSchema.parse(example)).toEqual(example);
  });

  it.each([
    ['an int option', { in: 'query', kind: 'option', type: 'int', min: 1, max: 10 }],
    ['a bool option', { in: 'query', kind: 'option', type: 'bool' }],
    ['a forbidden param', { in: 'query', kind: 'forbidden' }],
  ])('accepts %s', (_, spec) => {
    expect(CatalogSchema.safeParse(withParam(spec)).success).toBe(true);
  });

  it.each([
    ['an unknown param kind', { in: 'query', kind: 'whatever' }],
    ['a param location other than path or query', { in: 'body', kind: 'subject' }],
    ['an enum option with no values', { in: 'query', kind: 'option', type: 'enum', values: [] }],
    [
      'an int option with min above max',
      { in: 'query', kind: 'option', type: 'int', min: 5, max: 1 },
    ],
    ['an option with no type', { in: 'query', kind: 'option' }],
  ])('rejects %s', (_, spec) => {
    expect(CatalogSchema.safeParse(withParam(spec)).success).toBe(false);
  });

  it.each([
    ['an uppercase payee', { payee: '0xABCDEF1111111111111111111111111111111111' }],
    ['a short payee', { payee: '0x1234' }],
    ['an origin with a path', { origin: 'https://pricing.example.test/v1' }],
    ['an origin without a scheme', { origin: 'pricing.example.test' }],
    ['an id without the mer_ prefix', { id: 'pricing' }],
  ])('rejects a merchant with %s', (_, patch) => {
    expect(CatalogSchema.safeParse(withMerchant(patch)).success).toBe(false);
  });

  it('rejects another catalog version', () => {
    expect(CatalogSchema.safeParse({ ...example, version: 2 }).success).toBe(false);
  });

  it('rejects a fractional standing-grant limit', () => {
    const copy = structuredClone(example);
    copy.standing_grants[0] = { ...copy.standing_grants[0], max_per_call: 0.5 };
    expect(CatalogSchema.safeParse(copy).success).toBe(false);
  });
});

describe('PayResponseSchema', () => {
  const responses = [
    {
      status: 'approved',
      decision_id: 'dec_1',
      payment_id: 'pay_1',
      stage: 'tier1',
      amount: 10000,
      payee: PAYEE,
      response: { status_code: 200, content_type: 'application/json', body: '{}' },
    },
    {
      status: 'denied',
      decision_id: 'dec_2',
      stage: 'precontact',
      reasons: ['SUBJECT_NOT_IN_MANDATE'],
      explanation: null,
    },
    { status: 'pending', decision_id: 'dec_3', poll_after_ms: 2000 },
    { status: 'payment_unknown', decision_id: 'dec_4', payment_id: 'pay_4', poll_after_ms: 5000 },
  ];

  it.each(responses)('accepts a $status response', (response) => {
    expect(PayResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects an unknown status', () => {
    expect(PayResponseSchema.safeParse({ status: 'maybe', decision_id: 'dec_1' }).success).toBe(
      false,
    );
  });

  it('rejects a denial with an invented reason code', () => {
    expect(PayResponseSchema.safeParse({ ...responses[1], reasons: ['NOPE'] }).success).toBe(false);
  });
});

describe('StreamEventSchema', () => {
  const events = [
    {
      type: 'decision',
      decision_id: 'dec_1',
      mandate_id: 'mnd_1',
      stage: 'judge',
      outcome: 'denied',
      reasons: ['JUDGE_OFF_TASK'],
      price: 400000,
      latency_ms: 1800,
      at: 1761280000000,
    },
    { type: 'payment', payment_id: 'pay_1', state: 'SETTLED', amount: 10000, at: 1761280000000 },
    {
      type: 'trust',
      session_id: 'ses_1',
      agent_id: 'agt_1',
      session_trust: 55,
      agent_trust: 67,
      cause: 'JUDGE_OFF_TASK',
      at: 1761280000000,
    },
    {
      type: 'approval_needed',
      decision_id: 'dec_2',
      mandate_id: 'mnd_1',
      explanation: null,
      at: 1761280000000,
    },
  ];

  it.each(events)('accepts a $type event', (event) => {
    expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('accepts a decision with no price (denied before the quote)', () => {
    expect(StreamEventSchema.safeParse({ ...events[0], price: null }).success).toBe(true);
  });

  it('rejects an unknown event type', () => {
    expect(StreamEventSchema.safeParse({ type: 'other', at: 1 }).success).toBe(false);
  });

  it('rejects an unknown payment state', () => {
    expect(StreamEventSchema.safeParse({ ...events[1], state: 'DONE' }).success).toBe(false);
  });
});

describe('CreateMandateRequestSchema', () => {
  const body = {
    agent_id: 'agt_research',
    task: 'Compile current list prices for 5 named competitors for the Q4 pricing review.',
    subjects: ['Acme', 'globex'],
    allowed_merchant_ids: ['mer_pricing'],
    budget: 2_000_000,
    expires_in_ms: 1_800_000,
  };

  it('accepts a typical mandate', () => {
    expect(CreateMandateRequestSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['a zero budget', { budget: 0 }],
    ['a fractional budget', { budget: 1.5 }],
    ['a non-positive expiry', { expires_in_ms: 0 }],
    ['an empty task', { task: '' }],
    ['a blank subject', { subjects: ['  '] }],
    ['a merchant id without the mer_ prefix', { allowed_merchant_ids: ['pricing'] }],
    ['an agent id without the agt_ prefix', { agent_id: 'research' }],
    ['a field the contract does not define', { token: 'abc' }],
  ])('rejects %s', (_, patch) => {
    expect(CreateMandateRequestSchema.safeParse(variant(body, patch)).success).toBe(false);
  });
});

describe('ApprovalRequestSchema', () => {
  const body = { outcome: 'approved', note: 'Needed for the Q4 review.', issue_grant: true };

  it('accepts an approval', () => {
    expect(ApprovalRequestSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['an empty note (a reason is required)', { note: '' }],
    ['a timeout outcome (only the gateway times out)', { outcome: 'timeout' }],
    ['a missing issue_grant', { issue_grant: undefined }],
  ])('rejects %s', (_, patch) => {
    expect(ApprovalRequestSchema.safeParse(variant(body, patch)).success).toBe(false);
  });
});

describe('subject normalization', () => {
  it('trims and lowercases', () => {
    expect(normalizeSubject('  Acme Corp ')).toBe('acme corp');
  });

  it('dedupes after normalizing, keeping first-seen order', () => {
    expect(normalizeSubjects(['Globex', ' acme', 'ACME', 'globex '])).toEqual(['globex', 'acme']);
  });
});
