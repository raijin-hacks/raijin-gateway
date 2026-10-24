// A19: an agent crash or restart mid-purchase must never become a second logical purchase.
// Each case runs the real gateway (in process, SQLite, mock payments) and two agent "lives"
// that share only the on-disk journal.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTools } from './tools.js';
import { createJournal } from './journal.js';
import { createHarness } from '../../gateway/test/harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../../gateway/test/harness/db.js';
import { createApp } from '../../gateway/src/app.js';
import { loadCatalog } from '../../gateway/src/catalog/index.js';
import { createPaymentStore } from '../../gateway/src/db/payment-store.js';
import { createMockPayments } from '../../gateway/src/mock-payments.js';
import { createStubJudge } from '../../gateway/src/judge/index.js';

const PURCHASE = {
  url: 'http://localhost:4101/v1/pricing/acme?period=30d',
  method: 'GET' as const,
  expected_price: 10000,
  purpose: 'fetch_data' as const,
};
const BODY = JSON.stringify({ company: 'Acme', basic_monthly_usd: 19 });

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

async function world() {
  const h = createHarness();
  cleanups.push(() => h.db.sqlite.close());
  const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
  const payments = createMockPayments(createPaymentStore(h.db, h.clock), catalog, h.clock);
  let signatures = 0;
  const app = createApp({
    ...h.deps,
    catalog,
    payments: {
      ...payments,
      async pay(id, quote) {
        signatures++;
        const result = await payments.pay(id, quote);
        return result.state === 'SETTLED'
          ? {
              ...result,
              response: { status_code: 200, content_type: 'application/json', body: BODY },
            }
          : result;
      },
    },
    judge: createStubJudge('stub-approve'),
  });
  const mandate = await h.createMandate({});
  const journalPath = join(mkdtempSync(join(tmpdir(), 'agent-restart-')), 'purchases.json');
  const posts: { key: string; body: string }[] = [];
  /** One agent "life". `crash` decides, per POST, whether this life dies at that point. */
  const life = (crash?: { before?: boolean; afterSend?: boolean }) =>
    createTools({
      gateway: 'http://localhost:4000',
      token: mandate.token,
      journal: createJournal(journalPath),
      transport: async (url, init) => {
        if (init?.method === 'POST') {
          if (crash?.before) throw new Error('crashed before sending');
          posts.push({
            key: new Headers(init.headers).get('Idempotency-Key')!,
            body: String(init.body),
          });
        }
        const response = await app.request(String(url), init);
        if (init?.method === 'POST' && crash?.afterSend) throw new Error('crashed after sending');
        return response;
      },
    });
  const payments_ = () =>
    (h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM payments').get() as { n: number }).n;
  return {
    h,
    app,
    mandate,
    journalPath,
    posts,
    life,
    signatures: () => signatures,
    payments: payments_,
  };
}

describe('agent restart (A19)', () => {
  it('crash after journaling, before any POST: the next life sends the journaled key once', async () => {
    const w = await world();
    await expect(w.life({ before: true }).paid_fetch(PURCHASE)).rejects.toThrow(
      'PAYMENT_UNRESOLVED',
    );
    expect(w.posts).toHaveLength(0);
    const journaled = createJournal(w.journalPath).pending(w.mandate.token);
    expect(journaled).toHaveLength(1);

    const output = await w.life().paid_fetch(PURCHASE);
    expect(output.status).toBe('approved');
    expect(w.posts.map((p) => p.key)).toEqual([journaled[0]!.idempotency_key]);
    expect(w.payments()).toBe(1);
    expect(w.signatures()).toBe(1);
  });

  it('crash after POST, before the response: resume replays the same key, no second payment', async () => {
    const w = await world();
    await expect(w.life({ afterSend: true }).paid_fetch(PURCHASE)).rejects.toThrow(
      'PAYMENT_UNRESOLVED',
    );
    const [outcome] = await w.life().resume();
    expect(outcome).toMatchObject({ ok: true, output: { status: 'approved' } });
    expect(new Set(w.posts.map((p) => p.key)).size).toBe(1);
    expect(new Set(w.posts.map((p) => p.body)).size).toBe(1);
    expect(w.payments()).toBe(1);
    expect(w.signatures()).toBe(1);
  });

  it('crash after settlement, before delivery: resume delivers the stored data once', async () => {
    const w = await world();
    const first = await w.life().paid_fetch(PURCHASE);
    expect(first.status).toBe('approved'); // ...and then this life dies before using it.
    const [outcome] = await w.life().resume();
    expect(outcome!.ok && outcome.output.data?.body).toBe(BODY);
    expect(w.payments()).toBe(1);
    expect(w.signatures()).toBe(1);
  });

  it('concurrent resumes of one intent reuse one key and pay once', async () => {
    const w = await world();
    await expect(w.life({ before: true }).paid_fetch(PURCHASE)).rejects.toThrow();
    const results = await Promise.all([w.life().resume(), w.life().resume(), w.life().resume()]);
    for (const [outcome] of results) expect(outcome!.ok).toBe(true);
    expect(new Set(w.posts.map((p) => p.key)).size).toBe(1);
    expect(w.payments()).toBe(1);
    expect(w.signatures()).toBe(1);
  });

  it('409 conflict stops immediately: no retry and no fresh key', async () => {
    const w = await world();
    // Another request already holds this key at the gateway.
    const key = createJournal(w.journalPath).intent(w.mandate.token, PURCHASE).idempotency_key;
    await w.app.request('http://localhost:4000/pay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${w.mandate.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ ...PURCHASE, expected_price: 9999, idempotency_key: key }),
    });
    await expect(w.life().paid_fetch(PURCHASE)).rejects.toThrow('PAYMENT_CONFLICT');
    expect(w.posts.map((p) => p.key)).toEqual([key]); // one attempt, same key
    const [outcome] = await w.life().resume();
    expect(outcome).toEqual({ ok: false, error: 'PAYMENT_CONFLICT' });
  });

  it('a corrupt journal fails closed before any POST', async () => {
    const w = await world();
    await w.life().paid_fetch(PURCHASE);
    writeFileSync(w.journalPath, readFileSync(w.journalPath, 'utf8').slice(0, 20));
    const sent = w.posts.length;
    await expect(w.life().paid_fetch(PURCHASE)).rejects.toThrow('JOURNAL_CORRUPT');
    await expect(w.life().resume()).rejects.toThrow('JOURNAL_CORRUPT');
    expect(w.posts).toHaveLength(sent);
    expect(w.payments()).toBe(1);
  });

  it('resume without a journal does nothing', async () => {
    const w = await world();
    const tools = createTools({ gateway: 'http://localhost:4000', token: w.mandate.token });
    expect(await tools.resume()).toEqual([]);
  });
});
