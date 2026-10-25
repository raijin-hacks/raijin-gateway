import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJournal } from './journal.js';
import { findPage, pageUrl, purchaseHash } from './pages.js';
import { runCompromised } from './profiles.js';
import { createTools } from './tools.js';

const token = 't'.repeat(43);

function transport(pays: unknown[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://localhost:4199/pages/')) {
      return new Response('<html><body>untrusted page</body></html>');
    }
    if (url === 'http://localhost:4000/pay') {
      pays.push(JSON.parse(String(init?.body)));
      return Response.json({
        status: 'denied',
        decision_id: 'dec_a',
        stage: 'judge',
        reasons: ['JUDGE_OFF_TASK'],
        explanation: null,
      });
    }
    throw new Error('UNEXPECTED_URL');
  };
}

async function compromisedRun(journalPath: string) {
  const pays: {
    url: string;
    method: string;
    expected_price: number;
    purpose: string;
    idempotency_key: string;
  }[] = [];
  const pages: string[] = [];
  const inner = createTools({
    gateway: 'http://localhost:4000',
    token,
    journal: createJournal(journalPath),
    transport: transport(pays),
  });
  const result = await runCompromised(
    'demo',
    {
      async fetch_url(url) {
        pages.push(url);
        return inner.fetch_url(url);
      },
      paid_fetch: inner.paid_fetch,
    },
    () => {},
  );
  return { result, pays, pages };
}

it('reads the page then paid_fetchs the manifest tuple', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apf-lab-'));
  const { result, pays, pages } = await compromisedRun(join(dir, 'one.json'));
  const intended = findPage('demo').intended_purchase;
  expect(pages).toEqual([pageUrl('demo')]);
  expect(pays).toHaveLength(1);
  expect(pays[0]).toMatchObject(intended);
  expect(result.hash).toBe(purchaseHash(intended));
  expect(result.status).toBe('denied');
});

it('keeps the same fingerprint on a second run with a new key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apf-lab-'));
  const first = await compromisedRun(join(dir, 'a.json'));
  const second = await compromisedRun(join(dir, 'b.json'));
  expect(first.result.hash).toBe(second.result.hash);
  expect(first.pays[0]!.idempotency_key).not.toBe(second.pays[0]!.idempotency_key);
  expect([
    first.pays[0]!.url,
    first.pays[0]!.method,
    first.pays[0]!.expected_price,
    first.pays[0]!.purpose,
  ]).toEqual([
    second.pays[0]!.url,
    second.pays[0]!.method,
    second.pays[0]!.expected_price,
    second.pays[0]!.purpose,
  ]);
});
