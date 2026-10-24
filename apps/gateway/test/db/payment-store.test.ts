import type { PaymentState, PaymentStore } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createPaymentStore } from '../../src/db/payment-store.js';
import {
  createMandate,
  createReservedPayment,
  mandateMoney,
  seededDb,
  tenantCommitted,
} from '../harness/db.js';

const AMOUNT = 10_000;
const SIGNATURE = {
  nonce: '0xn0nce',
  validBefore: 1_761_300_000_000,
  authorizationJson: '{"s":1}',
};

type Method = 'markSigned' | 'markSubmitted' | 'markUnknown' | 'settle' | 'fail';
const METHODS: Method[] = ['markSigned', 'markSubmitted', 'markUnknown', 'settle', 'fail'];
const STATES: PaymentState[] = ['RESERVED', 'SIGNED', 'SUBMITTED', 'UNKNOWN', 'SETTLED', 'FAILED'];

/** final_contracts.md section 5: the only transitions each method may make. */
const ALLOWED: Record<Method, Partial<Record<PaymentState, PaymentState>>> = {
  markSigned: { RESERVED: 'SIGNED' },
  markSubmitted: { SIGNED: 'SUBMITTED' },
  markUnknown: { SUBMITTED: 'UNKNOWN' },
  settle: { SIGNED: 'SETTLED', SUBMITTED: 'SETTLED', UNKNOWN: 'SETTLED' },
  fail: { RESERVED: 'FAILED', SIGNED: 'FAILED', SUBMITTED: 'FAILED', UNKNOWN: 'FAILED' },
};

/** How a fresh RESERVED payment reaches each state through the store's own transitions. */
const PATH: Record<PaymentState, Method[]> = {
  RESERVED: [],
  SIGNED: ['markSigned'],
  SUBMITTED: ['markSigned', 'markSubmitted'],
  UNKNOWN: ['markSigned', 'markSubmitted', 'markUnknown'],
  SETTLED: ['markSigned', 'settle'],
  FAILED: ['fail'],
};

function call(store: PaymentStore, method: Method, id: string): Promise<boolean> {
  if (method === 'markSigned') return store.markSigned(id, SIGNATURE);
  if (method === 'settle') return store.settle(id, '0xtxhash');
  return store[method](id);
}

async function paymentIn(state: PaymentState) {
  const { db, clock } = seededDb();
  const store = createPaymentStore(db, clock);
  const mandate = createMandate(db, clock, { budget: 1_000_000 });
  const id = createReservedPayment(db, clock, mandate, AMOUNT);
  for (const step of PATH[state]) expect(await call(store, step, id)).toBe(true);
  const snapshot = async () => ({
    row: await store.get(id),
    money: mandateMoney(db, mandate),
    tenant: tenantCommitted(db, clock),
  });
  return { db, clock, store, id, mandate, snapshot };
}

describe('PaymentStore transition matrix', () => {
  const cases = METHODS.flatMap((method) =>
    STATES.map((from) => [method, from, ALLOWED[method][from] ?? null] as const),
  );

  it.each(cases)('%s from %s', async (method, from, to) => {
    const { store, id, snapshot } = await paymentIn(from);
    const before = await snapshot();

    const changed = await call(store, method, id);
    const after = await snapshot();

    expect(changed).toBe(to !== null);
    if (to === null) {
      expect(after).toEqual(before);
      return;
    }
    expect(after.row?.state).toBe(to);
    if (method === 'settle') {
      expect(after.money).toEqual({
        spent: before.money.spent + AMOUNT,
        reserved: before.money.reserved - AMOUNT,
      });
      expect(after.tenant).toBe(before.tenant);
    } else if (method === 'fail') {
      expect(after.money).toEqual({
        spent: before.money.spent,
        reserved: before.money.reserved - AMOUNT,
      });
      expect(after.tenant).toBe(before.tenant - AMOUNT);
    } else {
      expect(after.money).toEqual(before.money);
      expect(after.tenant).toBe(before.tenant);
    }
  });
});

describe('PaymentStore', () => {
  it('moves money exactly once however often settle or fail is called', async () => {
    const { store, id, snapshot } = await paymentIn('SUBMITTED');
    expect(await store.settle(id, '0xtx')).toBe(true);
    const settled = await snapshot();
    expect(await store.settle(id, '0xtx')).toBe(false);
    expect(await store.fail(id)).toBe(false);
    expect(await snapshot()).toEqual(settled);
    expect(settled.money).toEqual({ spent: AMOUNT, reserved: 0 });
  });

  it('never settles a payment that already failed', async () => {
    const { store, id, snapshot } = await paymentIn('UNKNOWN');
    expect(await store.fail(id)).toBe(true);
    const failed = await snapshot();
    expect(await store.settle(id, '0xtx')).toBe(false);
    expect(await snapshot()).toEqual(failed);
    expect(failed.money).toEqual({ spent: 0, reserved: 0 });
  });

  it('records the signed authorization and returns every field', async () => {
    const { store, id, clock } = await paymentIn('RESERVED');
    clock.advance(1_000);
    expect(await store.markSigned(id, SIGNATURE)).toBe(true);
    expect(await store.get(id)).toMatchObject({
      id,
      amount: AMOUNT,
      payee: '0x1111111111111111111111111111111111111111',
      state: 'SIGNED',
      nonce: SIGNATURE.nonce,
      valid_before: SIGNATURE.validBefore,
      authorization_json: SIGNATURE.authorizationJson,
    });
  });

  it('stores the settlement tx hash', async () => {
    const { db, store, id } = await paymentIn('SUBMITTED');
    await store.settle(id, '0xfeed');
    const row = db.sqlite.prepare('SELECT tx_hash FROM payments WHERE id = ?').get(id);
    expect(row).toEqual({ tx_hash: '0xfeed' });
  });

  it('returns null for an unknown payment', async () => {
    const { store } = await paymentIn('RESERVED');
    expect(await store.get('pay_missing')).toBeNull();
  });

  it('lists only payments the reconciler must resolve', async () => {
    const { db, clock } = seededDb();
    const store = createPaymentStore(db, clock);
    const mandate = createMandate(db, clock, { budget: 1_000_000 });
    const ids = Object.fromEntries(
      await Promise.all(
        STATES.map(async (state) => {
          const id = createReservedPayment(db, clock, mandate, AMOUNT);
          for (const step of PATH[state]) await call(store, step, id);
          return [state, id] as const;
        }),
      ),
    ) as Record<PaymentState, string>;
    expect((await store.listUnresolved()).sort()).toEqual(
      [ids.SIGNED, ids.SUBMITTED, ids.UNKNOWN].sort(),
    );
  });

  it('rolls the payment back if moving the money fails mid-settle', async () => {
    const { db, store, id, snapshot } = await paymentIn('SUBMITTED');
    const before = await snapshot();
    db.sqlite.exec(
      "CREATE TRIGGER block_spend BEFORE UPDATE OF spent ON mandates BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(store.settle(id, '0xtx')).rejects.toThrow('blocked');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls the payment back if releasing the money fails mid-fail', async () => {
    const { db, store, id, snapshot } = await paymentIn('UNKNOWN');
    const before = await snapshot();
    db.sqlite.exec(
      "CREATE TRIGGER block_release BEFORE UPDATE OF reserved ON mandates BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(store.fail(id)).rejects.toThrow('blocked');
    expect(await snapshot()).toEqual(before);
  });

  it('stamps updated_at from the clock on every transition', async () => {
    const { db, clock, store, id } = await paymentIn('RESERVED');
    clock.advance(5_000);
    await store.markSigned(id, SIGNATURE);
    const row = db.sqlite.prepare('SELECT updated_at FROM payments WHERE id = ?').get(id);
    expect(row).toEqual({ updated_at: clock.now() });
  });
});
