import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlanDrafter } from './advisory.js';

// Explicit local operator action; never called by the gateway or worker.
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 3 || args[0] !== '--live' || !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Usage: ANTHROPIC_API_KEY=... node --import tsx apps/gateway/src/judge/draft-cli.ts --live TASK_FILE APPROVED_CATALOG_FILE',
    );
  }
  const task = await readFile(args[1]!, 'utf8');
  const catalog: unknown = JSON.parse(await readFile(args[2]!, 'utf8'));
  const drafter = createPlanDrafter({
    model: 'claude-sonnet-4-5-20250929',
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeoutMs: 5000,
  });
  const output = await drafter.draft({ task, catalog: catalog as never });
  process.stdout.write(
    `${JSON.stringify({ mode: 'live-proposal-only', model: 'claude-sonnet-4-5-20250929', ...output }, null, 2)}\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'Draft failed. Check credentials, input files and required --live arguments; no draft was activated.\n',
    );
    process.exitCode = 1;
  });
}
