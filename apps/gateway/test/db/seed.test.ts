import { readFileSync } from 'node:fs';
import { ONE_USDC, TRUST_THRESHOLDS, type Catalog } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DEMO, seedDatabase } from '../../src/db/seed.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from '../harness/clock.js';
import { FIXTURE_CATALOG_PATH, all, count, one, seededDb, tempDb } from '../harness/db.js';

const TABLES = ['tenants', 'roles', 'agents', 'merchants', 'endpoints', 'standing_grants'];
const counts = (db: Db) => Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
const fixture = (): Catalog => loadCatalog(FIXTURE_CATALOG_PATH);

describe('seedDatabase', () => {
  it('creates the demo tenant with the $20 daily cap', () => {
    const { db } = seededDb();
    expect(all(db, 'SELECT id, daily_cap FROM tenants')).toEqual([
      { id: DEMO.tenantId, daily_cap: 20 * ONE_USDC },
    ]);
  });

  it('creates the research role with the design numbers', () => {
    const { db } = seededDb();
    expect(one(db, "SELECT * FROM roles WHERE name = 'research'")).toMatchObject({
      id: DEMO.roles.research,
      tenant_id: DEMO.tenantId,
      per_call_cap: ONE_USDC,
      velocity_per_min: 20,
      baseline_trust: 70,
      grant_trust_threshold: TRUST_THRESHOLDS.grants,
    });
  });

  it("uses final_contracts.md's role_policy example as the research policy", () => {
    const { db } = seededDb();
    const doc = readFileSync(new URL('../../../../final_contracts.md', import.meta.url), 'utf8');
    const policy = /"role_policy": "([^"]+)"/.exec(doc)?.[1];
    expect(policy).toBeDefined();
    expect(one(db, "SELECT policy_text FROM roles WHERE name = 'research'")).toEqual({
      policy_text: policy,
    });
  });

  it('gives the bulk role a higher velocity than research', () => {
    const { db } = seededDb();
    const velocity = (name: string) =>
      one<{ v: number }>(db, 'SELECT velocity_per_min AS v FROM roles WHERE name = ?', name)?.v ??
      0;
    expect(velocity('bulk')).toBeGreaterThan(velocity('research'));
  });

  it('starts every agent at its role baseline', () => {
    const { db } = seededDb();
    const agents = all<{ id: string; trust: number; baseline: number }>(
      db,
      'SELECT a.id, a.trust, r.baseline_trust AS baseline FROM agents a JOIN roles r ON r.id = a.role_id',
    );
    expect(agents.map((a) => a.id).sort()).toEqual(Object.values(DEMO.agents).sort());
    for (const agent of agents) expect(agent.trust).toBe(agent.baseline);
  });

  it('loads every catalog merchant and endpoint exactly', () => {
    const { db } = seededDb();
    const catalog = fixture();
    for (const merchant of catalog.merchants) {
      expect(one(db, 'SELECT * FROM merchants WHERE id = ?', merchant.id)).toEqual({
        id: merchant.id,
        tenant_id: DEMO.tenantId,
        name: merchant.name,
        origin: merchant.origin,
        payee: merchant.payee,
        category: merchant.category,
        description: merchant.description,
      });
      for (const endpoint of merchant.endpoints) {
        const row = one<{ params_json: string }>(
          db,
          'SELECT * FROM endpoints WHERE id = ?',
          endpoint.id,
        );
        expect(row).toMatchObject({
          merchant_id: merchant.id,
          method: endpoint.method,
          path: endpoint.path,
          category: endpoint.category,
          description: endpoint.description,
        });
        expect(JSON.parse(row?.params_json ?? 'null')).toEqual(endpoint.params);
      }
    }
    expect(count(db, 'merchants')).toBe(catalog.merchants.length);
    expect(count(db, 'endpoints')).toBe(catalog.merchants.flatMap((m) => m.endpoints).length);
  });

  it('attaches standing grants to the named role', () => {
    const { db } = seededDb();
    expect(all(db, 'SELECT * FROM standing_grants')).toEqual([
      {
        id: DEMO.standingGrantId('research', 'end_weather_forecast'),
        role_id: DEMO.roles.research,
        endpoint_id: 'end_weather_forecast',
        max_per_call: 20_000,
        daily_total: 500_000,
      },
    ]);
  });

  it('can run twice without duplicating anything', () => {
    const { db, clock } = seededDb();
    const before = counts(db);
    seedDatabase(db, fixture(), clock);
    expect(counts(db)).toEqual(before);
  });

  it('updates catalog rows that changed since the last run', () => {
    const { db, clock } = seededDb();
    const catalog = fixture();
    const merchant = catalog.merchants[0];
    const grant = catalog.standing_grants[0];
    if (!merchant || !grant) throw new Error('fixture catalog changed');
    merchant.description = 'Updated description';
    grant.daily_total = 900_000;
    seedDatabase(db, catalog, clock);
    expect(one(db, 'SELECT description FROM merchants WHERE id = ?', merchant.id)).toEqual({
      description: 'Updated description',
    });
    expect(one(db, 'SELECT daily_total FROM standing_grants')).toEqual({ daily_total: 900_000 });
  });

  it('keeps agent trust and the tenant creation time when run again', () => {
    const { db } = seededDb();
    db.sqlite.prepare('UPDATE agents SET trust = 41').run();
    const created = one(db, 'SELECT created_at FROM tenants');
    seedDatabase(db, fixture(), new TestClock(Date.UTC(2030, 0, 1)));
    expect(all(db, 'SELECT DISTINCT trust FROM agents')).toEqual([{ trust: 41 }]);
    expect(one(db, 'SELECT created_at FROM tenants')).toEqual(created);
  });

  it('rejects a standing grant for a role that does not exist, and writes nothing', () => {
    const db = tempDb();
    const catalog = fixture();
    catalog.standing_grants.push({
      role: 'intern',
      endpoint_id: 'end_news_headlines',
      max_per_call: 1,
      daily_total: 1,
    });
    expect(() => seedDatabase(db, catalog, new TestClock())).toThrow(/intern/);
    expect(Object.values(counts(db))).toEqual(TABLES.map(() => 0));
  });

  it('rejects a standing grant for an endpoint that does not exist, and writes nothing', () => {
    const db = tempDb();
    const catalog = fixture();
    catalog.standing_grants.push({
      role: 'research',
      endpoint_id: 'end_missing',
      max_per_call: 1,
      daily_total: 1,
    });
    expect(() => seedDatabase(db, catalog, new TestClock())).toThrow(/FOREIGN KEY/);
    expect(Object.values(counts(db))).toEqual(TABLES.map(() => 0));
  });
});
