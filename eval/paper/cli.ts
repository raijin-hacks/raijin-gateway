import { readFile, writeFile } from 'node:fs/promises';
import { createStubJudge } from '../../apps/gateway/src/judge/index';
import { createJudge } from '../../apps/gateway/src/judge/real';
import { validatePaperFixtures } from './index';
import { runPaper } from './runner';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: pnpm paper --output <new-report.json>');
  const rawMandates: unknown = JSON.parse(await readFile('eval/paper/mandates.json', 'utf8'));
  const rawCases: unknown = JSON.parse(await readFile('eval/paper/cases.json', 'utf8'));
  validatePaperFixtures(rawMandates, rawCases);
  const mode = process.env.JUDGE_MODE;
  if (mode !== 'real' && mode !== 'stub-approve' && mode !== 'stub-escalate') throw new Error('Set explicit JUDGE_MODE=real|stub-approve|stub-escalate');
  const model = mode === 'real' ? process.env.JUDGE_MODEL ?? '' : null;
  if (mode === 'real') {
    const { SUPPORTED_MODELS } = await import('../../apps/gateway/src/judge/real');
    if (!SUPPORTED_MODELS.some(supported => supported === model)) {
      console.error('JUDGE_MODEL must be a verified pinned model: ' + SUPPORTED_MODELS.join(', '));
      process.exitCode = 1;
      return;
    }
  }
  const judge = mode === 'real' ? createJudge({ model: model!, apiKey: process.env.ANTHROPIC_API_KEY ?? '', timeoutMs: 5000 }) : createStubJudge(mode);
  // Reserve the report path before paid calls; never overwrite earlier measurements.
  const handle = await import('node:fs/promises').then(fs => fs.open(args[1]!, 'wx', 0o600));
  await handle.close();
  const report = await runPaper(judge, rawMandates, rawCases, mode, model);
  await writeFile(args[1]!, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ checkpoint: report.checkpoint.status, judge: report.judge, report: args[1] }));
  if (report.checkpoint.status !== 'passed') process.exitCode = 1;
}
main().catch(() => {
  // Provider errors and configuration never print keys, headers or raw responses.
  console.error('Paper run failed. Check explicit mode, supported pinned model, credentials, fixtures and a new writable --output path.');
  process.exitCode = 1;
});
