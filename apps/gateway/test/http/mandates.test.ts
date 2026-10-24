import { CatalogSchema } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { MANDATE_BODY, createHarness, type Harness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH, createGrant } from '../harness/db.js';

const row = (h: Harness, sql: string, ...params: unknown[]) =>
  h.db.sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const count = (h: Harness, table: string) =>
  (row(h, `SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n;

/** Every value in every table, as one string, to prove a secret was never stored. */
function everythingStored(h: Harness): string {
  const tables = h.db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map(({ name }) => h.db.sqlite.prepare(`SELECT * FROM "${name}"`).all()),
  );
}

describe('POST /mandates', () => {
  it('creates the mandate and its session, and returns the token once', async () => {
    const h = createHarness();
    const created = await h.createMandate();

    expect(created.mandate_id).toMatch(/^mnd_[0-9A-Z]{26}$/);
    expect(created.session_id).toMatch(/^ses_[0-9A-Z]{26}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(row(h, 'SELECT * FROM mandates WHERE id = ?', created.mandate_id)).toMatchObject({
      tenant_id: 'tnt_demo',
      agent_id: MANDATE_BODY.agent_id,
      task: MANDATE_BODY.task,
      subjects_json: JSON.stringify(['acme', 'globex', 'initech', 'umbrella', 'hooli']),
      allowed_merchants_json: JSON.stringify(['mer_pricing']),
      budget: MANDATE_BODY.budget,
      spent: 0,
      reserved: 0,
      status: 'active',
      token_hash: hashToken(created.token),
      expires_at: h.clock.now() + MANDATE_BODY.expires_in_ms,
      created_at: h.clock.now(),
    });
    expect(row(h, 'SELECT * FROM sessions WHERE id = ?', created.session_id)).toMatchObject({
      mandate_id: created.mandate_id,
      agent_id: MANDATE_BODY.agent_id,
      trust: 70,
      status: 'active',
    });
    expect(everythingStored(h)).not.toContain(created.token);
  });

  it("starts the session at the agent's current trust", async () => {
    const h = createHarness();
    h.db.sqlite.prepare("UPDATE agents SET trust = 55 WHERE id = 'agt_pricing'").run();
    const { session_id } = await h.createMandate();
    expect(row(h, 'SELECT trust FROM sessions WHERE id = ?', session_id)).toEqual({ trust: 55 });
  });

  it('trims, lowercases and dedupes subjects, and dedupes merchants', async () => {
    const h = createHarness();
    const { mandate_id } = await h.createMandate({
      subjects: ['  ACME ', 'acme', 'Globex'],
      allowed_merchant_ids: ['mer_pricing', 'mer_weather', 'mer_pricing'],
    });
    expect(
      row(h, 'SELECT subjects_json, allowed_merchants_json FROM mandates WHERE id = ?', mandate_id),
    ).toEqual({
      subjects_json: '["acme","globex"]',
      allowed_merchants_json: '["mer_pricing","mer_weather"]',
    });
  });

  it('issues a different token for every mandate', async () => {
    const h = createHarness();
    const tokens = await Promise.all([1, 2, 3].map(() => h.createMandate()));
    expect(new Set(tokens.map((t) => t.token)).size).toBe(3);
  });

  it.each([
    ['a merchant not in the catalog', { allowed_merchant_ids: ['mer_attacker'] }],
    ['an agent that does not exist', { agent_id: 'agt_nobody' }],
    ['a zero budget', { budget: 0 }],
    ['a blank subject', { subjects: ['   '] }],
    ['a field the contract does not define', { token: 'chosen-by-caller' }],
  ])('answers 400 to %s and stores nothing', async (_, patch) => {
    const h = createHarness();
    const res = await h.admin('/mandates', {
      method: 'POST',
      body: JSON.stringify({ ...MANDATE_BODY, ...patch }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
    expect(count(h, 'mandates')).toBe(0);
    expect(count(h, 'sessions')).toBe(0);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const h = createHarness();
    const res = await h.admin('/mandates', { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('answers 413 to an oversized body', async () => {
    const h = createHarness();
    const res = await h.admin('/mandates', {
      method: 'POST',
      body: JSON.stringify({ ...MANDATE_BODY, task: 'x'.repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /mandates/:id/close', () => {
  it('closes the mandate, deletes its grants and ends its session', async () => {
    const h = createHarness();
    const { mandate_id, session_id } = await h.createMandate();
    createGrant(h.db, h.clock, { mandateId: mandate_id, sessionId: session_id }, { maxTotal: 100 });
    expect(count(h, 'grants')).toBe(1);

    const res = await h.admin(`/mandates/${mandate_id}/close`, { method: 'POST', body: '{}' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(row(h, 'SELECT status FROM mandates WHERE id = ?', mandate_id)).toEqual({
      status: 'closed',
    });
    expect(row(h, 'SELECT status FROM sessions WHERE id = ?', session_id)).toEqual({
      status: 'ended',
    });
    expect(count(h, 'grants')).toBe(0);
  });

  it('leaves other mandates and their grants alone', async () => {
    const h = createHarness();
    const closing = await h.createMandate();
    const other = await h.createMandate();
    createGrant(
      h.db,
      h.clock,
      { mandateId: other.mandate_id, sessionId: other.session_id },
      { maxTotal: 100 },
    );
    await h.admin(`/mandates/${closing.mandate_id}/close`, { method: 'POST', body: '{}' });
    expect(row(h, 'SELECT status FROM mandates WHERE id = ?', other.mandate_id)).toEqual({
      status: 'active',
    });
    expect(count(h, 'grants')).toBe(1);
  });

  it('is safe to call twice', async () => {
    const h = createHarness();
    const { mandate_id } = await h.createMandate();
    const close = () => h.admin(`/mandates/${mandate_id}/close`, { method: 'POST' });
    expect((await close()).status).toBe(200);
    expect((await close()).status).toBe(200);
  });

  it('answers 404 to an unknown mandate', async () => {
    const h = createHarness();
    const res = await h.admin('/mandates/mnd_missing/close', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('GET /catalog', () => {
  it('returns the loaded catalog', async () => {
    const h = createHarness();
    const res = await h.admin('/catalog');
    expect(res.status).toBe(200);
    const body = CatalogSchema.parse(await res.json());
    expect(body).toEqual(loadCatalog(FIXTURE_CATALOG_PATH));
  });
});

describe('GET /health', () => {
  it('needs no token', async () => {
    const h = createHarness();
    const res = await h.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
