// zod schemas for every body that crosses a boundary. Objects are strict: an unknown field
// is malformed, so no free text can ride along in a field the contract doesn't define.
// test/types.test.ts checks that each schema infers exactly its contract type.
import { z } from 'zod';
import { INPUT_LIMITS, JUDGE_EXPLANATION_MAX_CHARS } from './constants.js';
import { HTTP_METHODS, PAYMENT_STATES, PURPOSE_CODES, STAGES } from './enums.js';
import { JUDGE_CODES, REASON_CODES } from './reasons.js';
import type { Address } from './types.js';

// ---------- Building blocks ----------

const Money = z.number().int().nonnegative();
const PositiveMoney = z.number().int().positive();
const EpochMs = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();
const DurationMs = z.number().int().positive();

/** Non-empty and not just whitespace. */
const Text = (max: number) => z.string().max(max).regex(/\S/, 'Must not be blank');

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
export const AddressSchema = z.custom<Address>(
  (value) => typeof value === 'string' && ADDRESS_PATTERN.test(value),
  'Expected a lowercase 0x address with 40 hex digits',
);

const prefixedId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,64}$`), `Expected an id like ${prefix}_...`);

function isCanonicalOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}
const OriginSchema = z
  .string()
  .refine(isCanonicalOrigin, 'Expected a canonical origin like https://host[:port]');

export const HttpMethodSchema = z.enum(HTTP_METHODS);
export const PurposeCodeSchema = z.enum(PURPOSE_CODES);
export const StageSchema = z.enum(STAGES);
export const PaymentStateSchema = z.enum(PAYMENT_STATES);
export const ReasonCodeSchema = z.enum(REASON_CODES);
export const JudgeCodeSchema = z.enum(JUDGE_CODES);

// ---------- /pay (section 2) ----------

export const PayRequestSchema = z.strictObject({
  url: z.string().min(1).max(INPUT_LIMITS.urlMaxChars),
  method: HttpMethodSchema,
  expected_price: Money,
  purpose: PurposeCodeSchema,
  // Printable ASCII without spaces, so keys are safe to store, log and compare.
  idempotency_key: z
    .string()
    .regex(/^[\x21-\x7e]+$/, 'Printable ASCII without spaces')
    .min(1)
    .max(INPUT_LIMITS.idempotencyKeyMaxChars),
});

const MerchantResponseSchema = z.strictObject({
  status_code: z.number().int(),
  content_type: z.string(),
  body: z.string(),
});

export const PayResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('approved'),
    decision_id: z.string(),
    payment_id: z.string(),
    stage: StageSchema,
    amount: Money,
    payee: AddressSchema,
    response: MerchantResponseSchema,
  }),
  z.strictObject({
    status: z.literal('denied'),
    decision_id: z.string(),
    stage: StageSchema,
    reasons: z.array(ReasonCodeSchema),
    explanation: z.string().nullable(),
  }),
  z.strictObject({
    status: z.literal('pending'),
    decision_id: z.string(),
    poll_after_ms: Count,
  }),
  z.strictObject({
    status: z.literal('payment_unknown'),
    decision_id: z.string(),
    payment_id: z.string(),
    poll_after_ms: Count,
  }),
]);

// ---------- Admin bodies (section 2) ----------

export const CreateMandateRequestSchema = z.strictObject({
  agent_id: prefixedId('agt'),
  task: Text(INPUT_LIMITS.taskMaxChars),
  subjects: z.array(Text(INPUT_LIMITS.subjectMaxChars)).max(INPUT_LIMITS.subjectsMax),
  allowed_merchant_ids: z.array(prefixedId('mer')).max(INPUT_LIMITS.merchantsMax),
  budget: PositiveMoney,
  expires_in_ms: DurationMs,
});

export const ApprovalRequestSchema = z.strictObject({
  outcome: z.enum(['approved', 'rejected']),
  // Design.md: approving or rejecting requires a one-line reason.
  note: Text(INPUT_LIMITS.noteMaxChars),
  issue_grant: z.boolean(),
});

// ---------- Catalog (section 3) ----------

const ParamIn = z.enum(['path', 'query']);

export const ParamSpecSchema = z.union([
  z.strictObject({ in: ParamIn, kind: z.literal('subject') }),
  z.strictObject({
    in: ParamIn,
    kind: z.literal('option'),
    type: z.literal('enum'),
    values: z.array(z.string().min(1)).min(1),
  }),
  z
    .strictObject({
      in: ParamIn,
      kind: z.literal('option'),
      type: z.literal('int'),
      min: z.number().int(),
      max: z.number().int(),
    })
    .refine((spec) => spec.min <= spec.max, 'min must not exceed max'),
  z.strictObject({ in: ParamIn, kind: z.literal('option'), type: z.literal('bool') }),
  z.strictObject({ in: ParamIn, kind: z.literal('forbidden') }),
]);

export const CatalogEndpointSchema = z.strictObject({
  id: prefixedId('end'),
  method: HttpMethodSchema,
  path: z.string().startsWith('/'),
  category: z.string().min(1),
  description: z.string().min(1),
  params: z.record(z.string().min(1), ParamSpecSchema),
});

export const CatalogMerchantSchema = z.strictObject({
  id: prefixedId('mer'),
  name: z.string().min(1),
  origin: OriginSchema,
  payee: AddressSchema,
  category: z.string().min(1),
  description: z.string().min(1),
  endpoints: z.array(CatalogEndpointSchema),
});

/**
 * The shape of catalog/catalog.json. Cross-entry rules (duplicate ids, overlapping endpoints)
 * belong to Chunk 3's loadCatalog.
 */
export const CatalogSchema = z.strictObject({
  version: z.literal(1),
  merchants: z.array(CatalogMerchantSchema),
  standing_grants: z.array(
    z.strictObject({
      role: z.string().min(1),
      endpoint_id: prefixedId('end'),
      max_per_call: PositiveMoney,
      daily_total: PositiveMoney,
    }),
  ),
});

// ---------- Judge output (section 4) ----------

export const JudgeOutputSchema = z
  .strictObject({
    decision: z.enum(['approve', 'deny', 'escalate']),
    reasons: z.array(JudgeCodeSchema).min(1),
    explanation: z.string().max(JUDGE_EXPLANATION_MAX_CHARS),
    injection_suspected: z.boolean(),
    grant: z
      .strictObject({
        max_per_call: PositiveMoney,
        max_total: PositiveMoney,
        ttl_ms: DurationMs,
      })
      .optional(),
  })
  .refine((output) => output.grant === undefined || output.decision === 'approve', {
    message: 'A grant is only allowed when the decision is approve',
    path: ['grant'],
  });

// ---------- Dashboard stream (section 5) ----------

export const StreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('decision'),
    decision_id: z.string(),
    mandate_id: z.string(),
    stage: StageSchema,
    outcome: z.enum(['approved', 'denied', 'pending']),
    reasons: z.array(ReasonCodeSchema),
    price: Money.nullable(),
    latency_ms: Count,
    at: EpochMs,
  }),
  z.strictObject({
    type: z.literal('payment'),
    payment_id: z.string(),
    state: PaymentStateSchema,
    amount: Money,
    at: EpochMs,
  }),
  z.strictObject({
    type: z.literal('trust'),
    session_id: z.string(),
    agent_id: z.string(),
    session_trust: z.number(),
    agent_trust: z.number(),
    cause: z.string(),
    at: EpochMs,
  }),
  z.strictObject({
    type: z.literal('approval_needed'),
    decision_id: z.string(),
    mandate_id: z.string(),
    explanation: z.string().nullable(),
    at: EpochMs,
  }),
]);
