// Every number in constants.ts is checked against the document it came from.
import { describe, expect, it } from 'vitest';
import {
  GRANT_CLAMP,
  ID_PREFIX,
  INPUT_LIMITS,
  JUDGE_EXPLANATION_MAX_CHARS,
  NETWORK,
  ONE_USDC,
  PRECONTACT_LIMITS,
  TIER0_LIMITS,
  TIMING,
  TRUST_DELTAS,
  TRUST_THRESHOLDS,
} from '../src/index.js';
import {
  CHUNK2_DOC,
  CONTRACTS_DOC,
  DESIGN_DOC,
  backticked,
  captured,
  numbersIn,
  tableRow,
} from './doc.js';

const cell = (doc: string, label: string, index: number) => tableRow(doc, label)[index] ?? '';

describe('final_contracts.md section 0', () => {
  it('ID prefixes are the listed prefixes, in order', () => {
    expect(Object.values(ID_PREFIX)).toEqual(backticked(cell(CONTRACTS_DOC, 'IDs', 1)));
  });

  it('NETWORK is the CAIP-2 id', () => {
    expect(backticked(cell(CONTRACTS_DOC, 'Network', 1))).toEqual([NETWORK]);
  });

  it('ONE_USDC is 1 USDC in atomic units', () => {
    expect(captured(CONTRACTS_DOC, /1 USDC = ([\d_]+)/)).toBe(ONE_USDC);
  });
});

describe('Design.md trust scoring', () => {
  it('thresholds match the session-score table', () => {
    expect(numbersIn(cell(DESIGN_DOC, '≥ 60', 0))).toEqual([TRUST_THRESHOLDS.grants]);
    expect(numbersIn(cell(DESIGN_DOC, '40 to 59', 0))).toEqual([
      TRUST_THRESHOLDS.human,
      TRUST_THRESHOLDS.grants - 1,
    ]);
    expect(numbersIn(cell(DESIGN_DOC, '20 to 39', 0))).toEqual([
      TRUST_THRESHOLDS.quarantine,
      TRUST_THRESHOLDS.human - 1,
    ]);
    expect(numbersIn(cell(DESIGN_DOC, '< 20', 0))).toEqual([TRUST_THRESHOLDS.quarantine]);
  });

  it.each([
    ['Approved by grant or judge', TRUST_DELTAS.approved],
    ['Tier 0 denial', TRUST_DELTAS.tier0Denial],
    ['Judge deny: off-task', TRUST_DELTAS.judgeOffTask],
    ['Judge flags injection', TRUST_DELTAS.judgeInjection],
    ['Human rejects escalation', TRUST_DELTAS.humanRejected],
    ['Human approves escalation', TRUST_DELTAS.humanApproved],
  ])('deltas for "%s" match the event table', (label, delta) => {
    expect(numbersIn(cell(DESIGN_DOC, label, 1))[0]).toBe(delta.session);
    expect(numbersIn(cell(DESIGN_DOC, label, 2))[0]).toBe(delta.agent);
  });
});

describe('Design.md Tier 0 table', () => {
  it('REFERENCE_PRICE escalates above 2x the reference price', () => {
    expect(numbersIn(cell(DESIGN_DOC, '`REFERENCE_PRICE`', 1))).toEqual([
      TIER0_LIMITS.referencePriceMultiple,
    ]);
  });

  it('PRICE_MISMATCH allows a 10% margin', () => {
    expect(numbersIn(cell(DESIGN_DOC, '`PRICE_MISMATCH`', 2))).toEqual([
      TIER0_LIMITS.priceMismatchFraction * 100,
    ]);
  });

  it('DUPLICATE is 3 calls in 10 s', () => {
    expect(numbersIn(cell(DESIGN_DOC, '`DUPLICATE`', 2))).toEqual([
      TIER0_LIMITS.duplicateCount,
      TIER0_LIMITS.duplicateWindowMs / 1_000,
    ]);
  });

  it('VELOCITY counts payments per minute', () => {
    expect(cell(DESIGN_DOC, '`VELOCITY`', 1)).toContain('per minute');
    expect(TIER0_LIMITS.velocityWindowMs).toBe(60_000);
  });

  it('NEW_PAYEE_LIMIT escalates past 3 first-time payees', () => {
    expect(numbersIn(cell(DESIGN_DOC, '`NEW_PAYEE_LIMIT`', 1))).toEqual([
      TIER0_LIMITS.newPayeeLimit,
    ]);
  });
});

describe('CHUNK-2-GATEWAY.md pre-contact rules', () => {
  const secretRule = cell(CHUNK2_DOC, '`SECRET_IN_URL`', 1);

  it('QUERY_TOO_LONG is a raw query over 256 characters', () => {
    expect(numbersIn(cell(CHUNK2_DOC, '`QUERY_TOO_LONG`', 1))).toEqual([
      PRECONTACT_LIMITS.queryMaxChars,
    ]);
  });

  it('UNKNOWN_WITH_PARAMS counts path segments over 24 characters', () => {
    expect(numbersIn(cell(CHUNK2_DOC, '`UNKNOWN_WITH_PARAMS`', 1))).toEqual([
      PRECONTACT_LIMITS.unknownSegmentMaxChars,
    ]);
  });

  it('SECRET_IN_URL lengths and entropy match', () => {
    expect(captured(secretRule, /hex of (\d+)\+ chars/)).toBe(PRECONTACT_LIMITS.secretHexMinChars);
    expect(captured(secretRule, /token of (\d+)\+ chars/)).toBe(
      PRECONTACT_LIMITS.secretTokenMinChars,
    );
    expect(captured(secretRule, /entropy above ([\d.]+) bits/)).toBe(
      PRECONTACT_LIMITS.secretEntropyBitsPerChar,
    );
  });
});

describe('timing', () => {
  it('a human has 10 minutes before HUMAN_TIMEOUT', () => {
    expect(captured(CHUNK2_DOC, /Auto-reject after (\d+) minutes/) * 60_000).toBe(
      TIMING.humanTimeoutMs,
    );
  });

  it('the judge has 5 seconds', () => {
    expect(captured(CONTRACTS_DOC, /(\d+)-second timeout/) * 1_000).toBe(TIMING.judgeTimeoutMs);
  });

  it('/stream sends a heartbeat every 15 s', () => {
    expect(captured(CHUNK2_DOC, /heartbeat every (\d+) s/) * 1_000).toBe(TIMING.streamHeartbeatMs);
  });

  it('poll hints match the section 2 examples', () => {
    expect(captured(CONTRACTS_DOC, /"status": "pending".*"poll_after_ms": (\d+)/)).toBe(
      TIMING.pendingPollAfterMs,
    );
    expect(captured(CONTRACTS_DOC, /"status": "payment_unknown".*"poll_after_ms": (\d+)/)).toBe(
      TIMING.paymentUnknownPollAfterMs,
    );
  });
});

describe('final_contracts.md section 4 judge limits', () => {
  it('explanations are at most 200 characters', () => {
    expect(captured(CONTRACTS_DOC, /`explanation` at most (\d+) characters/)).toBe(
      JUDGE_EXPLANATION_MAX_CHARS,
    );
  });

  it('grants are clamped to 2x the reference price and 2x the payment price', () => {
    expect(captured(CONTRACTS_DOC, /(\d)× the reference price, and \d× this payment/)).toBe(
      GRANT_CLAMP.referencePriceMultiple,
    );
    expect(captured(CONTRACTS_DOC, /reference price, and (\d)× this payment's price/)).toBe(
      GRANT_CLAMP.paymentPriceMultiple,
    );
  });
});

describe('INPUT_LIMITS', () => {
  it('are positive integers', () => {
    for (const value of Object.values(INPUT_LIMITS)) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
  });

  it('leave room for what they bound', () => {
    expect(INPUT_LIMITS.urlMaxChars).toBeGreaterThan(PRECONTACT_LIMITS.queryMaxChars);
    // A ULID (26 characters) must fit as an idempotency key.
    expect(INPUT_LIMITS.idempotencyKeyMaxChars).toBeGreaterThanOrEqual(26);
  });
});
