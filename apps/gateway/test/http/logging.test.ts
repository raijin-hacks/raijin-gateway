import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PayRequest, PaymentsModule, Quote } from '@apf/contracts';
import { createApp } from '../../src/app.js';
import { loadCatalog } from '../../src/catalog/index.js';
import { createGatewayAdmission } from '../../src/judge/gateway.js';
import { createInjectedJudge } from '../../src/judge/index.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { createMockPayments } from '../../src/mock-payments.js';
import { systemClock } from '../../src/clock.js';
import { createPayments, startReconciler } from '../../src/payments/index.js';
import { MemoryPaymentStore } from '../../src/payments/testing/memory-store.js';
import { createPipeline } from '../../src/pipeline/index.js';
import type { Transport } from '../../src/payments/transport.js';
import { ADMIN_TOKEN, createHarness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../harness/db.js';

const fakeChain = vi.hoisted(() => ({
  latestBlock: 50_000_000n,
  timestamp: 1_800_000_000n,
  used: false,
  errorMessage: '',
}));

vi.mock('viem', async (importOriginal) => {
  const original = await importOriginal<typeof import('viem')>();
  return {
    ...original,
    createPublicClient: () => ({
      getChainId: async () => 84532,
      getBlock: async (options: { blockNumber?: bigint; blockTag?: string }) => {
        const number =
          options.blockNumber ??
          (options.blockTag === 'finalized' ? fakeChain.latestBlock - 1n : fakeChain.latestBlock);
        return {
          number,
          timestamp: fakeChain.timestamp - (fakeChain.latestBlock - number),
        };
      },
      readContract: async () => {
        if (fakeChain.errorMessage) throw new Error(fakeChain.errorMessage);
        return fakeChain.used;
      },
      getLogs: async () => [],
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('logs never contain a token (S7)', () => {
  it('across creating, using, refusing and closing mandates', async () => {
    const h = createHarness();
    const first = await h.createMandate();
    await h.createMandate();
    // A mandate token on every admin route, a bad token, a malformed body, a close, a 404.
    await h.postMandate({}, first.token);
    await h.request('/catalog', { token: first.token });
    await h.request(`/mandates/${first.mandate_id}/close`, { method: 'POST', token: first.token });
    await h.request('/catalog', { token: 'not-the-admin-token' });
    await h.postMandate('{broken');
    await h.closeMandate(first.mandate_id);
    await h.request(`/nowhere?token=${first.token}`);

    expect(h.logs.length).toBeGreaterThan(5);
    const all = h.logs.join('\n');
    const leaked = [...h.issuedTokens, ADMIN_TOKEN]
      .map((token, index) => (all.includes(token) ? `token-${index}` : null))
      .filter((name): name is string => name !== null);
    expect(leaked).toEqual([]);
  });

  it('covers payments, approvals, polling and reconciliation without logging credentials', async () => {
    const h = createHarness();
    const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
    const store = createPaymentStore(h.db, h.clock);
    const walletPrivateKey = `0x${'1'.repeat(64)}` as `0x${string}`;
    const merchantPayees = catalog.merchants.map((merchant) => merchant.payee);
    const idempotencySecret = (await import('../../src/pipeline/idempotency.js')).bindingSecret(
      h.db,
    );
    const paymentSignatures: string[] = [];
    const authorizationSignatures: string[] = [];
    let agentToken = '';
    const paymentCredentialBundle = (header: string, signature: string) =>
      [walletPrivateKey, merchantPayees[0]!, header, signature].join(' ');
    const mock = createMockPayments(store, catalog, h.clock);
    const payments = {
      getQuote: vi.fn(mock.getQuote),
      pay: vi.fn(mock.pay),
      reconcile: vi.fn(mock.reconcile),
    };
    const judge = createInjectedJudge({
      async judge(input) {
        if (input.payment.purpose === 'fetch_report')
          return {
            decision: 'deny',
            reasons: ['JUDGE_OFF_TASK'],
            explanation: '',
            injection_suspected: false,
          };
        if (input.payment.purpose === 'other')
          return {
            decision: 'escalate',
            reasons: ['JUDGE_OVER_SCOPED'],
            explanation: '',
            injection_suspected: false,
          };
        return {
          decision: 'approve',
          reasons: ['JUDGE_APPROVED'],
          explanation: '',
          injection_suspected: false,
        };
      },
    });
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
    agentToken = mandate.token;
    fakeChain.timestamp = BigInt(Math.floor(systemClock.now() / 1000));

    const consoleLines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(' '));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleLines.push(args.map(String).join(' '));
    });
    try {
      const request = (path: string, token: string, init: RequestInit = {}) =>
        app.request(path, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...init.headers,
          },
        });
      const pay = async (subject: string, purpose: PayRequest['purpose'], key = randomUUID()) => {
        const body: PayRequest = {
          url: `http://localhost:4101/v1/pricing/${subject}?period=30d`,
          method: 'GET',
          expected_price: 10000,
          purpose,
          idempotency_key: key,
        };
        const response = await request('/pay', agentToken, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      const approvedKey = randomUUID();
      const approved = await pay('acme', 'fetch_data', approvedKey);
      expect(approved.body.status).toBe('approved');
      const replay = await pay('acme', 'fetch_data', approvedKey);
      expect(replay.body.status).toBe('approved');
      expect(payments.pay).toHaveBeenCalledTimes(1);

      const denied = await pay('globex', 'fetch_report');
      expect(denied.body).toMatchObject({ status: 'denied' });

      const escalated = await pay('initech', 'other');
      expect(escalated.body.status).toBe('pending');
      const decisionId = escalated.body.decision_id as string;
      const approval = await request(`/approvals/${decisionId}`, ADMIN_TOKEN, {
        method: 'POST',
        body: JSON.stringify({ outcome: 'approved', note: 'Reviewed request', issue_grant: false }),
      });
      expect(approval.status).toBe(200);

      const approvedPaymentId = approved.body.payment_id as string;
      expect((await request(`/decisions/${approved.body.decision_id}`, agentToken)).status).toBe(
        200,
      );
      expect((await request(`/payments/${approvedPaymentId}`, agentToken)).status).toBe(200);
      expect((await request(`/decisions/${decisionId}`, agentToken)).status).toBe(200);

      const held = await pay('hooli', 'fetch_data');
      // v1.4: the earlier off-task incident persists after a payment approval.
      // Explicitly review this purchase so the credential-redaction probe still exercises payment.
      expect(held.body.status).toBe('pending');
      expect(
        (
          await request(`/approvals/${held.body.decision_id}`, ADMIN_TOKEN, {
            method: 'POST',
            body: JSON.stringify({
              outcome: 'approved',
              note: 'Reviewed request',
              issue_grant: false,
            }),
          })
        ).status,
      ).toBe(200);
      const unknown = {
        body: (await (
          await request(`/decisions/${held.body.decision_id}`, agentToken)
        ).json()) as Record<string, unknown>,
      };
      expect(unknown.body.status).toBe('approved');
      expect(payments.pay).toHaveBeenCalledTimes(3);
      const unknownPaymentId = unknown.body.payment_id as string;
      expect((await request(`/decisions/${unknown.body.decision_id}`, agentToken)).status).toBe(
        200,
      );
      expect((await request(`/payments/${unknownPaymentId}`, agentToken)).status).toBe(200);

      const signatureStore = new MemoryPaymentStore();
      signatureStore.reserve('pay_signature_probe', {
        amount: 10000,
        payee: catalog.merchants[0]!.payee,
      });
      const quote: Quote = {
        url: 'http://localhost:4101/v1/pricing/acme?period=30d',
        method: 'GET',
        network: 'eip155:84532',
        payee: catalog.merchants[0]!.payee,
        amount: 10000,
        raw: {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: catalog.merchants[0]!.payee,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
        },
      };
      const signatureTransport: Transport = async (_url, init) => {
        const header = new Headers(init.headers).get('PAYMENT-SIGNATURE');
        if (!header) throw new Error('paid request omitted its payment signature');
        paymentSignatures.push(header);
        const stored = (await signatureStore.get('pay_signature_probe'))!.authorization_json!;
        const signature = JSON.parse(stored).payload.signature as string;
        authorizationSignatures.push(signature);
        throw new Error(paymentCredentialBundle(header, signature));
      };
      const signer = createPayments({
        store: signatureStore,
        clock: systemClock,
        transport: signatureTransport,
        config: { walletPrivateKey },
      });
      expect((await signer.pay('pay_signature_probe', quote)).state).toBe('UNKNOWN');
      expect(paymentSignatures).toHaveLength(1);
      const storedAuthorization = (await signatureStore.get('pay_signature_probe'))!
        .authorization_json!;
      const signature = authorizationSignatures[0]!;
      const storedAuthorizationFields = JSON.parse(storedAuthorization).payload.authorization as {
        nonce: string;
        validBefore: string;
      };
      const reconcileStore = new MemoryPaymentStore();
      const nonce = storedAuthorizationFields.nonce;
      const validBefore = Number(storedAuthorizationFields.validBefore);
      const authorizationJson = JSON.stringify({
        payload: {
          signature,
          authorization: {
            from: '0x1111111111111111111111111111111111111111',
            to: merchantPayees[0],
            value: '10000',
            validBefore: String(validBefore),
            nonce,
          },
        },
      });
      reconcileStore.seed({
        id: 'pay_signed',
        state: 'SIGNED',
        payee: merchantPayees[0]!,
        nonce,
        valid_before: validBefore * 1000,
        authorization_json: authorizationJson,
      });
      reconcileStore.seed({
        id: 'pay_unknown',
        state: 'UNKNOWN',
        payee: merchantPayees[0]!,
        nonce,
        valid_before: validBefore * 1000,
        authorization_json: authorizationJson,
      });
      reconcileStore.seed({
        id: 'pay_expired',
        state: 'UNKNOWN',
        payee: merchantPayees[0]!,
        nonce,
        valid_before: systemClock.now() - 31 * 60_000,
        authorization_json: authorizationJson,
      });

      const reconciler = createPayments({
        store: reconcileStore,
        clock: systemClock,
        transport: signatureTransport,
        config: { walletPrivateKey },
      });
      fakeChain.used = false;
      fakeChain.errorMessage = paymentCredentialBundle(paymentSignatures[0]!, signature);
      const passFinished = deferred<void>();
      let reconciled = 0;
      const monitored: PaymentsModule = {
        ...reconciler,
        async reconcile(id) {
          const result = await reconciler.reconcile(id);
          reconciled++;
          if (reconciled === 3) passFinished.resolve();
          return result;
        },
      };
      const stop = startReconciler(monitored, reconcileStore, 60_000);
      await passFinished.promise;
      stop();
      expect((await reconcileStore.get('pay_signed'))?.state).toBe('FAILED');
      expect((await reconcileStore.get('pay_unknown'))?.state).toBe('UNKNOWN');
      expect((await reconcileStore.get('pay_expired'))?.state).toBe('UNKNOWN');

      fakeChain.errorMessage = '';
      reconcileStore.seed({
        id: 'pay_expired_proven',
        state: 'UNKNOWN',
        payee: merchantPayees[0]!,
        nonce: `0x${'3'.repeat(64)}`,
        valid_before: systemClock.now() - 31 * 60_000,
        authorization_json: authorizationJson,
      });
      expect(await reconciler.reconcile('pay_expired_proven')).toBe('FAILED');

      const candidates = [
        ...h.issuedTokens.map((value, index) => [`agent token ${index}`, value] as const),
        ['admin token', ADMIN_TOKEN] as const,
        ['wallet private key', walletPrivateKey] as const,
        ...merchantPayees.map((value, index) => [`payee ${index}`, value] as const),
        ...paymentSignatures.map((value, index) => [`payment signature ${index}`, value] as const),
        ...authorizationSignatures.map(
          (value, index) => [`stored authorization signature ${index}`, value] as const,
        ),
        ['idempotency HMAC secret', idempotencySecret] as const,
      ];
      const leaked = candidates.flatMap(([name, value]) => {
        if (!value) return [];
        const sources = [
          h.logs.some((line) => line.includes(value)) ? 'request log' : null,
          ...consoleLines.flatMap((line, index) =>
            line.includes(value)
              ? [`${line.startsWith('[payments]') ? 'payments' : 'reconciler'} log ${index}`]
              : [],
          ),
        ].filter((source): source is string => source !== null);
        return sources.map((source) => `${name} in ${source}`);
      });
      expect(leaked).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('request log', () => {
  it('writes one line per request with method, path, status and duration', async () => {
    const h = createHarness();
    await h.request('/catalog');
    expect(h.logRecords().at(-1)).toEqual({
      level: 'info',
      at: h.clock.now(),
      msg: 'request',
      method: 'GET',
      path: '/catalog',
      status: 401,
      ms: 0,
    });
  });

  it('logs the path without the query string', async () => {
    const h = createHarness();
    await h.request('/health?probe=1');
    expect(h.logRecords().at(-1)).toMatchObject({ path: '/health', status: 200 });
  });

  it('never logs headers or bodies', async () => {
    const h = createHarness();
    await h.postMandate({ task: 'A very distinctive task text' });
    const all = h.logs.join('\n');
    expect(all).not.toContain('distinctive');
    expect(all).not.toMatch(/authorization|content-type/i);
  });
});
