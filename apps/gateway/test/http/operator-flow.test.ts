import { randomUUID } from 'node:crypto';
import {
  PayResponseSchema,
  PendingApprovalsResponseSchema,
  type CreateMandateResponse,
  type PayRequest,
} from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadCatalog } from '../../src/catalog/index.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { createGatewayAdmission, createStubJudge } from '../../src/judge/index.js';
import { createMockPayments } from '../../src/mock-payments.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { ADMIN_TOKEN, MANDATE_BODY, createHarness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../harness/db.js';

const URL = 'http://localhost:4101/v1/pricing/acme?period=30d';

describe('operator to agent review flow', () => {
  it('runs the admin approval flow through agent polling', async () => {
    const h = createHarness();
    const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
    const store = createPaymentStore(h.db, h.clock);
    const deps = {
      ...h.deps,
      catalog,
      catalogAdmission: createGatewayAdmission(catalog),
      payments: createMockPayments(store, catalog, h.clock),
      judge: createStubJudge('stub-escalate'),
    };
    const pipeline = createPipeline(deps);
    const app = createApp({ ...deps, pipeline });
    const request = (path: string, token: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      });

    const createdResponse = await request('/mandates', ADMIN_TOKEN, {
      method: 'POST',
      body: JSON.stringify(MANDATE_BODY),
    });
    expect(createdResponse.status).toBe(201);
    const mandate = (await createdResponse.json()) as CreateMandateResponse;

    const payRequest: PayRequest = {
      url: URL,
      method: 'GET',
      expected_price: 10000,
      purpose: 'fetch_data',
      idempotency_key: randomUUID(),
    };
    const payResponse = await request('/pay', mandate.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': payRequest.idempotency_key },
      body: JSON.stringify(payRequest),
    });
    expect(payResponse.status).toBe(200);
    const pending = PayResponseSchema.parse(await payResponse.json());
    expect(pending.status).toBe('pending');

    const approvalsResponse = await request('/approvals?status=pending', ADMIN_TOKEN);
    expect(approvalsResponse.status).toBe(200);
    const approvals = PendingApprovalsResponseSchema.parse(await approvalsResponse.json());
    expect(approvals).toEqual([
      {
        decision_id: pending.decision_id,
        mandate_id: mandate.mandate_id,
        task: MANDATE_BODY.task,
        agent: { id: 'agt_pricing', name: 'Pricing researcher', role: 'research' },
        merchant: { id: 'mer_pricing', name: 'PriceScope' },
        endpoint: { id: 'end_pricing_get', method: 'GET', path: '/v1/pricing/{company}' },
        canonical_url: URL,
        price: 10000,
        reasons: ['JUDGE_OVER_SCOPED'],
        judge_explanation: 'Explicit stub-escalate fixture; no model was called.',
        stage: 'judge',
        deadline: h.clock.now() + 600_000,
      },
    ]);

    const approvedResponse = await request(`/approvals/${pending.decision_id}`, ADMIN_TOKEN, {
      method: 'POST',
      body: JSON.stringify({
        outcome: 'approved',
        note: 'Approved for the assigned review.',
        issue_grant: false,
      }),
    });
    expect(approvedResponse.status).toBe(200);
    expect(await approvedResponse.json()).toEqual({ ok: true });

    const remaining = await request('/approvals?status=pending', ADMIN_TOKEN);
    expect(PendingApprovalsResponseSchema.parse(await remaining.json())).toEqual([]);

    const decisionResponse = await request(`/decisions/${pending.decision_id}`, mandate.token);
    expect(decisionResponse.status).toBe(200);
    expect(PayResponseSchema.parse(await decisionResponse.json())).toMatchObject({
      status: 'approved',
      decision_id: pending.decision_id,
      stage: 'human',
      amount: 10000,
      payee: '0x1111111111111111111111111111111111111111',
      response: {
        status_code: 200,
        content_type: 'application/json',
        body: '{"mock":true}',
      },
    });
  });
});
