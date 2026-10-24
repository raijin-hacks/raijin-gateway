import { describe, expect, it } from 'vitest';
import {
  HUMAN_CODES,
  JUDGE_CODES,
  PRECONTACT_CODES,
  QUOTE_CODES,
  REASON_ACTION,
  REASON_CODES,
  REASON_STAGE,
  TIER0_CODES,
  TIER1_CODES,
  TRUST_CODES,
  type ReasonCode,
  type ReasonGroup,
} from '../src/index.js';
import { escalatingCodes, reasonCodeTable } from './doc.js';

const ROW_GROUP: Record<string, ReasonGroup> = {
  'Pre-contact': 'precontact',
  Quote: 'quote',
  'Tier 0': 'tier0',
  'Tier 1 (logged on miss; hit approves)': 'tier1',
  Judge: 'judge',
  Human: 'human',
  'Trust routing': 'trust',
};

const codesWith = (action: string) =>
  REASON_CODES.filter((code) => REASON_ACTION[code] === action).sort();

describe('reason codes', () => {
  it('match the section 2 table row by row, in order', () => {
    const table = reasonCodeTable();
    expect([...table.keys()]).toEqual(Object.keys(ROW_GROUP));
    const byGroup: Record<ReasonGroup, readonly ReasonCode[]> = {
      precontact: PRECONTACT_CODES,
      quote: QUOTE_CODES,
      tier0: TIER0_CODES,
      tier1: TIER1_CODES,
      judge: JUDGE_CODES,
      human: HUMAN_CODES,
      trust: TRUST_CODES,
    };
    for (const [label, codes] of table) {
      const group = ROW_GROUP[label];
      expect(group, label).toBeDefined();
      expect(byGroup[group as ReasonGroup], label).toEqual(codes);
    }
  });

  it('list every code exactly once', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    expect(REASON_CODES).toHaveLength(45);
  });

  it('map every code to the table row it appears in', () => {
    for (const [label, codes] of reasonCodeTable()) {
      for (const code of codes)
        expect(REASON_STAGE[code as ReasonCode], code).toBe(ROW_GROUP[label]);
    }
    expect(Object.keys(REASON_STAGE).sort()).toEqual([...REASON_CODES].sort());
  });

  it('escalate exactly the codes the contract names', () => {
    expect(codesWith('escalate')).toEqual(escalatingCodes().sort());
    expect(codesWith('escalate')).toEqual(
      [
        'NEW_PAYEE_LIMIT',
        'PARAM_NOT_IN_SCHEMA',
        'REFERENCE_PRICE',
        'SUBJECT_NOT_IN_MANDATE',
        'TRUST_REQUIRES_HUMAN',
        'UNKNOWN_WITH_PARAMS',
      ].sort(),
    );
  });

  it('deny every other pre-contact, quote and Tier 0 code', () => {
    const escalating = new Set(escalatingCodes());
    for (const code of [...PRECONTACT_CODES, ...QUOTE_CODES, ...TIER0_CODES]) {
      expect(REASON_ACTION[code], code).toBe(escalating.has(code) ? 'escalate' : 'deny');
    }
  });

  it('approve only on a grant hit, a judge approval or a human approval', () => {
    expect(codesWith('approve')).toEqual(['GRANT_HIT', 'HUMAN_APPROVED', 'JUDGE_APPROVED']);
  });

  it('log Tier 1 misses and continue', () => {
    expect(codesWith('log')).toEqual(TIER1_CODES.filter((c) => c !== 'GRANT_HIT').sort());
  });

  it('deny judge failures, and let the judge decide its other codes', () => {
    expect(REASON_ACTION.JUDGE_ERROR).toBe('deny');
    expect(REASON_ACTION.JUDGE_INVALID_OUTPUT).toBe('deny');
    expect(codesWith('judge_decides')).toEqual(
      JUDGE_CODES.filter(
        (c) => !['JUDGE_APPROVED', 'JUDGE_ERROR', 'JUDGE_INVALID_OUTPUT'].includes(c),
      ).sort(),
    );
  });

  it('deny a human rejection or timeout', () => {
    expect(REASON_ACTION.HUMAN_REJECTED).toBe('deny');
    expect(REASON_ACTION.HUMAN_TIMEOUT).toBe('deny');
  });
});
