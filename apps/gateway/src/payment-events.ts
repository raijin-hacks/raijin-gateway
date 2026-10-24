// Chunk 2-owned. Emit payment transitions only after their store transaction commits.
import type { PaymentStore } from '@apf/contracts';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
export function withPaymentEvents(store: PaymentStore, bus: EventBus, clock: Clock): PaymentStore {
  async function publish(id: string, changed: boolean): Promise<boolean> {
    if (!changed) return false;
    const row = await store.get(id);
    if (row)
      bus.publish({
        type: 'payment',
        payment_id: id,
        state: row.state,
        amount: row.amount,
        at: clock.now(),
      });
    return true;
  }
  return {
    get: (id) => store.get(id),
    listUnresolved: () => store.listUnresolved(),
    markSigned: async (id, fields) => publish(id, await store.markSigned(id, fields)),
    markSubmitted: async (id) => publish(id, await store.markSubmitted(id)),
    markUnknown: async (id) => publish(id, await store.markUnknown(id)),
    settle: async (id, hash) => publish(id, await store.settle(id, hash)),
    fail: async (id) => publish(id, await store.fail(id)),
    // Not a state change, so no event.
    saveResponse: (id, response) => store.saveResponse(id, response),
  };
}
