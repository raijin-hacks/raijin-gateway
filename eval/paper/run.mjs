// Bundle the TypeScript CLI using the workspace's existing Vite/esbuild toolchain.
import process from 'node:process';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'chunk3-paper-'));
try {
  const outfile = join(directory, 'paper.mjs');
  // Bundle contracts from source: the package's exports point at dist/, which may not be built.
  await build({
    entryPoints: ['eval/paper/cli.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    alias: { '@apf/contracts': './packages/contracts/src/index.ts' },
  });
  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
