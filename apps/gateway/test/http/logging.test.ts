import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';
import { ADMIN_TOKEN, MANDATE_BODY, createHarness } from '../harness/app.js';
import { TestClock } from '../harness/clock.js';

describe('logs never contain a token (S7)', () => {
  it('after mandates are created, used, refused and closed', async () => {
    const h = createHarness();
    const first = await h.createMandate();
    await h.createMandate();
    // A mandate token on an admin route, a bad token, a malformed body, a close.
    await h.request('/mandates', {
      method: 'POST',
      token: first.token,
      body: JSON.stringify(MANDATE_BODY),
    });
    await h.request('/catalog', { token: 'not-the-admin-token' });
    await h.admin('/mandates', { method: 'POST', body: '{broken' });
    await h.admin(`/mandates/${first.mandate_id}/close`, { method: 'POST' });

    expect(h.logs.length).toBeGreaterThan(0);
    const all = h.logs.join('\n');
    for (const token of [...h.issuedTokens, ADMIN_TOKEN]) expect(all).not.toContain(token);
  });

  it('logs one line per request with method, path and status', async () => {
    const h = createHarness();
    await h.request('/catalog');
    const line = JSON.parse(h.logs.at(-1) ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      msg: 'request',
      method: 'GET',
      path: '/catalog',
      status: 401,
    });
  });
});

describe('createLogger', () => {
  const capture = (secrets: string[] = []) => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) }, { clock: new TestClock(), secrets });
    return { log, lines };
  };

  it('redacts Bearer credentials, token-shaped strings and named secrets', () => {
    const { log, lines } = capture(['hunter2-admin']);
    const token = 'Zx9_-'.repeat(8) + 'abc'; // 43 base64url characters, like a mandate token
    log.warn(`Authorization: Bearer abc.def leaked ${token}`, {
      header: 'bearer xyz',
      admin: 'hunter2-admin',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/abc\.def|xyz|hunter2-admin/);
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).toContain('[redacted]');
  });

  it('keeps ids and ordinary values readable', () => {
    const { log, lines } = capture();
    log.info('mandate created', {
      mandate_id: 'mnd_01JB7XK3ABCDEFGHJKMNPQRSTV',
      budget: 2_000_000,
    });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 'info',
      msg: 'mandate created',
      mandate_id: 'mnd_01JB7XK3ABCDEFGHJKMNPQRSTV',
      budget: 2_000_000,
    });
  });

  it('records errors by name and message', () => {
    const { log, lines } = capture();
    log.error('boom', { error: new TypeError('bad thing') });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      error: { name: 'TypeError', message: 'bad thing' },
    });
  });
});
