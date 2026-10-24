// Chunk 2-owned: reconciliation and stream wiring over the real SQLite store.
import { expect, it, vi } from 'vitest';
import { createHarness } from './harness/app.js';
import { createMandate, createReservedPayment } from './harness/db.js';
import { createPaymentStore } from '../src/db/payment-store.js';
import { withPaymentEvents } from '../src/payment-events.js';
import { startReconciler } from '../src/payments/index.js';

it('reconciles an unknown payment once, accounts once and publishes the committed transition', async () => {
  const h = createHarness();
  const mandate = createMandate(h.db, h.clock, { budget: 10000 });
  const id = createReservedPayment(h.db, h.clock, mandate, 10000);
  const store = withPaymentEvents(createPaymentStore(h.db, h.clock), h.bus, h.clock);
  await store.markSigned(id, {
    nonce: 'nonce',
    validBefore: h.clock.now() + 1000,
    authorizationJson: '{}',
  });
  await store.markSubmitted(id);
  await store.markUnknown(id);
  const reconcile = vi.fn(async (paymentId: string) => {
    await store.settle(paymentId, 'confirmed');
    return 'SETTLED' as const;
  });
  const stop = startReconciler({ getQuote: vi.fn(), pay: vi.fn(), reconcile }, store, 10000);
  try {
    await vi.waitFor(() =>
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: 'payment', payment_id: id, state: 'SETTLED' }),
      ),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    await store.settle(id, 'confirmed');
    const money = h.db.sqlite
      .prepare('SELECT spent, reserved FROM mandates WHERE id = ?')
      .get(mandate.mandateId);
    expect(money).toEqual({ spent: 10000, reserved: 0 });
    expect(h.events.filter((e) => e.type === 'payment' && e.state === 'SETTLED')).toHaveLength(1);
  } finally {
    stop();
  }
});

it('the signing transition refuses an expired, closed or quarantined authority', async () => {
  for (const status of ['closed', 'expired', 'quarantined']) {
    const h = createHarness();
    const mandate = createMandate(h.db, h.clock, { budget: 10000 });
    const id = createReservedPayment(h.db, h.clock, mandate, 10000);
    if (status === 'quarantined')
      h.db.sqlite
        .prepare("UPDATE sessions SET status = 'quarantined' WHERE id = ?")
        .run(mandate.sessionId);
    else
      h.db.sqlite
        .prepare('UPDATE mandates SET status = ? WHERE id = ?')
        .run(status, mandate.mandateId);
    const store = createPaymentStore(h.db, h.clock);
    expect(
      await store.markSigned(id, {
        nonce: 'nonce',
        validBefore: h.clock.now() + 1000,
        authorizationJson: '{}',
      }),
    ).toBe(false);
    expect((await store.get(id))?.state).toBe('RESERVED');
  }
});
