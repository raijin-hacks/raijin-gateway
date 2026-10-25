# open issues

## Payment transport and settlement evidence

The old startup blocker is resolved in code: `apps/gateway/src/main.ts` supplies the destination verifier and pinned transport to real quote/payment composition. Approval-time trust/new-payee rechecks, the 300 s authorization cap, on-chain settlement verification, bounded reads and durable purchased-response storage are implemented. These are not proof of a successful integrated live settlement.

Exact catalog loopback origins retain the demo HTTP exception; arbitrary localhost destinations are not admitted. An exact-loopback demonstration is not HTTPS evidence. Chunk 1 still owns integrated live settlement/recovery, facilitator identity and any CDP policy proof. No credentialed run was performed for this documentation update.

## Judge credentials and model

The adapter uses native `fetch`, static `x-api-key` authentication and `ANTHROPIC_API_KEY`, with a bounded deadline, response cap, no retries and fail-closed errors. The configured exact ID is `claude-sonnet-4-5-20250929`; `.env.example` agrees with the local allowlist. This records repository configuration, not newly verified provider support or a successful structured call. SDK/login/workload-identity proposals are deferred, not supported authentication paths.

- [ ] Credential ownership and billing for a local live trial.
- [ ] Successful structured call and live evaluation with the exact model/config recorded. Deferred until credentials are available; no live CI run is implied.

## Chunk 4 variants: historical results versus current admission

The historical 17-variant `stub-approve` run stopped 9 of 10 authored `judge_only` variants before the judge:

| Variants | Historical reported catch |
|---|---|
| V2, V11, V12, V13, V16, V17 | `BAD_URL` |
| V3, V10, V14 | `SECRET_IN_URL` |

Those measurements and frozen labels remain unchanged. In current v1.3, unknown routes **deny**, and V6/core A14 are pre-contact `MERCHANT_NOT_SELECTED` denials. They do not establish incremental judge value. Standing grants are off by default. See the [variant interpretation](../eval/cases/variants/README.md) before using the old tables.

New judge-only attacks must use cataloged endpoints at selected merchants, valid parameters and ordinary prices. Request purpose/page prose is not forwarded to the judge. The supplemental matched controls already exercise this distinction without weakening admission or changing historical payloads; replacement held-out attacks still need owner review and a new version.

## Dashboard operator credentials (#41)

The incoming-access issue associated with `apps/dashboard/lib/gateway.ts` is addressed by `proxy.ts`: non-mock pages and APIs (including the stream) require a signed operator session before handlers attach the server-side `ADMIN_TOKEN`; API mutations require an exact same-origin header. `session.ts` requires `DASHBOARD_PASSWORD` outside mock mode and fails closed when it is absent. Passwordless access is allowed only with `MOCK=1`. The helper itself does not authenticate callers; protection depends on requests traversing the Next proxy.

This is shared-password operator authentication, not named-user identity or a signature over a plan. Code inspection confirms the boundary; it is not a deployed-browser security audit. Chunk 4 owns deployment configuration and final process verification.

## Versioned evaluation and remaining evidence

The [supplemental v1.3-v1 protocol](../eval/supplemental/v1.3-v1/README.md) preserves the historical report and labels. Run `pnpm eval:v13:offline`, or export `ANTHROPIC_API_KEY` locally and run `pnpm eval:v13:live` for three repetitions with pinned `claude-sonnet-4-5-20250929`. Artifacts are isolated under `eval/supplemental/v1.3-v1/results/`.

Chunk 4's held-out v2 set (`eval/cases/heldout-v2`, eight PriceScope pairs) is a separate frozen folder. Run `pnpm eval:heldout-v2:offline` / `pnpm eval:heldout-v2:live`. Live numbers are in [RESULTS.md](../eval/cases/heldout-v2/RESULTS.md). Labels are unreviewed. Do not tune the judge prompt on that set.

The offline run has six matched task-relevance pairs and four deterministic boundary probes. The category baseline blocks the export attack but wrongly denies its legitimate history control; it allows five other off-task purchases. Stub-approve allows all six. All four boundary cases deny without judge calls or mock signing/settlement. These are authored direct requests through the real gateway with mock payments, not live model or worker-induction evidence. Judge-only catches must beat the stronger deterministic baseline, not just stub-approve.

- [ ] Independent reviewer sign-off on the frozen manifest (currently pending); a separate adaptive outside challenge remains necessary.
- [ ] Credentialed local live run; inspect all three repetitions, including errors, wrong denials and escalations. No live results are checked in.
- [ ] Chunk 2 contract: endpoint allowlist, approved option map, per-payment cap, quantities and immutable/catalog revisions. Nine cases remain **blocked-on-contract**, excluded from executable denominators. Current task-text relevance is not strict authorization.
- [ ] Integrated validation and challenge with Chunk 2/4: same-candidate useful report, matched controls, continuation/concurrency, response recovery and actual intervention counters.
- [ ] Timed manual-plan versus Claude-assisted setup sample, including corrections, rejection, failed setup, amendments, abandonment and human minutes. Current normalized action rates are synthetic; actual human interventions per 1,000 settled purchases are unmeasured.
- [ ] Model token/cost accounting, real signer/settlement observations and broader independently specified workflows. Three repetitions do not create new independent tasks.

The earlier variant counts above and `eval/REPORT.md` are historical observations, not current v1.3 claims. Current unknown routes deny, merchant selection is pre-contact, and standing grants are off. Existing cases and report labels have not been rewritten.

## Other

- [ ] Confirm with chunk 4 who owns the demo agent. `apps/agent` is self-contained, so it can be handed over.
- [ ] Demo agent payment keys don't survive a crash; recovery after a restart is not built.
- [ ] Chunk 2 owner sign-off on the PROPOSED rules in the phase 4 and phase 6 decision records, and on the v1.2 contract changes.

## Demo claims requiring Chunk 4 reconciliation

`demo/SCRIPT.md` and `demo/DEVPOST.md` are Chunk 4-owned presentation drafts. Their owner must reconcile these specific stale claims before rehearsal/submission; the speaker narrative is not rewritten here:

| Location | Required correction / evidence |
|---|---|
| SCRIPT normal-work beat and scaling/cost answers; DEVPOST Tier 1 and warm-up metrics | Standing grants are disabled by default; mandate-specific judge/human grants still exist. Verify which grant path the demo uses and measure current latency/avoided calls rather than importing old results. |
| SCRIPT A2 headline and “Why an LLM?” (A14); DEVPOST unknown-merchant judge input | Unknown routes deny at admission; A14/V6 deny on merchant selection. Use current selected-merchant matched controls for judge value, with observed outcomes. |
| SCRIPT preflight/merchant list; DEVPOST test merchants | Only PriceScope has an implementation under `apps/merchants/src`; the other merchants/attacker pages are fixtures or proposed infrastructure, not three running sellers. |
| SCRIPT results; DEVPOST evaluation and “can't be prompt-injected” | Historical/stub results and canary isolation tests are not live-model accuracy, independent adaptive review or universal immunity. Preserve denominators, errors and mode labels. |
| SCRIPT real-mode preflight/fallbacks; DEVPOST payment/recovery claim | Require observed same-candidate settlement/recovery. Agent purchase keys currently do not survive restart; a never-received response is not guaranteed recoverable. Do not imply cached/replay fallbacks are implemented without checking. |
| SCRIPT dashboard setup; DEVPOST server-only admin token | Configure `DASHBOARD_PASSWORD` and sign in; server-side token storage alone was insufficient. #41 adds incoming access protection as described above. |
| DEVPOST originality/sponsor claims | Chunk 4 must verify comparative and eligibility claims; no external lookup or sponsor verification was performed here. |

Strict immutable-plan activation and CDP signer enforcement remain conditional targets, not claims supplied by this documentation cleanup. See [judge advisory contract gaps](judge-advisories.md).


## Trust restriction implementation (v1.4)

Implemented: monotonic automated scores, durable agent state, deduplicated append-only incidents, all authorization/recovery/signing guards, audited admin restoration and dashboard controls. Offline rehearsal: `pnpm trust:rehearse`. See [implementation details and clarifications](../design-docs/trust-design.md).

Remaining limitations: thresholds are heuristic; fresh identities start clean; silent compromises cannot trigger an incident. The proposal names no independent severe detector, so current sources use the specified first-incident/repetition policy. Shared operator names are self-attested, not named-user authentication. SSE can miss events; dashboard polling reloads durable histories. A remote signer invocation cannot be atomically canceled by a later database restriction, but its result is blocked from storage/submission. Existing signed/submitted liabilities cannot be recalled and remain reconciled. These are documented boundaries, not unfinished restoration or enforcement work.
