import { readFileSync } from 'node:fs';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import {
  all,
  count,
  createDecision,
  createGrant,
  createMandate,
  createReservedPayment,
  one,
  seededDb,
  tableNames,
  tempDb,
} from '../harness/db.js';

// ---------- What the database actually has ----------

interface DbColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
const columnsOf = (db: Db, table: string) => all<DbColumn>(db, `PRAGMA table_info("${table}")`);
const foreignKeysOf = (db: Db, table: string) =>
  all<{ table: string; from: string; to: string }>(db, `PRAGMA foreign_key_list("${table}")`)
    .map((fk) => `${fk.from} -> ${fk.table}.${fk.to}`)
    .sort();
const uniqueColumnSetsOf = (db: Db, table: string) =>
  all<{ name: string; unique: number }>(db, `PRAGMA index_list("${table}")`)
    .filter((index) => index.unique === 1)
    .map((index) =>
      all<{ name: string }>(db, `PRAGMA index_info("${index.name}")`)
        .map((c) => c.name)
        .join(','),
    );
const checkCountOf = (db: Db, table: string) =>
  (
    one<{ sql: string }>(db, 'SELECT sql FROM sqlite_master WHERE name = ?', table)?.sql ?? ''
  ).match(/\bCHECK\b/g)?.length ?? 0;

// ---------- What final_contracts.md section 1 says ----------

interface ContractColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue: string | undefined;
  references: string | undefined;
}
interface ContractTable {
  name: string;
  columns: ContractColumn[];
  uniques: string[];
  primaryKey: string[] | undefined;
  checks: number;
}

function contractTables(): ContractTable[] {
  const doc = readFileSync(new URL('../../../../final_contracts.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## 1. Database schema'));
  const sql = /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  const names = (list: string) => list.split(',').map((s) => s.trim());

  return [...sql.matchAll(/CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/g)].map(
    ([, name = '', body = '']) => {
      const table: ContractTable = {
        name,
        columns: [],
        uniques: [],
        primaryKey: undefined,
        checks: 0,
      };
      for (const raw of body.split('\n')) {
        const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
        if (line === '') continue;
        table.checks += line.match(/\bCHECK\b/g)?.length ?? 0;
        const unique = /^UNIQUE \(([^)]+)\)$/.exec(line);
        const primaryKey = /^PRIMARY KEY \(([^)]+)\)$/.exec(line);
        if (unique) table.uniques.push(names(unique[1] ?? '').join(','));
        else if (primaryKey) table.primaryKey = names(primaryKey[1] ?? '');
        else if (!line.startsWith('CHECK')) {
          const column = /^(\w+) (TEXT|INTEGER|REAL)\b(.*)$/.exec(line);
          if (!column) throw new Error(`Unparsed line in ${name}: ${line}`);
          const [, colName = '', type = '', rest = ''] = column;
          const ref = /REFERENCES (\w+)\((\w+)\)/.exec(rest);
          table.columns.push({
            name: colName,
            type,
            notNull: rest.includes('NOT NULL'),
            primaryKey: rest.includes('PRIMARY KEY'),
            unique: /\bUNIQUE\b/.test(rest),
            defaultValue: /DEFAULT (\S+)/.exec(rest)?.[1],
            references: ref ? `${colName} -> ${ref[1]}.${ref[2]}` : undefined,
          });
          if (/\bUNIQUE\b/.test(rest)) table.uniques.push(colName);
        }
      }
      return table;
    },
  );
}

/** Columns and tables CHUNK-2-BUILD-PLAN.md proposes beyond the contract (D4, D5, D6). */
const PROPOSED_COLUMNS: Record<string, string[]> = {
  decisions: ['request_json'],
  payments: ['quote_json', 'response_json', 'day'],
};
const PROPOSED_TABLES = ['standing_grant_usage', 'tenant_daily'];

describe('the migrated schema matches final_contracts.md section 1', () => {
  const db = openDb(':memory:');
  const tables = contractTables();

  it('parses all 14 contract tables', () => {
    expect(tables.map((t) => t.name)).toHaveLength(14);
  });

  it('has exactly the contract tables plus the proposed ones', () => {
    expect(tableNames(db).filter((t) => t !== '__drizzle_migrations')).toEqual(
      [...tables.map((t) => t.name), ...PROPOSED_TABLES].sort(),
    );
  });

  describe.each(tables)('$name', (table) => {
    const actual = columnsOf(db, table.name);
    const byName = new Map(actual.map((c) => [c.name, c]));

    it('has exactly the contract columns, plus any proposed ones', () => {
      expect(actual.map((c) => c.name).sort()).toEqual(
        [...table.columns.map((c) => c.name), ...(PROPOSED_COLUMNS[table.name] ?? [])].sort(),
      );
    });

    it.each(table.columns)('column $name has the contract type, nullability and default', (col) => {
      const real = byName.get(col.name);
      expect(real?.type.toUpperCase()).toBe(col.type);
      // A primary key may be stricter (NOT NULL) than the contract spells out, never looser.
      if (col.notNull || col.primaryKey) expect(real?.notnull).toBe(1);
      else expect(real?.notnull).toBe(0);
      expect((real?.pk ?? 0) > 0).toBe(
        col.primaryKey || (table.primaryKey ?? []).includes(col.name),
      );
      expect(real?.dflt_value ?? undefined).toBe(col.defaultValue);
    });

    it('has exactly the contract foreign keys', () => {
      const expected = table.columns.flatMap((c) => (c.references ? [c.references] : [])).sort();
      expect(foreignKeysOf(db, table.name)).toEqual(expected);
    });

    it('enforces every contract UNIQUE constraint', () => {
      const uniques = uniqueColumnSetsOf(db, table.name);
      for (const columns of table.uniques) expect(uniques).toContain(columns);
    });

    it('has the contract primary key', () => {
      const pk = actual
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk).toEqual(
        table.primaryKey ?? table.columns.filter((c) => c.primaryKey).map((c) => c.name),
      );
    });

    it('has as many CHECK constraints as the contract', () => {
      expect(checkCountOf(db, table.name)).toBe(table.checks);
    });
  });
});

describe('schema.ts and the committed migration agree', () => {
  // Fails when schema.ts is edited without running `pnpm --filter @apf/gateway db:generate`.
  const db = openDb(':memory:');
  const drizzleTables = Object.values(schema).filter((value) => is(value, SQLiteTable));

  it.each(drizzleTables.map((t) => [getTableName(t), t] as const))('%s', (name, table) => {
    const config = getTableConfig(table);
    const real = new Map(columnsOf(db, name).map((c) => [c.name, c]));
    expect([...real.keys()].sort()).toEqual(config.columns.map((c) => c.name).sort());
    for (const column of config.columns) {
      expect(real.get(column.name)?.notnull, column.name).toBe(column.notNull ? 1 : 0);
    }
    const fks = config.foreignKeys
      .flatMap((fk) => {
        const ref = fk.reference();
        return ref.columns.map(
          (c, i) => `${c.name} -> ${getTableName(ref.foreignTable)}.${ref.foreignColumns[i]?.name}`,
        );
      })
      .sort();
    expect(foreignKeysOf(db, name)).toEqual(fks);
    expect(checkCountOf(db, name)).toBe(config.checks.length);
  });
});

describe('database setup', () => {
  it('turns on WAL, a 5 s busy timeout and foreign keys', () => {
    const { db } = seededDb();
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies the migration once and can reopen the same file', () => {
    const db = tempDb();
    const again = openDb(db.sqlite.name);
    expect(count(again, '__drizzle_migrations')).toBe(1);
    expect(tableNames(again)).toEqual(tableNames(db));
    again.sqlite.close();
  });
});

describe('constraints', () => {
  it('rejects a mandate whose spent + reserved exceeds its budget', () => {
    const { db, clock } = seededDb();
    const { mandateId } = createMandate(db, clock, { budget: 100 });
    const set = (column: string, value: number) =>
      db.sqlite.prepare(`UPDATE mandates SET ${column} = ? WHERE id = ?`).run(value, mandateId);
    expect(() => set('reserved', 101)).toThrow(/CHECK constraint failed/);
    expect(() => set('reserved', -1)).toThrow(/CHECK constraint failed/);
    expect(() => set('spent', -1)).toThrow(/CHECK constraint failed/);
    expect(set('reserved', 60).changes).toBe(1);
    expect(() => set('spent', 41)).toThrow(/CHECK constraint failed/);
    expect(set('spent', 40).changes).toBe(1);
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
    expect(() => db.sqlite.prepare(`UPDATE ${table} SET ${column} = ?`).run(value)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('accepts every allowed approval outcome and nothing else', () => {
    const { db, clock } = seededDb();
    const mandate = createMandate(db, clock, { budget: 100 });
    const insert = (outcome: string) =>
      db.sqlite
        .prepare(
          "INSERT INTO approvals (id, decision_id, reviewer, outcome, note, created_at) VALUES (?, ?, 'admin', ?, 'n', 0)",
        )
        .run(`apr_${outcome}`, createDecision(db, clock, mandate), outcome);
    expect(() => insert('maybe')).toThrow(/CHECK constraint failed/);
    for (const outcome of ['approved', 'rejected', 'timeout'])
      expect(insert(outcome).changes).toBe(1);
  });

  it('keeps idempotency keys unique per mandate, not across mandates', () => {
    const { db, clock } = seededDb();
    const mandate = createMandate(db, clock, { budget: 100 });
    const other = createMandate(db, clock, { budget: 100 });
    const a = createDecision(db, clock, mandate);
    const b = createDecision(db, clock, mandate);
    const c = createDecision(db, clock, other);
    const copyKey = db.sqlite.prepare(
      'UPDATE decisions SET idempotency_key = (SELECT idempotency_key FROM decisions WHERE id = ?) WHERE id = ?',
    );
    expect(() => copyKey.run(a, b)).toThrow(/UNIQUE constraint failed/);
    expect(copyKey.run(a, c).changes).toBe(1);
  });

  it('allows one payment and one approval per decision', () => {
    const { db, clock } = seededDb();
    const mandate = createMandate(db, clock, { budget: 1_000 });
    const paymentId = createReservedPayment(db, clock, mandate, 10);
    const duplicate = db.sqlite.prepare(
      `INSERT INTO payments (id, decision_id, mandate_id, amount, payee, state, updated_at, day)
       SELECT 'pay_copy', decision_id, mandate_id, amount, payee, 'RESERVED', 0, day FROM payments WHERE id = ?`,
    );
    expect(() => duplicate.run(paymentId)).toThrow(/UNIQUE constraint failed/);
  });

  it('keeps mandate token hashes unique', () => {
    const { db, clock } = seededDb();
    createMandate(db, clock, { budget: 1, tokenHash: 'same' });
    expect(() => createMandate(db, clock, { budget: 1, tokenHash: 'same' })).toThrow(/UNIQUE/);
  });

  it('enforces foreign keys', () => {
    const { db } = seededDb();
    const insert = db.sqlite.prepare(
      "INSERT INTO payments (id, decision_id, mandate_id, amount, payee, state, updated_at, day) VALUES ('pay_x', 'dec_missing', 'mnd_missing', 1, '0x1', 'RESERVED', 0, '2026-10-24')",
    );
    expect(() => insert.run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('never lets a tenant daily total or standing-grant use go negative', () => {
    const { db, clock } = seededDb();
    createReservedPayment(db, clock, createMandate(db, clock, { budget: 1_000 }), 1_000);
    expect(() => db.sqlite.prepare('UPDATE tenant_daily SET committed = -1').run()).toThrow(
      /CHECK constraint failed/,
    );
    db.sqlite
      .prepare(
        "INSERT INTO standing_grant_usage VALUES ('grt_standing_research_weather_forecast', '2026-10-24', 0)",
      )
      .run();
    expect(() =>
      db.sqlite.prepare('UPDATE standing_grant_usage SET used_total = -1').run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
