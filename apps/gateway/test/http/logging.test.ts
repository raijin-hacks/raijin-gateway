import { describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, createHarness } from '../harness/app.js';

describe('logs never contain a token (S7)', () => {
  it('across creating, using, refusing and closing mandates', async () => {
    const h = createHarness();
    const first = await h.createMandate();
    await h.createMandate();
    // A mandate token on every admin route, a bad token, a malformed body, a close, a 404.
    await h.postMandate({}, first.token);
    await h.request('/catalog', { token: first.token });
    await h.request(`/mandates/${first.mandate_id}/close`, { method: 'POST', token: first.token });
    await h.request('/catalog', { token: 'not-the-admin-token' });
    await h.postMandate('{broken');
    await h.closeMandate(first.mandate_id);
    await h.request(`/nowhere?token=${first.token}`);

    expect(h.logs.length).toBeGreaterThan(5);
    const all = h.logs.join('\n');
    for (const token of [...h.issuedTokens, ADMIN_TOKEN]) expect(all).not.toContain(token);
  });
});

describe('request log', () => {
  it('writes one line per request with method, path, status and duration', async () => {
    const h = createHarness();
    await h.request('/catalog');
    expect(h.logRecords().at(-1)).toEqual({
      level: 'info',
      at: h.clock.now(),
      msg: 'request',
      method: 'GET',
      path: '/catalog',
      status: 401,
      ms: 0,
    });
  });

  it('logs the path without the query string', async () => {
    const h = createHarness();
    await h.request('/health?probe=1');
    expect(h.logRecords().at(-1)).toMatchObject({ path: '/health', status: 200 });
  });

  it('never logs headers or bodies', async () => {
    const h = createHarness();
    await h.postMandate({ task: 'A very distinctive task text' });
    const all = h.logs.join('\n');
    expect(all).not.toContain('distinctive');
    expect(all).not.toMatch(/authorization|content-type/i);
  });
});
