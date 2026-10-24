// Chunk 2-owned, explicit in-memory transport substitute. Never makes merchant requests.
import type { Catalog, PaymentsModule, PaymentStore } from '@apf/contracts';
import type { Clock } from './clock.js';
export function createMockPayments(
  store: PaymentStore,
  catalog: Catalog,
  clock: Clock,
): PaymentsModule {
  return {
    async getQuote(url, method) {
      const merchant = catalog.merchants.find((m) => m.origin === new URL(url).origin);
      if (!merchant) throw new Error('UNKNOWN_MOCK_MERCHANT');
      return {
        url,
        method,
        payee: merchant.payee,
        amount: 10000,
        network: 'eip155:84532',
        raw: { mock: true },
      };
    },
    async pay(id, quote) {
      if (
        !(await store.markSigned(id, {
          nonce: id,
          validBefore: clock.now() + 60000,
          authorizationJson: JSON.stringify({ mock: true, amount: quote.amount }),
        }))
      )
        return { state: 'UNKNOWN' };
      if (!(await store.markSubmitted(id))) return { state: 'UNKNOWN' };
      if (!(await store.settle(id, `mock:${id}`))) return { state: 'UNKNOWN' };
      return {
        state: 'SETTLED',
        txHash: `mock:${id}`,
        response: { status_code: 200, content_type: 'application/json', body: '{"mock":true}' },
      };
    },
    async reconcile(id) {
      const state = (await store.get(id))?.state;
      return state === 'SETTLED' || state === 'FAILED' ? state : 'UNKNOWN';
    },
  };
}
