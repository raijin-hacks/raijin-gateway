import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app.js';
import { agentAuth, hashToken } from '../../src/auth.js';
import { ADMIN_TOKEN, MANDATE_BODY, createHarness, type Harness } from '../harness/app.js';

const ADMIN_ROUTES: [string, string, string?][] = [
  ['POST', '/mandates', JSON.stringify(MANDATE_BODY)],
  ['POST', '/mandates/mnd_any/close', '{}'],
  ['GET', '/catalog'],
  ['GET', '/stream'],
];

/** A throwaway app with one agent-only route, to exercise the agent middleware alone. */
function agentProbe(h: Harness) {
  const app = new Hono<AppEnv>();
  app.use(agentAuth(h.deps));
  app.get('/whoami', (c) =>
    c.json({ mandate: c.var.agent.mandate.id, session: c.var.agent.session.id }),
  );
  return (token?: string) =>
    app.request(
      '/whoami',
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
}

const mandateCount = (h: Harness) =>
  (h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM mandates').get() as { n: number }).n;

describe('admin routes', () => {
  it.each(ADMIN_ROUTES)('%s %s answers 401 with no token', async (method, path, body) => {
    const h = createHarness();
    const res = await h.request(path, { method, body });
    expect(res.status).toBe(401);
  });

  it.each(ADMIN_ROUTES)('%s %s answers 401 to a non-Bearer header', async (method, path, body) => {
    const h = createHarness();
    const res = await h.request(path, {
      method,
      body,
      headers: { authorization: `Basic ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it.each(ADMIN_ROUTES)('%s %s answers 403 to a wrong token', async (method, path, body) => {
    const h = createHarness();
    const res = await h.request(path, { method, body, token: `${ADMIN_TOKEN}x` });
    expect(res.status).toBe(403);
  });

  it.each(ADMIN_ROUTES)(
    '%s %s answers 403 to a mandate token (A11)',
    async (method, path, body) => {
      const h = createHarness();
      const { token } = await h.createMandate();
      const before = mandateCount(h);
      const res = await h.request(path, { method, body, token });
      expect(res.status).toBe(403);
      expect(mandateCount(h)).toBe(before);
    },
  );
});

describe('agent authentication', () => {
  it('loads the mandate and session for a valid token', async () => {
    const h = createHarness();
    const created = await h.createMandate();
    const res = await agentProbe(h)(created.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mandate: created.mandate_id, session: created.session_id });
  });

  it.each([
    ['no token', undefined],
    ['an unknown token', 'A'.repeat(43)],
    ['the admin token', ADMIN_TOKEN],
  ])('answers 401 to %s', async (_, token) => {
    const h = createHarness();
    await h.createMandate();
    expect((await agentProbe(h)(token)).status).toBe(401);
  });

  it('answers 401 once the mandate is closed', async () => {
    const h = createHarness();
    const { mandate_id, token } = await h.createMandate();
    await h.admin(`/mandates/${mandate_id}/close`, { method: 'POST', body: '{}' });
    expect((await agentProbe(h)(token)).status).toBe(401);
  });

  it('answers 401 once the mandate expires', async () => {
    const h = createHarness();
    const { token } = await h.createMandate({ expires_in_ms: 60_000 });
    const probe = agentProbe(h);
    expect((await probe(token)).status).toBe(200);
    h.clock.advance(60_000);
    expect((await probe(token)).status).toBe(401);
  });
});

describe('hashToken', () => {
  it('is the SHA-256 hex digest', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});
