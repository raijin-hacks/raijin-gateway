import { ONE_USDC } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createFunds, utcDay } from '../../src/db/funds.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { DEMO } from '../../src/db/seed.js';
import {
  PRICESCOPE_PAYEE,
  count,
  createDecision,
  createGrant,
  createMandate,
  mandateMoney,
  one,
  seededDb,
  tenantCommitted,
  type TestMandate,
} from '../harness/db.js';

const DAY_MS = 24 * 60 * 60_000;
const STANDING_WEATHER = DEMO.standingGrantId('research', 'end_weather_forecast');

function setup(budget = 1_000_000) {
  const { db, clock } = seededDb();
  const funds = createFunds(db, clock);
  const mandate = createMandate(db, clock, { budget });
  const reserve = (amount: number, m: TestMandate = mandate) =>
    funds.reserve({
      mandateId: m.mandateId,
      decisionId: createDecision(db, clock, m),
      amount,
      payee: PRICESCOPE_PAYEE,
      quoteJson: `{"amount":${amount}}`,
    });
  /** Everything a refused reservation must leave untouched. */
  const state = () => ({
    money: mandateMoney(db, mandate),
    tenant: tenantCommitted(db, clock),
    payments: count(db, 'payments'),
  });
  return { db, clock, funds, mandate, reserve, state };
}

describe('utcDay', () => {
  it.each([
    [Date.UTC(2026, 9, 24, 0, 0, 0, 0), '2026-10-24'],
    [Date.UTC(2026, 9, 24, 23, 59, 59, 999), '2026-10-24'],
    [Date.UTC(2026, 9, 25, 0, 0, 0, 0), '2026-10-25'],
    [0, '1970-01-01'],
  ])('%i is %s', (now, day) => {
    expect(utcDay(now)).toBe(day);
  });
});

describe('reserve', () => {
  it('holds the money and creates a RESERVED payment with the quote and the day', () => {
    const { db, clock, mandate, reserve } = setup();
    const result = reserve(10_000);
    if (!result.ok) throw new Error(result.code);
    expect(result.paymentId).toMatch(/^pay_[0-9A-Z]{26}$/);
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 10_000 });
    expect(tenantCommitted(db, clock)).toBe(10_000);
    expect(one(db, 'SELECT * FROM payments WHERE id = ?', result.paymentId)).toMatchObject({
      state: 'RESERVED',
      amount: 10_000,
      payee: PRICESCOPE_PAYEE,
      quote_json: '{"amount":10000}',
      mandate_id: mandate.mandateId,
      day: utcDay(clock.now()),
      updated_at: clock.now(),
      nonce: null,
      tx_hash: null,
    });
  });

  it('allows reserving exactly up to the budget, then refuses', () => {
    const { reserve } = setup(100_000);
    expect(reserve(60_000).ok).toBe(true);
    expect(reserve(40_000).ok).toBe(true);
    expect(reserve(1)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
  });

  it('refuses past the budget and changes nothing', () => {
    const { reserve, state } = setup(100_000);
    expect(reserve(60_000).ok).toBe(true);
    const before = state();
    expect(reserve(50_000)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
    expect(state()).toEqual(before);
  });

  it.each(['closed', 'expired'] as const)('refuses a %s mandate', (status) => {
    const { db, clock, reserve } = setup();
    const mandate = createMandate(db, clock, { budget: 1_000_000, status });
    expect(reserve(10_000, mandate)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 0 });
  });

  it('works until the expiry instant, and not at it', () => {
    const { clock, reserve } = setup();
    clock.advance(30 * 60_000 - 1);
    expect(reserve(10_000).ok).toBe(true);
    clock.advance(1);
    expect(reserve(10_000)).toEqual({ ok: false, code: 'MANDATE_BUDGET' });
  });

  it('enforces the tenant daily cap across mandates without touching the refused mandate', () => {
    const { db, clock, reserve } = setup(15 * ONE_USDC);
    const second = createMandate(db, clock, { budget: 15 * ONE_USDC });
    const rest = DEMO.tenantDailyCap - 15 * ONE_USDC;
    expect(reserve(15 * ONE_USDC).ok).toBe(true);
    expect(reserve(rest + 1, second)).toEqual({ ok: false, code: 'TENANT_DAILY' });
    expect(mandateMoney(db, second)).toEqual({ spent: 0, reserved: 0 });
    expect(reserve(rest, second).ok).toBe(true);
    expect(tenantCommitted(db, clock)).toBe(DEMO.tenantDailyCap);
  });

  it('refuses a single amount above the tenant cap', () => {
    const { reserve, state } = setup(30 * ONE_USDC);
    const before = state();
    expect(reserve(DEMO.tenantDailyCap + 1)).toEqual({ ok: false, code: 'TENANT_DAILY' });
    expect(state()).toEqual(before);
  });

  it('reports TENANT_DAILY when both the tenant and the mandate would be over', () => {
    const { db, clock, reserve } = setup(20 * ONE_USDC);
    expect(reserve(DEMO.tenantDailyCap).ok).toBe(true);
    const tiny = createMandate(db, clock, { budget: 1 });
    expect(reserve(2, tiny)).toEqual({ ok: false, code: 'TENANT_DAILY' });
  });

  it('starts a fresh tenant total each UTC day', () => {
    const { db, clock, reserve } = setup(20 * ONE_USDC);
    expect(reserve(DEMO.tenantDailyCap).ok).toBe(true);
    clock.advance(DAY_MS);
    const tomorrow = createMandate(db, clock, { budget: ONE_USDC });
    expect(reserve(ONE_USDC, tomorrow).ok).toBe(true);
    expect(tenantCommitted(db, clock)).toBe(ONE_USDC);
  });

  it('gives released money back to the tenant total', async () => {
    const { db, clock, reserve } = setup(20 * ONE_USDC);
    const first = reserve(DEMO.tenantDailyCap);
    if (!first.ok) throw new Error(first.code);
    expect(await createPaymentStore(db, clock).fail(first.paymentId)).toBe(true);
    expect(tenantCommitted(db, clock)).toBe(0);
    expect(reserve(ONE_USDC).ok).toBe(true);
  });

  it('releases a payment into the day it was reserved on, even after midnight', async () => {
    const { db, clock, reserve } = setup();
    clock.set(Date.UTC(2026, 9, 24, 23, 59, 59, 0));
    const result = reserve(10_000, createMandate(db, clock, { budget: 1_000_000 }));
    if (!result.ok) throw new Error(result.code);
    const reservedDay = utcDay(clock.now());
    clock.advance(2_000);
    expect(utcDay(clock.now())).not.toBe(reservedDay);
    expect(await createPaymentStore(db, clock).fail(result.paymentId)).toBe(true);
    expect(one(db, 'SELECT committed FROM tenant_daily WHERE day = ?', reservedDay)).toEqual({
      committed: 0,
    });
    expect(count(db, 'tenant_daily', 'day = ?', utcDay(clock.now()))).toBe(0);
  });

  it('approves exactly 4 of 10 half-USDC reservations on a 2 USDC mandate (A13)', () => {
    const { reserve } = setup(2 * ONE_USDC);
    const results = Array.from({ length: 10 }, () => reserve(ONE_USDC / 2));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.code === 'MANDATE_BUDGET')).toHaveLength(6);
  });

  it('allows only one payment per decision and rolls the second reservation back', () => {
    const { db, clock, funds, mandate, state } = setup();
    const decisionId = createDecision(db, clock, mandate);
    const request = {
      mandateId: mandate.mandateId,
      decisionId,
      amount: 10_000,
      payee: PRICESCOPE_PAYEE,
      quoteJson: '{}',
    };
    expect(funds.reserve(request).ok).toBe(true);
    const before = state();
    expect(() => funds.reserve(request)).toThrow(/UNIQUE/);
    expect(state()).toEqual(before);
  });

  it('rolls back and throws for a decision that does not exist', () => {
    const { funds, mandate, state } = setup();
    const before = state();
    expect(() =>
      funds.reserve({
        mandateId: mandate.mandateId,
        decisionId: 'dec_missing',
        amount: 1,
        payee: PRICESCOPE_PAYEE,
        quoteJson: '{}',
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(state()).toEqual(before);
  });

  it('refuses a mandate that does not exist and changes nothing', () => {
    const { db, clock, funds, mandate, state } = setup();
    const before = state();
    const result = funds.reserve({
      mandateId: 'mnd_missing',
      decisionId: createDecision(db, clock, mandate),
      amount: 1,
      payee: PRICESCOPE_PAYEE,
      quoteJson: '{}',
    });
    expect(result.ok).toBe(false);
    expect(state()).toEqual(before);
  });
});

describe('useGrant', () => {
  const usedTotal = (db: ReturnType<typeof setup>['db'], id: string) =>
    one<{ used_total: number }>(db, 'SELECT used_total FROM grants WHERE id = ?', id)?.used_total;

  it('counts use up to max_total exactly, then refuses without counting', () => {
    const { db, clock, funds, mandate } = setup();
    const grant = createGrant(db, clock, mandate, { maxTotal: 30_000 });
    expect(funds.useGrant(grant, 10_000)).toBe(true);
    expect(funds.useGrant(grant, 20_000)).toBe(true);
    expect(funds.useGrant(grant, 1)).toBe(false);
    expect(usedTotal(db, grant)).toBe(30_000);
  });

  it('works until the expiry instant, and not at it', () => {
    const { db, clock, funds, mandate } = setup();
    const grant = createGrant(db, clock, mandate, { maxTotal: 30_000, expiresInMs: 1_000 });
    clock.advance(999);
    expect(funds.useGrant(grant, 10_000)).toBe(true);
    clock.advance(1);
    expect(funds.useGrant(grant, 10_000)).toBe(false);
    expect(usedTotal(db, grant)).toBe(10_000);
  });

  it('refuses an unknown grant', () => {
    expect(setup().funds.useGrant('grt_missing', 1)).toBe(false);
  });
});

describe('useStandingGrant', () => {
  it('caps use per day at daily_total and resets the next UTC day', () => {
    const { clock, funds } = setup();
    for (let i = 0; i < 25; i++)
      expect(funds.useStandingGrant(STANDING_WEATHER, 20_000)).toBe(true);
    expect(funds.useStandingGrant(STANDING_WEATHER, 1)).toBe(false);
    clock.advance(DAY_MS);
    expect(funds.useStandingGrant(STANDING_WEATHER, 20_000)).toBe(true);
  });

  it('refuses a single use larger than daily_total without recording it', () => {
    const { db, funds } = setup();
    expect(funds.useStandingGrant(STANDING_WEATHER, 500_001)).toBe(false);
    expect(count(db, 'standing_grant_usage')).toBe(0);
  });

  it('refuses an unknown standing grant', () => {
    expect(setup().funds.useStandingGrant('grt_missing', 1)).toBe(false);
  });
});
