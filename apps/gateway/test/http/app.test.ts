import type { Catalog } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { createHarness } from '../harness/app.js';
import { FIXTURE_CATALOG_PATH } from '../harness/db.js';

describe('createApp', () => {
  it.each([
    ['an unknown path', 'GET', '/nowhere'],
    ['a known path with the wrong method', 'DELETE', '/mandates'],
    ['GET on a POST-only route', 'GET', '/mandates/mnd_1/close'],
  ])('answers 404 JSON to %s', async (_, method, path) => {
    const h = createHarness();
    const res = await h.admin(path, { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 500 JSON to an unexpected error, and logs it without details leaking', async () => {
    const broken = loadCatalog(FIXTURE_CATALOG_PATH) as Catalog & { toJSON(): never };
    broken.toJSON = () => {
      throw new Error('catalog exploded');
    };
    const h = createHarness({}, { catalog: broken });

    const res = await h.admin('/catalog');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(h.logRecords()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'unhandled error',
        method: 'GET',
        path: '/catalog',
        error: { name: 'Error', message: 'catalog exploded' },
      }),
    );
    expect(h.logRecords().at(-1)).toMatchObject({ msg: 'request', status: 500 });
  });

  it('logs requests refused for size', async () => {
    const h = createHarness();
    await h.postMandate({ task: 'x'.repeat(70_000) });
    expect(h.logRecords().at(-1)).toMatchObject({ msg: 'request', path: '/mandates', status: 413 });
  });

  it('lets a body under the size limit through to validation', async () => {
    const h = createHarness();
    // 60 KB of padding in an unknown field: the schema rejects it (400), not the size limit (413).
    const res = await h.postMandate({ padding: 'x'.repeat(60_000) });
    expect(res.status).toBe(400);
  });
});
