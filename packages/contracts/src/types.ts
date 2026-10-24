// final_contracts.md section 5, copied exactly. Change it only through section 6 of that
// document, and bump CONTRACTS_VERSION with it.

export type Money = number;          // atomic USDC units, integer
export type EpochMs = number;
export type Address = `0x${string}`; // lowercase

export type PurposeCode = 'fetch_data' | 'fetch_report' | 'verify_access' | 'subscribe' | 'other';
export type HttpMethod = 'GET' | 'POST';
export type Stage = 'precontact' | 'tier0' | 'tier1' | 'judge' | 'human';
export type PaymentState = 'RESERVED' | 'SIGNED' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'UNKNOWN';

export type PrecontactCode = 'NO_MANDATE' | 'QUARANTINED' | 'DENYLIST' | 'SECRET_IN_URL' | 'QUERY_TOO_LONG'
  | 'PARAM_NOT_IN_SCHEMA' | 'SUBJECT_NOT_IN_MANDATE' | 'UNKNOWN_WITH_PARAMS' | 'DUPLICATE_PARAM' | 'BAD_URL' | 'UNCATALOGED_ENDPOINT' | 'MERCHANT_NOT_SELECTED';
export type QuoteCode = 'QUOTE_FAILED' | 'NOT_402' | 'QUOTE_INVALID';
export type Tier0Code = 'NETWORK' | 'PAYEE_SWAP' | 'PER_CALL_CAP' | 'REFERENCE_PRICE' | 'PRICE_MISMATCH'
  | 'MANDATE_BUDGET' | 'TENANT_DAILY' | 'VELOCITY' | 'DUPLICATE' | 'NEW_PAYEE_LIMIT' | 'INTERNAL_ERROR';
export type Tier1Code = 'GRANT_HIT' | 'GRANT_NONE' | 'GRANT_PRICE' | 'GRANT_ENDPOINT' | 'GRANT_METHOD'
  | 'GRANT_PARAMS' | 'GRANT_TRUST' | 'GRANT_EXHAUSTED';
export type JudgeCode = 'JUDGE_APPROVED' | 'JUDGE_OFF_TASK' | 'JUDGE_OVER_SCOPED' | 'JUDGE_UNKNOWN_MERCHANT'
  | 'JUDGE_PRICE_UNUSUAL' | 'JUDGE_UNEXPECTED_PARAMS' | 'JUDGE_INJECTION_SUSPECTED' | 'JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT';
export type HumanCode = 'HUMAN_APPROVED' | 'HUMAN_REJECTED' | 'HUMAN_TIMEOUT';
export type ReasonCode = PrecontactCode | QuoteCode | Tier0Code | Tier1Code | JudgeCode | HumanCode | 'TRUST_REQUIRES_HUMAN';

// ---------- /pay ----------
export interface PayRequest {
  url: string;
  method: HttpMethod;
  expected_price: Money;
  purpose: PurposeCode;
  idempotency_key: string;
}

export type PayResponse =
  | { status: 'approved'; decision_id: string; payment_id: string; stage: Stage; amount: Money; payee: Address;
      response: { status_code: number; content_type: string; body: string } | null }
  | { status: 'denied'; decision_id: string; stage: Stage; reasons: ReasonCode[]; explanation: string | null }
  | { status: 'pending'; decision_id: string; poll_after_ms: number }
  | { status: 'payment_unknown'; decision_id: string; payment_id: string; poll_after_ms: number };

// ---------- Catalog ----------
export type ParamSpec =
  | { in: 'path' | 'query'; kind: 'subject' }
  | { in: 'path' | 'query'; kind: 'option'; type: 'enum'; values: string[] }
  | { in: 'path' | 'query'; kind: 'option'; type: 'int'; min: number; max: number }
  | { in: 'path' | 'query'; kind: 'option'; type: 'bool' }
  | { in: 'path' | 'query'; kind: 'forbidden' };

export interface CatalogEndpoint {
  id: string; method: HttpMethod; path: string;
  category: string; description: string;
  params: Record<string, ParamSpec>;
}
export interface CatalogMerchant {
  id: string; name: string; origin: string; payee: Address;
  category: string; description: string;
  endpoints: CatalogEndpoint[];
}
export interface Catalog {
  version: 1;
  merchants: CatalogMerchant[];
  standing_grants: { role: string; endpoint_id: string; max_per_call: Money; daily_total: Money }[];
}

// ---------- Payments module (owner A) ----------
export interface Quote {
  url: string;               // canonical
  method: HttpMethod;
  network: string;           // must be 'eip155:84532'
  payee: Address;
  amount: Money;
  raw: unknown;              // x402 payment requirements, passed back to pay() unchanged
}
export interface PaymentsModule {
  getQuote(canonicalUrl: string, method: HttpMethod): Promise<Quote>;          // throws QuoteError(code: QuoteCode)
  pay(paymentId: string, quote: Quote): Promise<                               // signs exactly quote.amount
    | { state: 'SETTLED'; txHash: string; response: { status_code: number; content_type: string; body: string } }
    | { state: 'FAILED'; reason: string }
    | { state: 'UNKNOWN' }>;
  reconcile(paymentId: string): Promise<'SETTLED' | 'FAILED' | 'UNKNOWN'>;
}

// Implemented by the gateway (owner B) over the payments table; used by the payments module (owner A).
// Every method is a conditional update on the current state and returns false if it changed nothing.
// pay() never calls fail(): a merchant's rejection proves nothing while a signed authorization is still valid.
export interface PaymentStore {
  get(paymentId: string): Promise<{ id: string; mandate_id: string; amount: Money; payee: Address; state: PaymentState;
    nonce: string | null; valid_before: EpochMs | null; authorization_json: string | null } | null>;
  markSigned(paymentId: string, f: { nonce: string; validBefore: EpochMs; authorizationJson: string }): Promise<boolean>; // RESERVED -> SIGNED
  markSubmitted(paymentId: string): Promise<boolean>;                    // SIGNED -> SUBMITTED (before sending)
  markUnknown(paymentId: string): Promise<boolean>;                      // SUBMITTED -> UNKNOWN
  settle(paymentId: string, txHash: string): Promise<boolean>;           // SIGNED|SUBMITTED|UNKNOWN -> SETTLED, moves reserved to spent
  fail(paymentId: string): Promise<boolean>;                             // RESERVED|SIGNED|SUBMITTED|UNKNOWN -> FAILED, releases reserved
  listUnresolved(): Promise<string[]>;                                   // ids in SIGNED, SUBMITTED, UNKNOWN
  // The merchant's 2xx reply, saved when it arrives so a settlement proven later can't lose the purchased data.
  saveResponse(paymentId: string, response: { status_code: number; content_type: string; body: string }): Promise<boolean>; // SUBMITTED|UNKNOWN|SETTLED, first save only
}

// ---------- Catalog matching (owner C) ----------
export type EndpointMatch =
  | { kind: 'known'; merchant: CatalogMerchant; endpoint: CatalogEndpoint;
      params: { name: string; kind: 'subject' | 'option' | 'forbidden' | 'undeclared'; value: string;
                violation: null | 'PARAM_NOT_IN_SCHEMA' }[] }
  | { kind: 'unknown'; origin: string; hasParams: boolean;
      urlShape: { path_segments: number[]; query_params: { type: 'string' | 'int' | 'other'; length: number }[] } };

// ---------- Judge module (owner C) ----------
export interface JudgeParam {
  name: string;
  kind: 'subject' | 'option';
  value?: string;            // only when the builder rules allow it
}
export interface JudgeInput {
  mandate: { task: string; subjects: string[]; budget_remaining: Money; expires_in_ms: number };
  role_policy: string;
  payment: {
    price: Money;
    purpose: PurposeCode;
    merchant: { known: true; name: string; category: string; description: string; selected_for_mandate: boolean }
            | { known: false; selected_for_mandate: false };
    endpoint: { known: true; method: HttpMethod; category: string; description: string }
            | { known: false; method: HttpMethod };
    payee: { first_seen: boolean; prior_calls: number; recent_prices: Money[] };
    params: JudgeParam[];
    url_shape: { path_segments: number[]; query_params: { type: 'string' | 'int' | 'other'; length: number }[] } | null;
  };
}
export interface JudgeOutput {
  decision: 'approve' | 'deny' | 'escalate';
  reasons: JudgeCode[];
  explanation: string;
  injection_suspected: boolean;
  grant?: { max_per_call: Money; max_total: Money; ttl_ms: number };
}
// Built by the gateway (owner B), projected only by buildInput (owner C). Raw match parameter values remain untrusted.
export interface JudgeContext {
  mandate: { task: string; subjects: string[]; allowed_merchant_ids: string[]; budget_remaining: Money; expires_in_ms: number };
  role_policy: string;
  price: Money;
  purpose: PurposeCode;
  method: HttpMethod;
  match: EndpointMatch;
  payee_facts: { first_seen: boolean; prior_calls: number; recent_prices: Money[] };
}
export interface JudgeModule {
  buildInput(ctx: JudgeContext): JudgeInput;
  judge(input: JudgeInput): Promise<JudgeOutput>;   // shape-validated; throws JudgeError('JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT'). Clamping is the gateway's job.
}

// ---------- Dashboard stream ----------
export type StreamEvent =
  | { type: 'decision'; decision_id: string; mandate_id: string; stage: Stage; outcome: 'approved' | 'denied' | 'pending';
      reasons: ReasonCode[]; price: Money | null; latency_ms: number; at: EpochMs }
  | { type: 'payment'; payment_id: string; state: PaymentState; amount: Money; at: EpochMs }
  | { type: 'trust'; session_id: string; agent_id: string; session_trust: number; agent_trust: number; cause: string; at: EpochMs }
  | { type: 'approval_needed'; decision_id: string; mandate_id: string; explanation: string | null; at: EpochMs };
