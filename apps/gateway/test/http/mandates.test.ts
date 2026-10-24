import { CatalogSchema } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { MANDATE_BODY, createHarness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH, count, createGrant, dumpAll, one } from '../harness/db.js';

describe('POST /mandates', () => {
  it('creates the mandate and its session, and returns the token once', async () => {
    const h = createHarness();
    const res = await h.postMandate();
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const created = (await res.json()) as { mandate_id: string; session_id: string; token: string };
    expect(Object.keys(created).sort()).toEqual(['mandate_id', 'session_id', 'token']);
    expect(created.mandate_id).toMatch(/^mnd_[0-9A-Z]{26}$/);
    expect(created.session_id).toMatch(/^ses_[0-9A-Z]{26}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(one(h.db, 'SELECT * FROM mandates WHERE id = ?', created.mandate_id)).toEqual({
      id: created.mandate_id,
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
      created_by: 'admin',
      created_at: h.clock.now(),
    });
    expect(one(h.db, 'SELECT * FROM sessions WHERE id = ?', created.session_id)).toEqual({
      id: created.session_id,
      mandate_id: created.mandate_id,
      agent_id: MANDATE_BODY.agent_id,
      trust: 70,
      status: 'active',
      created_at: h.clock.now(),
    });
    expect(dumpAll(h.db)).not.toContain(created.token);
  });

  it("starts the session at the agent's current trust", async () => {
    const h = createHarness();
    h.db.sqlite.prepare("UPDATE agents SET trust = 55.5 WHERE id = 'agt_pricing'").run();
    const { session_id } = await h.createMandate();
    expect(one(h.db, 'SELECT trust FROM sessions WHERE id = ?', session_id)).toEqual({
      trust: 55.5,
    });
  });

  it('works for every seeded agent and records the right one', async () => {
    const h = createHarness();
    for (const agent_id of ['agt_pricing', 'agt_logistics', 'agt_bulk']) {
      const { mandate_id } = await h.createMandate({ agent_id });
      expect(one(h.db, 'SELECT agent_id FROM mandates WHERE id = ?', mandate_id)).toEqual({
        agent_id,
      });
    }
  });

  it('trims, lowercases and dedupes subjects, and dedupes merchants', async () => {
    const h = createHarness();
    const { mandate_id } = await h.createMandate({
      subjects: ['  ACME ', 'acme', 'Globex'],
      allowed_merchant_ids: ['mer_pricing', 'mer_weather', 'mer_pricing'],
    });
    expect(
      one(
        h.db,
        'SELECT subjects_json, allowed_merchants_json FROM mandates WHERE id = ?',
        mandate_id,
      ),
    ).toEqual({
      subjects_json: '["acme","globex"]',
      allowed_merchants_json: '["mer_pricing","mer_weather"]',
    });
  });

  it('accepts a mandate with no subjects and no merchants', async () => {
    const h = createHarness();
    const { mandate_id } = await h.createMandate({ subjects: [], allowed_merchant_ids: [] });
    expect(
      one(
        h.db,
        'SELECT subjects_json, allowed_merchants_json FROM mandates WHERE id = ?',
        mandate_id,
      ),
    ).toEqual({
      subjects_json: '[]',
      allowed_merchants_json: '[]',
    });
  });

  it('issues a different token for every mandate', async () => {
    const h = createHarness();
    const created = await Promise.all([1, 2, 3, 4, 5].map(() => h.createMandate()));
    expect(new Set(created.map((c) => c.token)).size).toBe(5);
    expect(new Set(created.map((c) => c.mandate_id)).size).toBe(5);
  });

  it.each([
    [
      'a merchant not in the catalog',
      { allowed_merchant_ids: ['mer_pricing', 'mer_attacker'] },
      'allowed_merchant_ids',
      'mer_attacker',
    ],
    ['an agent that does not exist', { agent_id: 'agt_nobody' }, 'agent_id', 'Unknown agent'],
    ['a zero budget', { budget: 0 }, 'budget', ''],
    ['a blank subject', { subjects: ['ok', '   '] }, 'subjects.1', ''],
    ['a field the contract does not define', { token: 'chosen-by-caller' }, '', ''],
  ])('answers 400 to %s, says where, and stores nothing', async (_, patch, path, message) => {
    const h = createHarness();
    const res = await h.postMandate(patch);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('bad_request');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.map((i) => i.path)).toContain(path);
    expect(body.issues.map((i) => i.message).join(' ')).toContain(message);
    expect(count(h.db, 'mandates')).toBe(0);
    expect(count(h.db, 'sessions')).toBe(0);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"mandate"'],
  ])('answers 400 to %s', async (_, body) => {
    const h = createHarness();
    const res = await h.postMandate(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('answers 413 to an oversized body and stores nothing', async () => {
    const h = createHarness();
    const res = await h.postMandate({ task: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(count(h.db, 'mandates')).toBe(0);
  });

  it('logs the creation without the token', async () => {
    const h = createHarness();
    const { mandate_id, token } = await h.createMandate();
    const entry = h.logRecords().find((r) => r.msg === 'mandate created');
    expect(entry).toMatchObject({
      mandate_id,
      agent_id: 'agt_pricing',
      budget: MANDATE_BODY.budget,
    });
    expect(JSON.stringify(entry)).not.toContain(token);
  });
});

describe('POST /mandates/:id/close', () => {
  it('closes the mandate, deletes its grants and ends its session', async () => {
    const h = createHarness();
    const { mandate_id, session_id } = await h.createMandate();
    createGrant(h.db, h.clock, { mandateId: mandate_id, sessionId: session_id }, { maxTotal: 100 });

    const res = await h.closeMandate(mandate_id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(one(h.db, 'SELECT status FROM mandates WHERE id = ?', mandate_id)).toEqual({
      status: 'closed',
    });
    expect(one(h.db, 'SELECT status FROM sessions WHERE id = ?', session_id)).toEqual({
      status: 'ended',
    });
    expect(count(h.db, 'grants')).toBe(0);
    expect(
      h.logRecords().some((r) => r.msg === 'mandate closed' && r.mandate_id === mandate_id),
    ).toBe(true);
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
    await h.closeMandate(closing.mandate_id);
    expect(one(h.db, 'SELECT status FROM mandates WHERE id = ?', other.mandate_id)).toEqual({
      status: 'active',
    });
    expect(count(h.db, 'grants', 'mandate_id = ?', other.mandate_id)).toBe(1);
  });

  it('is safe to call twice, with or without a body', async () => {
    const h = createHarness();
    const { mandate_id } = await h.createMandate();
    expect((await h.closeMandate(mandate_id)).status).toBe(200);
    expect((await h.admin(`/mandates/${mandate_id}/close`, { method: 'POST' })).status).toBe(200);
  });

  it('answers 404 to an unknown mandate', async () => {
    const h = createHarness();
    const res = await h.closeMandate('mnd_missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /catalog', () => {
  it('returns the loaded catalog as JSON', async () => {
    const h = createHarness();
    const res = await h.admin('/catalog');
    expect(res.status).toBe(200);
    expect(CatalogSchema.parse(await res.json())).toEqual(loadCatalog(FIXTURE_CATALOG_PATH));
  });
});

describe('GET /health', () => {
  it('needs no token', async () => {
    const res = await createHarness().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
