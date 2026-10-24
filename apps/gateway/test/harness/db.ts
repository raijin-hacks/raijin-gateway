// Database fixtures: a migrated, seeded temp-file database per test, plus helpers that
// create the rows a payment needs. Chunk 1 can use these to run its PaymentStore tests.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from '@apf/contracts';
import { and, eq } from 'drizzle-orm';
import { expect, onTestFinished } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { createFunds, utcDay } from '../../src/db/funds.js';
import { decisions, grants, mandates, sessions, tenantDaily } from '../../src/db/schema.js';
import { DEMO, seedDatabase } from '../../src/db/seed.js';
import { newId } from '../../src/ids.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from './clock.js';

export const FIXTURE_CATALOG_PATH = fileURLToPath(
  new URL('../fixtures/catalog.json', import.meta.url),
);

/** A migrated database in a fresh temp file, closed and deleted when the test ends. */
export function tempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'apf-gateway-'));
  const db = openDb(join(dir, 'gateway.db'));
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** A temp database seeded with the demo tenant, roles, agents and the fixture catalog. */
export function seededDb(clock = new TestClock()): { db: Db; clock: TestClock } {
  const db = tempDb();
  seedDatabase(db, loadCatalog(FIXTURE_CATALOG_PATH), clock);
  return { db, clock };
}

export interface TestMandate {
  mandateId: string;
  sessionId: string;
}

export function createMandate(
  db: Db,
  clock: TestClock,
  opts: { budget: number; status?: 'active' | 'closed' | 'expired'; expiresInMs?: number },
): TestMandate {
  const now = clock.now();
  const mandateId = newId('mandate', now);
  const sessionId = newId('session', now);
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
      token_hash: randomBytes(32).toString('hex'),
      expires_at: now + (opts.expiresInMs ?? 30 * 60_000),
      created_by: 'test',
      created_at: now,
    })
    .run();
  db.orm
    .insert(sessions)
    .values({
      id: sessionId,
      mandate_id: mandateId,
      agent_id: DEMO.agents.pricing,
      trust: 70,
      status: 'active',
      created_at: now,
    })
    .run();
  return { mandateId, sessionId };
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

export const PRICESCOPE_PAYEE: Address = '0x1111111111111111111111111111111111111111';

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

export function mandateMoney(db: Db, mandate: TestMandate): { spent: number; reserved: number } {
  const row = db.orm
    .select({ spent: mandates.spent, reserved: mandates.reserved })
    .from(mandates)
    .where(eq(mandates.id, mandate.mandateId))
    .get();
  expect(row).toBeDefined();
  return row as { spent: number; reserved: number };
}

/** The demo tenant's committed (spent + reserved) total for the clock's current UTC day. */
export function tenantCommitted(db: Db, clock: TestClock): number {
  const row = db.orm
    .select({ committed: tenantDaily.committed })
    .from(tenantDaily)
    .where(and(eq(tenantDaily.tenant_id, DEMO.tenantId), eq(tenantDaily.day, utcDay(clock.now()))))
    .get();
  return row?.committed ?? 0;
}
