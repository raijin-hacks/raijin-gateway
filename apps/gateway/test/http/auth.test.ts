import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app.js';
import { agentAuth, hashToken, newMandateToken } from '../../src/auth.js';
import { ADMIN_TOKEN, MANDATE_BODY, createHarness, type Harness } from '../harness/app.js';
import { count } from '../harness/db.js';

/** Every admin route, and the status it answers once authentication passes. */
const ADMIN_ROUTES = [
  { method: 'POST', path: '/mandates', body: JSON.stringify(MANDATE_BODY), ok: 201 },
  { method: 'POST', path: '/mandates/mnd_any/close', body: '{}', ok: 404 },
  { method: 'GET', path: '/catalog', ok: 200 },
  { method: 'GET', path: '/stream', ok: 200 },
] as const;

/** Authorization headers, and whether each is missing (401), wrong (403) or the admin (ok). */
const ADMIN_HEADERS: [string, string | undefined, 401 | 403 | 'ok'][] = [
  ['no Authorization header', undefined, 401],
  ['a non-Bearer scheme', `Basic ${ADMIN_TOKEN}`, 401],
  ['Bearer with no token', 'Bearer', 401],
  ['Bearer with two tokens', `Bearer ${ADMIN_TOKEN} extra`, 401],
  ['a wrong token', `Bearer ${ADMIN_TOKEN}x`, 403],
  ['a prefix of the admin token', `Bearer ${ADMIN_TOKEN.slice(0, -1)}`, 403],
  ['the admin token', `Bearer ${ADMIN_TOKEN}`, 'ok'],
  ['a lowercase scheme', `bearer ${ADMIN_TOKEN}`, 'ok'],
  ['extra spaces', `Bearer   ${ADMIN_TOKEN}  `, 'ok'],
];

async function send(h: Harness, route: (typeof ADMIN_ROUTES)[number], authorization?: string) {
  const res = await h.request(route.path, {
    method: route.method,
    body: 'body' in route ? route.body : undefined,
    headers: authorization === undefined ? {} : { authorization },
  });
  await res.body?.cancel(); // /stream never ends on its own
  return res.status;
}

describe('admin routes', () => {
  describe.each(ADMIN_ROUTES)('$method $path', (route) => {
    it.each(ADMIN_HEADERS)('with %s', async (_, header, expected) => {
      const h = createHarness();
      expect(await send(h, route, header)).toBe(expected === 'ok' ? route.ok : expected);
    });

    it('answers 403 to a mandate token and changes nothing (A11)', async () => {
      const h = createHarness();
      const { token } = await h.createMandate();
      const before = count(h.db, 'mandates');
      expect(await send(h, route, `Bearer ${token}`)).toBe(403);
      expect(count(h.db, 'mandates')).toBe(before);
    });
  });
});

/** A throwaway app with one agent-only route, to exercise the agent middleware alone. */
function agentProbe(h: Harness) {
  const app = new Hono<AppEnv>();
  app.use(agentAuth(h.deps));
  app.get('/whoami', (c) =>
    c.json({ mandate: c.var.agent.mandate.id, session: c.var.agent.session.id }),
  );
  return (authorization?: string) =>
    app.request('/whoami', authorization === undefined ? {} : { headers: { authorization } });
}

describe('agent authentication', () => {
  it('loads the mandate and session for a valid token', async () => {
    const h = createHarness();
    const created = await h.createMandate();
    const res = await agentProbe(h)(`Bearer ${created.token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mandate: created.mandate_id, session: created.session_id });
  });

  it('accepts a lowercase scheme', async () => {
    const h = createHarness();
    const { token } = await h.createMandate();
    expect((await agentProbe(h)(`bearer ${token}`)).status).toBe(200);
  });

  it.each([
    ['no header', undefined],
    ['Bearer with no token', 'Bearer'],
    ['an unknown token', `Bearer ${'A'.repeat(43)}`],
    ['the admin token', `Bearer ${ADMIN_TOKEN}`],
    ['the token hash instead of the token', 'hash'],
  ])('answers 401 to %s', async (_, header) => {
    const h = createHarness();
    const { token } = await h.createMandate();
    const value = header === 'hash' ? `Bearer ${hashToken(token)}` : header;
    expect((await agentProbe(h)(value)).status).toBe(401);
  });

  it('answers 401 once the mandate is closed', async () => {
    const h = createHarness();
    const { mandate_id, token } = await h.createMandate();
    await h.closeMandate(mandate_id);
    expect((await agentProbe(h)(`Bearer ${token}`)).status).toBe(401);
  });

  it('answers 401 from the expiry instant on', async () => {
    const h = createHarness();
    const { token } = await h.createMandate({ expires_in_ms: 60_000 });
    const probe = agentProbe(h);
    h.clock.advance(59_999);
    expect((await probe(`Bearer ${token}`)).status).toBe(200);
    h.clock.advance(1);
    expect((await probe(`Bearer ${token}`)).status).toBe(401);
  });

  it('answers 401 for a mandate marked expired', async () => {
    const h = createHarness();
    const { mandate_id, token } = await h.createMandate();
    h.db.sqlite.prepare("UPDATE mandates SET status = 'expired' WHERE id = ?").run(mandate_id);
    expect((await agentProbe(h)(`Bearer ${token}`)).status).toBe(401);
  });

  it('lets a quarantined session through, for the pipeline to deny (D8)', async () => {
    const h = createHarness();
    const { session_id, token } = await h.createMandate();
    h.db.sqlite.prepare("UPDATE sessions SET status = 'quarantined' WHERE id = ?").run(session_id);
    expect((await agentProbe(h)(`Bearer ${token}`)).status).toBe(200);
  });

  it('keeps each token bound to its own mandate', async () => {
    const h = createHarness();
    const a = await h.createMandate();
    const b = await h.createMandate();
    const probe = agentProbe(h);
    expect(await (await probe(`Bearer ${a.token}`)).json()).toMatchObject({
      mandate: a.mandate_id,
    });
    expect(await (await probe(`Bearer ${b.token}`)).json()).toMatchObject({
      mandate: b.mandate_id,
    });
  });
});

describe('tokens', () => {
  it('hashToken is the SHA-256 hex digest', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('newMandateToken is 43 base64url characters and never repeats', () => {
    const tokens = Array.from({ length: 1_000 }, () => newMandateToken());
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
