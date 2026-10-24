import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createJournal, JournalError, type Intent } from './journal.js';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const INTENT: Intent = {
  url: 'http://localhost:4101/v1/pricing/acme?period=30d',
  method: 'GET',
  expected_price: 10000,
  purpose: 'fetch_data',
};
const tempJournal = () => join(mkdtempSync(join(tmpdir(), 'agent-journal-')), 'nested', 'p.json');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof JournalError ? error.code : 'OTHER';
  }
  return 'NONE';
};

describe('purchase journal', () => {
  it('persists the key before returning it, owner-only, without the token', () => {
    const path = tempJournal();
    const request = createJournal(path).intent(TOKEN_A, INTENT);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain(request.idempotency_key);
    expect(raw).not.toContain(TOKEN_A);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('maps identical intents to one key, across journal instances (a restart)', () => {
    const path = tempJournal();
    const first = createJournal(path).intent(TOKEN_A, INTENT);
    const afterRestart = createJournal(path).intent(TOKEN_A, { ...INTENT });
    expect(afterRestart).toEqual(first);
  });

  it('never shares a key across different requests or mandates', () => {
    const journal = createJournal(tempJournal());
    const keys = [
      journal.intent(TOKEN_A, INTENT),
      journal.intent(TOKEN_A, { ...INTENT, expected_price: 10001 }),
      journal.intent(TOKEN_A, { ...INTENT, purpose: 'fetch_report' }),
      journal.intent(TOKEN_B, INTENT),
    ].map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(4);
    expect(journal.pending(TOKEN_A)).toHaveLength(3);
    expect(journal.pending(TOKEN_B)).toHaveLength(1);
  });

  it('starts empty only when the journal is absent', () => {
    expect(createJournal(tempJournal()).pending(TOKEN_A)).toEqual([]);
  });

  it('fails closed on corrupt, unknown-version or tampered journals', () => {
    for (const content of [
      'not json',
      JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: { x: { mandate: 'zz' } } }),
    ]) {
      const path = tempJournal();
      createJournal(path).pending(TOKEN_A); // creates the directory
      writeFileSync(path, content);
      expect(code(() => createJournal(path).intent(TOKEN_A, INTENT))).toBe('JOURNAL_CORRUPT');
      expect(code(() => createJournal(path).pending(TOKEN_A))).toBe('JOURNAL_CORRUPT');
    }
    // Two entries sharing one key would let two purchases collide: reject, don't pick one.
    const path = tempJournal();
    const journal = createJournal(path);
    journal.intent(TOKEN_A, INTENT);
    journal.intent(TOKEN_A, { ...INTENT, expected_price: 2 });
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const [a, b] = Object.values(file.entries) as { request: { idempotency_key: string } }[];
    b!.request.idempotency_key = a!.request.idempotency_key;
    writeFileSync(path, JSON.stringify(file));
    expect(code(() => journal.pending(TOKEN_A))).toBe('JOURNAL_CORRUPT');
  });

  it('waits for a live lock, then reports JOURNAL_LOCKED; breaks a stale one', () => {
    const path = tempJournal();
    const journal = createJournal(path);
    journal.pending(TOKEN_A);
    writeFileSync(`${path}.lock`, '');
    expect(code(() => journal.intent(TOKEN_A, INTENT))).toBe('JOURNAL_LOCKED');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(code(() => journal.intent(TOKEN_A, INTENT))).toBe('NONE');
  });

  it('agrees on one key when separate processes race on the same intent', async () => {
    const path = tempJournal();
    createJournal(path).pending(TOKEN_A);
    const script = fileURLToPath(new URL('./journal-race.fixture.ts', import.meta.url));
    const run = () =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', script, path, TOKEN_A]).then((r) =>
        r.stdout.trim(),
      );
    const keys = await Promise.all([run(), run(), run(), run()]);
    expect(new Set(keys).size).toBe(1);
    expect(createJournal(path).pending(TOKEN_A)).toHaveLength(1);
  }, 30_000);
});
