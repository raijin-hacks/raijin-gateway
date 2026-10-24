import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export interface Db {
  /** The raw connection, for the atomic statements in statements.ts. */
  sqlite: Database.Database;
  /** Drizzle over the same connection, for everything else. */
  orm: BetterSQLite3Database<typeof schema>;
}

/** Opens (creating if needed) the SQLite file at `path` and applies any pending migrations. */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  const orm = drizzle({ client: sqlite, schema });
  migrate(orm, { migrationsFolder: findMigrationsFolder() });
  return { sqlite, orm };
}

/** apps/gateway/drizzle, found by walking up from this file (works from src/ and dist/src/). */
function findMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Drizzle migrations folder not found above ' + dir);
    dir = parent;
  }
}
