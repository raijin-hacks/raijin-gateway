// Chunk 2-owned mixed-PR integration tests: actual HTTP/auth, catalog, SQLite, judge and holds.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PayResponseSchema,
  type JudgeModule,
  type JudgeOutput,
  type PayRequest,
  type PayResponse,
  type Quote,
} from '@apf/contracts';
import { createApp } from '../../src/app.js';
import { loadCatalog, createCanonicalizer } from '../../src/catalog/index.js';
import { createGatewayAdmission } from '../../src/judge/gateway.js';
import {
  createInjectedJudge,
  createJudge,
  createStubJudge,
  JudgeError,
} from '../../src/judge/index.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { createMockPayments } from '../../src/mock-payments.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { createHarness, ADMIN_TOKEN } from '../harness/app.js';
import { createDecision, FIXTURE_CATALOG_PATH } from '../harness/db.js';

const url = 'http://localhost:4101/v1/pricing/acme?period=30d';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(judge: JudgeModule = createStubJudge('stub-approve')) {
  const h = createHarness();
  const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
  const store = createPaymentStore(h.db, h.clock);
  const underlying = createMockPayments(store, catalog, h.clock);
  const payments = {
    getQuote: vi.fn(underlying.getQuote),
    pay: vi.fn(underlying.pay),
    reconcile: vi.fn(underlying.reconcile),
  };
  const deps = {
    ...h.deps,
    catalog,
    catalogAdmission: createGatewayAdmission(catalog),
    payments,
    judge,
  };
  const pipeline = createPipeline(deps);
  const app = createApp({ ...deps, pipeline });
  const mandate = await h.createMandate();
  const request = (path: string, token = mandate.token, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  const purchase = (patch: Partial<PayRequest> = {}): PayRequest => ({
    url,
    method: 'GET',
    expected_price: 10000,
    purpose: 'fetch_data',
    idempotency_key: randomUUID(),
    ...patch,
  });
  const pay = async (body = purchase(), token = mandate.token) => {
    const response = await request('/pay', token, {
      method: 'POST',
      headers: { 'Idempotency-Key': body.idempotency_key },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (response.status === 200 || response.status === 202) PayResponseSchema.parse(value);
    return { status: response.status, body: value as PayResponse };
  };
  const review = (id: string, outcome = 'approved', issue_grant = false) =>
    request(`/approvals/${id}`, ADMIN_TOKEN, {
      method: 'POST',
      body: JSON.stringify({ outcome, note: 'Reviewed request', issue_grant }),
    });
  const money = () =>
    h.db.sqlite
      .prepare('SELECT spent, reserved FROM mandates WHERE id = ?')
      .get(mandate.mandate_id) as { spent: number; reserved: number };
  const count = (table: string) =>
    (h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    ...h,
    app,
    deps,
    pipeline,
    mandate,
    payments,
    store,
    request,
    purchase,
    pay,
    review,
    money,
    count,
  };
}

describe('/pay mixed Chunk 2/3 pipeline', () => {
  it('requires authentication and matching UUIDv4 header/body before contact', async () => {
    const h = await fixture();
    for (const headers of [
      {},
      { 'Idempotency-Key': randomUUID() },
      { 'Idempotency-Key': 'bad' },
    ] as Record<string, string>[]) {
      expect(
        (
          await h.request('/pay', h.mandate.token, {
            method: 'POST',
            headers,
            body: JSON.stringify(h.purchase()),
          })
        ).status,
      ).toBe(400);
    }
    expect((await h.pay(h.purchase(), 'invalid')).status).toBe(401);
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    expect(h.count('decisions')).toBe(0);
  });

  it.each([
    ['http://localhost:4199/steal?x=hello', 'BAD_URL', 'denied'],
    ['https://attacker.test/steal', 'UNCATALOGED_ENDPOINT', 'pending'],
    ['https://attacker.test/steal?x=hello', 'UNCATALOGED_ENDPOINT', 'pending'],
    ['http://localhost:4101/unknown', 'UNCATALOGED_ENDPOINT', 'pending'],
    ['http://localhost:4101/v1/pricing/other', 'SUBJECT_NOT_IN_MANDATE', 'pending'],
    [url + '&extra=hello', 'PARAM_NOT_IN_SCHEMA', 'pending'],
    [url + '&token=sk-secret', 'SECRET_IN_URL', 'denied'],
    [url + '&period=90d', 'DUPLICATE_PARAM', 'denied'],
    ['https://example.test/a/../b', 'BAD_URL', 'denied'],
  ])('pre-contact holds %s with zero quote/judge/payment calls', async (target, reason, status) => {
    const judge = createStubJudge('stub-approve');
    const spy = vi.spyOn(judge, 'buildInput');
    const h = await fixture(judge);
    const response = await h.pay(h.purchase({ url: target }));
    expect(response.body.status).toBe(status);
    const row = h.db.sqlite
      .prepare('SELECT reasons_json FROM decisions WHERE id = ?')
      .get(response.body.decision_id) as { reasons_json: string };
    expect(JSON.parse(row.reasons_json)).toContain(reason);
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(h.payments.pay).not.toHaveBeenCalled();
    expect(h.money()).toEqual({ spent: 0, reserved: 0 });
  });

  it('human approval cannot bypass unknown-route admission', async () => {
    const h = await fixture();
    const first = await h.pay(h.purchase({ url: 'https://attacker.test/steal' }));
    expect((await h.review(first.body.decision_id)).status).toBe(200);
    expect(h.pipeline.replay(first.body.decision_id).status).toBe('pending');
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('signs only after a committed approval; replay is exact and does not update trust twice', async () => {
    const h = await fixture();
    const originalPay = h.payments.pay.getMockImplementation()!;
    h.payments.pay.mockImplementation(async (id, quote) => {
      expect(
        h.db.sqlite
          .prepare(
            'SELECT outcome FROM decisions WHERE id = (SELECT decision_id FROM payments WHERE id = ?)',
          )
          .get(id),
      ).toEqual({ outcome: 'approved' });
      return originalPay(id, quote);
    });
    const purchase = h.purchase();
    const first = await h.pay(purchase);
    expect(first.body.status).toBe('approved');
    expect(await h.pay(purchase)).toEqual(first);
    expect(h.money()).toEqual({ spent: 10000, reserved: 0 });
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
    expect(h.count('payments')).toBe(1);
    expect(h.count('trust_events')).toBe(1);
  });

  it('claims concurrent same-key requests before quote and returns an immediate processing handle', async () => {
    const h = await fixture();
    const barrier = deferred<Quote>();
    const started = deferred<void>();
    h.payments.getQuote.mockImplementation(async (target, method) => {
      started.resolve();
      return barrier.promise.then((q) => ({ ...q, url: target, method }));
    });
    const purchase = h.purchase();
    const first = h.pay(purchase);
    await started.promise;
    const duplicate = await h.pay(purchase);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.status).toBe('pending');
    const otherWorker = createPipeline(h.deps);
    const conflict = await otherWorker.run(
      (await import('../../src/db/repos/mandates.js'))
        .createMandateRepo(h.db)
        .findActiveByTokenHash(
          (await import('../../src/auth.js')).hashToken(h.mandate.token),
          h.clock.now(),
        )!,
      { ...purchase, purpose: 'other' },
    );
    expect(conflict).toEqual({ conflict: true });
    const canonical = createCanonicalizer(h.deps.catalog)(url);
    expect(canonical.ok).toBe(true);
    barrier.resolve({
      url: canonical.ok ? canonical.url : url,
      method: 'GET',
      amount: 10000,
      network: 'eip155:84532',
      payee: h.deps.catalog.merchants[0]!.payee,
      raw: {},
    });
    expect((await first).body.status).toBe('approved');
    expect(h.payments.getQuote).toHaveBeenCalledTimes(1);
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
    expect(h.count('decisions')).toBe(1);
    expect(h.count('payments')).toBe(1);
  });

  it.each(['url', 'purpose', 'expected_price', 'method'] as const)(
    'conflicts when %s changes under the same key',
    async (field) => {
      const h = await fixture();
      const purchase = h.purchase();
      await h.pay(purchase);
      const changes = {
        url: url + '&extra=x',
        purpose: 'other',
        expected_price: 11000,
        method: 'POST',
      };
      expect((await h.pay({ ...purchase, [field]: changes[field] } as PayRequest)).status).toBe(
        409,
      );
      expect(h.payments.getQuote).toHaveBeenCalledTimes(1);
      expect(h.payments.pay).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['JUDGE_ERROR', 'JUDGE_INVALID_OUTPUT', 'builder'] as const)(
    'releases unsigned holds exactly once on %s',
    async (failure) => {
      const judge = createStubJudge('stub-approve');
      if (failure === 'builder')
        judge.buildInput = () => {
          throw new Error('SECRET');
        };
      else
        judge.judge = async () => {
          throw new JudgeError(failure);
        };
      const h = await fixture(judge);
      const purchase = h.purchase();
      const result = await h.pay(purchase);
      expect(result.body).toMatchObject({
        status: 'denied',
        reasons: [failure === 'builder' ? 'JUDGE_ERROR' : failure],
      });
      await h.pay(purchase);
      expect(h.money()).toEqual({ spent: 0, reserved: 0 });
      expect(h.payments.pay).not.toHaveBeenCalled();
      expect(h.db.sqlite.prepare('SELECT state FROM payments').get()).toEqual({ state: 'FAILED' });
    },
  );

  it.each([19, 20, 39, 40, 59, 60])('routes trust score %s correctly', async (score) => {
    const judge = createStubJudge('stub-approve');
    const spy = vi.spyOn(judge, 'judge');
    const h = await fixture(judge);
    h.db.sqlite
      .prepare('UPDATE sessions SET trust = ? WHERE id = ?')
      .run(score, h.mandate.session_id);
    const result = await h.pay();
    expect(result.body.status).toBe(score < 20 ? 'denied' : score < 40 ? 'pending' : 'approved');
    expect(spy).toHaveBeenCalledTimes(score >= 40 ? 1 : 0);
    expect(h.payments.pay).toHaveBeenCalledTimes(score >= 40 ? 1 : 0);
    expect(h.money().reserved).toBe(score >= 20 && score < 40 ? 10000 : 0);
  });

  it.each(['tier0', 'off-task'] as const)(
    'requires human review when a concurrent %s denial lowers trust while the judge is pending',
    async (cause) => {
      const started = deferred<void>();
      const waiting = deferred<unknown>();
      const judge = createInjectedJudge({
        judge: async () => {
          started.resolve();
          return waiting.promise;
        },
      });
      const h = await fixture(judge);
      h.db.sqlite.prepare('UPDATE sessions SET trust = 40 WHERE id = ?').run(h.mandate.session_id);
      const pending = h.pay();
      await started.promise;
      if (cause === 'tier0') {
        expect((await h.pay(h.purchase({ expected_price: 1 }))).body).toMatchObject({
          status: 'denied',
          reasons: ['PRICE_MISMATCH'],
        });
      } else {
        // A separate endpoint has its own renewal lock and can judge concurrently.
        vi.spyOn(judge, 'judge').mockResolvedValueOnce({
          decision: 'deny',
          reasons: ['JUDGE_OFF_TASK'],
          explanation: '',
          injection_suspected: false,
        });
        expect(
          (
            await h.pay(
              h.purchase({
                url: 'http://localhost:4101/v1/pricing/export',
                method: 'POST',
              }),
            )
          ).body,
        ).toMatchObject({ status: 'denied', reasons: ['JUDGE_OFF_TASK'] });
      }
      expect(
        h.db.sqlite.prepare('SELECT trust FROM sessions WHERE id = ?').get(h.mandate.session_id),
      ).toEqual({ trust: cause === 'tier0' ? 35 : 25 });
      waiting.resolve({
        decision: 'approve',
        reasons: ['JUDGE_APPROVED'],
        explanation: '',
        injection_suspected: false,
        grant: { max_per_call: 10000, max_total: 10000, ttl_ms: 60000 },
      });
      const result = await pending;
      expect(result.body.status).toBe('pending');
      expect(
        h.db.sqlite
          .prepare('SELECT stage, reasons_json FROM decisions WHERE id = ?')
          .get(result.body.decision_id),
      ).toEqual({ stage: 'human', reasons_json: '["TRUST_REQUIRES_HUMAN"]' });
      expect(h.payments.pay).not.toHaveBeenCalled();
      expect(h.count('grants')).toBe(0);
      expect(h.money()).toEqual({ spent: 0, reserved: 10000 });
      expect((await h.review(result.body.decision_id)).status).toBe(200);
      expect(h.pipeline.replay(result.body.decision_id).status).toBe('approved');
      expect(h.payments.pay).toHaveBeenCalledTimes(1);
    },
  );

  it('atomically caps concurrent approvals for distinct new payees and permits explicit review', async () => {
    const waiting = deferred<JudgeOutput>();
    const started = deferred<void>();
    let calls = 0;
    const h = await fixture(
      createInjectedJudge({
        judge: async () => {
          if (++calls === 3) started.resolve();
          return waiting.promise;
        },
      }),
    );
    h.db.sqlite.prepare('UPDATE sessions SET trust = 50 WHERE id = ?').run(h.mandate.session_id);
    h.db.sqlite
      .prepare('UPDATE mandates SET allowed_merchants_json = ? WHERE id = ?')
      .run(JSON.stringify(['mer_pricing', 'mer_weather', 'mer_news']), h.mandate.mandate_id);
    // Two approved payees precede three overlapping judge calls, all of which see room initially.
    for (const payee of [
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
    ]) {
      const id = createDecision(h.db, h.clock, {
        mandateId: h.mandate.mandate_id,
        sessionId: h.mandate.session_id,
      });
      h.db.sqlite
        .prepare(
          "UPDATE decisions SET stage = 'judge', outcome = 'approved', payee = ? WHERE id = ?",
        )
        .run(payee, id);
    }
    const pending = [
      url,
      'http://localhost:4102/v1/forecast?city=acme&units=metric',
      'http://localhost:4103/v1/headlines?topic=acme',
    ].map((target) => h.pay(h.purchase({ url: target })));
    await started.promise;
    expect(h.money().reserved).toBe(30000);
    waiting.resolve({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
    });
    const results = await Promise.all(pending);
    expect(results.map((result) => result.body.status).sort()).toEqual([
      'approved',
      'pending',
      'pending',
    ]);
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
    expect(h.money()).toEqual({ spent: 10000, reserved: 20000 });
    for (const result of results.filter((result) => result.body.status === 'pending')) {
      expect(
        h.db.sqlite
          .prepare('SELECT reasons_json FROM decisions WHERE id = ?')
          .get(result.body.decision_id),
      ).toEqual({ reasons_json: '["NEW_PAYEE_LIMIT"]' });
      expect((await h.review(result.body.decision_id)).status).toBe(200);
      expect(h.pipeline.replay(result.body.decision_id).status).toBe('approved');
    }
    expect(h.payments.pay).toHaveBeenCalledTimes(3);
    expect(h.money()).toEqual({ spent: 30000, reserved: 0 });
  });

  it('injection overrides approval, persists quarantine, strips grant and prevents further quotes', async () => {
    const h = await fixture(
      createInjectedJudge({
        judge: async () => ({
          decision: 'approve',
          reasons: ['JUDGE_APPROVED'],
          explanation: '',
          injection_suspected: true,
          grant: { max_per_call: 10000, max_total: 100000, ttl_ms: 1000 },
        }),
      }),
    );
    expect((await h.pay()).body).toMatchObject({
      status: 'denied',
      reasons: ['JUDGE_INJECTION_SUSPECTED'],
    });
    expect(
      h.db.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(h.mandate.session_id),
    ).toEqual({ status: 'quarantined' });
    expect((await h.pay()).body).toMatchObject({ status: 'denied', reasons: ['QUARANTINED'] });
    expect(h.payments.getQuote).toHaveBeenCalledTimes(1);
    expect(h.payments.pay).not.toHaveBeenCalled();
    expect(h.count('grants')).toBe(0);
    expect(h.money()).toEqual({ spent: 0, reserved: 0 });
  });

  it('rejects a mandate closed during the model call without signing', async () => {
    const waiting = deferred<unknown>();
    const started = deferred<void>();
    const h = await fixture(
      createInjectedJudge({
        judge: async () => {
          started.resolve();
          return waiting.promise;
        },
      }),
    );
    const response = h.pay();
    await started.promise;
    expect(h.money().reserved).toBe(10000);
    await h.closeMandate(h.mandate.mandate_id);
    waiting.resolve({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
    });
    expect((await response).body.status).toBe('denied');
    expect(h.payments.pay).not.toHaveBeenCalled();
    expect(h.money()).toEqual({ spent: 0, reserved: 0 });
  });

  it.each(['rejected', 'timeout', 'approved'])(
    'durable human %s resolves a held reservation once',
    async (outcome) => {
      const h = await fixture(createStubJudge('stub-escalate'));
      const result = await h.pay();
      expect(result.body.status).toBe('pending');
      expect(h.money().reserved).toBe(10000);
      if (outcome === 'timeout') {
        h.clock.advance(600001);
        await h.pipeline.sweep();
      } else expect((await h.review(result.body.decision_id, outcome)).status).toBe(200);
      expect(h.pipeline.replay(result.body.decision_id).status).toBe(
        outcome === 'approved' ? 'approved' : 'denied',
      );
      expect(h.money()).toEqual({ spent: outcome === 'approved' ? 10000 : 0, reserved: 0 });
      expect((await h.review(result.body.decision_id, 'approved')).status).toBe(409);
      await h.pipeline.sweep();
      expect(h.payments.pay).toHaveBeenCalledTimes(outcome === 'approved' ? 1 : 0);
      expect(h.count('approvals')).toBe(1);
    },
  );

  it('rechecks hard caps and unchanged quote on human continuation', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay();
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      amount: 20000,
    }));
    await h.review(first.body.decision_id);
    expect(h.pipeline.replay(first.body.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['PRICE_MISMATCH'],
    });
    expect(h.money().reserved).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('clamps oversized proposals, derives bindings, skips judge on exact grant hit and rejects method/endpoint reuse', async () => {
    const provider = vi.fn(async () => ({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
      grant: {
        max_per_call: Number.MAX_SAFE_INTEGER,
        max_total: Number.MAX_SAFE_INTEGER,
        ttl_ms: Number.MAX_SAFE_INTEGER,
      },
    }));
    const h = await fixture(createInjectedJudge({ judge: provider }));
    expect((await h.pay()).body.status).toBe('approved');
    const grant = h.db.sqlite.prepare('SELECT * FROM grants').get() as Record<string, unknown>;
    expect(grant).toMatchObject({
      mandate_id: h.mandate.mandate_id,
      endpoint_id: 'end_pricing_get',
      method: 'GET',
      origin: 'http://localhost:4101',
      max_per_call: 20000,
      max_total: 1990000,
    });
    expect(grant.expires_at).toBe(
      (
        h.db.sqlite
          .prepare('SELECT expires_at FROM mandates WHERE id = ?')
          .get(h.mandate.mandate_id) as { expires_at: number }
      ).expires_at,
    );
    h.clock.advance(11000);
    expect((await h.pay()).body).toMatchObject({ status: 'approved', stage: 'tier1' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      (await h.pay(h.purchase({ method: 'POST', url: 'http://localhost:4101/v1/pricing/export' })))
        .body.status,
    ).toBe('approved');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('keeps the first reference price and escalates a price ratchet', async () => {
    const h = await fixture();
    await h.pay();
    h.clock.advance(11000);
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      amount: 40000,
    }));
    expect((await h.pay(h.purchase({ expected_price: 40000 }))).body.status).toBe('pending');
    expect(h.db.sqlite.prepare('SELECT price FROM reference_prices').get()).toEqual({
      price: 10000,
    });
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
  });

  it('enforces parallel budget admission with exactly four 500000 payments', async () => {
    const h = await fixture();
    const subjects = Array.from({ length: 10 }, (_, i) => `company${i}`);
    h.db.sqlite
      .prepare('UPDATE mandates SET subjects_json = ? WHERE id = ?')
      .run(JSON.stringify(subjects), h.mandate.mandate_id);
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      amount: 500000,
    }));
    const results = await Promise.all(
      subjects.map((subject) =>
        h.pay(
          h.purchase({
            url: `http://localhost:4101/v1/pricing/${subject}`,
            expected_price: 500000,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.body.status === 'approved')).toHaveLength(4);
    expect(h.payments.pay).toHaveBeenCalledTimes(4);
    expect(h.money()).toEqual({ spent: 2000000, reserved: 0 });
  });

  it('restricts decision/payment polling to the owning mandate or admin and rejects digest/revoked tokens', async () => {
    const h = await fixture();
    const first = await h.pay();
    expect(first.body.status).toBe('approved');
    const paymentId = first.body.status === 'approved' ? first.body.payment_id : '';
    const second = await h.createMandate();
    for (const path of [`/decisions/${first.body.decision_id}`, `/payments/${paymentId}`]) {
      expect((await h.request(path)).status).toBe(200);
      expect((await h.request(path, second.token)).status).toBe(404);
      expect((await h.request(path, ADMIN_TOKEN)).status).toBe(200);
      expect(
        (await h.request(path, (await import('../../src/auth.js')).hashToken(h.mandate.token)))
          .status,
      ).toBe(401);
    }
    await h.closeMandate(h.mandate.mandate_id);
    expect((await h.request(`/decisions/${first.body.decision_id}`)).status).toBe(401);
  });

  it('retains an unknown submitted payment and recovers settlement without another signature', async () => {
    const h = await fixture();
    h.payments.pay.mockImplementation(async (id) => {
      await h.store.markSigned(id, {
        nonce: 'stable',
        validBefore: h.clock.now() + 1000,
        authorizationJson: '{}',
      });
      await h.store.markSubmitted(id);
      await h.store.markUnknown(id);
      throw new Error('Lost response');
    });
    const purchase = h.purchase();
    const first = await h.pay(purchase);
    expect(first.body.status).toBe('payment_unknown');
    expect(h.money()).toEqual({ spent: 0, reserved: 10000 });
    const restarted = createPipeline(h.deps);
    restarted.recover();
    expect(restarted.replay(first.body.decision_id).status).toBe('payment_unknown');
    const p = h.db.sqlite.prepare('SELECT id FROM payments').get() as { id: string };
    await h.store.settle(p.id, '0xconfirmed');
    expect((await h.pay(purchase)).body).toMatchObject({ status: 'approved', response: null });
    expect(h.money()).toEqual({ spent: 10000, reserved: 0 });
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
  });

  it('captures the actual real-adapter payload without token/hash/untrusted canaries', async () => {
    const calls: string[] = [];
    const judge = createJudge(
      { model: 'claude-sonnet-4-5-20250929', apiKey: 'fixture-provider-key', timeoutMs: 5000 },
      {
        fetch: async (_url, init) => {
          calls.push(String(init?.body));
          return Response.json({
            type: 'message',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  decision: 'approve',
                  reasons: ['JUDGE_APPROVED'],
                  explanation: '',
                  injection_suspected: false,
                }),
              },
            ],
          });
        },
      },
    );
    const h = await fixture(judge);
    const first = await h.pay(h.purchase({ url: url + '&extra=CANARY_AGENT_TEXT' }));
    expect(calls).toHaveLength(0);
    await h.review(first.body.decision_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('CANARY_AGENT_TEXT');
    expect(calls[0]).not.toContain(h.mandate.token);
    expect(calls[0]).not.toContain((await import('../../src/auth.js')).hashToken(h.mandate.token));
    expect(calls[0]).not.toContain('localhost');
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
  });

  it('allows a pre-contact review followed by a separate judge review with immutable review history', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay(h.purchase({ url: url + '&extra=hello' }));
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    await h.review(first.body.decision_id);
    expect(h.pipeline.replay(first.body.decision_id).status).toBe('pending');
    expect(h.money().reserved).toBe(10000);
    expect((await h.review(first.body.decision_id)).status).toBe(200);
    expect(h.pipeline.replay(first.body.decision_id).status).toBe('approved');
    expect(h.count('pay_review_events')).toBe(2);
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
    expect(h.count('grants')).toBe(0);
  });

  it('makes approval/timeout races single-winner and blocks late completion', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay();
    h.clock.advance(600001);
    const responses = await Promise.all([
      h.review(first.body.decision_id),
      h.review(first.body.decision_id, 'rejected'),
      h.pipeline.sweep(),
    ]);
    expect((responses[0] as Response).status).toBe(409);
    expect(h.pipeline.replay(first.body.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['HUMAN_TIMEOUT'],
    });
    expect(h.money().reserved).toBe(0);
    expect(h.count('approvals')).toBe(1);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('times out a model, releases its hold and discards a later approval', async () => {
    vi.useFakeTimers();
    try {
      const waiting = deferred<unknown>();
      const started = deferred<void>();
      const h = await fixture(
        createInjectedJudge({
          judge: async () => {
            started.resolve();
            return waiting.promise;
          },
        }),
      );
      const response = h.pay();
      await started.promise;
      expect(h.money().reserved).toBe(10000);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await response).body).toMatchObject({ status: 'denied', reasons: ['JUDGE_ERROR'] });
      waiting.resolve({
        decision: 'approve',
        reasons: ['JUDGE_APPROVED'],
        explanation: '',
        injection_suspected: false,
      });
      await Promise.resolve();
      expect(h.money()).toEqual({ spent: 0, reserved: 0 });
      expect(h.payments.pay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timeout sweep wins against an in-flight worker without releasing submitted money', async () => {
    const waiting = deferred<unknown>();
    const started = deferred<void>();
    const h = await fixture(
      createInjectedJudge({
        judge: async () => {
          started.resolve();
          return waiting.promise;
        },
      }),
    );
    const response = h.pay();
    await started.promise;
    h.clock.advance(600001);
    await h.pipeline.sweep();
    waiting.resolve({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
    });
    expect((await response).body).toMatchObject({ status: 'denied', reasons: ['HUMAN_TIMEOUT'] });
    expect(h.money().reserved).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it.each([
    ['network', 'NETWORK'],
    ['payee', 'PAYEE_SWAP'],
    ['cap', 'PER_CALL_CAP'],
    ['expected', 'PRICE_MISMATCH'],
    ['negative', 'QUOTE_INVALID'],
  ])('denies a %s quote before judge/signing', async (kind, reason) => {
    const judge = createStubJudge('stub-approve');
    const called = vi.spyOn(judge, 'judge');
    const h = await fixture(judge);
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      ...(kind === 'network'
        ? { network: 'eip155:1' }
        : kind === 'payee'
          ? { payee: '0x4444444444444444444444444444444444444444' as const }
          : { amount: kind === 'cap' ? 1000001 : kind === 'negative' ? -1 : 12000 }),
    }));
    expect((await h.pay()).body).toMatchObject({ status: 'denied', reasons: [reason] });
    expect(called).not.toHaveBeenCalled();
    expect(h.payments.pay).not.toHaveBeenCalled();
    expect(h.money()).toEqual({ spent: 0, reserved: 0 });
  });

  it('independently enforces duplicate attempts and velocity windows', async () => {
    const h = await fixture();
    await h.pay();
    await h.pay();
    expect((await h.pay()).body).toMatchObject({ status: 'denied', reasons: ['DUPLICATE'] });
    h.db.sqlite.prepare('UPDATE roles SET velocity_per_min = 3').run();
    expect((await h.pay()).body).toMatchObject({ status: 'denied', reasons: ['VELOCITY'] });
    h.clock.advance(60001);
    expect((await h.pay()).body.status).toBe('approved');
  });

  it('isolates same keys and grants across mandates', async () => {
    const judge = createInjectedJudge({
      judge: async () => ({
        decision: 'approve',
        reasons: ['JUDGE_APPROVED'],
        explanation: '',
        injection_suspected: false,
        grant: { max_per_call: 10000, max_total: 100000, ttl_ms: 60000 },
      }),
    });
    const called = vi.spyOn(judge, 'judge');
    const h = await fixture(judge);
    const purchase = h.purchase();
    await h.pay(purchase);
    const other = await h.createMandate();
    expect((await h.pay(purchase, other.token)).body).toMatchObject({
      status: 'approved',
      stage: 'judge',
    });
    expect(called).toHaveBeenCalledTimes(2);
    expect(h.payments.pay).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('standing grants require merchant selection (%s)', async (selected) => {
    const judge = createStubJudge('stub-approve');
    const called = vi.spyOn(judge, 'judge');
    const h = await fixture(judge);
    h.db.sqlite
      .prepare('UPDATE mandates SET subjects_json = ?, allowed_merchants_json = ? WHERE id = ?')
      .run(
        '["paris"]',
        JSON.stringify(selected ? ['mer_weather'] : ['mer_pricing']),
        h.mandate.mandate_id,
      );
    const result = await h.pay(
      h.purchase({ url: 'http://localhost:4102/v1/forecast?city=paris&units=metric' }),
    );
    expect(result.body).toMatchObject({ status: 'approved', stage: selected ? 'tier1' : 'judge' });
    expect(called).toHaveBeenCalledTimes(selected ? 0 : 1);
  });

  it('options and subject membership remain exact even after human review', async () => {
    const provider = vi.fn(async () => ({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
      grant: { max_per_call: 10000, max_total: 100000, ttl_ms: 60000 },
    }));
    const h = await fixture(createInjectedJudge({ judge: provider }));
    await h.pay();
    h.clock.advance(11000);
    expect((await h.pay(h.purchase({ url: url.replace('30d', '90d') }))).body).toMatchObject({
      status: 'approved',
      stage: 'judge',
    });
    const first = await h.pay(h.purchase({ url: url.replace('acme', 'outsider') }));
    expect(first.body.status).toBe('pending');
    await h.review(first.body.decision_id, 'approved', true);
    expect(h.pipeline.replay(first.body.decision_id).status).toBe('approved');
    expect(h.count('grants')).toBe(2);
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('serializes grant renewal so concurrent misses use the new grant after one judge call', async () => {
    const barrier = deferred<unknown>();
    const started = deferred<void>();
    const provider = vi.fn(async () => {
      started.resolve();
      return barrier.promise;
    });
    const h = await fixture(createInjectedJudge({ judge: provider }));
    const first = h.pay();
    await started.promise;
    const second = h.pay();
    barrier.resolve({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
      grant: { max_per_call: 10000, max_total: 100000, ttl_ms: 60000 },
    });
    expect((await first).body.status).toBe('approved');
    expect((await second).body.status).toBe('approved');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(h.payments.pay).toHaveBeenCalledTimes(2);
  });

  it('persists restart recovery for review deadlines and invalidates saved catalog revisions', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay();
    const restarted = createPipeline(h.deps);
    expect(restarted.replay(first.body.decision_id).status).toBe('pending');
    h.db.sqlite
      .prepare("UPDATE pay_workflows SET catalog_revision = 'old-policy' WHERE decision_id = ?")
      .run(first.body.decision_id);
    await restarted.review(first.body.decision_id, {
      outcome: 'approved',
      note: 'Review',
      issue_grant: false,
    });
    expect(restarted.replay(first.body.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['INTERNAL_ERROR'],
    });
    expect(h.money().reserved).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('recovers a crash after approval but before signing without starting another payment', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay();
    h.db.sqlite
      .prepare("UPDATE decisions SET outcome = 'approved' WHERE id = ?")
      .run(first.body.decision_id);
    h.db.sqlite
      .prepare(
        "UPDATE pay_workflows SET state = 'AUTHORIZED', response_json = NULL WHERE decision_id = ?",
      )
      .run(first.body.decision_id);
    const restarted = createPipeline(h.deps);
    restarted.recover();
    expect(restarted.replay(first.body.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['INTERNAL_ERROR'],
    });
    expect(h.money().reserved).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('does not cache a pending result when payment fails before signing', async () => {
    const h = await fixture();
    h.payments.pay.mockRejectedValue(new Error('signer failed'));
    const purchase = h.purchase();
    const result = await h.pay(purchase);
    expect(result.body).toMatchObject({ status: 'denied', reasons: ['INTERNAL_ERROR'] });
    expect(await h.pay(purchase)).toEqual(result);
    expect(h.money().reserved).toBe(0);
  });

  it('redacts encoded secrets in every persisted request record', async () => {
    const h = await fixture();
    const response = await h.pay(h.purchase({ url: url + '&email=private%40example.com' }));
    expect(response.body).toMatchObject({ status: 'denied', reasons: ['SECRET_IN_URL'] });
    const record = JSON.stringify(
      h.db.sqlite
        .prepare(
          'SELECT d.canonical_url, d.request_json, w.request_json AS saved FROM decisions d JOIN pay_workflows w ON w.decision_id = d.id',
        )
        .get(),
    );
    expect(record).not.toContain('private');
    expect(h.logs.join('')).not.toContain('private');
  });

  it('resolves a closed mandate human hold immediately and never releases unknown submission', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const held = await h.pay();
    await h.request(`/mandates/${h.mandate.mandate_id}/close`, ADMIN_TOKEN, {
      method: 'POST',
      body: '{}',
    });
    expect(h.pipeline.replay(held.body.decision_id)).toMatchObject({
      status: 'denied',
      reasons: ['NO_MANDATE'],
    });
    expect(h.money().reserved).toBe(0);
  });

  it('rolls reservation back when tenant accounting or payment insertion fails', async () => {
    const h = await fixture();
    h.db.sqlite.exec(
      "CREATE TRIGGER fail_payment_insert BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'fixture disk boundary'); END",
    );
    expect((await h.pay()).body).toMatchObject({ status: 'denied', reasons: ['INTERNAL_ERROR'] });
    expect(h.money()).toEqual({ spent: 0, reserved: 0 });
    expect(h.count('payments')).toBe(0);
    expect(h.count('tenant_daily')).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('keeps a winning approval when its continuation crosses the original review deadline', async () => {
    const h = await fixture(createStubJudge('stub-escalate'));
    const first = await h.pay();
    h.clock.advance(599999);
    const barrier = deferred<Quote>();
    const started = deferred<void>();
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => {
      started.resolve();
      return barrier.promise.then(async () => get(...args));
    });
    const approved = h.review(first.body.decision_id);
    await started.promise;
    h.clock.advance(2);
    await h.pipeline.sweep();
    barrier.resolve({} as Quote);
    expect((await approved).status).toBe(200);
    expect(h.pipeline.replay(first.body.decision_id).status).toBe('approved');
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
    expect(h.count('approvals')).toBe(1);
  });

  it.each([
    ['A2', 'http://localhost:4103/v1/headlines?topic=acme', 'GET', 'fetch_data'],
    ['A3', url, 'GET', 'subscribe'],
    ['A14', 'http://localhost:4102/v1/forecast?city=acme&units=metric', 'GET', 'fetch_data'],
    ['A17', 'http://localhost:4101/v1/pricing/export', 'POST', 'fetch_data'],
  ] as const)(
    '%s reaches the judge when catalog-admitted and no grant applies',
    async (_id, target, method, purpose) => {
      const provider = vi.fn(async () => ({
        decision: 'deny',
        reasons: ['JUDGE_OFF_TASK'],
        explanation: '',
        injection_suspected: false,
      }));
      const h = await fixture(createInjectedJudge({ judge: provider }));
      expect((await h.pay(h.purchase({ url: target, method, purpose }))).body).toMatchObject({
        status: 'denied',
        reasons: ['JUDGE_OFF_TASK'],
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(h.payments.getQuote).toHaveBeenCalledTimes(1);
      expect(h.payments.pay).not.toHaveBeenCalled();
      expect(h.money().reserved).toBe(0);
    },
  );

  it('a changed catalog-bound admission dependency fails startup composition', async () => {
    const h = await fixture();
    expect(() =>
      createPipeline({
        ...h.deps,
        catalogAdmission: createGatewayAdmission(loadCatalog(FIXTURE_CATALOG_PATH)),
      }),
    ).toThrow('CATALOG_SNAPSHOT_MISMATCH');
  });

  it('recovers idempotency bindings and exact settled replay through a new SQLite connection', async () => {
    const { openDb } = await import('../../src/db/client.js');
    const { createMandateRepo } = await import('../../src/db/repos/mandates.js');
    const { hashToken } = await import('../../src/auth.js');
    const h = await fixture();
    const purchase = h.purchase();
    const first = await h.pay(purchase);
    const reopened = openDb(h.db.sqlite.name);
    try {
      const restarted = createPipeline({ ...h.deps, db: reopened });
      restarted.recover();
      const agent = createMandateRepo(reopened).findActiveByTokenHash(
        hashToken(h.mandate.token),
        h.clock.now(),
      )!;
      expect(await restarted.run(agent, purchase)).toEqual({
        response: first.body,
        processing: false,
      });
      expect(h.payments.getQuote).toHaveBeenCalledTimes(1);
      expect(h.payments.pay).toHaveBeenCalledTimes(1);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('refuses new work when durable coordination is unavailable', async () => {
    const { openDb } = await import('../../src/db/client.js');
    const h = await fixture();
    const other = openDb(h.db.sqlite.name);
    const restarted = createPipeline({ ...h.deps, db: other });
    const app = createApp({ ...h.deps, db: other, pipeline: restarted });
    other.sqlite.close();
    const purchase = h.purchase();
    const response = await app.request('/pay', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.mandate.token}`,
        'Idempotency-Key': purchase.idempotency_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(purchase),
    });
    expect(response.status).toBe(500);
    expect(h.payments.getQuote).not.toHaveBeenCalled();
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('rechecks role caps changed during a model call and releases the unsigned hold', async () => {
    const waiting = deferred<unknown>();
    const started = deferred<void>();
    const h = await fixture(
      createInjectedJudge({
        judge: async () => {
          started.resolve();
          return waiting.promise;
        },
      }),
    );
    const response = h.pay();
    await started.promise;
    h.db.sqlite.prepare('UPDATE roles SET per_call_cap = 9999').run();
    waiting.resolve({
      decision: 'approve',
      reasons: ['JUDGE_APPROVED'],
      explanation: '',
      injection_suspected: false,
    });
    expect((await response).body).toMatchObject({ status: 'denied', reasons: ['PER_CALL_CAP'] });
    expect(h.money().reserved).toBe(0);
    expect(h.payments.pay).not.toHaveBeenCalled();
  });

  it('normalizes UUID case so the same logical key cannot purchase twice', async () => {
    const h = await fixture();
    const purchase = h.purchase();
    const first = await h.pay(purchase);
    expect(
      await h.pay({ ...purchase, idempotency_key: purchase.idempotency_key.toUpperCase() }),
    ).toEqual(first);
    expect(h.payments.pay).toHaveBeenCalledTimes(1);
  });

  it('admits exactly twenty 50000 purchases against a 1000000 mandate when rate limits are isolated', async () => {
    const h = await fixture();
    h.db.sqlite
      .prepare('UPDATE mandates SET budget = 1000000 WHERE id = ?')
      .run(h.mandate.mandate_id);
    h.db.sqlite.prepare('UPDATE roles SET velocity_per_min = 100').run();
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      amount: 50000,
    }));
    const statuses: string[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await h.pay(h.purchase({ expected_price: 50000 }))).body.status);
      h.clock.advance(11000);
    }
    expect(statuses.filter((s) => s === 'approved')).toHaveLength(20);
    expect(h.payments.pay).toHaveBeenCalledTimes(20);
    expect(h.money()).toEqual({ spent: 1000000, reserved: 0 });
  });

  it('atomically caps parallel exposure across separate mandates in one tenant', async () => {
    const h = await fixture();
    h.db.sqlite.prepare('UPDATE tenants SET daily_cap = 2000000').run();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => h.createMandate()));
    const get = h.payments.getQuote.getMockImplementation()!;
    h.payments.getQuote.mockImplementation(async (...args) => ({
      ...(await get(...args)),
      amount: 500000,
    }));
    const responses = await Promise.all(
      tokens.map((m) => h.pay(h.purchase({ expected_price: 500000 }), m.token)),
    );
    expect(responses.filter((r) => r.body.status === 'approved')).toHaveLength(4);
    expect(h.payments.pay).toHaveBeenCalledTimes(4);
    expect(
      h.db.sqlite
        .prepare('SELECT SUM(spent) AS spent, SUM(reserved) AS reserved FROM mandates')
        .get(),
    ).toEqual({ spent: 2000000, reserved: 0 });
  });
});
