import { writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  createPlanDrafter,
  createStubPlanDrafter,
} from '../../../apps/gateway/src/judge/advisory.js';
import { loadCatalog } from '../../../apps/gateway/src/catalog/index.js';
import { differences, parsePlan, propose, reference, tasks, type Plan } from './setup.js';
import { provenance } from './provenance.js';

const live = process.argv.includes('--live');
const reverse = process.argv.includes('--reverse');
const operator = process.argv.find((a) => a.startsWith('--operator='))?.slice(11) ?? null;
const output = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
if (!output) throw new Error('Provide --out=/tmp/setup-results.json');
if (live && (!process.env.ANTHROPIC_API_KEY || !process.stdin.isTTY))
  throw new Error('Live comparison requires ANTHROPIC_API_KEY and an interactive terminal');
const model = 'claude-sonnet-4-5-20250929';
const drafter = live
  ? createPlanDrafter({ model, apiKey: process.env.ANTHROPIC_API_KEY!, timeoutMs: 5000 })
  : createStubPlanDrafter();
const catalog = loadCatalog('catalog/catalog.json');
const rows: unknown[] = [];
const report = {
  ...provenance(),
  mode: live
    ? 'live convenience sample; authored references, independent review pending'
    : 'OFFLINE STUB: NOT EVIDENCE of Claude quality or human setup time',
  model: live ? model : null,
  operator,
  reverse_order: reverse,
  activation: 'not attempted; contract cannot express strict operation plans',
  task_execution: 'unmeasured',
  token_usage: null,
  cost: null,
  rows,
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const terminal = live ? createInterface({ input: process.stdin, output: process.stdout }) : null;
try {
  for (const [index, task] of tasks.entries()) {
    const expected = reference(task);
    if (!terminal) {
      const draft = await propose(drafter, task.task, catalog);
      rows.push({
        task_id: task.id,
        manual_plan: expected,
        ...draft,
        reference_differences: differences(draft.proposal?.draft ?? null, expected),
        draft_failed: draft.error !== null || !draft.proposal?.draft,
        manual_setup_ms: null,
        assisted_setup_ms: null,
        human_edits: null,
        activation_errors: null,
        task_failed: null,
      });
      save();
      continue;
    }
    // Alternates order within the convenience sample; user can repeat with another operator.
    const assistedFirst = Boolean(index % 2) !== reverse;
    for (const method of assistedFirst ? ['assisted', 'manual'] : ['manual', 'assisted']) {
      await terminal.question(`Ready for ${task.id} / ${method}? Enter to start timer. `);
      const started = performance.now();
      console.log(task.task);
      const draft = method === 'assisted' ? await propose(drafter, task.task, catalog) : null;
      if (draft) console.log(JSON.stringify(draft, null, 2));
      else
        console.log(
          'Create JSON fields: task (exact), subjects, allowed_merchant_ids, budget, expires_in_ms. Catalog: catalog/catalog.json.',
        );
      let plan: Plan | null = null;
      const errors: string[] = [];
      for (;;) {
        const path = await terminal.question(
          'Review/edit JSON in a local file; enter its path, or skip to record setup failure: ',
        );
        if (path === 'skip') break;
        try {
          plan = parsePlan(JSON.parse(readFileSync(path, 'utf8')), task.task, catalog);
          break;
        } catch {
          errors.push('INVALID_PLAN_FILE_OR_SCHEMA');
          console.log('Invalid file/schema/task/merchant. Correct it or skip; timer continues.');
        }
      }
      const setupMs = performance.now() - started;
      const mismatches = plan ? differences(plan, expected) : null;
      const outcome = await terminal.question(
        'Optional observed task outcome from a separate local run: completed / failed / unmeasured [unmeasured]: ',
      );
      const taskFailed = outcome === 'failed' ? true : outcome === 'completed' ? false : null;
      rows.push({
        task_id: task.id,
        method,
        order: assistedFirst ? 'assisted-first' : 'manual-first',
        setup_ms: setupMs,
        ...draft,
        final_plan: plan,
        errors,
        reference_differences: mismatches,
        field_edits:
          method === 'assisted' && plan ? differences(draft?.proposal?.draft ?? null, plan) : null,
        setup_failed: plan === null || mismatches!.length > 0,
        activation_errors: null,
        task_failed: taskFailed,
        task_outcome_source:
          taskFailed === null ? null : 'operator self-report; not verified by harness',
        human_setup_sessions: 1,
        plan_submissions: errors.length + (plan === null ? 0 : 1),
      });
      save();
    }
  }
} finally {
  save();
  terminal?.close();
}
console.log(
  `Saved ${output}. Setup-only comparison; activation and useful task completion are unmeasured.`,
);
