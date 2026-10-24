import { expect, it } from 'vitest';
import { createTokenClient } from './client.js';
import { createHarness } from '../../apps/gateway/test/harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../../apps/gateway/test/harness/db.js';
import { createApp } from '../../apps/gateway/src/app.js';
import { loadCatalog } from '../../apps/gateway/src/catalog/index.js';
import { createPaymentStore } from '../../apps/gateway/src/db/payment-store.js';
import { createMockPayments } from '../../apps/gateway/src/mock-payments.js';
import { createStubJudge } from '../../apps/gateway/src/judge/index.js';
import { randomUUID } from 'node:crypto';

it('runs the safe evaluation client against actual authenticated pay and polling routes', async () => {
  const h = createHarness();
  const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
  const payments = createMockPayments(createPaymentStore(h.db, h.clock), catalog, h.clock);
  const app = createApp({ ...h.deps, catalog, payments, judge: createStubJudge('stub-approve') });
  const mandate = await h.createMandate();
  const client = createTokenClient('http://localhost:4000', mandate.token, async (url, init) =>
    app.request(String(url), init),
  );
  const purchase = {
    url: 'http://localhost:4101/v1/pricing/acme?period=30d',
    method: 'GET' as const,
    expected_price: 10000,
    purpose: 'fetch_data' as const,
    idempotency_key: randomUUID(),
  };
  const response = await client.pay(purchase);
  expect(response.status).toBe('approved');
  expect(await client.decision(response.decision_id)).toEqual(response);
  if (response.status === 'approved')
    expect(await client.payment(response.payment_id)).toMatchObject({
      state: 'SETTLED',
      amount: 10000,
    });
  expect(await client.pay(purchase)).toEqual(response);
  const ledger = h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get();
  expect(ledger).toEqual({ n: 1 });
});
