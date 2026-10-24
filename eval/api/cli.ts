import { readFileSync, writeFileSync } from 'node:fs';
import { createJudge, createStubJudge } from '../../apps/gateway/src/judge/index.js';
import {
  SYSTEM_PROMPT,
  OUTPUT_SCHEMA,
  PROMPT_VERSION,
} from '../../apps/gateway/src/judge/prompt.js';
import { aggregate, runCase } from './runner.js';
import { BASELINE_VERSION, createCategoryBaseline } from './baseline.js';
import { hash, loadSuite, MANDATES } from './fixtures.js';
import { acceptance, measuredMarkdown, summarize } from './report.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--real')) throw new Error('Usage: pnpm eval:stub | pnpm eval:real');
const real = args.includes('--real');
if (real && !process.env.ANTHROPIC_API_KEY)
  throw new Error('ANTHROPIC_API_KEY required; no real-to-stub fallback');
const mode = real ? 'real' : 'stub-approve';
const model = real ? (process.env.JUDGE_MODEL ?? '') : null;
// Validate real credentials/settings before any work; preserve native-fetch auth unchanged.
const judge = real
  ? createJudge({ model: model!, apiKey: process.env.ANTHROPIC_API_KEY!, timeoutMs: 5000 })
  : createStubJudge('stub-approve');
const suite = loadSuite();
const cases = [...suite.core, ...suite.variants];
const coreIds = new Set(suite.core.map((c) => c.id));
const stub = [];
for (const fixture of cases) stub.push(await runCase(fixture, createStubJudge('stub-approve')));
const deterministic = [];
for (const fixture of cases) deterministic.push(await runCase(fixture, createCategoryBaseline()));
const runs = [];
for (let i = 0; i < (real ? 3 : 1); i++) {
  const results = [];
  if (real) {
    for (const fixture of cases) results.push(await runCase(fixture, judge));
  } else results.push(...stub);
  const warmup = await runCase(
    suite.core.find((c) => c.kind === 'legitimate' && c.mandate === 'pricing')!,
    judge,
    6,
  );
  runs.push({ run: i + 1, metrics: summarize(results, coreIds), results, warmup });
}
const report = {
  version: 2,
  mode,
  payments_mode: 'mock',
  merchant_control: 'isolated injected fixtures; external /_control unmeasured',
  model,
  settings: { temperature: 0, timeout_ms: 5000, retries: 0, max_tokens: 512 },
  prompt_version: PROMPT_VERSION,
  prompt_sha256: hash([SYSTEM_PROMPT, OUTPUT_SCHEMA]),
  catalog_sha256: hash(readFileSync('catalog/catalog.json', 'utf8')),
  fixtures_sha256: hash(suite),
  mandates_sha256: hash(MANDATES),
  created_at: new Date().toISOString(),
  runs,
  deterministic_baseline: {
    version: BASELINE_VERSION,
    metrics: summarize(deterministic, coreIds),
    results: deterministic,
  },
  stub_comparison: { metrics: summarize(stub, coreIds), results: stub },
  core_aggregation: aggregate(runs.map((r) => r.results.filter((v) => coreIds.has(v.id)))),
  held_out_aggregation: aggregate(runs.map((r) => r.results.filter((v) => !coreIds.has(v.id)))),
  acceptance: acceptance(
    runs.map((r) => r.results.filter((v) => coreIds.has(v.id))),
    stub.filter((v) => coreIds.has(v.id)),
    mode,
    runs.map((r) => r.warmup),
  ),
};
const stem = real ? 'eval/api/real-results' : 'eval/api/stub-results';
writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
writeFileSync(`${stem}.md`, measuredMarkdown(runs, stub, coreIds, mode, deterministic) + '\n');
if (!real) {
  const path = 'eval/REPORT.md';
  const current = readFileSync(path, 'utf8');
  const start = '<!-- measured:start -->';
  const end = '<!-- measured:end -->';
  if (!current.includes(start) || !current.includes(end)) throw new Error('REPORT_MARKERS_MISSING');
  writeFileSync(
    path,
    current.slice(0, current.indexOf(start) + start.length) +
      '\n\n' +
      measuredMarkdown(runs, stub, coreIds, mode, deterministic) +
      '\n\n' +
      current.slice(current.indexOf(end)),
  );
}
console.log(JSON.stringify({ output: `${stem}.json`, acceptance: report.acceptance }, null, 2));
if (
  runs.some((r) => r.results.some((v) => v.outcome === 'error' || v.outcome === 'unknown')) ||
  [...stub, ...deterministic].some((v) => v.outcome === 'error' || v.outcome === 'unknown') ||
  runs.some((r) => r.warmup.outcome === 'error' || r.warmup.outcome === 'unknown')
)
  process.exitCode = 1;
