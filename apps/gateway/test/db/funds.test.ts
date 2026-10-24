import { ONE_USDC } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createFunds } from '../../src/db/funds.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { DEMO } from '../../src/db/seed.js';
import {
  PRICESCOPE_PAYEE,
  createDecision,
  createGrant,
  createMandate,
  mandateMoney,
  seededDb,
  tenantCommitted,
} from '../harness/db.js';

const DAY_MS = 24 * 60 * 60_000;

function setup(budget: number) {
  const { db, clock } = seededDb();
  const funds = createFunds(db, clock);
  const mandate = createMandate(db, clock, { budget });
  const reserve = (amount: number, m = mandate) =>
    funds.reserve({
      mandateId: m.mandateId,
      decisionId: createDecision(db, clock, m),
      amount,
      payee: PRICESCOPE_PAYEE,
      quoteJson: `{"amount":${amount}}`,
    });
  return { db, clock, funds, mandate, reserve };
}

describe('reserve', () => {
  it('holds the money and creates a RESERVED payment with the quote', () => {
    const { db, clock, mandate, reserve } = setup(1_000_000);
    const result = reserve(10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 10_000 });
    expect(tenantCommitted(db, clock)).toBe(10_000);
    const row = db.sqlite
      .prepare('SELECT state, amount, payee, quote_json, mandate_id FROM payments WHERE id = ?')
      .get(result.paymentId);
    expect(row).toEqual({
      state: 'RESERVED',
      amount: 10_000,
      payee: PRICESCOPE_PAYEE,
      quote_json: '{"amount":10000}',
      mandate_id: mandate.mandateId,
    });
  });

  it('allows reserving exactly up to the budget', () => {
    const { reserve } = setup(100_000);
    expect(reserve(60_000).ok).toBe(true);
    expect(reserve(40_000).ok).toBe(true);
    expect(reserve(1)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
  });

  it('refuses past the budget and changes nothing', () => {
    const { db, clock, mandate, reserve } = setup(100_000);
    expect(reserve(60_000).ok).toBe(true);
    expect(reserve(50_000)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 60_000 });
    expect(tenantCommitted(db, clock)).toBe(60_000);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 1 });
  });

  it.each(['closed', 'expired'] as const)('refuses a %s mandate', (status) => {
    const { db, clock, funds } = setup(1_000_000);
    const mandate = createMandate(db, clock, { budget: 1_000_000, status });
    const result = funds.reserve({
      mandateId: mandate.mandateId,
      decisionId: createDecision(db, clock, mandate),
      amount: 10_000,
      payee: PRICESCOPE_PAYEE,
      quoteJson: '{}',
    });
    expect(result).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
  });

  it('refuses once the mandate reaches its expiry time', () => {
    const { clock, reserve } = setup(1_000_000);
    clock.advance(30 * 60_000);
    expect(reserve(10_000)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
  });

  it('enforces the tenant daily cap across mandates without touching the second mandate', () => {
    const { db, clock, reserve } = setup(15 * ONE_USDC);
    const second = createMandate(db, clock, { budget: 15 * ONE_USDC });
    expect(reserve(15 * ONE_USDC).ok).toBe(true);
    expect(reserve(DEMO.tenantDailyCap - 15 * ONE_USDC + 1, second)).toEqual({
      ok: false,
      code: 'TENANT_DAILY',
    });
    expect(mandateMoney(db, second)).toEqual({ spent: 0, reserved: 0 });
    expect(reserve(DEMO.tenantDailyCap - 15 * ONE_USDC, second).ok).toBe(true);
  });

  it('starts a fresh tenant total on the next UTC day', () => {
    const { db, clock, reserve } = setup(20 * ONE_USDC);
    expect(reserve(DEMO.tenantDailyCap).ok).toBe(true);
    clock.advance(DAY_MS);
    const tomorrow = createMandate(db, clock, { budget: ONE_USDC });
    expect(reserve(ONE_USDC, tomorrow).ok).toBe(true);
  });

  it('gives released money back to the tenant total', async () => {
    const { db, clock, reserve } = setup(20 * ONE_USDC);
    const first = reserve(DEMO.tenantDailyCap);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await createPaymentStore(db, clock).fail(first.paymentId)).toBe(true);
    expect(tenantCommitted(db, clock)).toBe(0);
    expect(reserve(ONE_USDC).ok).toBe(true);
  });

  it('approves exactly 4 of 10 half-USDC reservations on a 2 USDC mandate (A13)', () => {
    const { reserve } = setup(2 * ONE_USDC);
    const results = Array.from({ length: 10 }, () => reserve(ONE_USDC / 2));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.code === 'MANDATE_BUDGET')).toHaveLength(6);
  });

  it('allows only one payment per decision and rolls the second reservation back', () => {
    const { db, clock, funds, mandate } = setup(1_000_000);
    const decisionId = createDecision(db, clock, mandate);
    const request = {
      mandateId: mandate.mandateId,
      decisionId,
      amount: 10_000,
      payee: PRICESCOPE_PAYEE,
      quoteJson: '{}',
    };
    expect(funds.reserve(request).ok).toBe(true);
    expect(() => funds.reserve(request)).toThrow(/UNIQUE/);
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 10_000 });
    expect(tenantCommitted(db, clock)).toBe(10_000);
  });
});

describe('useGrant', () => {
  it('counts use up to max_total, then refuses', () => {
    const { db, clock, funds, mandate } = setup(1_000_000);
    const grant = createGrant(db, clock, mandate, { maxTotal: 30_000 });
    expect(funds.useGrant(grant, 10_000)).toBe(true);
    expect(funds.useGrant(grant, 20_000)).toBe(true);
    expect(funds.useGrant(grant, 1)).toBe(false);
    const row = db.sqlite.prepare('SELECT used_total FROM grants WHERE id = ?').get(grant);
    expect(row).toEqual({ used_total: 30_000 });
  });

  it('refuses an expired grant', () => {
    const { db, clock, funds, mandate } = setup(1_000_000);
    const grant = createGrant(db, clock, mandate, { maxTotal: 30_000, expiresInMs: 1_000 });
    clock.advance(1_000);
    expect(funds.useGrant(grant, 10_000)).toBe(false);
  });

  it('refuses an unknown grant', () => {
    const { funds } = setup(1_000_000);
    expect(funds.useGrant('grt_missing', 1)).toBe(false);
  });
});

describe('useStandingGrant', () => {
  it('caps use per day at daily_total and resets the next UTC day', () => {
    const { clock, funds } = setup(1_000_000);
    const id = DEMO.standingGrantId('research', 'end_weather_forecast');
    for (let i = 0; i < 25; i++) expect(funds.useStandingGrant(id, 20_000)).toBe(true);
    expect(funds.useStandingGrant(id, 20_000)).toBe(false);
    clock.advance(DAY_MS);
    expect(funds.useStandingGrant(id, 20_000)).toBe(true);
  });

  it('refuses a single use larger than daily_total', () => {
    const { funds } = setup(1_000_000);
    const id = DEMO.standingGrantId('research', 'end_weather_forecast');
    expect(funds.useStandingGrant(id, 500_001)).toBe(false);
  });
});
