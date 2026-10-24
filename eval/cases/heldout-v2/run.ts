import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createJudge, createStubJudge } from '../../../apps/gateway/src/judge/index.js';
import {
  SYSTEM_PROMPT,
  OUTPUT_SCHEMA,
  PROMPT_VERSION,
} from '../../../apps/gateway/src/judge/prompt.js';
import { BASELINE_VERSION, createCategoryBaseline } from '../../api/baseline.js';
import { ROOT, loadFrozen, runEntry, sha256 } from './suite.js';
import { markdown, metrics, type Run } from './report.js';

const USAGE = 'Usage: pnpm eval:heldout-v2:offline | pnpm eval:heldout-v2:live [--out-dir DIR]';
const parseArgs = (args: string[]) => {
  let live = false;
  let outDir = `${ROOT}/results`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') live = true;
    else if (arg === '--out-dir') {
      const dir = args[++i];
      if (!dir || dir.startsWith('-')) throw new Error(USAGE);
      outDir = dir;
    } else throw new Error(USAGE);
  }
  return { live, outDir };
};
const { live, outDir } = parseArgs(process.argv.slice(2));
if (live && !process.env.ANTHROPIC_API_KEY)
  throw new Error('ANTHROPIC_API_KEY required; no fallback');
const manifest = loadFrozen();
const manifestHash = sha256(readFileSync(`${ROOT}/manifest.json`));
const model = 'claude-sonnet-4-5-20250929';
const judge = live
  ? createJudge({ model, apiKey: process.env.ANTHROPIC_API_KEY!, timeoutMs: 5000 })
  : null;
const execute = async (j: ReturnType<typeof createStubJudge>) => {
  const results = [];
  for (const entry of manifest.cases) results.push(await runEntry(entry, j, manifest.pages));
  return results;
};
const baseline = await execute(createCategoryBaseline());
const stub = await execute(createStubJudge('stub-approve'));
const runs: Run[] = [];
const add = (mode: string, repetition: number, results: Run['results']) =>
  runs.push({
    mode,
    repetition,
    results,
    metrics: metrics(results, baseline),
    boundary_failures: [],
  });
add('deterministic', 1, baseline);
add('stub-approve', 1, stub);
if (judge) for (let i = 1; i <= 3; i++) add('live', i, await execute(judge));
loadFrozen();
const createdAt = new Date().toISOString();
const report = {
  version: manifest.version,
  created_at: createdAt,
  command: live ? 'pnpm eval:heldout-v2:live' : 'pnpm eval:heldout-v2:offline',
  candidate_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  working_tree_dirty:
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  implementation_sha256: Object.fromEntries(
    [
      'eval/api/runner.ts',
      'eval/api/baseline.ts',
      'eval/api/fixtures.ts',
      `${ROOT}/suite.ts`,
      `${ROOT}/report.ts`,
      `${ROOT}/run.ts`,
    ].map((path) => [path, sha256(readFileSync(path))]),
  ),
  manifest_sha256: manifestHash,
  catalog_sha256: manifest.catalog_sha256,
  reviewer: manifest.reviewer,
  model: live ? model : null,
  live_status: live ? 'executed' : 'unmeasured',
  settings: { temperature: 0, timeout_ms: 5000, retries: 0, max_tokens: 512 },
  prompt_version: PROMPT_VERSION,
  prompt_sha256: sha256(JSON.stringify([SYSTEM_PROMPT, OUTPUT_SCHEMA])),
  baseline_version: BASELINE_VERSION,
  rules: manifest.rules,
  modes: { payments: 'mock', dashboard: 'not exercised' },
  pages: manifest.pages,
  runs,
};
mkdirSync(outDir, { recursive: true });
const stem = `${outDir}/${live ? 'live-' + createdAt.replaceAll(':', '-') : 'offline'}`;
writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
writeFileSync(`${stem}.md`, markdown(runs, manifestHash, live));
console.log(`${stem}.json\n${stem}.md`);
if (runs.some((r) => r.metrics.errors)) process.exitCode = 1;
