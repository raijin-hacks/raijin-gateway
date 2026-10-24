import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test, vi } from 'vitest';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPriceScopeApp } from './pricescope.js';

const NETWORK = 'eip155:84532';
const PRICE_SCOPE_PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae';
const ATTACKER_PAYEE = '0xca7c3c3ac945e0febcebae02de1fbe847bcd4d19';
const AUTHORIZED_SETTLEMENT = {
  success: true,
  transaction: `0x${'1'.repeat(64)}`,
  network: NETWORK,
};

type FacilitatorCounts = { verified: number; settled: number };

const listeningServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    listeningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(
  handler: RequestListener | ReturnType<typeof createPriceScopeApp>,
): Promise<string> {
  const server = createServer(handler as RequestListener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  listeningServers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startFacilitator(counts: FacilitatorCounts): Promise<string> {
  return listen((req, res) => {
    if (req.method === 'GET' && req.url === '/supported') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
          extensions: [],
          signers: {},
        }),
      );
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        paymentPayload: { payload: { authorization: { from: string } } };
      };
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/verify') {
        counts.verified += 1;
        res.end(
          JSON.stringify({
            isValid: true,
            payer: parsed.paymentPayload.payload.authorization.from,
          }),
        );
        return;
      }
      if (req.url === '/settle') {
        counts.settled += 1;
        res.end(
          JSON.stringify({
            ...AUTHORIZED_SETTLEMENT,
            payer: parsed.paymentPayload.payload.authorization.from,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
}

async function startPriceScope(facilitatorUrl: string): Promise<string> {
  vi.stubEnv('FACILITATOR_URL', facilitatorUrl);
  return listen(createPriceScopeApp());
}

async function control(baseUrl: string, mode: string): Promise<Response> {
  return fetch(`${baseUrl}/_control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

async function quote(baseUrl: string, path = '/v1/pricing/acme') {
  const response = await fetch(`${baseUrl}${path}`, {
    method: path.endsWith('/export') ? 'POST' : 'GET',
  });
  const required = JSON.parse(
    Buffer.from(response.headers.get('PAYMENT-REQUIRED') ?? '', 'base64').toString('utf8'),
  ) as { accepts: { amount: string; payTo: string }[] };
  return { response, requirement: required.accepts[0] };
}

async function sendPaidRequest(
  baseUrl: string,
  path: string,
): Promise<{
  status: number | undefined;
  body: string;
  error?: Error;
}> {
  const unpaid = await fetch(`${baseUrl}${path}`, {
    method: path.endsWith('/export') ? 'POST' : 'GET',
  });
  const http = new x402HTTPClient(
    new x402Client().register(
      'eip155:*',
      new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())),
    ),
  );
  const required = http.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.json(),
  );
  const payload = await http.createPaymentPayload(required);
  const headers = http.encodePaymentSignatureHeader(payload);
  return new Promise((resolve) => {
    const request = httpRequest(
      new URL(path, baseUrl),
      { method: path.endsWith('/export') ? 'POST' : 'GET', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('aborted', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', (error) => resolve({ status: undefined, body: '', error }));
    request.end();
  });
}

test.each([
  ['normal', '10000', PRICE_SCOPE_PAYEE],
  ['price_switch', '900000', PRICE_SCOPE_PAYEE],
  ['ratchet', '10000', PRICE_SCOPE_PAYEE],
  ['payee_swap', '10000', ATTACKER_PAYEE],
  ['drop_after_settle', '10000', PRICE_SCOPE_PAYEE],
] as const)(
  'unpaid quote in %s mode names expected amount and payee',
  async (mode, amount, payee) => {
    const counts = { verified: 0, settled: 0 };
    const facilitatorUrl = await startFacilitator(counts);
    const baseUrl = await startPriceScope(facilitatorUrl);
    const controlResponse = await control(baseUrl, mode);
    assert.equal(controlResponse.status, 200);
    assert.deepEqual(await controlResponse.json(), { mode });

    const { response, requirement } = await quote(baseUrl);
    assert.equal(response.status, 402);
    assert.equal(requirement.amount, amount);
    assert.equal(requirement.payTo.toLowerCase(), payee.toLowerCase());
    assert.equal(counts.verified, 0);
    assert.equal(counts.settled, 0);
  },
);

test('control rejects unknown modes and accepts normal without payment', async () => {
  const counts = { verified: 0, settled: 0 };
  const facilitatorUrl = await startFacilitator(counts);
  const baseUrl = await startPriceScope(facilitatorUrl);

  const invalid = await control(baseUrl, 'unknown');
  assert.equal(invalid.status, 400);
  const valid = await control(baseUrl, 'normal');
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { mode: 'normal' });
  assert.equal(counts.verified, 0);
});

test('export is a POST priced at 500000 atomic USDC', async () => {
  const counts = { verified: 0, settled: 0 };
  const facilitatorUrl = await startFacilitator(counts);
  const baseUrl = await startPriceScope(facilitatorUrl);
  const { response, requirement } = await quote(baseUrl, '/v1/pricing/export');

  assert.equal(response.status, 402);
  assert.equal(requirement.amount, '500000');
  assert.equal(requirement.payTo.toLowerCase(), PRICE_SCOPE_PAYEE.toLowerCase());
});

test('ratchet doubles only after a successful settlement', async () => {
  const counts = { verified: 0, settled: 0 };
  const facilitatorUrl = await startFacilitator(counts);
  const baseUrl = await startPriceScope(facilitatorUrl);
  assert.equal((await control(baseUrl, 'ratchet')).status, 200);

  const paid = await sendPaidRequest(baseUrl, '/v1/pricing/acme');
  assert.equal(paid.status, 200);
  assert.equal(counts.verified, 1);
  assert.equal(counts.settled, 1);

  const { requirement } = await quote(baseUrl);
  assert.equal(requirement.amount, '20000');
});

test('drop_after_settle destroys the connection before response bytes and resets to normal', async () => {
  const counts = { verified: 0, settled: 0 };
  const facilitatorUrl = await startFacilitator(counts);
  const baseUrl = await startPriceScope(facilitatorUrl);
  assert.equal((await control(baseUrl, 'drop_after_settle')).status, 200);

  const dropped = await sendPaidRequest(baseUrl, '/v1/pricing/acme');
  assert.equal(counts.verified, 1);
  assert.equal(counts.settled, 1, 'facilitator settled before the response connection closed');
  assert.equal(dropped.status, undefined, 'client received no response headers');
  assert.equal(dropped.body, '', 'client received no response bytes');
  assert.ok(dropped.error, 'client observed the destroyed connection');

  const { requirement } = await quote(baseUrl);
  assert.equal(requirement.amount, '10000');
  assert.equal(requirement.payTo.toLowerCase(), PRICE_SCOPE_PAYEE.toLowerCase());
});
