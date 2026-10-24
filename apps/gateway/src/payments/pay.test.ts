// P4/P5 · pay(paymentId, quote) and reconcile(paymentId), written before the implementation.
// Each test runs a throwaway local merchant; signing uses a random key, so nothing touches the chain.
import { afterAll as after, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey } from 'viem/accounts';
import { createPayments } from './index.js';
import { getQuote } from './quote.js';
import { systemClock } from '../clock.js';
import { MemoryPaymentStore } from './testing/memory-store.js';

// Controlled chain evidence for paid-request tests. The dedicated reconciler suite exercises
// JSON-RPC; a merchant header alone never changes this fixture's nonce state.
const chainUsed = vi.hoisted(() => new Set<string>());
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => ({
    getChainId: async () => 84532,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({
      number: blockNumber ?? 50000n,
      timestamp:
        BigInt(Math.floor(systemClock.now() / 1000)) -
        (blockNumber === undefined ? 0n : 50000n - blockNumber),
    }),
    readContract: async ({ args }: { args: [string, string] }) => chainUsed.has(args[1]),
    getLogs: async () => [{ transactionHash: TX }],
  }),
}));

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae';
const TX = '0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15';
const PRICE = 10_000;

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

const servers: ReturnType<typeof createServer>[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// What the merchant does with a paid request.
type Outcome =
  | 'drop_after_settle'
  | 'settle'
  | 'settle_slowly'
  | '402'
  | '500'
  | '200_without_settlement_header'
  | 'settle_with_endless_body'
  | 'endless_body_without_settlement';

interface PaidRequest {
  header: string; // PAYMENT-SIGNATURE exactly as received
  nonce: string;
  value: string;
  stateWhenReceived: string | undefined; // store state at the moment the merchant saw the payment
}

// A merchant like PriceScope: 402 with requirements when unpaid, then `next` outcome for each paid request.
async function merchant(store: MemoryPaymentStore, paymentId: string, outcomes: Outcome[]) {
  const paid: PaidRequest[] = [];
  let unpaid = 0;
  let bytesSent = 0;
  const origin = await listen(async (req, res) => {
    const header = req.headers['payment-signature'];
    if (typeof header !== 'string') {
      unpaid++;
      res.writeHead(402, {
        'Content-Type': 'application/json',
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
      return res.end('{}');
    }

    const { authorization } = decode(header).payload;
    paid.push({
      header,
      nonce: authorization.nonce,
      value: authorization.value,
      stateWhenReceived: (await store.get(paymentId))?.state,
    });

    const outcome = outcomes[paid.length - 1] ?? 'settle';
    if (['settle', 'settle_slowly', 'drop_after_settle'].includes(outcome))
      chainUsed.add(authorization.nonce);
    if (outcome === 'settle_slowly') await new Promise((r) => setTimeout(r, 100)); // keeps the request in flight
    switch (outcome === 'settle_slowly' ? 'settle' : outcome) {
      case 'drop_after_settle':
        // The facilitator settled; the connection dies before the gateway hears about it.
        return req.socket.destroy();
      case 'settle':
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': encode({
            success: true,
            transaction: TX,
            network: 'eip155:84532',
            payer: authorization.from,
          }),
        });
        return res.end('{"company":"acme","products":[]}');
      case '402':
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end('{}');
      case '500':
        res.writeHead(500);
        return res.end('boom');
      case '200_without_settlement_header':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"company":"acme","products":[]}');
      case 'settle_with_endless_body':
      case 'endless_body_without_settlement': {
        const proof = encode({
          success: true,
          transaction: TX,
          network: 'eip155:84532',
          payer: authorization.from,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(outcome === 'settle_with_endless_body' ? { 'PAYMENT-RESPONSE': proof } : {}),
        });
        // Keeps writing until the gateway hangs up.
        const chunk = Buffer.alloc(64 * 1024, 'a');
        const pump = () => {
          while (!res.destroyed && res.write(chunk)) bytesSent += chunk.length;
          if (!res.destroyed) res.once('drain', pump);
        };
        return pump();
      }
    }
  });
  return {
    url: `${origin}/v1/pricing/acme?period=30d`,
    paid,
    unpaidCount: () => unpaid,
    bytesSent: () => bytesSent,
  };
}

// A JSON-RPC endpoint that counts calls and answers nothing useful: proves when no chain lookup happened.
async function countingRpc() {
  let hits = 0;
  const url = await listen((_req, res) => {
    hits++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"test rpc"}}');
  });
  return { url, hits: () => hits };
}

async function setup(outcomes: Outcome[]) {
  const store = new MemoryPaymentStore();
  const paymentId = 'pay_test';
  store.reserve(paymentId, { amount: PRICE, payee: PAYEE });
  const m = await merchant(store, paymentId, outcomes);
  const rpc = await countingRpc();
  const payments = createPayments({
    store,
    config: { walletPrivateKey: generatePrivateKey(), rpcUrl: rpc.url },
  });
  const quote = await getQuote(m.url, 'GET');
  return { store, paymentId, merchant: m, rpc, payments, quote };
}

// ---------- (a) dropped connection after settlement ends UNKNOWN, never FAILED ----------

test('(a) connection dropped after settlement: payment ends UNKNOWN, never FAILED', async () => {
  const { store, paymentId, merchant: m, payments, quote } = await setup(['drop_after_settle']);

  const result = await payments.pay(paymentId, quote);

  assert.deepEqual(result, { state: 'UNKNOWN' });
  assert.equal((await store.get(paymentId))?.state, 'UNKNOWN');
  assert.equal(store.called('fail'), 0, 'pay() must never call store.fail');

  // The order of writes is what makes UNKNOWN recoverable.
  assert.equal(m.paid.length, 1);
  assert.equal(
    m.paid[0].stateWhenReceived,
    'SUBMITTED',
    'markSigned and markSubmitted happen before the paid request is sent',
  );
  assert.equal(
    (await store.get(paymentId))?.nonce,
    m.paid[0].nonce,
    'the stored nonce is the one the merchant received',
  );
  assert.equal(m.paid[0].value, String(PRICE), 'signed for exactly quote.amount');
});

// Same rule for every other non-settled answer: the merchant may still hold a cashable authorization.
for (const outcome of ['402', '500', '200_without_settlement_header'] as const) {
  test(`(a) merchant answers ${outcome} after payment: UNKNOWN, never FAILED`, async () => {
    const { store, paymentId, payments, quote } = await setup([outcome]);

    const result = await payments.pay(paymentId, quote);

    assert.deepEqual(result, { state: 'UNKNOWN' });
    assert.equal((await store.get(paymentId))?.state, 'UNKNOWN');
    assert.equal(store.called('fail'), 0, 'pay() must never call store.fail');
  });
}

// ---------- (b) a retry resends the same signed authorization ----------

test('(b) retry after a dropped connection resends the exact same authorization and never signs again', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['drop_after_settle', 'settle']);

  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  const stored = await store.get(paymentId);

  const retry = await payments.pay(paymentId, quote);

  assert.equal(m.paid.length, 2);
  assert.equal(
    m.paid[1].header,
    m.paid[0].header,
    'PAYMENT-SIGNATURE must be byte-identical on retry',
  );
  assert.equal(store.called('markSigned'), 1, 'one authorization per payment');
  assert.equal((await store.get(paymentId))?.nonce, stored?.nonce, 'nonce unchanged');
  assert.equal((await store.get(paymentId))?.authorization_json, stored?.authorization_json);

  assert.equal(retry.state, 'SETTLED');
  assert.equal(retry.state === 'SETTLED' && retry.txHash, TX);
  assert.equal(retry.state === 'SETTLED' && retry.response.status_code, 200);
  assert.equal((await store.get(paymentId))?.state, 'SETTLED');
  assert.equal(store.called('fail'), 0);
});

// ---------- (d) the quote must match the reservation it is paid under ----------

// The reservation (amount, payee) on the payment row is what the gateway approved and budgeted.
// A quote that disagrees must never be signed or sent under that payment id.
const ATTACKER = '0xca7c3c3ac945e0febcebae02de1fbe847bcd4d19';
const mismatches: [string, { amount: number; payee: `0x${string}` }][] = [
  ['quote amount larger than the reservation', { amount: PRICE / 2, payee: PAYEE }],
  ['quote amount smaller than the reservation', { amount: PRICE * 2, payee: PAYEE }],
  ['quote payee different from the reservation', { amount: PRICE, payee: ATTACKER }],
];
for (const [name, reservation] of mismatches) {
  test(`(d) ${name}: refused before signing, nothing sent, reservation untouched`, async () => {
    const { store, paymentId, merchant: m, payments, quote } = await setup(['settle']);
    store.reserve(paymentId, reservation); // the quote below still says 10000 to PriceScope

    await assert.rejects(payments.pay(paymentId, quote), /reservation/);

    assert.equal(m.paid.length, 0, 'nothing sent to the merchant');
    assert.equal(store.called('markSigned'), 0, 'nothing signed');
    assert.equal(store.called('fail'), 0);
    assert.equal((await store.get(paymentId))?.state, 'RESERVED');
  });
}

const wrongRequirements: [string, Record<string, unknown>][] = [
  [
    'another token (same amount and payee)',
    { asset: '0x1111111111111111111111111111111111111111' },
  ],
  ['a scheme other than exact', { scheme: 'upto' }],
];
for (const [name, change] of wrongRequirements) {
  test(`(d) quote.raw names ${name}: refused before signing, nothing sent`, async () => {
    const { store, paymentId, merchant: m, payments, quote } = await setup(['settle']);
    const tampered = { ...quote, raw: { ...(quote.raw as Record<string, unknown>), ...change } };

    await assert.rejects(payments.pay(paymentId, tampered), /refusing to sign/);

    assert.equal(m.paid.length, 0, 'nothing sent to the merchant');
    assert.equal(store.called('markSigned'), 0, 'nothing signed');
    assert.equal((await store.get(paymentId))?.state, 'RESERVED');
  });
}

test('(d) retry with a quote that no longer matches the reservation is refused, nothing resent', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['drop_after_settle', 'settle']);
  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });

  await assert.rejects(payments.pay(paymentId, { ...quote, payee: ATTACKER }), /reservation/);

  assert.equal(m.paid.length, 1, 'the stored authorization was not resent');
  assert.equal((await store.get(paymentId))?.state, 'UNKNOWN');
});

// ---------- (e) SETTLED is only reported once the store has recorded it ----------

// Simulates the reconciler resolving the row while the paid request is in flight, so store.settle() returns false.
function reconcilerWins(store: MemoryPaymentStore, paymentId: string, state: 'SETTLED' | 'FAILED') {
  const settle = store.settle.bind(store);
  store.settle = async (id, txHash) => {
    Object.assign(store.rows.get(paymentId)!, { state, tx_hash: state === 'SETTLED' ? TX : null });
    return settle(id, txHash);
  };
}

test('(e) store already SETTLED by the reconciler: pay still reports SETTLED, recorded once', async () => {
  const { store, paymentId, payments, quote } = await setup(['settle']);
  reconcilerWins(store, paymentId, 'SETTLED');

  const result = await payments.pay(paymentId, quote);

  assert.equal(result.state, 'SETTLED');
  assert.equal(result.state === 'SETTLED' && result.txHash, TX);
  assert.deepEqual(
    store.calls.filter((c) => c.method === 'settle').map((c) => c.changed),
    [false],
  );
  assert.equal((await store.get(paymentId))?.state, 'SETTLED');
});

test('(e) store refuses settlement (row already FAILED): pay must not report SETTLED', async () => {
  const { store, paymentId, payments, quote } = await setup(['settle']);
  reconcilerWins(store, paymentId, 'FAILED');

  await assert.rejects(payments.pay(paymentId, quote), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /FAILED/);
    assert.equal((err as { txHash?: string }).txHash, TX);
    return true;
  });
  assert.equal(
    (await store.get(paymentId))?.state,
    'FAILED',
    'pay does not invent a transition the store refused',
  );
});

// ---------- (f) concurrent pay() calls for the same payment ----------

test('(f) concurrent pay() calls for one payment send the authorization once and share the result', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['settle_slowly', 'settle']);

  const [first, second] = await Promise.all([
    payments.pay(paymentId, quote),
    payments.pay(paymentId, quote),
  ]);

  assert.equal(
    m.paid.length,
    1,
    'the second call joined the in-flight one instead of sending again',
  );
  assert.equal(first.state, 'SETTLED');
  assert.deepEqual(second, first);
  assert.equal(store.called('markSigned'), 1);
});

test('(f) a concurrent call with a different quote is refused, not joined, and sends nothing', async () => {
  const { paymentId, merchant: m, payments, quote } = await setup(['settle_slowly']);

  const first = payments.pay(paymentId, quote);
  await assert.rejects(
    payments.pay(paymentId, { ...quote, url: `${quote.url}&other=1` }),
    /different quote/,
  );

  assert.equal((await first).state, 'SETTLED');
  assert.equal(m.paid.length, 1);
});

test('(f) a retry after the first call finished still sends (the guard only covers calls in flight)', async () => {
  const { paymentId, merchant: m, payments, quote } = await setup(['drop_after_settle', 'settle']);

  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  assert.equal((await payments.pay(paymentId, quote)).state, 'SETTLED');
  assert.equal(m.paid.length, 2);
});

test('(f) two gateway processes retrying one payment at once: the ledger still ends SETTLED, never FAILED', async () => {
  // First attempt drops, leaving UNKNOWN with the stored authorization. Then two separate payments modules on one
  // store (like two gateway processes, which the in-process guard can't coordinate) retry at the same time:
  // one request settles slowly, the other gets a fast, ambiguous 402.
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['drop_after_settle', 'settle_slowly', '402']);
  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });

  const processA = createPayments({ store, config: { walletPrivateKey: generatePrivateKey() } });
  const processB = createPayments({ store, config: { walletPrivateKey: generatePrivateKey() } });
  const results = await Promise.all([
    processA.pay(paymentId, quote),
    processB.pay(paymentId, quote),
  ]);

  assert.equal(m.paid.length, 3);
  assert.equal(
    new Set(m.paid.map((p) => p.header)).size,
    1,
    'every send carried the one stored authorization',
  );
  assert.deepEqual(
    results.map((r) => r.state).sort(),
    ['SETTLED', 'UNKNOWN'],
    'one caller hears UNKNOWN: ambiguous, not wrong',
  );
  assert.equal(
    (await store.get(paymentId))?.state,
    'SETTLED',
    'the ambiguous answer cannot undo the settlement',
  );
  assert.equal(store.called('fail'), 0);
});

// ---------- (g) pay() acts on the current row, not a stale snapshot ----------

test('(g) reconciler failed the payment after pay() read the row: nothing is sent, pay reports FAILED', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['drop_after_settle', 'settle']);
  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });

  // pay() reads UNKNOWN, then the reconciler fails the row before the send.
  const get = store.get.bind(store);
  let reads = 0;
  store.get = async (id) => {
    const row = await get(id);
    if (row && reads++ === 0) {
      Object.assign(store.rows.get(id)!, { state: 'FAILED' });
      return { ...row, state: 'UNKNOWN' };
    }
    return row;
  };

  const result = await payments.pay(paymentId, quote);

  assert.equal(result.state, 'FAILED');
  assert.equal(m.paid.length, 1, 'the dead payment was not sent again');
  assert.equal(store.called('fail'), 0, 'pay reports the store state, it never calls fail');
});

test('(g) retry of an authorization already past validBefore: not sent, left for the reconciler', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['drop_after_settle', 'settle']);
  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  store.rows.get(paymentId)!.valid_before = systemClock.now() - 1_000;

  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  assert.equal(m.paid.length, 1, 'an expired authorization cannot settle, so it is not resent');
  assert.equal((await store.get(paymentId))?.state, 'UNKNOWN');
  assert.equal(store.called('fail'), 0);
});

test('(g) reconciler failed the payment while the request was in flight: ambiguous answer reports FAILED', async () => {
  const { store, paymentId, payments, quote } = await setup(['402']);
  const markUnknown = store.markUnknown.bind(store);
  store.markUnknown = async (id) => {
    Object.assign(store.rows.get(id)!, { state: 'FAILED' }); // the reconciler got there first
    return markUnknown(id);
  };

  const result = await payments.pay(paymentId, quote);

  assert.equal(result.state, 'FAILED');
  assert.equal(store.called('fail'), 0);
});

// ---------- (h) a merchant can't make the gateway buffer an unbounded response ----------

test('(h) endless response, even with a settlement header: cut off at the size limit, UNKNOWN for the reconciler', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['settle_with_endless_body']);

  const started = performance.now();
  const result = await payments.pay(paymentId, quote);

  // A merchant header is never settlement evidence, and there is no deliverable to keep.
  assert.deepEqual(result, { state: 'UNKNOWN' });
  assert.equal((await store.get(paymentId))?.state, 'UNKNOWN');
  assert.equal(store.called('fail'), 0);
  assert.equal(store.rows.get(paymentId)?.response_json, null, 'nothing over the cap is saved');
  assert.ok(performance.now() - started < 5_000, 'stopped on size, not on the 15 s timeout');
  assert.ok(
    m.bytesSent() < 32 * 1024 * 1024,
    `kept reading: merchant pushed ${m.bytesSent()} bytes`,
  );
});

test('(h) endless response without settlement proof: cut off quickly, UNKNOWN, never FAILED', async () => {
  const {
    store,
    paymentId,
    merchant: m,
    payments,
    quote,
  } = await setup(['endless_body_without_settlement']);

  const started = performance.now();
  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });

  assert.equal(store.called('fail'), 0);
  assert.ok(performance.now() - started < 5_000, 'stopped on size, not on the 15 s timeout');
  assert.ok(
    m.bytesSent() < 32 * 1024 * 1024,
    `kept reading: merchant pushed ${m.bytesSent()} bytes`,
  );
});

// ---------- (i) the purchased data is kept before settlement is proven ----------

const ACME = {
  status_code: 200,
  content_type: 'application/json',
  body: '{"company":"acme","products":[]}',
};
const savedResponse = (store: MemoryPaymentStore, id: string) => {
  const json = store.rows.get(id)?.response_json;
  return json ? JSON.parse(json) : null;
};

test('(i) 200 with data but no settlement proof yet: the data is saved and still there once settlement is recorded', async () => {
  const { store, paymentId, payments, quote } = await setup(['200_without_settlement_header']);

  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  assert.deepEqual(savedResponse(store, paymentId), ACME, 'saved before settlement was proven');

  assert.equal(await store.settle(paymentId, TX), true); // the reconciler finds the settlement later
  assert.deepEqual(savedResponse(store, paymentId), ACME, 'delivered from the saved reply');
});

test('(i) a retry keeps the first saved reply', async () => {
  const { store, paymentId, payments, quote } = await setup([
    '200_without_settlement_header',
    'settle',
  ]);

  assert.deepEqual(await payments.pay(paymentId, quote), { state: 'UNKNOWN' });
  assert.equal((await payments.pay(paymentId, quote)).state, 'SETTLED');

  assert.deepEqual(
    store.calls.filter((c) => c.method === 'saveResponse').map((c) => c.changed),
    [true, false],
  );
  assert.deepEqual(savedResponse(store, paymentId), ACME);
});

for (const outcome of ['402', '500', 'endless_body_without_settlement'] as const) {
  test(`(i) ${outcome}: nothing is saved as purchased data`, async () => {
    const { store, paymentId, payments, quote } = await setup([outcome]);

    await payments.pay(paymentId, quote);

    assert.equal(savedResponse(store, paymentId), null);
  });
}

test('(i) a failing save does not stop the settlement from being recorded', async () => {
  const { store, paymentId, payments, quote } = await setup(['settle']);
  store.saveResponse = async () => {
    throw new Error('disk full');
  };

  const result = await payments.pay(paymentId, quote);

  assert.equal(result.state, 'SETTLED');
  assert.equal((await store.get(paymentId))?.state, 'SETTLED');
});

// ---------- (c) a payment stuck in SIGNED is failed by the reconciler ----------

test('(c) reconciler fails a payment stuck in SIGNED without asking the chain or the merchant', async () => {
  const store = new MemoryPaymentStore();
  const rpc = await countingRpc();
  let merchantHits = 0;
  await listen((_req, res) => (merchantHits++, res.end()));
  // Signed with plenty of validity left: it is still FAILED, because it never left the process.
  store.seed({
    id: 'pay_signed',
    state: 'SIGNED',
    amount: PRICE,
    payee: PAYEE,
    nonce: '0x65fdb52b2c867d0825b833ad0e0f22fe127f8262640d187602c7acd6cb6dc26a',
    valid_before: systemClock.now() + 5 * 60_000,
    authorization_json: JSON.stringify({
      x402Version: 2,
      payload: { signature: '0x', authorization: {} },
    }),
  });
  const payments = createPayments({
    store,
    config: { walletPrivateKey: generatePrivateKey(), rpcUrl: rpc.url },
  });

  const result = await payments.reconcile('pay_signed');

  assert.equal(result, 'FAILED');
  assert.equal((await store.get('pay_signed'))?.state, 'FAILED');
  assert.equal(store.called('fail'), 1);
  assert.equal(rpc.hits(), 0, 'a SIGNED payment needs no chain lookup');
  assert.equal(merchantHits, 0, 'and must never be sent');
});
