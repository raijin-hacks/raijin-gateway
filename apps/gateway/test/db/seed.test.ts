import { ONE_USDC } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { DEMO, seedDatabase } from '../../src/db/seed.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from '../harness/clock.js';
import { FIXTURE_CATALOG_PATH, seededDb, tempDb } from '../harness/db.js';

const counts = (db: ReturnType<typeof tempDb>) =>
  Object.fromEntries(
    ['tenants', 'roles', 'agents', 'merchants', 'endpoints', 'standing_grants'].map((t) => [
      t,
      (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

describe('seedDatabase', () => {
  it('creates the demo tenant, both roles and three agents at their baseline', () => {
    const { db } = seededDb();
    expect(db.sqlite.prepare('SELECT id, daily_cap FROM tenants').all()).toEqual([
      { id: DEMO.tenantId, daily_cap: 20 * ONE_USDC },
    ]);
    expect(
      db.sqlite
        .prepare(
          "SELECT per_call_cap, velocity_per_min, baseline_trust, grant_trust_threshold FROM roles WHERE name = 'research'",
        )
        .get(),
    ).toEqual({
      per_call_cap: ONE_USDC,
      velocity_per_min: 20,
      baseline_trust: 70,
      grant_trust_threshold: 60,
    });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM roles WHERE name = 'bulk'").get()).toEqual({
      n: 1,
    });
    const agents = db.sqlite
      .prepare('SELECT a.trust, r.baseline_trust FROM agents a JOIN roles r ON r.id = a.role_id')
      .all() as { trust: number; baseline_trust: number }[];
    expect(agents).toHaveLength(3);
    for (const agent of agents) expect(agent.trust).toBe(agent.baseline_trust);
  });

  it('loads every catalog merchant, endpoint and standing grant', () => {
    const { db } = seededDb();
    const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
    expect(counts(db)).toMatchObject({
      merchants: catalog.merchants.length,
      endpoints: catalog.merchants.flatMap((m) => m.endpoints).length,
      standing_grants: catalog.standing_grants.length,
    });
    const endpoint = db.sqlite
      .prepare(
        "SELECT merchant_id, method, path, params_json FROM endpoints WHERE id = 'end_pricing_get'",
      )
      .get() as { params_json: string };
    expect(endpoint).toMatchObject({
      merchant_id: 'mer_pricing',
      method: 'GET',
      path: '/v1/pricing/{company}',
    });
    expect(JSON.parse(endpoint.params_json)).toEqual(catalog.merchants[0]?.endpoints[0]?.params);
    expect(
      db.sqlite
        .prepare('SELECT id, role_id, endpoint_id, max_per_call, daily_total FROM standing_grants')
        .get(),
    ).toEqual({
      id: DEMO.standingGrantId('research', 'end_weather_forecast'),
      role_id: DEMO.roles.research,
      endpoint_id: 'end_weather_forecast',
      max_per_call: 20_000,
      daily_total: 500_000,
    });
  });

  it('can run twice without duplicating anything', () => {
    const { db, clock } = seededDb();
    const before = counts(db);
    seedDatabase(db, loadCatalog(FIXTURE_CATALOG_PATH), clock);
    expect(counts(db)).toEqual(before);
  });

  it('rejects a standing grant for a role that does not exist, and writes nothing', () => {
    const db = tempDb();
    const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
    catalog.standing_grants.push({
      role: 'intern',
      endpoint_id: 'end_news_headlines',
      max_per_call: 1,
      daily_total: 1,
    });
    expect(() => seedDatabase(db, catalog, new TestClock())).toThrow(/intern/);
    expect(counts(db)).toMatchObject({ tenants: 0, merchants: 0 });
  });
});

describe('loadCatalog (stub until Chunk 3 ships theirs)', () => {
  it('rejects a catalog that fails the contract schema', () => {
    expect(() =>
      loadCatalog(new URL('../fixtures/../../package.json', import.meta.url).pathname),
    ).toThrow();
  });
});
