import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import {
  createDecision,
  createGrant,
  createMandate,
  createReservedPayment,
  seededDb,
} from '../harness/db.js';

describe('database setup', () => {
  it('turns on WAL, a 5 s busy timeout and foreign keys', () => {
    const { db } = seededDb();
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('can reopen an already-migrated database', () => {
    const { db } = seededDb();
    const path = db.sqlite.name;
    const again = openDb(path);
    const count = (d: typeof db) =>
      d.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    expect(count(again)).toEqual(count(db));
    again.sqlite.close();
  });
});

describe('constraints from final_contracts.md section 1', () => {
  it('rejects a mandate whose spent + reserved exceeds its budget', () => {
    const { db, clock } = seededDb();
    const { mandateId } = createMandate(db, clock, { budget: 100 });
    const update = db.sqlite.prepare('UPDATE mandates SET reserved = ? WHERE id = ?');
    expect(() => update.run(101, mandateId)).toThrow(/CHECK constraint failed/);
    expect(() => update.run(-1, mandateId)).toThrow(/CHECK constraint failed/);
    expect(update.run(100, mandateId).changes).toBe(1);
  });

  it.each([
    ['payments', 'state', 'DONE'],
    ['decisions', 'stage', 'tier2'],
    ['decisions', 'outcome', 'maybe'],
    ['mandates', 'status', 'paused'],
    ['sessions', 'status', 'sleeping'],
    ['grants', 'source', 'agent'],
    ['endpoints', 'method', 'PUT'],
  ])('rejects %s.%s = %s', (table, column, value) => {
    const { db, clock } = seededDb();
    const mandate = createMandate(db, clock, { budget: 1_000_000 });
    createReservedPayment(db, clock, mandate, 1_000);
    createGrant(db, clock, mandate, { maxTotal: 1_000 });
    const update = db.sqlite.prepare(`UPDATE ${table} SET ${column} = ?`);
    expect(() => update.run(value)).toThrow(/CHECK constraint failed/);
  });

  it('rejects an approval outcome outside approved, rejected and timeout', () => {
    const { db, clock } = seededDb();
    const decisionId = createDecision(db, clock, createMandate(db, clock, { budget: 100 }));
    const insert = db.sqlite.prepare(
      "INSERT INTO approvals (id, decision_id, reviewer, outcome, note, created_at) VALUES ('apr_1', ?, 'admin', ?, 'n', 0)",
    );
    expect(() => insert.run(decisionId, 'maybe')).toThrow(/CHECK constraint failed/);
    expect(insert.run(decisionId, 'timeout').changes).toBe(1);
  });

  it('keeps idempotency keys unique per mandate', () => {
    const { db, clock } = seededDb();
    const mandate = createMandate(db, clock, { budget: 100 });
    const a = createDecision(db, clock, mandate);
    const b = createDecision(db, clock, mandate);
    const copyKey = db.sqlite.prepare(
      'UPDATE decisions SET idempotency_key = (SELECT idempotency_key FROM decisions WHERE id = ?) WHERE id = ?',
    );
    expect(() => copyKey.run(a, b)).toThrow(/UNIQUE constraint failed/);
  });

  it('enforces foreign keys', () => {
    const { db } = seededDb();
    const insert = db.sqlite.prepare(
      "INSERT INTO payments (id, decision_id, mandate_id, amount, payee, state, updated_at, day) VALUES ('pay_x', 'dec_missing', 'mnd_missing', 1, '0x1', 'RESERVED', 0, '2026-10-24')",
    );
    expect(() => insert.run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('never lets a tenant daily total go negative', () => {
    const { db, clock } = seededDb();
    createReservedPayment(db, clock, createMandate(db, clock, { budget: 1_000 }), 1_000);
    expect(() =>
      db.sqlite.prepare('UPDATE tenant_daily SET committed = committed - 1001').run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
