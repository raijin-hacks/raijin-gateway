// Reason codes from the final_contracts.md section 2 table: which row each code belongs to,
// and what the pipeline does when it fires. test/reasons.test.ts checks both against the doc.
import type {
  HumanCode,
  JudgeCode,
  PrecontactCode,
  QuoteCode,
  ReasonCode,
  Tier0Code,
  Tier1Code,
} from './types.js';

export const PRECONTACT_CODES = [
  'AGENT_SUSPENDED',
  'NO_MANDATE',
  'QUARANTINED',
  'DENYLIST',
  'SECRET_IN_URL',
  'QUERY_TOO_LONG',
  'PARAM_NOT_IN_SCHEMA',
  'SUBJECT_NOT_IN_MANDATE',
  'UNKNOWN_WITH_PARAMS',
  'DUPLICATE_PARAM',
  'BAD_URL',
  'UNCATALOGED_ENDPOINT',
  'MERCHANT_NOT_SELECTED',
] as const satisfies readonly PrecontactCode[];

export const QUOTE_CODES = [
  'QUOTE_FAILED',
  'NOT_402',
  'QUOTE_INVALID',
] as const satisfies readonly QuoteCode[];

export const TIER0_CODES = [
  'NETWORK',
  'PAYEE_SWAP',
  'PER_CALL_CAP',
  'REFERENCE_PRICE',
  'PRICE_MISMATCH',
  'MANDATE_BUDGET',
  'TENANT_DAILY',
  'VELOCITY',
  'DUPLICATE',
  'NEW_PAYEE_LIMIT',
  'INTERNAL_ERROR',
] as const satisfies readonly Tier0Code[];

export const TIER1_CODES = [
  'GRANT_HIT',
  'GRANT_NONE',
  'GRANT_PRICE',
  'GRANT_ENDPOINT',
  'GRANT_METHOD',
  'GRANT_PARAMS',
  'GRANT_TRUST',
  'GRANT_EXHAUSTED',
] as const satisfies readonly Tier1Code[];

export const JUDGE_CODES = [
  'JUDGE_APPROVED',
  'JUDGE_OFF_TASK',
  'JUDGE_OVER_SCOPED',
  'JUDGE_UNKNOWN_MERCHANT',
  'JUDGE_PRICE_UNUSUAL',
  'JUDGE_UNEXPECTED_PARAMS',
  'JUDGE_INJECTION_SUSPECTED',
  'JUDGE_ERROR',
  'JUDGE_INVALID_OUTPUT',
] as const satisfies readonly JudgeCode[];

export const HUMAN_CODES = [
  'HUMAN_APPROVED',
  'HUMAN_REJECTED',
  'HUMAN_TIMEOUT',
] as const satisfies readonly HumanCode[];

export const TRUST_CODES = [
  'TRUST_REQUIRES_HUMAN',
  'AGENT_REVIEW_REQUIRED',
] as const satisfies readonly ReasonCode[];

export const REASON_CODES = [
  ...PRECONTACT_CODES,
  ...QUOTE_CODES,
  ...TIER0_CODES,
  ...TIER1_CODES,
  ...JUDGE_CODES,
  ...HUMAN_CODES,
  ...TRUST_CODES,
] as const satisfies readonly ReasonCode[];

/**
 * The row of the section 2 table a code belongs to. Not the same as `Stage` (the stage a
 * decision records): quote and trust-routing codes have rows of their own.
 */
export type ReasonGroup = 'precontact' | 'quote' | 'tier0' | 'tier1' | 'judge' | 'human' | 'trust';

const GROUPS: Record<ReasonGroup, readonly ReasonCode[]> = {
  precontact: PRECONTACT_CODES,
  quote: QUOTE_CODES,
  tier0: TIER0_CODES,
  tier1: TIER1_CODES,
  judge: JUDGE_CODES,
  human: HUMAN_CODES,
  trust: TRUST_CODES,
};

export const REASON_STAGE = Object.fromEntries(
  Object.entries(GROUPS).flatMap(([group, codes]) => codes.map((code) => [code, group])),
) as Readonly<Record<ReasonCode, ReasonGroup>>;

/**
 * What the pipeline does when a code fires.
 * - `deny`, `escalate`, `approve`: the decision's outcome.
 * - `log`: recorded on the decision; the pipeline continues (a Tier 1 miss goes to the judge).
 * - `judge_decides`: the judge's `decision` field picks deny or escalate.
 */
export type ReasonAction = 'deny' | 'escalate' | 'approve' | 'log' | 'judge_decides';

export const REASON_ACTION: Readonly<Record<ReasonCode, ReasonAction>> = {
  AGENT_SUSPENDED: 'deny',
  AGENT_REVIEW_REQUIRED: 'escalate',
  NO_MANDATE: 'deny',
  QUARANTINED: 'deny',
  DENYLIST: 'deny',
  SECRET_IN_URL: 'deny',
  QUERY_TOO_LONG: 'deny',
  PARAM_NOT_IN_SCHEMA: 'escalate',
  SUBJECT_NOT_IN_MANDATE: 'escalate',
  UNKNOWN_WITH_PARAMS: 'escalate',
  DUPLICATE_PARAM: 'deny',
  BAD_URL: 'deny',
  UNCATALOGED_ENDPOINT: 'deny',
  MERCHANT_NOT_SELECTED: 'deny',

  QUOTE_FAILED: 'deny',
  NOT_402: 'deny',
  QUOTE_INVALID: 'deny',

  NETWORK: 'deny',
  PAYEE_SWAP: 'deny',
  PER_CALL_CAP: 'deny',
  REFERENCE_PRICE: 'escalate',
  PRICE_MISMATCH: 'deny',
  MANDATE_BUDGET: 'deny',
  TENANT_DAILY: 'deny',
  VELOCITY: 'deny',
  DUPLICATE: 'deny',
  NEW_PAYEE_LIMIT: 'escalate',
  INTERNAL_ERROR: 'deny',

  GRANT_HIT: 'approve',
  GRANT_NONE: 'log',
  GRANT_PRICE: 'log',
  GRANT_ENDPOINT: 'log',
  GRANT_METHOD: 'log',
  GRANT_PARAMS: 'log',
  GRANT_TRUST: 'log',
  GRANT_EXHAUSTED: 'log',

  JUDGE_APPROVED: 'approve',
  JUDGE_OFF_TASK: 'judge_decides',
  JUDGE_OVER_SCOPED: 'judge_decides',
  JUDGE_UNKNOWN_MERCHANT: 'judge_decides',
  JUDGE_PRICE_UNUSUAL: 'judge_decides',
  JUDGE_UNEXPECTED_PARAMS: 'judge_decides',
  JUDGE_INJECTION_SUSPECTED: 'judge_decides',
  JUDGE_ERROR: 'deny',
  JUDGE_INVALID_OUTPUT: 'deny',

  HUMAN_APPROVED: 'approve',
  HUMAN_REJECTED: 'deny',
  HUMAN_TIMEOUT: 'deny',

  TRUST_REQUIRES_HUMAN: 'escalate',
};
