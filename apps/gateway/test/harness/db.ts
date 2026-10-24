// Database fixtures: a migrated, seeded temp-file database per test, row builders for what a
// payment needs, and small query helpers. Chunk 1 can use these to run its PaymentStore tests.
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from '@apf/contracts';
import { onTestFinished } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { createFunds, utcDay } from '../../src/db/funds.js';
import { decisions, grants, mandates, sessions } from '../../src/db/schema.js';
import { DEMO, seedDatabase } from '../../src/db/seed.js';
import { newId } from '../../src/ids.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from './clock.js';

export const FIXTURE_CATALOG_PATH = fileURLToPath(
  new URL('../fixtures/catalog.json', import.meta.url),
);
export const PRICESCOPE_PAYEE: Address = '0x1111111111111111111111111111111111111111';

// ---------- Databases ----------

/** Opens `gateway.db` in a fresh temp directory; closes and deletes both when the test ends. */
function openForTest(prepare: (path: string) => void = () => undefined): Db {
  const dir = mkdtempSync(join(tmpdir(), 'apf-gateway-'));
  const path = join(dir, 'gateway.db');
  prepare(path);
  const db = openDb(path);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** A migrated, empty database in a fresh temp file. */
export function tempDb(): Db {
  return openForTest();
}

// Migrating and seeding takes most of a test's setup time, so each worker does it once into a
// template file and every test gets a byte copy.
let templatePath: string | undefined;
function seededTemplate(): string {
  if (templatePath !== undefined) return templatePath;
  const dir = mkdtempSync(join(tmpdir(), 'apf-template-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'template.db');
  const db = openDb(path);
  seedDatabase(db, loadCatalog(FIXTURE_CATALOG_PATH), new TestClock());
  db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  db.sqlite.close();
  templatePath = path;
  return path;
}

/** A temp database seeded with the demo tenant, roles, agents and the fixture catalog. */
export function seededDb(clock = new TestClock()): { db: Db; clock: TestClock } {
  return { db: openForTest((path) => copyFileSync(seededTemplate(), path)), clock };
}

// ---------- Queries ----------

export function one<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]) {
  return db.sqlite.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]) {
  return db.sqlite.prepare(sql).all(...params) as T[];
}

/** Rows in `table`, optionally filtered by a WHERE clause. */
export function count(db: Db, table: string, where = '1', ...params: unknown[]): number {
  return (
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`, ...params)?.n ?? 0
  );
}

export function tableNames(db: Db): string[] {
  return all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((t) => t.name);
}

/** Every value in every table as one string, to prove a secret was never stored. */
export function dumpAll(db: Db): string {
  return JSON.stringify(tableNames(db).map((name) => all(db, `SELECT * FROM "${name}"`)));
}

export function mandateMoney(db: Db, mandate: TestMandate): { spent: number; reserved: number } {
  const row = one<{ spent: number; reserved: number }>(
    db,
    'SELECT spent, reserved FROM mandates WHERE id = ?',
    mandate.mandateId,
  );
  if (!row) throw new Error(`No mandate ${mandate.mandateId}`);
  return row;
}

/** The demo tenant's committed (spent + reserved) total for the clock's current UTC day. */
export function tenantCommitted(db: Db, clock: TestClock): number {
  return (
    one<{ committed: number }>(
      db,
      'SELECT committed FROM tenant_daily WHERE tenant_id = ? AND day = ?',
      DEMO.tenantId,
      utcDay(clock.now()),
    )?.committed ?? 0
  );
}

// ---------- Row builders ----------

export interface TestMandate {
  mandateId: string;
  sessionId: string;
}

export function createMandate(
  db: Db,
  clock: TestClock,
  opts: {
    budget: number;
    status?: 'active' | 'closed' | 'expired';
    expiresInMs?: number;
    tokenHash?: string;
  },
): TestMandate {
  const now = clock.now();
  const mandateId = newId('mandate', now);
  db.orm
    .insert(mandates)
    .values({
      id: mandateId,
      tenant_id: DEMO.tenantId,
      agent_id: DEMO.agents.pricing,
      task: 'Compile current list prices for 5 named competitors.',
      subjects_json: '["acme"]',
      allowed_merchants_json: '["mer_pricing"]',
      budget: opts.budget,
      status: opts.status ?? 'active',
      token_hash: opts.tokenHash ?? randomBytes(32).toString('hex'),
      expires_at: now + (opts.expiresInMs ?? 30 * 60_000),
      created_by: 'test',
      created_at: now,
    })
    .run();
  return { mandateId, sessionId: createSession(db, clock, mandateId) };
}

export function createSession(
  db: Db,
  clock: TestClock,
  mandateId: string,
  status: 'active' | 'quarantined' | 'ended' = 'active',
): string {
  const id = newId('session', clock.now());
  db.orm
    .insert(sessions)
    .values({
      id,
      mandate_id: mandateId,
      agent_id: DEMO.agents.pricing,
      trust: 70,
      status,
      created_at: clock.now(),
    })
    .run();
  return id;
}

export function createDecision(db: Db, clock: TestClock, mandate: TestMandate): string {
  const id = newId('decision', clock.now());
  db.orm
    .insert(decisions)
    .values({
      id,
      idempotency_key: randomBytes(8).toString('hex'),
      mandate_id: mandate.mandateId,
      session_id: mandate.sessionId,
      canonical_url: 'http://localhost:4101/v1/pricing/acme',
      method: 'GET',
      stage: 'tier0',
      outcome: 'pending',
      reasons_json: '[]',
      created_at: clock.now(),
    })
    .run();
  return id;
}

/** Reserves `amount` under a new decision and returns the RESERVED payment's id. */
export function createReservedPayment(
  db: Db,
  clock: TestClock,
  mandate: TestMandate,
  amount: number,
): string {
  const result = createFunds(db, clock).reserve({
    mandateId: mandate.mandateId,
    decisionId: createDecision(db, clock, mandate),
    amount,
    payee: PRICESCOPE_PAYEE,
    quoteJson: '{}',
  });
  if (!result.ok) throw new Error(`Fixture reservation refused: ${result.code}`);
  return result.paymentId;
}

export function createGrant(
  db: Db,
  clock: TestClock,
  mandate: TestMandate,
  opts: { maxTotal: number; expiresInMs?: number },
): string {
  const id = newId('grant', clock.now());
  db.orm
    .insert(grants)
    .values({
      id,
      mandate_id: mandate.mandateId,
      endpoint_id: 'end_pricing_get',
      payee: PRICESCOPE_PAYEE,
      method: 'GET',
      origin: 'http://localhost:4101',
      path: '/v1/pricing/{company}',
      option_values_json: '{"period":"30d"}',
      max_per_call: 10_000,
      max_total: opts.maxTotal,
      source: 'judge',
      expires_at: clock.now() + (opts.expiresInMs ?? 30 * 60_000),
      created_at: clock.now(),
    })
    .run();
  return id;
}
