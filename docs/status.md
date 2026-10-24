# Chunk 3 status

## Current repository state (October 24, 2026)

The former phase 6–8 branch stack is historical and must not be merged or rebased using this document. The current working branch is `chunk3/integrated-acceptance`, based on `main` at `6f38740` with chunk 3 part 3 (#39) and operator sign-in (#41). Uncommitted integrated-acceptance work is separate from this documentation cleanup; its presence is not a merged or live-evidence claim.

| Area | Implemented behavior | Remaining evidence / limits |
|---|---|---|
| Admission | Unknown routes deny before contact; selected merchants are enforced pre-contact (`MERCHANT_NOT_SELECTED`). V6/A14 are early catches. | Old `judge_only` labels are historical; use observed layer attribution. |
| Judge | Sanitized known-route input, strict output validation, bounded native-fetch adapter; configured model `claude-sonnet-4-5-20250929`. | No new live structured-call/model accuracy claim; credentials deferred. |
| Advisory channels (#39) | Separate validated draft and explanation interfaces, typed numeric/boolean explanation facts, fixed outage fallback. | Advisory only; no activation privilege or strict-plan fields. See [contract gaps](judge-advisories.md). |
| Payment pipeline | Idempotency, atomic money reservations, approval-time rechecks, bounded purchased-response persistence and reconciliation. | Strict operation/count/revision authority requires Chunk 2. |
| Transport | Startup wires destination verification and pinned transport for quote and payment; exact catalog loopback HTTP exception remains. | Old startup gate is removed. Integrated live settlement, HTTPS and CDP evidence remain separate gates. |
| Grants | Standing grants disabled by default. | Do not reuse old warm-cache performance or grant assumptions as default behavior. |
| Worker | Bounded purchased output and receipt/source metadata reach the worker; final answer and failure/step limits are exposed. | Purchase keys are session-local; durable agent restart identity remains next offline engineering work. |
| Evidence | Historical API report/cases preserved; separate frozen v1.3-v1 protocol has six matched pairs and four boundary probes. | Mock transitions are not real signatures/settlements; nine strict-contract cases blocked, independent review and human-effort measurements pending. |
| Dashboard (#41) | Operator session gate precedes admin proxy calls; same-origin API mutation checks. | Shared password, not named-user/plan-signature identity. Deployment verification belongs to Chunk 4. |

## Historical verification

On the old `chunk3/phase8` stack, outside the Codex sandbox: **1,416 tests passed, 3 todo, 0 failures**; lint, formatting, typecheck, build, agent rehearsal and frozen-lockfile install passed. This is retained as a historical measurement, not the current candidate's check result.

## Documentation-cleanup verification

On this working tree, October 24, 2026, `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm build` passed. `pnpm test` reported **1,540 passed, 96 failed, 1 expected fail, 3 todo** (57 files passed, 7 failed, 1 skipped). The 96 failures were sandbox-blocked TCP tests: `listen EPERM`, including eight transport timeouts with corresponding failed-listen errors. They are not passing tests. `pnpm --filter dashboard build` was also sandbox-blocked: Turbopack's CSS processing attempted to bind a port and received “Operation not permitted.” These require verification outside the restricted sandbox; no code or test was changed to bypass them.

This run includes the pre-existing uncommitted integrated-acceptance work; this cleanup changes documentation only. No live/credentialed call or evidence rerun was made, and historical result artifacts were left unchanged.

## Next work

1. Durable worker purchase identity across restart, with dropped-reply/restart tests; do not reissue an unresolved purchase with a fresh key.
2. Chunk 2's immutable authority contract and continuation/concurrency integration, then strict-plan evidence.
3. Credentialed model/settlement trials and independent review when their owners are ready; all remain deferred here.
4. Chunk 4 reconciliation of the [flagged demo claims](open-issues.md#demo-claims-requiring-chunk-4-reconciliation), followed by a truthful rehearsal/recording.
