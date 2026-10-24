# Verification on the implementation working tree

Candidate base: `b5021a2` on `chunk3/validation-contracts`; changes are uncommitted. See generated JSON for full SHA and evaluation implementation hashes.

- `pnpm lint`: passed.
- `pnpm format:check`: passed. The repository ignores `eval/` in Prettier; supplemental TypeScript/manifest and the modified runner were additionally formatted explicitly with `--ignore-path /dev/null`.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm exec vitest run --project eval`: 52 passed, 3 todo, 9 files passed and 1 skipped.
- `pnpm test`: 1,524 passed, 82 failed, 3 todo; 55 files passed, 5 failed, 1 skipped. The five failing files are gateway `test/process.test.ts` and `src/payments/{pay,quote,reconcile,transport}.test.ts`. Failures are sandbox `listen EPERM`; eight transport tests subsequently time out waiting for blocked listeners, with eight matching unhandled EPERM errors. Run `pnpm test` locally to verify TCP tests. No application assertion failure was observed outside those blocked files.
- `pnpm eval:v13:offline`: passed with zero infrastructure errors or boundary failures. Six semantic misses in each control are intentionally reported: stub permits six off-task requests; baseline permits five and wrongly denies one legitimate export. Four boundary probes deny in each control with zero judge calls and no mock signatures/settlements.
- Frozen historical report SHA-256 and manifest content verification: passed. `todo.md` and `eval/REPORT.md` were not edited. No commits or branch switches.

Live judge results, independent reviewer sign-off and real human intervention measurements are unmeasured. With `ANTHROPIC_API_KEY` exported securely, run `pnpm eval:v13:live` locally; this pins `claude-sonnet-4-5-20250929` and performs three repetitions using mock payments. Results go to timestamped `results/live-*.json` and `.md` files. Inspect errors and all raw outcomes before making a model-value claim.
