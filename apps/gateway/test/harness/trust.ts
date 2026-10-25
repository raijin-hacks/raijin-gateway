// Offline gateway fixture: real authentication, migrations, pipeline, mock ledger, stub judge.
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { PayRequest, PayResponse } from '@apf/contracts';
import { loadCatalog } from '../../src/catalog/index.js';
import { FIXTURE_CATALOG_PATH } from './db.js';
import { createApp } from '../../src/app.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { createStubJudge } from '../../src/judge/index.js';
import { createMockPayments } from '../../src/mock-payments.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { restrictionFor } from '../../src/pipeline/restrictions.js';
import { ADMIN_TOKEN, createHarness } from './app.js';

export async function trustFixture() {
  const h = createHarness({}, { catalog: loadCatalog(FIXTURE_CATALOG_PATH) });
  const store = createPaymentStore(h.db, h.clock);
  const mock = createMockPayments(store, h.deps.catalog, h.clock);
  const payments = {
    getQuote: vi.fn(mock.getQuote),
    pay: vi.fn(mock.pay),
    reconcile: mock.reconcile,
  };
  const judge = createStubJudge('stub-approve');
  const judgeCall = vi.spyOn(judge, 'judge').mockResolvedValue({
    decision: 'approve',
    reasons: ['JUDGE_APPROVED'],
    injection_suspected: false,
    explanation: 'Within task',
    grant: { max_per_call: 10000, max_total: 100000, ttl_ms: 600000 },
  });
  const deps = { ...h.deps, payments, judge };
  const pipeline = createPipeline(deps);
  const app = createApp({ ...deps, pipeline });
  const mandate = await h.createMandate();
  const request = (path: string, body?: unknown, token = ADMIN_TOKEN) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const purchase = (patch: Partial<PayRequest> = {}): PayRequest => ({
    url: 'http://localhost:4101/v1/pricing/acme?period=30d',
    method: 'GET',
    expected_price: 10000,
    purpose: 'fetch_data',
    idempotency_key: randomUUID(),
    ...patch,
  });
  const pay = async (body = purchase(), token = mandate.token): Promise<PayResponse> => {
    const res = await app.request('/pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
        'Idempotency-Key': body.idempotency_key,
      },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<PayResponse>;
  };
  const review = (id: string, outcome = 'approved', issue_grant = false) =>
    request(`/approvals/${id}`, { outcome, note: 'Reviewed for the demo', issue_grant });
  const restore = (target = 'normal', token = ADMIN_TOKEN) =>
    request(
      '/agents/agt_pricing/restore',
      {
        target,
        reason: 'Removed the poisoned source and inspected the agent',
        operator: 'Demo operator',
      },
      token,
    );
  const state = () => restrictionFor(deps, 'agt_pricing').restriction;
  const count = (table: string) =>
    (h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    ...h,
    deps,
    app,
    pipeline,
    store,
    payments,
    judgeCall,
    mandate,
    request,
    purchase,
    pay,
    review,
    restore,
    state,
    count,
  };
}
export type TrustFixture = Awaited<ReturnType<typeof trustFixture>>;
