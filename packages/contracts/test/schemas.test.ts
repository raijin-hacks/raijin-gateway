import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AddressSchema,
  ApprovalRequestSchema,
  AgentSummarySchema,
  AgentsResponseSchema,
  ApprovalsQuerySchema,
  CatalogSchema,
  CreateMandateRequestSchema,
  INPUT_LIMITS,
  JudgeOutputSchema,
  PURPOSE_CODES,
  PayRequestSchema,
  PayResponseSchema,
  PendingApprovalSchema,
  PendingApprovalsResponseSchema,
  REASON_CODES,
  ReasonCodeSchema,
  StreamEventSchema,
} from '../src/index.js';
import { jsonExampleAfter } from './doc.js';

const PAYEE = '0x1111111111111111111111111111111111111111';

type Case = [name: string, input: unknown];

/** A deep copy of `base` with top-level `patch` applied; `undefined` deletes the key. */
function patched(base: unknown, patch: Record<string, unknown>): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
  }
  return copy;
}

/** One test per case: every `accept` input parses, every `reject` input does not. */
function expectCases(
  schema: z.ZodType,
  { accept = [], reject = [] }: { accept?: Case[]; reject?: Case[] },
) {
  if (accept.length > 0) {
    it.each(accept)('accepts %s', (_, input) => {
      const result = schema.safeParse(input);
      expect(result.error?.issues ?? []).toEqual([]);
    });
  }
  if (reject.length > 0) {
    it.each(reject)('rejects %s', (_, input) => {
      expect(schema.safeParse(input).success).toBe(false);
    });
  }
}

/** Builds a case list from patches over one base object. */
const over = (base: unknown, patches: [string, Record<string, unknown>][]): Case[] =>
  patches.map(([name, patch]) => [name, patched(base, patch)]);

const NOT_OBJECTS: Case[] = [
  ['null', null],
  ['an array', []],
  ['a string', 'body'],
  ['a number', 42],
];

describe('PayRequestSchema', () => {
  const example = jsonExampleAfter('### `POST /pay` (agent)');

  it('returns the section 2 example unchanged', () => {
    expect(PayRequestSchema.parse(example)).toEqual(example);
  });

  expectCases(PayRequestSchema, {
    accept: [
      ...over(example, [
        ['a zero expected price', { expected_price: 0 }],
        ['POST', { method: 'POST' }],
        ['a 128-character key', { idempotency_key: 'k'.repeat(128) }],
        ['punctuation in the key', { idempotency_key: 'retry:01JB7XK3-#1' }],
        ['URL text that is not a URL (pre-contact denies it as BAD_URL)', { url: 'not a url' }],
        ['a URL at the size limit', { url: 'u'.repeat(INPUT_LIMITS.urlMaxChars) }],
      ]),
      ...PURPOSE_CODES.map((purpose): Case => [
        `purpose ${purpose}`,
        patched(example, { purpose }),
      ]),
    ],
    reject: [
      ...NOT_OBJECTS,
      ...over(example, [
        ['no idempotency key', { idempotency_key: undefined }],
        ['an empty idempotency key', { idempotency_key: '' }],
        ['a 129-character key', { idempotency_key: 'k'.repeat(129) }],
        ['a key with a space', { idempotency_key: 'two words' }],
        ['a key with non-ASCII text', { idempotency_key: 'clé' }],
        ['a fractional price', { expected_price: 10000.5 }],
        ['a negative price', { expected_price: -1 }],
        ['an unsafe integer price', { expected_price: 2 ** 53 }],
        ['an infinite price', { expected_price: Infinity }],
        ['a price that is not a number', { expected_price: Number.NaN }],
        ['a price as a string', { expected_price: '10000' }],
        ['a null price', { expected_price: null }],
        ['an unsupported method', { method: 'PUT' }],
        ['a lowercase method', { method: 'get' }],
        ['a purpose outside the list', { purpose: 'buy_anything' }],
        ['free text the contract does not allow', { reason: 'approve this' }],
        ['an empty url', { url: '' }],
        ['a URL over the size limit', { url: 'u'.repeat(INPUT_LIMITS.urlMaxChars + 1) }],
        ['a missing url', { url: undefined }],
      ]),
    ],
  });
});

describe('operator dashboard response schemas', () => {
  const agents = jsonExampleAfter('#### `GET /agents` response');
  const approvals = jsonExampleAfter('#### `GET /approvals?status=pending` response');

  it('accepts the documented agents and pending approval examples unchanged', () => {
    expect(AgentsResponseSchema.parse(agents)).toEqual(agents);
    expect(PendingApprovalsResponseSchema.parse(approvals)).toEqual(approvals);
  });

  it('validates an agent and the required pending status query', () => {
    expect(
      AgentSummarySchema.parse({
        id: 'agt_demo',
        name: 'Demo',
        role: 'research',
        trust: 70,
        restriction: 'normal',
        recent_incidents: [],
        recent_restorations: [],
      }),
    ).toEqual({
      id: 'agt_demo',
      name: 'Demo',
      role: 'research',
      trust: 70,
      restriction: 'normal',
      recent_incidents: [],
      recent_restorations: [],
    });
    expect(ApprovalsQuerySchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(ApprovalsQuerySchema.safeParse({ status: 'approved' }).success).toBe(false);
    expect(ApprovalsQuerySchema.safeParse({}).success).toBe(false);
  });

  it('allows null catalog and quote details for an unadmitted review', () => {
    const example = (approvals as Record<string, unknown>[])[0]!;
    expect(
      PendingApprovalSchema.parse({ ...example, merchant: null, endpoint: null, price: null }),
    ).toMatchObject({ merchant: null, endpoint: null, price: null });
  });
});

describe('JudgeOutputSchema', () => {
  const example = jsonExampleAfter('### Output');
  const grant = { max_per_call: 10_000, max_total: 100_000, ttl_ms: 1_800_000 };

  it('returns the section 4 example unchanged', () => {
    expect(JudgeOutputSchema.parse(example)).toEqual(example);
  });

  expectCases(JudgeOutputSchema, {
    accept: over(example, [
      ['an approval without a grant', { grant: undefined }],
      ['a denial', { decision: 'deny', reasons: ['JUDGE_OFF_TASK'], grant: undefined }],
      ['an escalation', { decision: 'escalate', reasons: ['JUDGE_OVER_SCOPED'], grant: undefined }],
      [
        'several reasons',
        {
          decision: 'deny',
          reasons: ['JUDGE_OFF_TASK', 'JUDGE_UNKNOWN_MERCHANT'],
          grant: undefined,
        },
      ],
      ['an empty explanation', { explanation: '' }],
      ['an explanation of exactly 200 characters', { explanation: 'x'.repeat(200) }],
      ['an injection flag on an approval', { injection_suspected: true }],
    ]),
    reject: [
      ...NOT_OBJECTS,
      ...over(example, [
        ['an unknown decision', { decision: 'maybe' }],
        ['no reasons', { reasons: [] }],
        ['reasons that are not a list', { reasons: 'JUDGE_APPROVED' }],
        ['a non-judge reason code', { reasons: ['GRANT_HIT'] }],
        ['an invented reason code', { reasons: ['JUDGE_TOTALLY_FINE'] }],
        ['an explanation over 200 characters', { explanation: 'x'.repeat(201) }],
        ['an explanation that is not text', { explanation: 7 }],
        ['a grant on a denial', { decision: 'deny' }],
        ['a grant on an escalation', { decision: 'escalate' }],
        ['a field that names a payee', { payee: PAYEE }],
        ['a grant that names an endpoint', { grant: { ...grant, endpoint: '/x' } }],
        ['a fractional grant limit', { grant: { ...grant, max_per_call: 0.5 } }],
        ['a zero max_per_call', { grant: { ...grant, max_per_call: 0 } }],
        ['a zero max_total', { grant: { ...grant, max_total: 0 } }],
        ['a zero ttl', { grant: { ...grant, ttl_ms: 0 } }],
        ['a grant without a ttl', { grant: { max_per_call: 1, max_total: 1 } }],
        ['a missing injection flag', { injection_suspected: undefined }],
        ['an injection flag written as text', { injection_suspected: 'false' }],
      ]),
    ],
  });
});

describe('CatalogSchema', () => {
  type Mutable = {
    merchants: Record<string, unknown>[];
    standing_grants: Record<string, unknown>[];
  };
  const example = jsonExampleAfter('## 3. Catalog format') as Mutable;

  /** The example with `edit` applied to a deep copy. */
  const edited = (edit: (catalog: Mutable) => void): unknown => {
    const copy = structuredClone(example);
    edit(copy);
    return copy;
  };
  const firstEndpoint = (catalog: Mutable) =>
    (catalog.merchants[0]?.endpoints as Record<string, unknown>[])[0] as Record<string, unknown>;
  const withParam = (spec: unknown) =>
    edited((c) => {
      (firstEndpoint(c).params as Record<string, unknown>).extra = spec;
    });
  const withMerchant = (patch: Record<string, unknown>) =>
    edited((c) => {
      c.merchants[0] = patched(c.merchants[0], patch) as Record<string, unknown>;
    });
  const withEndpoint = (patch: Record<string, unknown>) =>
    edited((c) => {
      const endpoints = c.merchants[0]?.endpoints as Record<string, unknown>[];
      endpoints[0] = patched(endpoints[0], patch) as Record<string, unknown>;
    });
  const withGrant = (patch: Record<string, unknown>) =>
    edited((c) => {
      c.standing_grants[0] = patched(c.standing_grants[0], patch) as Record<string, unknown>;
    });

  it('returns the section 3 example unchanged', () => {
    expect(CatalogSchema.parse(example)).toEqual(example);
  });

  describe('param specs', () => {
    expectCases(CatalogSchema, {
      accept: [
        ['an int option', withParam({ in: 'query', kind: 'option', type: 'int', min: 1, max: 10 })],
        [
          'an int option with min equal to max',
          withParam({ in: 'query', kind: 'option', type: 'int', min: 3, max: 3 }),
        ],
        ['a bool option', withParam({ in: 'query', kind: 'option', type: 'bool' })],
        ['a forbidden param', withParam({ in: 'query', kind: 'forbidden' })],
        ['a subject in the path', withParam({ in: 'path', kind: 'subject' })],
      ],
      reject: [
        ['an unknown param kind', withParam({ in: 'query', kind: 'whatever' })],
        ['a param in the body', withParam({ in: 'body', kind: 'subject' })],
        [
          'an enum option with no values',
          withParam({ in: 'query', kind: 'option', type: 'enum', values: [] }),
        ],
        [
          'an enum option with an empty value',
          withParam({ in: 'query', kind: 'option', type: 'enum', values: [''] }),
        ],
        [
          'an int option with min above max',
          withParam({ in: 'query', kind: 'option', type: 'int', min: 5, max: 1 }),
        ],
        [
          'an int option with a fractional bound',
          withParam({ in: 'query', kind: 'option', type: 'int', min: 0.5, max: 1 }),
        ],
        ['an option with no type', withParam({ in: 'query', kind: 'option' })],
        [
          'a bool option with values',
          withParam({ in: 'query', kind: 'option', type: 'bool', values: ['x'] }),
        ],
        [
          'a subject with a type',
          withParam({ in: 'query', kind: 'subject', type: 'enum', values: ['a'] }),
        ],
      ],
    });
  });

  describe('merchants', () => {
    expectCases(CatalogSchema, {
      accept: [
        ['a localhost origin with a port', withMerchant({ origin: 'http://localhost:4101' })],
        ['a merchant with no endpoints', withMerchant({ endpoints: [] })],
      ],
      reject: [
        [
          'an uppercase payee',
          withMerchant({ payee: '0xABCDEF1111111111111111111111111111111111' }),
        ],
        ['a short payee', withMerchant({ payee: '0x1234' })],
        ['an origin with a path', withMerchant({ origin: 'https://pricing.example.test/v1' })],
        [
          'an origin with a trailing slash',
          withMerchant({ origin: 'https://pricing.example.test/' }),
        ],
        [
          'an origin spelling out the default port',
          withMerchant({ origin: 'https://pricing.example.test:443' }),
        ],
        [
          'an origin with an uppercase host',
          withMerchant({ origin: 'https://Pricing.example.test' }),
        ],
        ['an origin without a scheme', withMerchant({ origin: 'pricing.example.test' })],
        ['an ftp origin', withMerchant({ origin: 'ftp://pricing.example.test' })],
        ['an id without the mer_ prefix', withMerchant({ id: 'pricing' })],
        ['an id with a hyphen', withMerchant({ id: 'mer_price-scope' })],
        ['an id that is only the prefix', withMerchant({ id: 'mer_' })],
        ['an empty name', withMerchant({ name: '' })],
        ['a field the contract does not define', withMerchant({ website: 'https://x.test' })],
      ],
    });
  });

  describe('endpoints', () => {
    expectCases(CatalogSchema, {
      reject: [
        ['a path without a leading slash', withEndpoint({ path: 'v1/pricing' })],
        ['an unsupported method', withEndpoint({ method: 'PUT' })],
        ['an id without the end_ prefix', withEndpoint({ id: 'pricing_get' })],
        ['an empty param name', withEndpoint({ params: { '': { in: 'query', kind: 'subject' } } })],
        ['an empty description', withEndpoint({ description: '' })],
      ],
    });
  });

  describe('standing grants', () => {
    expectCases(CatalogSchema, {
      accept: [
        [
          'a catalog with no merchants or grants',
          { version: 1, merchants: [], standing_grants: [] },
        ],
      ],
      reject: [
        ['another catalog version', { ...example, version: 2 }],
        ['a fractional limit', withGrant({ max_per_call: 0.5 })],
        ['a zero daily total', withGrant({ daily_total: 0 })],
        ['an empty role', withGrant({ role: '' })],
        ['an endpoint id without the end_ prefix', withGrant({ endpoint_id: 'weather_forecast' })],
      ],
    });
  });
});

describe('PayResponseSchema', () => {
  const approved = {
    status: 'approved',
    decision_id: 'dec_1',
    payment_id: 'pay_1',
    stage: 'tier1',
    amount: 10_000,
    payee: PAYEE,
    response: { status_code: 200, content_type: 'application/json', body: '{}' },
  };
  const denied = {
    status: 'denied',
    decision_id: 'dec_2',
    stage: 'precontact',
    reasons: ['SUBJECT_NOT_IN_MANDATE'],
    explanation: null,
  };
  const pending = { status: 'pending', decision_id: 'dec_3', poll_after_ms: 2_000 };
  const unknown = {
    status: 'payment_unknown',
    decision_id: 'dec_4',
    payment_id: 'pay_4',
    poll_after_ms: 5_000,
  };

  expectCases(PayResponseSchema, {
    accept: [
      ['an approval', approved],
      ['a denial', denied],
      ['a denial with an explanation', patched(denied, { explanation: 'Off task.' })],
      ['a pending decision', pending],
      ['an unknown payment', unknown],
    ],
    reject: [
      ['an unknown status', { status: 'maybe', decision_id: 'dec_1' }],
      ...over(approved, [
        ['an approval with an invalid payee', { payee: '0xabc' }],
        ['an approval without the merchant response', { response: undefined }],
        ['an approval with an extra field', { reasons: [] }],
      ]),
      ...over(denied, [
        ['a denial with an invented reason code', { reasons: ['NOPE'] }],
        ['a denial at an unknown stage', { stage: 'tier2' }],
        ['a denial with a numeric explanation', { explanation: 3 }],
      ]),
      ['a pending decision without a poll hint', patched(pending, { poll_after_ms: undefined })],
    ],
  });
});

describe('StreamEventSchema', () => {
  const decision = {
    type: 'decision',
    decision_id: 'dec_1',
    mandate_id: 'mnd_1',
    stage: 'judge',
    outcome: 'denied',
    reasons: ['JUDGE_OFF_TASK'],
    price: 400_000,
    latency_ms: 1_800,
    at: 1_761_280_000_000,
  };
  const payment = { type: 'payment', payment_id: 'pay_1', state: 'SETTLED', amount: 10_000, at: 1 };
  const trust = {
    type: 'trust',
    session_id: 'ses_1',
    agent_id: 'agt_1',
    session_trust: 55,
    agent_trust: 67.4,
    cause: 'JUDGE_OFF_TASK',
    at: 1,
  };
  const approval = {
    type: 'approval_needed',
    decision_id: 'dec_2',
    mandate_id: 'mnd_1',
    explanation: null,
    at: 1,
  };

  expectCases(StreamEventSchema, {
    accept: [
      ['a decision', decision],
      ['a decision with no price (denied before the quote)', patched(decision, { price: null })],
      ['a payment', payment],
      ['a trust change with fractional scores', trust],
      ['an approval request', approval],
    ],
    reject: [
      ['an unknown event type', { type: 'other', at: 1 }],
      ['an event without a type', patched(payment, { type: undefined })],
      ['an unknown payment state', patched(payment, { state: 'DONE' })],
      ['a payment event with an extra field', patched(payment, { tx_hash: '0x1' })],
      ['a negative latency', patched(decision, { latency_ms: -1 })],
      ['a fractional timestamp', patched(decision, { at: 1.5 })],
      ['an unknown outcome', patched(decision, { outcome: 'maybe' })],
      ['an invented reason code', patched(decision, { reasons: ['NOPE'] })],
    ],
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
  const list = (n: number, make: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => make(i));

  it('returns a typical mandate unchanged', () => {
    expect(CreateMandateRequestSchema.parse(body)).toEqual(body);
  });

  expectCases(CreateMandateRequestSchema, {
    accept: over(body, [
      ['no subjects', { subjects: [] }],
      ['no merchants', { allowed_merchant_ids: [] }],
      ['the most subjects allowed', { subjects: list(INPUT_LIMITS.subjectsMax, (i) => `s${i}`) }],
      ['a subject at the length limit', { subjects: ['s'.repeat(INPUT_LIMITS.subjectMaxChars)] }],
      ['a task at the length limit', { task: 't'.repeat(INPUT_LIMITS.taskMaxChars) }],
    ]),
    reject: [
      ...NOT_OBJECTS,
      ...over(body, [
        ['a zero budget', { budget: 0 }],
        ['a negative budget', { budget: -1 }],
        ['a fractional budget', { budget: 1.5 }],
        ['a non-positive expiry', { expires_in_ms: 0 }],
        ['a fractional expiry', { expires_in_ms: 1.5 }],
        ['an empty task', { task: '' }],
        ['a blank task', { task: ' \n\t' }],
        ['a task over the length limit', { task: 't'.repeat(INPUT_LIMITS.taskMaxChars + 1) }],
        ['a blank subject', { subjects: ['   '] }],
        [
          'a subject over the length limit',
          { subjects: ['s'.repeat(INPUT_LIMITS.subjectMaxChars + 1)] },
        ],
        ['too many subjects', { subjects: list(INPUT_LIMITS.subjectsMax + 1, (i) => `s${i}`) }],
        [
          'too many merchants',
          { allowed_merchant_ids: list(INPUT_LIMITS.merchantsMax + 1, (i) => `mer_${i}`) },
        ],
        ['a merchant id without the mer_ prefix', { allowed_merchant_ids: ['pricing'] }],
        ['an agent id without the agt_ prefix', { agent_id: 'research' }],
        ['a missing agent id', { agent_id: undefined }],
        ['a field the contract does not define', { token: 'abc' }],
      ]),
    ],
  });
});

describe('ApprovalRequestSchema', () => {
  const body = { outcome: 'approved', note: 'Needed for the Q4 review.', issue_grant: true };

  expectCases(ApprovalRequestSchema, {
    accept: over(body, [
      ['an approval', {}],
      ['a rejection', { outcome: 'rejected', issue_grant: false }],
      ['a note at the length limit', { note: 'n'.repeat(INPUT_LIMITS.noteMaxChars) }],
    ]),
    reject: over(body, [
      ['an empty note (a reason is required)', { note: '' }],
      ['a blank note', { note: '   ' }],
      ['a note over the length limit', { note: 'n'.repeat(INPUT_LIMITS.noteMaxChars + 1) }],
      ['a timeout outcome (only the gateway times out)', { outcome: 'timeout' }],
      ['a missing issue_grant', { issue_grant: undefined }],
      ['issue_grant written as text', { issue_grant: 'yes' }],
      ['a field the contract does not define', { reviewer: 'someone' }],
    ]),
  });
});

describe('AddressSchema', () => {
  expectCases(AddressSchema, {
    accept: [
      ['a lowercase address', PAYEE],
      ['lowercase hex letters', '0xabcdef0000000000000000000000000000000000'],
    ],
    reject: [
      ['uppercase hex letters', '0xABCDEF0000000000000000000000000000000000'],
      ['a 0X prefix', PAYEE.replace('0x', '0X')],
      ['39 hex digits', PAYEE.slice(0, -1)],
      ['41 hex digits', `${PAYEE}1`],
      ['a non-hex digit', `${PAYEE.slice(0, -1)}g`],
      ['a number', 123],
      ['null', null],
    ],
  });
});

describe('ReasonCodeSchema', () => {
  expectCases(ReasonCodeSchema, {
    accept: REASON_CODES.map((code): Case => [code, code]),
    reject: [
      ['a lowercase code', 'grant_hit'],
      ['an empty string', ''],
    ],
  });
});
