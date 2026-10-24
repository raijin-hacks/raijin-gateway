// J2b: the pinned transport against a real local merchant and a real, loader-admitted catalog.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, test } from 'vitest';
import { loadCatalog } from '../catalog/index.js';
import { FIXTURE_CATALOG_PATH } from '../../test/harness/db.js';
import { createDestinationVerifier, DestinationError } from './destination.js';
import { getQuote, QuoteError } from './quote.js';
import { createPinnedTransport } from './transport.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae';
const dir = mkdtempSync(join(tmpdir(), 'transport-'));
const servers: ReturnType<typeof createServer>[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

// A PriceScope-like merchant: 402 with requirements on /v1/pricing/*, a redirect on /redirect.
async function merchant() {
  const seen: IncomingMessage[] = [];
  let attackerHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/attacker') {
      attackerHits++;
      return res.end();
    }
    seen.push(req);
    if (req.url?.startsWith('/v1/pricing/redirect')) {
      res.writeHead(302, { Location: '/attacker' });
      return res.end();
    }
    const required = {
      x402Version: 2,
      resource: { url: `http://merchant${req.url}` },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: USDC,
          payTo: PAYEE,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64'),
    });
    res.end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, attackerHits: () => attackerHits };
}

// The fixture catalog with PriceScope moved to this test's port: loopback HTTP only works for an
// exact cataloged origin, so the catalog has to name it, and it has to go through the real loader.
function catalogFor(port: number) {
  const path = join(dir, `catalog-${port}.json`);
  const text = readFileSync(FIXTURE_CATALOG_PATH, 'utf8').replace(
    'http://localhost:4101',
    `http://localhost:${port}`,
  );
  writeFileSync(path, text);
  return loadCatalog(path);
}

// DNS stub that counts lookups and returns whatever the test sets.
function dns(...answerSets: { address: string; family: number }[][]) {
  let calls = 0;
  const resolve = async () => answerSets[Math.min(calls++, answerSets.length - 1)]!;
  return { resolve, calls: () => calls };
}

const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

test('quotes a cataloged demo merchant through the pinned connection', async () => {
  const m = await merchant();
  const lookups = dns(LOOPBACK);
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), lookups.resolve),
  );

  const quote = await getQuote(`http://localhost:${m.port}/v1/pricing/acme`, 'GET', transport);

  assert.equal(quote.amount, 10000);
  assert.equal(quote.payee, PAYEE);
  assert.equal(m.seen[0]?.headers.host, `localhost:${m.port}`, 'the real hostname is sent');
  assert.equal(lookups.calls(), 1, 'one DNS lookup per request');
});

test('each request re-checks DNS: a rebinding answer on the next request is refused before connecting', async () => {
  const m = await merchant();
  const lookups = dns(LOOPBACK, [{ address: '10.0.0.5', family: 4 }]);
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), lookups.resolve),
  );
  const url = `http://localhost:${m.port}/v1/pricing/acme`;

  await getQuote(url, 'GET', transport);
  await assert.rejects(getQuote(url, 'GET', transport), (err: unknown) => {
    assert.ok(err instanceof QuoteError);
    assert.equal(err.code, 'QUOTE_INVALID');
    return true;
  });

  assert.equal(m.seen.length, 1, 'the rebound request never connected');
});

test('a cataloged origin with any non-loopback DNS answer is refused before connecting', async () => {
  const m = await merchant();
  const lookups = dns([...LOOPBACK, { address: '8.8.8.8', family: 4 }]);
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), lookups.resolve),
  );

  await assert.rejects(
    transport(`http://localhost:${m.port}/v1/pricing/acme`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    }),
    DestinationError,
  );
  assert.equal(m.seen.length, 0);
});

test('an origin that is not in the catalog is refused without a lookup or a connection', async () => {
  const m = await merchant();
  const other = await merchant();
  const lookups = dns(LOOPBACK);
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), lookups.resolve),
  );

  await assert.rejects(
    transport(`http://localhost:${other.port}/v1/pricing/acme`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    }),
    DestinationError,
  );
  assert.equal(lookups.calls(), 0);
  assert.equal(other.seen.length, 0);
});

test('a redirect is returned, never followed: getQuote refuses it and the target is never contacted', async () => {
  const m = await merchant();
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), dns(LOOPBACK).resolve),
  );

  await assert.rejects(
    getQuote(`http://localhost:${m.port}/v1/pricing/redirect`, 'GET', transport),
    (err: unknown) => err instanceof QuoteError && err.code === 'QUOTE_INVALID',
  );
  assert.equal(m.attackerHits(), 0);
});

test('proxy environment variables are ignored: the connection goes straight to the verified address', async () => {
  const m = await merchant();
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), dns(LOOPBACK).resolve),
  );
  const saved = { ...process.env };
  process.env.HTTP_PROXY = process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = process.env.https_proxy = 'http://127.0.0.1:9';
  try {
    const quote = await getQuote(`http://localhost:${m.port}/v1/pricing/acme`, 'GET', transport);
    assert.equal(quote.amount, 10000);
  } finally {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('connects to the pinned address, never re-resolving the name (.invalid can only work through the pin)', async () => {
  const m = await merchant();
  const transport = createPinnedTransport(async () => ({
    canonicalUrl: `http://pinned.invalid:${m.port}/v1/pricing/acme`,
    hostname: 'pinned.invalid',
    address: '127.0.0.1',
    family: 4,
  }));

  const res = await transport(`http://pinned.invalid:${m.port}/v1/pricing/acme`, {
    method: 'GET',
    signal: AbortSignal.timeout(3000),
  });

  assert.equal(res.status, 402);
  assert.equal(m.seen[0]?.headers.host, `pinned.invalid:${m.port}`);
});

test('an HTTPS origin that is not in the catalog is refused, even with a public DNS answer', async () => {
  const m = await merchant();
  const lookups = dns([{ address: '93.184.215.14', family: 4 }]);
  const transport = createPinnedTransport(
    createDestinationVerifier(catalogFor(m.port), lookups.resolve),
  );

  await assert.rejects(
    transport('https://uncataloged.example.com/v1/pricing/acme', {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    }),
    DestinationError,
  );
  assert.equal(lookups.calls(), 0, 'refused before any lookup');
});
