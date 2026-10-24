// The entry points as real processes: main.ts boots, seeds, serves and shuts down cleanly;
// seed-cli.ts seeds a database file. Slower than the rest (each spawn starts tsx), so the
// tests run concurrently, each with its own context-bound cleanup.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from '@apf/contracts';
import { describe, expect, it, type TestContext } from 'vitest';
import { openDb } from '../src/db/client.js';
import { FIXTURE_CATALOG_PATH, count } from './harness/db.js';
import { runScript } from './harness/process.js';

const ADMIN_TOKEN = 'process-test-admin-token';
// Per test, inherited by the nested catalog-admission suites. On CI with 39 isolated
// workers, single-start cases take 4–5 s; several cases launch two cold tsx children.
// Allow 30 s for both startups and database assertions without changing the
// gateway's deadlines or weakening assertions. All other suites keep their defaults.
const PROCESS_TEST_TIMEOUT_MS = 30_000;

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

describe.concurrent('main.ts', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  const invalidCatalogs: [string, (catalog: Catalog) => void][] = [
    ['duplicate ID', (c) => c.merchants.push(structuredClone(c.merchants[0]!))],
    [
      'dangling grant',
      (c) => {
        c.standing_grants[0]!.endpoint_id = 'end_missing';
      },
    ],
    [
      'overlap',
      (c) => {
        const endpoint = structuredClone(c.merchants[0]!.endpoints[0]!);
        endpoint.id = 'end_overlap';
        endpoint.path = '/v1/pricing/acme';
        endpoint.params = {};
        c.merchants[0]!.endpoints.push(endpoint);
      },
    ],
  ];
  describe.each(['src/main.ts', 'src/db/seed-cli.ts'])('%s catalog admission', (script) => {
    it.for(invalidCatalogs)(
      'rejects %s before creating or migrating a database',
      async ([_name, mutate], ctx) => {
        const { databasePath, run } = sandbox(ctx);
        const catalog: Catalog = JSON.parse(readFileSync(FIXTURE_CATALOG_PATH, 'utf8'));
        mutate(catalog);
        const path = databasePath + '.catalog.json';
        writeFileSync(path, JSON.stringify(catalog));
        const process = run(script, {
          ADMIN_TOKEN,
          DATABASE_PATH: databasePath,
          CATALOG_PATH: path,
          PORT: '0',
        });
        expect(await process.exited).not.toBe(0);
        expect(process.stderr()).toContain('Invalid catalog');
        expect(process.lines).not.toContainEqual(
          expect.objectContaining({ msg: 'gateway listening' }),
        );
        expect(existsSync(databasePath)).toBe(false);
        expect(existsSync(databasePath + '-wal')).toBe(false);

        // Existing databases must also remain byte-for-byte unchanged.
        const existing = openDb(databasePath);
        existing.sqlite.close();
        const before = readFileSync(databasePath);
        const retry = run(script, {
          ADMIN_TOKEN,
          DATABASE_PATH: databasePath,
          CATALOG_PATH: path,
          PORT: '0',
        });
        expect(await retry.exited).not.toBe(0);
        expect(retry.stderr()).toContain('Invalid catalog');
        expect(readFileSync(databasePath)).toEqual(before);
      },
    );
  });
  it('seeds the database, serves requests, and exits 0 on SIGTERM', async (ctx) => {
    const { databasePath, run } = sandbox(ctx);
    const gateway = run('src/main.ts', {
      ADMIN_TOKEN,
      DATABASE_PATH: databasePath,
      CATALOG_PATH: FIXTURE_CATALOG_PATH,
      PORT: '0',
    });
    // Startup includes tsx compiling the whole gateway; with every test file running in parallel on
    // a small CI runner it can pass the harness's 10 s default. Use most of the test's 30 s budget.
    const listening = await gateway.waitForLog('gateway listening', 25_000);
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
