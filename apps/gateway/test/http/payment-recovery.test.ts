import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PaymentsModule, PayRequest, PayResponse } from '@apf/contracts';
import { decodeFunctionData, pad, parseAbi, toEventSelector } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { createApp } from '../../src/app.js';
import { loadCatalog } from '../../src/catalog/index.js';
import { createGatewayAdmission } from '../../src/judge/gateway.js';
import { createStubJudge } from '../../src/judge/index.js';
import { createPaymentStore } from '../../src/db/payment-store.js';
import { openDb, type Db } from '../../src/db/client.js';
import { createPayments, startReconciler } from '../../src/payments/index.js';
import type { Transport } from '../../src/payments/transport.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { createHarness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../harness/db.js';

const PRICE = 10_000;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x1111111111111111111111111111111111111111';
const LATEST_BLOCK = 50_000_000n;
const AUTHORIZATION_USED = toEventSelector(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const authorizationStateAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

const servers: Server[] = [];

afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function decodePaymentSignature(value: string) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
    payload: {
      signature: string;
      authorization: { nonce: string; value: string; from: string; to: string };
    };
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

interface ChainFixture {
  url: string;
  readonly settled: Map<string, bigint>;
  unreadable: boolean;
  settle(nonce: string): void;
}

async function createFakeChain(clock: { now(): number }): Promise<ChainFixture> {
  const settled = new Map<string, bigint>();
  const latestTimestamp = BigInt(Math.floor(clock.now() / 1000));
  const blockTimestamp = (number: bigint) => latestTimestamp - (LATEST_BLOCK - number);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const request = JSON.parse(raw) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      };
      const fail = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: 'fixture RPC unavailable' },
          }),
        );
      };

      if (fixture.unreadable) {
        fail();
        return;
      }
      switch (request.method) {
        case 'eth_chainId':
          reply('0x14a34');
          return;
        case 'eth_blockNumber':
          reply(`0x${LATEST_BLOCK.toString(16)}`);
          return;
        case 'eth_getBlockByNumber': {
          const [tag] = request.params as [string, boolean?];
          const number =
            tag === 'latest' ? LATEST_BLOCK : tag === 'finalized' ? LATEST_BLOCK - 1n : BigInt(tag);
          reply({
            number: `0x${number.toString(16)}`,
            timestamp: `0x${blockTimestamp(number).toString(16)}`,
            hash: pad('0x01'),
            parentHash: pad('0x00'),
            transactions: [],
            gasLimit: '0x0',
            gasUsed: '0x0',
            logsBloom: '0x',
            miner: PAYEE,
            extraData: '0x',
          });
          return;
        }
        case 'eth_call': {
          const [{ data }] = request.params as [{ data: `0x${string}` }, string];
          const { functionName, args } = decodeFunctionData({
            abi: authorizationStateAbi,
            data,
          });
          if (functionName !== 'authorizationState') {
            fail();
            return;
          }
          const nonce = String(args[1]).toLowerCase();
          reply(pad(settled.has(nonce) ? '0x01' : '0x00'));
          return;
        }
        case 'eth_getLogs': {
          const [{ fromBlock, toBlock, topics }] = request.params as [
            { fromBlock: string; toBlock: string; topics: string[] },
          ];
          const from = BigInt(fromBlock);
          const to = BigInt(toBlock);
          const [event, authorizer, nonce] = topics;
          if (to - from + 1n > 200n) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32000, message: 'eth_getLogs range exceeds 200 blocks' },
              }),
            );
            return;
          }
          const settlementBlock = nonce ? settled.get(`0x${nonce.slice(-64)}`) : undefined;
          if (
            event === AUTHORIZATION_USED &&
            settlementBlock !== undefined &&
            settlementBlock >= from &&
            settlementBlock <= to
          ) {
            reply([
              {
                address: USDC,
                topics: [AUTHORIZATION_USED, authorizer, nonce],
                data: '0x',
                blockNumber: `0x${settlementBlock.toString(16)}`,
                blockHash: pad('0x02'),
                transactionHash: pad('0x1234'),
                transactionIndex: '0x0',
                logIndex: '0x0',
                removed: false,
              },
            ]);
          } else {
            reply([]);
          }
          return;
        }
        default:
          fail();
      }
    });
  });
  servers.push(server);
  const url = await listen(server);
  const fixture: ChainFixture = {
    url,
    settled,
    unreadable: false,
    settle(nonce) {
      settled.set(nonce.toLowerCase(), LATEST_BLOCK - 10n);
    },
  };
  return fixture;
}

interface MerchantPayment {
  header: string;
  nonce: string;
  payload: ReturnType<typeof decodePaymentSignature>;
}

type PaidHandler = (
  payment: MerchantPayment,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

interface MerchantFixture {
  origin: string;
  readonly quoteCount: number;
  readonly paid: MerchantPayment[];
  setPaidHandler(handler: PaidHandler): void;
}

async function createFakeMerchant(): Promise<MerchantFixture> {
  let quoteCount = 0;
  let paidHandler: PaidHandler = (_payment, _req, res) => sendBody(res);
  const paid: MerchantPayment[] = [];
  const server = createServer(async (req, res) => {
    const header = req.headers['payment-signature'];
    if (typeof header !== 'string') {
      quoteCount++;
      res.writeHead(402, {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': encode({
          x402Version: 2,
          error: 'Payment required',
          resource: { url: `http://merchant${req.url}`, mimeType: 'application/json' },
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:84532',
              amount: String(PRICE),
              asset: USDC,
              payTo: PAYEE,
              maxTimeoutSeconds: 300,
              extra: { name: 'USDC', version: '2' },
            },
          ],
        }),
      });
      res.end('{}');
      return;
    }
    const payload = decodePaymentSignature(header);
    const payment = {
      header,
      nonce: payload.payload.authorization.nonce.toLowerCase(),
      payload,
    };
    paid.push(payment);
    await paidHandler(payment, req, res);
  });
  servers.push(server);
  return {
    origin: await listen(server),
    get quoteCount() {
      return quoteCount;
    },
    paid,
    setPaidHandler(handler) {
      paidHandler = handler;
    },
  };
}

function sendBody(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ company: 'acme', products: [{ sku: 'fixture', price: PRICE }] }));
}

interface Runtime {
  h: ReturnType<typeof createHarness>;
  db: Db;
  catalog: ReturnType<typeof loadCatalog>;
  merchant: MerchantFixture;
  chain: ChainFixture;
  walletPrivateKey: `0x${string}`;
  mandate: Awaited<ReturnType<ReturnType<typeof createHarness>['createMandate']>>;
  store: ReturnType<typeof createPaymentStore>;
  payments: PaymentsModule;
  pipeline: ReturnType<typeof createPipeline>;
  app: ReturnType<typeof createApp>;
  request(path: string, token: string, init?: RequestInit): Promise<Response>;
  purchase(key?: string): PayRequest;
  pay(body: PayRequest): Promise<{ httpStatus: number; body: PayResponse }>;
}

function buildRuntime(
  h: ReturnType<typeof createHarness>,
  db: Db,
  catalog: ReturnType<typeof loadCatalog>,
  merchant: MerchantFixture,
  chain: ChainFixture,
  walletPrivateKey: `0x${string}`,
  mandate: Runtime['mandate'],
): Runtime {
  const store = createPaymentStore(db, h.clock);
  const transport: Transport = async (url, init) => {
    const canonical = new URL(url);
    return fetch(`${merchant.origin}${canonical.pathname}${canonical.search}`, init);
  };
  const payments = createPayments({
    store,
    clock: h.clock,
    transport,
    config: { walletPrivateKey, rpcUrl: chain.url },
  });
  const deps = {
    ...h.deps,
    db,
    catalog,
    catalogAdmission: createGatewayAdmission(catalog),
    payments,
    judge: createStubJudge('stub-approve'),
  };
  const pipeline = createPipeline(deps);
  const app = createApp({ ...deps, pipeline });
  const request = async (path: string, token: string, init: RequestInit = {}) =>
    await app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  const purchase = (key = randomUUID()): PayRequest => ({
    url: 'http://localhost:4101/v1/pricing/acme?period=30d',
    method: 'GET',
    expected_price: PRICE,
    purpose: 'fetch_data',
    idempotency_key: key,
  });
  const pay = async (body: PayRequest) => {
    const response = await request('/pay', mandate.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': body.idempotency_key },
      body: JSON.stringify(body),
    });
    return {
      httpStatus: response.status,
      body: (await response.json()) as PayResponse,
    };
  };
  return {
    h,
    db,
    catalog,
    merchant,
    chain,
    walletPrivateKey,
    mandate,
    store,
    payments,
    pipeline,
    app,
    request,
    purchase,
    pay,
  };
}

async function fixture(budget = 2_000_000): Promise<Runtime> {
  const h = createHarness();
  const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
  const chain = await createFakeChain(h.clock);
  const merchant = await createFakeMerchant();
  const walletPrivateKey = generatePrivateKey();
  const mandate = await h.createMandate({ budget });
  return buildRuntime(h, h.db, catalog, merchant, chain, walletPrivateKey, mandate);
}

function withTestClock<T>(clock: { now(): number }, work: () => Promise<T>): Promise<T> {
  const systemNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.now());
  return work().finally(() => systemNow.mockRestore());
}

function money(db: Db, mandateId: string): { spent: number; reserved: number } {
  return db.sqlite.prepare('SELECT spent, reserved FROM mandates WHERE id = ?').get(mandateId) as {
    spent: number;
    reserved: number;
  };
}

interface PaymentRow {
  id: string;
  decision_id: string;
  state: string;
  nonce: string | null;
  tx_hash: string | null;
  authorization_json: string | null;
  response_json: string | null;
}

function paymentRows(db: Db): PaymentRow[] {
  return db.sqlite
    .prepare(
      'SELECT id, decision_id, state, nonce, tx_hash, authorization_json, response_json FROM payments ORDER BY id',
    )
    .all() as PaymentRow[];
}

async function poll<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function expectPaymentUnknown(
  response: PayResponse,
): Extract<PayResponse, { status: 'payment_unknown' }> {
  expect(response.status).toBe('payment_unknown');
  if (response.status !== 'payment_unknown') throw new Error('Expected payment_unknown response');
  return response;
}

function expectOneAuthorization(world: Runtime): void {
  expect(world.merchant.paid).toHaveLength(1);
  expect(new Set(world.merchant.paid.map((payment) => payment.nonce)).size).toBe(1);
  const row = paymentRows(world.db)[0]!;
  const received = world.merchant.paid[0]!;
  const stored = JSON.parse(row.authorization_json!) as ReturnType<typeof decodePaymentSignature>;
  expect(received.payload.payload.signature).toBe(stored.payload.signature);
  expect(received.payload.payload.authorization.nonce).toBe(row.nonce);
}

describe('integrated settlement and recovery proof', () => {
  it('settles delayed chain proof and replays the original body through polling and /pay', async () => {
    const world = await fixture();
    const purchase = world.purchase();
    world.merchant.setPaidHandler((_payment, _req, res) => sendBody(res));

    const first = await withTestClock(world.h.clock, () => world.pay(purchase));
    const firstUnknown = expectPaymentUnknown(first.body);
    const firstDecisionId = firstUnknown.decision_id;
    const firstPaymentId = firstUnknown.payment_id;
    expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: 0, reserved: PRICE });
    expect(paymentRows(world.db)).toMatchObject([
      { state: 'UNKNOWN', response_json: expect.any(String) },
    ]);
    expect(world.chain.settled.size).toBe(0);

    world.chain.settle(world.merchant.paid[0]!.nonce);
    expect(await world.payments.reconcile(firstPaymentId)).toBe('SETTLED');

    const decision = await poll<PayResponse>(
      await world.request(`/decisions/${firstDecisionId}`, world.mandate.token),
    );
    const retry = await world.pay(purchase);
    const payment = await poll<{ state: string; tx_hash: string | null }>(
      await world.request(`/payments/${firstPaymentId}`, world.mandate.token),
    );
    expect(decision).toMatchObject({
      status: 'approved',
      payment_id: firstPaymentId,
      response: {
        status_code: 200,
        body: JSON.stringify({ company: 'acme', products: [{ sku: 'fixture', price: PRICE }] }),
      },
    });
    expect(retry.body).toEqual(decision);
    expect(payment.state).toBe('SETTLED');
    expect(payment.tx_hash).not.toBeNull();
    expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: PRICE, reserved: 0 });
    expect(paymentRows(world.db)).toHaveLength(1);
    expect(world.chain.settled.size).toBe(1);
    expectOneAuthorization(world);
  });

  it('recovers a dropped settled reply after rebuilding on the same SQLite file', async () => {
    const world = await fixture();
    const purchase = world.purchase();
    world.merchant.setPaidHandler((payment, req) => {
      world.chain.settle(payment.nonce);
      req.socket.destroy();
    });

    const first = await withTestClock(world.h.clock, () => world.pay(purchase));
    const firstUnknown = expectPaymentUnknown(first.body);
    const paymentId = firstUnknown.payment_id;
    const decisionId = firstUnknown.decision_id;
    expect(paymentRows(world.db)).toMatchObject([{ state: 'UNKNOWN', response_json: null }]);
    expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: 0, reserved: PRICE });

    const reopened = openDb(world.db.sqlite.name);
    try {
      const restarted = buildRuntime(
        world.h,
        reopened,
        world.catalog,
        world.merchant,
        world.chain,
        world.walletPrivateKey,
        world.mandate,
      );
      restarted.pipeline.recover();
      const reconciled = deferred<string>();
      const monitored: PaymentsModule = {
        ...restarted.payments,
        async reconcile(id) {
          const result = await restarted.payments.reconcile(id);
          reconciled.resolve(result);
          return result;
        },
      };
      const stop = startReconciler(monitored, restarted.store, 60_000);
      try {
        await reconciled.promise;
      } finally {
        stop();
      }

      const retry = await restarted.pay(purchase);
      const decision = await poll<PayResponse>(
        await restarted.request(`/decisions/${decisionId}`, world.mandate.token),
      );
      const payment = await poll<{ state: string; tx_hash: string | null }>(
        await restarted.request(`/payments/${paymentId}`, world.mandate.token),
      );
      expect(retry.body).toMatchObject({
        status: 'approved',
        payment_id: paymentId,
        response: null,
      });
      expect(decision).toEqual(retry.body);
      expect(payment.state).toBe('SETTLED');
      expect(payment.tx_hash).not.toBeNull();
      expect(money(reopened, world.mandate.mandate_id)).toEqual({ spent: PRICE, reserved: 0 });
      expect(paymentRows(reopened)).toHaveLength(1);
      expect(world.chain.settled.size).toBe(1);
      expectOneAuthorization(restarted);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('replays the same key in flight and after settlement without another signature', async () => {
    const world = await fixture();
    const received = deferred<MerchantPayment>();
    const release = deferred<void>();
    world.merchant.setPaidHandler(async (payment, _req, res) => {
      received.resolve(payment);
      await release.promise;
      world.chain.settle(payment.nonce);
      sendBody(res);
    });
    const purchase = world.purchase();
    const systemNow = vi.spyOn(Date, 'now').mockImplementation(() => world.h.clock.now());
    try {
      const firstPromise = world.pay(purchase);
      const accepted = await received.promise;
      const rowWhileInFlight = paymentRows(world.db)[0]!;
      expect(rowWhileInFlight.state).toBe('SUBMITTED');
      expect(world.merchant.paid).toHaveLength(1);

      const inFlightReplay = await world.pay(purchase);
      const replayUnknown = expectPaymentUnknown(inFlightReplay.body);
      expect(replayUnknown.payment_id).toBe(rowWhileInFlight.id);
      expect(world.merchant.paid).toHaveLength(1);

      release.resolve();
      const first = await firstPromise;
      systemNow.mockRestore();
      expect(first.body.status).toBe('approved');
      const settledRow = paymentRows(world.db)[0]!;
      expect(settledRow.authorization_json).toBe(rowWhileInFlight.authorization_json);
      expect(decodePaymentSignature(accepted.header).payload.authorization.nonce).toBe(
        settledRow.nonce,
      );

      const afterSettle = await world.pay(purchase);
      expect(afterSettle.body).toEqual(first.body);
      expect(world.merchant.paid).toHaveLength(1);
      expect(world.chain.settled.size).toBe(1);
      expect(paymentRows(world.db)).toHaveLength(1);
      expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: PRICE, reserved: 0 });
      expectOneAuthorization(world);
    } finally {
      release.resolve();
      systemNow.mockRestore();
    }
  });

  it('admits exactly one fresh-key request when parallel calls share one purchase budget', async () => {
    const world = await fixture(PRICE);
    world.merchant.setPaidHandler((payment, _req, res) => {
      world.chain.settle(payment.nonce);
      sendBody(res);
    });
    const purchases = Array.from({ length: 6 }, () => world.purchase());
    const results = await withTestClock(world.h.clock, () =>
      Promise.all(purchases.map((purchase) => world.pay(purchase))),
    );

    expect(results.filter((result) => result.body.status === 'approved')).toHaveLength(1);
    expect(results.filter((result) => result.body.status === 'denied')).toHaveLength(5);
    expect(world.merchant.quoteCount).toBe(6);
    expect(world.merchant.paid).toHaveLength(1);
    expect(world.chain.settled.size).toBe(1);
    expect(paymentRows(world.db)).toHaveLength(1);
    expect(paymentRows(world.db)[0]?.state).toBe('SETTLED');
    expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: PRICE, reserved: 0 });
    expectOneAuthorization(world);
  });

  it('keeps an UNKNOWN payment reserved while the chain is unreadable', async () => {
    const world = await fixture();
    world.chain.unreadable = true;
    world.merchant.setPaidHandler((_payment, _req, res) => sendBody(res));

    const result = await withTestClock(world.h.clock, () => world.pay(world.purchase()));
    expect(result.body.status).toBe('payment_unknown');
    expect(world.merchant.paid).toHaveLength(1);
    expect(world.chain.settled.size).toBe(0);
    expect(paymentRows(world.db)).toMatchObject([{ state: 'UNKNOWN' }]);
    expect(paymentRows(world.db)).toHaveLength(1);
    expect(money(world.db, world.mandate.mandate_id)).toEqual({ spent: 0, reserved: PRICE });
    expectOneAuthorization(world);
  });
});
