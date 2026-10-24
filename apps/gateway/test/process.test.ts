// The entry points as real processes: main.ts boots, seeds, serves and shuts down cleanly;
// seed-cli.ts seeds a database file. Slower than the rest (each spawn starts tsx), so the
// tests run concurrently, each with its own context-bound cleanup.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import { openDb } from '../src/db/client.js';
import { FIXTURE_CATALOG_PATH, count } from './harness/db.js';
import { runScript } from './harness/process.js';

const ADMIN_TOKEN = 'process-test-admin-token';

/** A temp database path, a script runner, and cleanup bound to this test. */
function sandbox({ onTestFinished }: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'apf-process-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return {
    databasePath: join(dir, 'gateway.db'),
    run: (script: string, env: Record<string, string>) => runScript(script, env, onTestFinished),
  };
}

function countsIn(path: string) {
  const db = openDb(path);
  const result = { merchants: count(db, 'merchants'), agents: count(db, 'agents') };
  db.sqlite.close();
  return result;
}

describe.concurrent('main.ts', () => {
  it('seeds the database, serves requests, and exits 0 on SIGTERM', async (ctx) => {
    const { databasePath, run } = sandbox(ctx);
    const gateway = run('src/main.ts', {
      ADMIN_TOKEN,
      DATABASE_PATH: databasePath,
      CATALOG_PATH: FIXTURE_CATALOG_PATH,
      PORT: '0',
    });
    const listening = await gateway.waitForLog('gateway listening');
    expect(listening).toMatchObject({ payments_mode: 'mock', judge_mode: 'stub-escalate' });
    const base = `http://127.0.0.1:${String(listening.port)}`;

    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    const catalog = await fetch(`${base}/catalog`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(catalog.status).toBe(200);

    gateway.child.kill('SIGTERM');
    expect(await gateway.exited).toBe(0);
    expect(gateway.lines.at(-1)).toMatchObject({ msg: 'shutting down', signal: 'SIGTERM' });
    expect(countsIn(databasePath)).toEqual({ merchants: 3, agents: 3 });
    expect(JSON.stringify(gateway.lines)).not.toContain(ADMIN_TOKEN);
  });

  it('refuses to start without an admin token, naming the variable', async (ctx) => {
    const { databasePath, run } = sandbox(ctx);
    const gateway = run('src/main.ts', {
      DATABASE_PATH: databasePath,
      CATALOG_PATH: FIXTURE_CATALOG_PATH,
      PORT: '0',
    });
    expect(await gateway.exited).not.toBe(0);
    expect(gateway.stderr()).toContain('ADMIN_TOKEN');
    expect(gateway.lines.find((l) => l.msg === 'gateway listening')).toBeUndefined();
  });

  it('refuses to start with a missing catalog', async (ctx) => {
    const { databasePath, run } = sandbox(ctx);
    const gateway = run('src/main.ts', {
      ADMIN_TOKEN,
      DATABASE_PATH: databasePath,
      CATALOG_PATH: join(tmpdir(), 'no-such-catalog.json'),
      PORT: '0',
    });
    expect(await gateway.exited).not.toBe(0);
    expect(gateway.stderr()).toContain('ENOENT');
  });

  it('migrates and seeds with seed-cli.ts, safely twice', async (ctx) => {
    const { databasePath, run } = sandbox(ctx);
    const env = { DATABASE_PATH: databasePath, CATALOG_PATH: FIXTURE_CATALOG_PATH };
    expect(await run('src/db/seed-cli.ts', env).exited).toBe(0);
    expect(await run('src/db/seed-cli.ts', env).exited).toBe(0);
    expect(countsIn(databasePath)).toEqual({ merchants: 3, agents: 3 });
  });
});
