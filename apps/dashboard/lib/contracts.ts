// Copied from contracts.md section 5 (contracts v1).
// TEMPORARY: replace with an import from packages/contracts once Chunk 2 publishes it.

export type Money = number; // atomic USDC units, integer
export type EpochMs = number;

export type Stage = 'precontact' | 'tier0' | 'tier1' | 'judge' | 'human';
export type PaymentState = 'RESERVED' | 'SIGNED' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'UNKNOWN';

export type PrecontactCode =
  | 'NO_MANDATE'
  | 'QUARANTINED'
  | 'DENYLIST'
  | 'SECRET_IN_URL'
  | 'QUERY_TOO_LONG'
  | 'PARAM_NOT_IN_SCHEMA'
  | 'SUBJECT_NOT_IN_MANDATE'
  | 'UNKNOWN_WITH_PARAMS'
  | 'DUPLICATE_PARAM'
  | 'BAD_URL';
export type QuoteCode = 'QUOTE_FAILED' | 'NOT_402' | 'QUOTE_INVALID';
export type Tier0Code =
  | 'NETWORK'
  | 'PAYEE_SWAP'
  | 'PER_CALL_CAP'
  | 'REFERENCE_PRICE'
  | 'PRICE_MISMATCH'
  | 'MANDATE_BUDGET'
  | 'TENANT_DAILY'
  | 'VELOCITY'
  | 'DUPLICATE'
  | 'NEW_PAYEE_LIMIT';
export type Tier1Code =
  | 'GRANT_HIT'
  | 'GRANT_NONE'
  | 'GRANT_PRICE'
  | 'GRANT_ENDPOINT'
  | 'GRANT_METHOD'
  | 'GRANT_PARAMS'
  | 'GRANT_TRUST'
  | 'GRANT_EXHAUSTED'
  | 'MERCHANT_NOT_SELECTED';
export type JudgeCode =
  | 'JUDGE_APPROVED'
  | 'JUDGE_OFF_TASK'
  | 'JUDGE_OVER_SCOPED'
  | 'JUDGE_UNKNOWN_MERCHANT'
  | 'JUDGE_PRICE_UNUSUAL'
  | 'JUDGE_UNEXPECTED_PARAMS'
  | 'JUDGE_INJECTION_SUSPECTED'
  | 'JUDGE_ERROR'
  | 'JUDGE_INVALID_OUTPUT';
export type HumanCode = 'HUMAN_APPROVED' | 'HUMAN_REJECTED' | 'HUMAN_TIMEOUT';
export type ReasonCode =
  | PrecontactCode
  | QuoteCode
  | Tier0Code
  | Tier1Code
  | JudgeCode
  | HumanCode
  | 'TRUST_REQUIRES_HUMAN';

export type StreamEvent =
  | {
      type: 'decision';
      decision_id: string;
      mandate_id: string;
      stage: Stage;
      outcome: 'approved' | 'denied' | 'pending';
      reasons: ReasonCode[];
      price: Money | null;
      latency_ms: number;
      at: EpochMs;
    }
  | { type: 'payment'; payment_id: string; state: PaymentState; amount: Money; at: EpochMs }
  | {
      type: 'trust';
      session_id: string;
      agent_id: string;
      session_trust: number;
      agent_trust: number;
      cause: string;
      at: EpochMs;
    }
  | {
      type: 'approval_needed';
      decision_id: string;
      mandate_id: string;
      explanation: string | null;
      at: EpochMs;
    };
