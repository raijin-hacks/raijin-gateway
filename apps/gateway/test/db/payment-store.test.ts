import type { PaymentState, PaymentStore } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createPaymentStore } from '../../src/db/payment-store.js';
import {
  createMandate,
  createReservedPayment,
  mandateMoney,
  one,
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

/** A seeded database with one mandate, a store, and a way to make payments in any state. */
function setup() {
  const { db, clock } = seededDb();
  const store = createPaymentStore(db, clock);
  const mandate = createMandate(db, clock, { budget: 1_000_000 });
  const paymentIn = async (state: PaymentState) => {
    const id = createReservedPayment(db, clock, mandate, AMOUNT);
    for (const step of PATH[state]) expect(await call(store, step, id)).toBe(true);
    return id;
  };
  /** The payment row (with tx_hash), the mandate's money and the tenant's total for today. */
  const snapshot = async (id: string) => ({
    row: {
      ...(await store.get(id)),
      ...one<{ tx_hash: string | null; updated_at: number }>(
        db,
        'SELECT tx_hash, updated_at FROM payments WHERE id = ?',
        id,
      ),
    },
    money: mandateMoney(db, mandate),
    tenant: tenantCommitted(db, clock),
  });
  return { db, clock, store, mandate, paymentIn, snapshot };
}

describe('PaymentStore transition matrix', () => {
  const cases = METHODS.flatMap((method) =>
    STATES.map((from) => [method, from, ALLOWED[method][from] ?? null] as const),
  );

  it.each(cases)('%s from %s', async (method, from, to) => {
    const { store, paymentIn, snapshot } = setup();
    const id = await paymentIn(from);
    const before = await snapshot(id);

    const changed = await call(store, method, id);
    const after = await snapshot(id);

    expect(changed).toBe(to !== null);
    if (to === null) {
      expect(after).toEqual(before);
      return;
    }
    expect(after.row.state).toBe(to);
    const moved = {
      spent: after.money.spent - before.money.spent,
      reserved: after.money.reserved - before.money.reserved,
    };
    if (method === 'settle') {
      expect(moved).toEqual({ spent: AMOUNT, reserved: -AMOUNT });
      expect(after.tenant).toBe(before.tenant);
      expect(after.row.tx_hash).toBe('0xtxhash');
    } else if (method === 'fail') {
      expect(moved).toEqual({ spent: 0, reserved: -AMOUNT });
      expect(after.tenant).toBe(before.tenant - AMOUNT);
    } else {
      expect(moved).toEqual({ spent: 0, reserved: 0 });
      expect(after.tenant).toBe(before.tenant);
    }
  });
});

describe('PaymentStore', () => {
  it.each(METHODS)('%s on an unknown payment changes nothing', async (method) => {
    const { store, mandate, db } = setup();
    expect(await call(store, method, 'pay_missing')).toBe(false);
    expect(mandateMoney(db, mandate)).toEqual({ spent: 0, reserved: 0 });
  });

  it('returns null for an unknown payment', async () => {
    expect(await setup().store.get('pay_missing')).toBeNull();
  });

  it('returns a reserved payment with no signature yet', async () => {
    const { store, mandate, paymentIn } = setup();
    const id = await paymentIn('RESERVED');
    expect(await store.get(id)).toEqual({
      id,
      mandate_id: mandate.mandateId,
      amount: AMOUNT,
      payee: '0x1111111111111111111111111111111111111111',
      state: 'RESERVED',
      nonce: null,
      valid_before: null,
      authorization_json: null,
    });
  });

  it('records the signed authorization and never overwrites it', async () => {
    const { store, paymentIn } = setup();
    const id = await paymentIn('SIGNED');
    expect(await store.markSigned(id, { ...SIGNATURE, nonce: '0xother' })).toBe(false);
    expect(await store.get(id)).toMatchObject({
      state: 'SIGNED',
      nonce: SIGNATURE.nonce,
      valid_before: SIGNATURE.validBefore,
      authorization_json: SIGNATURE.authorizationJson,
    });
  });

  it('moves money exactly once however often settle or fail is called', async () => {
    const { store, paymentIn, snapshot } = setup();
    const id = await paymentIn('SUBMITTED');
    expect(await store.settle(id, '0xtx')).toBe(true);
    const settled = await snapshot(id);
    expect(await store.settle(id, '0xother')).toBe(false);
    expect(await store.fail(id)).toBe(false);
    expect(await snapshot(id)).toEqual(settled);
    expect(settled.money).toEqual({ spent: AMOUNT, reserved: 0 });
  });

  it('never settles a payment that already failed', async () => {
    const { store, paymentIn, snapshot } = setup();
    const id = await paymentIn('UNKNOWN');
    expect(await store.fail(id)).toBe(true);
    const failed = await snapshot(id);
    expect(await store.settle(id, '0xtx')).toBe(false);
    expect(await snapshot(id)).toEqual(failed);
    expect(failed.money).toEqual({ spent: 0, reserved: 0 });
  });

  it('lets exactly one of a racing settle and fail win', async () => {
    const { store, paymentIn, snapshot } = setup();
    const id = await paymentIn('UNKNOWN');
    const results = await Promise.all([store.settle(id, '0xtx'), store.fail(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const { money } = await snapshot(id);
    expect(money.reserved).toBe(0);
    expect(money.spent).toBe(results[0] ? AMOUNT : 0);
  });

  it('lists only payments the reconciler must resolve, oldest update first', async () => {
    const { clock, store, paymentIn } = setup();
    const ids: Partial<Record<PaymentState, string>> = {};
    for (const state of [
      'UNKNOWN',
      'RESERVED',
      'SETTLED',
      'SIGNED',
      'FAILED',
      'SUBMITTED',
    ] as const) {
      ids[state] = await paymentIn(state);
      clock.advance(1_000);
    }
    expect(await store.listUnresolved()).toEqual([ids.UNKNOWN, ids.SIGNED, ids.SUBMITTED]);
  });

  it('stamps updated_at from the clock on every transition', async () => {
    const { clock, store, paymentIn, snapshot } = setup();
    const id = await paymentIn('RESERVED');
    for (const step of ['markSigned', 'markSubmitted', 'markUnknown', 'settle'] as const) {
      clock.advance(5_000);
      await call(store, step, id);
      expect((await snapshot(id)).row.updated_at).toBe(clock.now());
    }
  });

  it.each([
    ['settle', 'spent', 'SUBMITTED'],
    ['fail', 'reserved', 'UNKNOWN'],
  ] as const)('rolls %s back entirely if moving the money fails', async (method, column, from) => {
    const { db, store, paymentIn, snapshot } = setup();
    const id = await paymentIn(from);
    const before = await snapshot(id);
    db.sqlite.exec(
      `CREATE TRIGGER block BEFORE UPDATE OF ${column} ON mandates BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    await expect(call(store, method, id)).rejects.toThrow('blocked');
    expect(await snapshot(id)).toEqual(before);
  });

  it('rolls fail back entirely if releasing the tenant total fails', async () => {
    const { db, store, paymentIn, snapshot } = setup();
    const id = await paymentIn('SIGNED');
    const before = await snapshot(id);
    db.sqlite.exec(
      "CREATE TRIGGER block BEFORE UPDATE ON tenant_daily BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(store.fail(id)).rejects.toThrow('blocked');
    expect(await snapshot(id)).toEqual(before);
  });
});
