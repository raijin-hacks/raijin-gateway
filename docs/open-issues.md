# open issues

## Payment hardening and J2b (issue #18)

Done in open PRs: approval-time rechecks of trust and the new-payee limit, the 300 s authorization cap, on-chain settlement proof, and the 1 MiB response cap.

Still open, and all needed before real payments are turned on:

- [ ] Pinned connection that keeps the hostname for TLS, SNI and Host; peer verification; no redirects or proxies.
- [ ] Wire the destination classifier and pinned connection into both the quote and paid requests.
- [ ] **Decide the localhost exception** (chunks 1–4). The J2b spec forbids any localhost exception on the live path, but phase 4 allows HTTP for exact loopback catalog origins so the demo merchants (`http://localhost:4101–4103`) work. Keep it through the pinned transport, or move the demo merchants to HTTPS.
- [ ] Remove the real-payment startup block in `apps/gateway/src/main.ts` last.

## Judge credentials and model

The judge calls the API with native `fetch` and a static `x-api-key`, and `eval:real` requires `ANTHROPIC_API_KEY`. Proposal: switch to the official SDK so it resolves credentials itself, using `ant auth login` locally and workload identity federation in CI, with no key in the repo or `.env`.

Decisions needed:

- [ ] Adopt the SDK transport, keeping the 5 s deadline, no retries, response cap and fail-closed errors.
- [ ] Local policy: `ant auth login` only, or personal keys allowed too.
- [ ] Live evals in CI or not (manual or scheduled only; each run costs money), and if yes, who sets up the WIF service account and federation rule.
- [x] Model decided: Sonnet 4.5, exact ID `claude-sonnet-4-5-20250929`. `.env.example` now agrees with the existing allowlist. Keep native fetch and `ANTHROPIC_API_KEY`; SDK/auth redesign is deferred. Live draft/evaluation evidence remains unmeasured until a credentialed local run.
- [ ] Billing: each person's account, or one shared service account.

## Chunk 4 variants

From the 17-variant `stub-approve` run: 9 of the 10 `judge_only` variants are stopped by a rule before the judge sees them.

| Variants | Stopped by |
|---|---|
| V2, V11, V12, V13, V16, V17 | `BAD_URL` |
| V3, V10, V14 | `SECRET_IN_URL` |

Also: V9 is caught pre-contact (`PARAM_NOT_IN_SCHEMA`); V16 and V14 target an uncataloged origin, and unknown routes always escalate; `path_segments` counts decoded characters.

- [ ] Chunk 4 relabels or rewrites these variants. A judge-only attack has to target a **cataloged** endpoint with valid parameters and a normal price, and carry the attack in its purpose.

## Versioned evaluation and remaining evidence

The [supplemental v1.3-v1 protocol](../eval/supplemental/v1.3-v1/README.md) preserves the historical report and labels. Run `pnpm eval:v13:offline`, or export `ANTHROPIC_API_KEY` locally and run `pnpm eval:v13:live` for three repetitions with pinned `claude-sonnet-4-5-20250929`. Artifacts are isolated under `eval/supplemental/v1.3-v1/results/`.

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
