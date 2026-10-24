// writePrivateFile: the wallet keys file must end up owner-only however it came to exist.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, test } from 'vitest';
import { writePrivateFile } from './private-file.js';

const dir = mkdtempSync(join(tmpdir(), 'private-file-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const modeOf = (path: string) => statSync(path).mode & 0o777;

test('an existing world-readable file (e.g. copied from the example) ends up owner-only', () => {
  const path = join(dir, 'copied');
  writeFileSync(path, 'ADMIN_TOKEN=\n');
  chmodSync(path, 0o644);

  writePrivateFile(path, 'ADMIN_TOKEN=\nWALLET_PRIVATE_KEY=0xabc\n');

  assert.equal(modeOf(path), 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'ADMIN_TOKEN=\nWALLET_PRIVATE_KEY=0xabc\n');
});

test('a new file is created owner-only', () => {
  const path = join(dir, 'new');

  writePrivateFile(path, 'WALLET_PRIVATE_KEY=0xabc\n');

  assert.equal(modeOf(path), 0o600);
});

test('a file with looser group/other bits is tightened on every write, not just the first', () => {
  const path = join(dir, 'rewritten');
  writePrivateFile(path, 'first\n');
  chmodSync(path, 0o664); // e.g. loosened later by hand or by another tool

  writePrivateFile(path, 'second\n');

  assert.equal(modeOf(path), 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'second\n');
});
