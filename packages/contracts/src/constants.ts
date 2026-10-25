// Numbers from final_contracts.md and the Design.md tables. Values marked tunable in the
// design doc start here; change them here so every chunk sees the same value.
import type { Money } from './types.js';

/** Base Sepolia (CAIP-2). A quote on any other network is denied `NETWORK`. */
export const NETWORK = 'eip155:84532';

/** One USDC in atomic units (6 decimals). All money is integer atomic units. */
export const ONE_USDC: Money = 1_000_000;

/** ID prefixes (section 0). Every ID is its prefix followed by a ULID. */
export const ID_PREFIX = {
  tenant: 'tnt_',
  role: 'rol_',
  agent: 'agt_',
  mandate: 'mnd_',
  session: 'ses_',
  decision: 'dec_',
  payment: 'pay_',
  grant: 'grt_',
  merchant: 'mer_',
  endpoint: 'end_',
  approval: 'apr_',
  trustEvent: 'tev_',
} as const;

/** Session-trust routing at pipeline step 7 (Design.md "Trust scoring"). */
export const TRUST_THRESHOLDS = {
  /** Below this the session is quarantined: every payment is denied `QUARANTINED`. */
  quarantine: 20,
  /** Below this (and not quarantined) every payment goes to a human (`TRUST_REQUIRES_HUMAN`). */
  human: 40,
  /** At or above this, grants are usable. Between `human` and this, Tier 1 is skipped.
   * Seeds `roles.grant_trust_threshold`, which is what the pipeline reads. */
  grants: 60,
} as const;

/**
 * Automatic trust changes are nonpositive. Only audited operator restoration can reset
 * scores to the role baseline. Zero approval entries preserve caller compatibility.
 */
export const TRUST_DELTAS = {
  /** Approvals never earn trust back. */
  approved: { session: 0, agent: 0 },
  tier0Denial: { session: -5, agent: -1 },
  judgeOffTask: { session: -15, agent: -3 },
  /** Also quarantines the session immediately. */
  judgeInjection: { session: -30, agent: -5 },
  humanRejected: { session: -20, agent: -5 },
  humanApproved: { session: 0, agent: 0 },
} as const;

/** Pre-contact checks (CHUNK-2-GATEWAY.md G5). */
export const PRECONTACT_LIMITS = {
  /** `QUERY_TOO_LONG`: a raw query string longer than this. */
  queryMaxChars: 256,
  /** `UNKNOWN_WITH_PARAMS`: an unknown endpoint with a path segment longer than this. */
  unknownSegmentMaxChars: 24,
  /** `SECRET_IN_URL`: a hex run at least this long. */
  secretHexMinChars: 32,
  /** `SECRET_IN_URL`: a base64- or base32-looking token at least this long ... */
  secretTokenMinChars: 24,
  /** ... whose Shannon entropy is above this many bits per character. */
  secretEntropyBitsPerChar: 3.5,
} as const;

/** Tier 0 rules (CHUNK-2-GATEWAY.md G6). Role limits such as velocity live in the roles table. */
export const TIER0_LIMITS = {
  /** `REFERENCE_PRICE`: escalate a price above this multiple of the reference price. */
  referencePriceMultiple: 2,
  /** `PRICE_MISMATCH`: deny a quote further than this fraction from `expected_price`. */
  priceMismatchFraction: 0.1,
  /** `VELOCITY`: the sliding window for the role's per-minute limit. */
  velocityWindowMs: 60_000,
  /** `DUPLICATE`: this many calls with the same canonical URL and price ... */
  duplicateCount: 3,
  /** ... within this window. */
  duplicateWindowMs: 10_000,
  /** `NEW_PAYEE_LIMIT`: escalate past this many judge-approved first-time payees in a mandate. */
  newPayeeLimit: 3,
} as const;

/** Clamps on a grant the judge or a human proposes (section 4). The gateway applies them. */
export const GRANT_CLAMP = {
  /** `max_per_call` is at most this multiple of the reference price ... */
  referencePriceMultiple: 2,
  /** ... and at most this multiple of the approved payment's price. */
  paymentPriceMultiple: 2,
} as const;

export const TIMING = {
  /** An escalation with no human answer is rejected `HUMAN_TIMEOUT` after this long. */
  humanTimeoutMs: 10 * 60_000,
  /** A judge call slower than this is `JUDGE_ERROR`. */
  judgeTimeoutMs: 5_000,
  /** `/stream` heartbeat interval. */
  streamHeartbeatMs: 15_000,
  /** `poll_after_ms` on a `pending` response. */
  pendingPollAfterMs: 2_000,
  /** `poll_after_ms` on a `payment_unknown` response. */
  paymentUnknownPollAfterMs: 5_000,
} as const;

/** Longest judge explanation the contract allows (section 4). */
export const JUDGE_EXPLANATION_MAX_CHARS = 200;

/**
 * Size limits on request bodies. These are input-safety bounds chosen for this package,
 * not contract rules: a body over them is malformed (HTTP 400).
 */
export const INPUT_LIMITS = {
  urlMaxChars: 8_192,
  idempotencyKeyMaxChars: 128,
  taskMaxChars: 2_000,
  subjectMaxChars: 100,
  subjectsMax: 50,
  merchantsMax: 50,
  noteMaxChars: 500,
} as const;
