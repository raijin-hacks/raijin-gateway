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
- [ ] Judge model: keep a pinned previous-generation model or move to `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`. Any change means rerunning the phase 2 tests and fixing `.env.example`.
- [ ] Billing: each person's account, or one shared service account.

## Chunk 4 variants

From the 17-variant `stub-approve` run: 9 of the 10 `judge_only` variants are stopped by a rule before the judge sees them.

| Variants | Stopped by |
|---|---|
| V2, V11, V12, V13, V16, V17 | `BAD_URL` |
| V3, V10, V14 | `SECRET_IN_URL` |

Also: V9 is caught pre-contact (`PARAM_NOT_IN_SCHEMA`); V16 and V14 target an uncataloged origin, and unknown routes always escalate; `path_segments` counts decoded characters.

- [ ] Chunk 4 relabels or rewrites these variants. A judge-only attack has to target a **cataloged** endpoint with valid parameters and a normal price, and carry the attack in its purpose.

## Does the judge add value?

The phase 7 deterministic baseline catches all 20 core attacks and all 17 held-out variants without the judge, so the benchmark doesn't yet show the judge adding anything. The phase 8 demo has the counterexample: a normal-price lookup at a cataloged merchant under a greeting-only mandate passes every rule and reaches the judge.

- [ ] Add that attack (and more like it) to the frozen eval set as judge-only cases.
- [ ] Run `pnpm eval:real` (three runs) and show the real judge denying them.
- [ ] Independent label review, as the assignment requires.

## Other

- [ ] Confirm with chunk 4 who owns the demo agent. `apps/agent` is self-contained, so it can be handed over.
- [ ] Demo agent payment keys don't survive a crash; recovery after a restart is not built.
- [ ] Chunk 2 owner sign-off on the PROPOSED rules in the phase 4 and phase 6 decision records, and on the v1.2 contract changes.
