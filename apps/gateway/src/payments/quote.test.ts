// P3 · getQuote(canonicalUrl, method). Each test runs a throwaway local merchant.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getQuote, QuoteError } from './quote.ts';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x0D972D44bda2Bc27420Debd711395729480186aE'; // mixed case on purpose; Quote.payee must be lowercase

// The 402 PriceScope actually sends (x402 v2): body `{}`, requirements base64 JSON in PAYMENT-REQUIRED.
const baseSepoliaUsdc = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '10000',
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};
const paymentRequired = (accepts: unknown[]) => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'http://localhost/v1/pricing/acme', mimeType: 'application/json' },
  accepts,
});
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: ReturnType<typeof createServer>[] = [];

async function merchant(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

after(() => {
  for (const s of servers) s.closeAllConnections?.(), s.close();
});

const send402 = (res: ServerResponse, accepts: unknown[] = [baseSepoliaUsdc]) => {
  res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': encode(paymentRequired(accepts)) });
  res.end('{}');
};

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof QuoteError, `expected QuoteError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

// ---------- happy path (baseline for the cases below) ----------

test('402 with a Base Sepolia USDC option returns the Quote', async () => {
  const origin = await merchant((_req, res) => send402(res));
  const url = `${origin}/v1/pricing/acme?period=30d`;

  const quote = await getQuote(url, 'GET');

  assert.deepEqual(
    { url: quote.url, method: quote.method, network: quote.network, payee: quote.payee, amount: quote.amount },
    { url, method: 'GET', network: 'eip155:84532', payee: PAYEE.toLowerCase(), amount: 10000 },
  );
  assert.deepEqual(quote.raw, baseSepoliaUsdc, 'raw is the selected requirements object, unchanged');
});

// ---------- 1. no payment attached ----------

test('sends the request without any payment header, using the given method', async () => {
  let seen: IncomingMessage | undefined;
  const origin = await merchant((req, res) => {
    seen = req;
    send402(res);
  });

  await getQuote(`${origin}/v1/pricing/export`, 'POST');

  assert.ok(seen);
  assert.equal(seen.method, 'POST');
  for (const h of ['payment-signature', 'x-payment', 'authorization']) {
    assert.equal(seen.headers[h], undefined, `must not send ${h}`);
  }
});

// ---------- 2. any 3xx is QUOTE_INVALID, never followed ----------

for (const status of [301, 302, 303, 307, 308]) {
  test(`${status} redirect is QUOTE_INVALID and the target is never requested`, async () => {
    let targetHits = 0;
    const origin = await merchant((req, res) => {
      if (req.url === '/attacker') {
        targetHits++;
        return send402(res);
      }
      res.writeHead(status, { Location: '/attacker' });
      res.end();
    });

    await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_INVALID');
    assert.equal(targetHits, 0, 'redirect must not be followed');
  });
}

// ---------- 3. non-402 is NOT_402 ----------

for (const status of [200, 401, 404, 500]) {
  test(`${status} response is NOT_402`, async () => {
    const origin = await merchant((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'NOT_402');
  });
}

// ---------- 4. timeout or network error is QUOTE_FAILED ----------

test('merchant that never responds times out after ~3 s as QUOTE_FAILED', async () => {
  const origin = await merchant(() => {
    /* accept the connection, never answer */
  });

  const started = Date.now();
  await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_FAILED');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2_800 && elapsed < 4_500, `timed out after ${elapsed} ms, expected ~3000`);
});

test('the 3 s timeout also covers a body that stalls after the 402 headers', async () => {
  const origin = await merchant((_req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.write('{"x402Version":'); // ...and never finishes
  });

  const started = Date.now();
  await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_FAILED');
  assert.ok(Date.now() - started < 4_500);
});

test('connection refused is QUOTE_FAILED', async () => {
  const origin = await merchant(() => {});
  const closed = servers.pop()!;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_FAILED');
});

test('unresolvable host is QUOTE_FAILED', async () => {
  await rejectsWith(getQuote('http://quote-test.invalid/v1/pricing/acme', 'GET'), 'QUOTE_FAILED');
});

// ---------- 5. read at most 64 KB ----------

test('an endless 402 body is cut off at 64 KB instead of read to the end', async () => {
  let bytesSent = 0;
  const origin = await merchant((_req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' }); // no PAYMENT-REQUIRED: requirements would have to come from the body
    const chunk = Buffer.alloc(16 * 1024, 'a');
    const pump = () => {
      while (!res.destroyed && res.write(chunk)) bytesSent += chunk.length;
      if (!res.destroyed) res.once('drain', pump);
    };
    pump();
  });

  const started = Date.now();
  await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_INVALID');
  assert.ok(Date.now() - started < 2_800, 'gave up on size, not on the timeout');
  assert.ok(bytesSent < 8 * 1024 * 1024, `kept reading: server pushed ${bytesSent} bytes`);
});

test('a 402 body just over 64 KB is QUOTE_INVALID even if it is valid JSON', async () => {
  const body = JSON.stringify({ ...paymentRequired([baseSepoliaUsdc]), pad: 'x'.repeat(64 * 1024) });
  const origin = await merchant((_req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_INVALID');
});

// ---------- requirements parsing (spec: none or malformed is QUOTE_INVALID) ----------

test('picks the Base Sepolia USDC option when several are offered', async () => {
  const mainnet = { ...baseSepoliaUsdc, network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  const otherToken = { ...baseSepoliaUsdc, asset: '0x1111111111111111111111111111111111111111', amount: '1' };
  const origin = await merchant((_req, res) => send402(res, [mainnet, otherToken, baseSepoliaUsdc]));

  const quote = await getQuote(`${origin}/v1/pricing/acme`, 'GET');
  assert.deepEqual(quote.raw, baseSepoliaUsdc);
  assert.equal(quote.amount, 10000);
});

const invalid: [string, (res: ServerResponse) => void][] = [
  ['no PAYMENT-REQUIRED header and empty body', (res) => (res.writeHead(402), res.end('{}'))],
  ['header that is not base64 JSON', (res) => (res.writeHead(402, { 'PAYMENT-REQUIRED': '!!not-base64-json' }), res.end())],
  ['no option for eip155:84532', (res) => send402(res, [{ ...baseSepoliaUsdc, network: 'eip155:8453' }])],
  ['Base Sepolia option in a non-USDC asset', (res) => send402(res, [{ ...baseSepoliaUsdc, asset: '0x1111111111111111111111111111111111111111' }])],
  ['amount that is not a positive integer', (res) => send402(res, [{ ...baseSepoliaUsdc, amount: '0.01' }])],
  ['payTo that is not an address', (res) => send402(res, [{ ...baseSepoliaUsdc, payTo: 'pricescope' }])],
];
for (const [name, respond] of invalid) {
  test(`QUOTE_INVALID: ${name}`, async () => {
    const origin = await merchant((_req, res) => respond(res));
    await rejectsWith(getQuote(`${origin}/v1/pricing/acme`, 'GET'), 'QUOTE_INVALID');
  });
}
