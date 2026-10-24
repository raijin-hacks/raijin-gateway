# Test harness plan: gateway and judge

Oct 23, 2026 · Status: proposal · Companion to `CHUNK-2-3-BOUNDARY.md`

## Goals

1. Every test ID in `CHUNK-2-GATEWAY.md` and `CHUNK-3-JUDGE-AGENT-EVAL.md` gets an automated test at the cheapest layer that can prove it.
2. No test passes vacuously. A parallel test must actually overlap, and a canary test must actually send something to the model.
3. CI is deterministic: no network, no wallet, no model API, and a fake clock.
4. Each chunk can test alone against fakes. The point where they meet is tested with Chunk 3's real code and only the model faked.

## What exists today

- `tests/test_gateway.py` tests `GatewayEngine` in `tests/gateway_mocks.py`, an in-memory Python reference mock. It proves the invariants hold **for the mock**, not for the product. It also differs from the contracts:
  - money in cents, not atomic USDC
  - its own reason codes (`PAYEE`, `ROLE_CAP`, `BUDGET`, `JUDGE_DENIED`)
  - a judge that names the payee and endpoint
  - `REFERENCE_PRICE` denies instead of escalating
- `tests/fixtures/payment_matrix.json` holds 40 cases written in those mock reason codes.
- CI always runs pytest. The Node checks only run when there's a root `package.json`, and they require npm.

## Tools

| Need | Choice | Why |
|---|---|---|
| Test runner | Vitest | Supports TypeScript and ESM natively, and is fast |
| HTTP without ports | Hono's `app.request()` | Runs the real routes and middleware in-process |
| Database | A temporary SQLite **file** per test, not `:memory:` | WAL mode and `busy_timeout` behave as in production; the multi-process test needs a file anyway |
| No outbound traffic | undici `MockAgent` with `disableNetConnect()` | Any unexpected `fetch` fails the test, which backs up invariant 4 |
| Time | An injected `clock` plus an explicit `sweepTimeouts(now)` | Lets velocity windows, duplicate windows, expiry and the 10-minute human timeout be tested without waiting |
| Fake model | The `transport` option on `createJudge` (boundary doc, gap 4) | Runs the real `buildInput` and output checks, and records the exact text sent to the model |

### What Chunk 2's code must allow

These are cheap if decided now and painful to retrofit later.

- **Build the app with a factory, not module-level singletons:** `createApp({ db, clock, payments, judge, catalog, bus, logger })`. Production `main.ts` wires in the real pieces; tests wire in fakes.
- **No `Date.now()` in `apps/gateway/src`** outside `clock.ts`. A lint rule enforces it.
- **The human-timeout sweep is a plain function.** Production calls it from `setInterval`; tests call it directly after moving the clock forward.

## Test layers

| Layer | What runs | Real | Faked | When in CI |
|---|---|---|---|---|
| L0 Static | Lint and typecheck | — | — | Every push |
| L1 Unit | Pure functions | Everything under test | Nothing | Every push |
| L2 Database | `PaymentStore`, the atomic statements, repositories | SQLite file | Clock | Every push |
| L3 Pipeline | The whole gateway in-process | Database, Chunk 3's catalog, matching, `buildInput` and output checks, `PaymentStore` | Model transport, `PaymentsModule`, clock, network | Every push |
| L4 End to end | Separate processes: gateway, Chunk 1's merchants, attacker server | Everything except the chain and the model | `PAYMENTS_MODE=mock`, `JUDGE_MODE=stub-*` | Push to `main`, or run by hand |
| L5 Evaluation | Chunk 3's runner | Real model | `PAYMENTS_MODE=mock` | Run by hand only: it costs money and isn't deterministic |

Most attack IDs live at L3. It's fast enough for every push and real enough to catch ordering and race bugs.

### L0 static rules

- ESLint `no-empty`, plus a check that no `catch` block consists only of a comment. This enforces "no silent fallbacks".
- `no-restricted-syntax` banning `Date.now()` and `new Date()` in `apps/gateway/src` outside `clock.ts`.
- `no-restricted-imports`: only `apps/gateway/src/judge/` may import the model SDK or the `JudgeInput` type (tests excepted). This backs up the rule that `buildInput` is the only builder.

### L1 unit tests

| Area | Owner | Cases |
|---|---|---|
| Contracts package | 2 | Each zod schema accepts the examples in `final_contracts.md` and rejects broken copies. `REASON_STAGE` and `REASON_ACTION` cover every `ReasonCode`. The escalating codes are exactly `PARAM_NOT_IN_SCHEMA`, `SUBJECT_NOT_IN_MANDATE`, `UNKNOWN_WITH_PARAMS`, `REFERENCE_PRICE`, `NEW_PAYEE_LIMIT` and `TRUST_REQUIRES_HUMAN` |
| `canonicalize` (J-parse) | 3 | Uppercase host; default port; explicit non-default port; fragment; userinfo; percent-encoded path; `..` and empty segments; repeated parameter; empty value; `http` on localhost versus a public host |
| `matchEndpoint` | 3 | Path-template match; unknown endpoint on a known origin; known endpoint with an undeclared parameter; enum, int and bool option violations; `forbidden` parameter present |
| `loadCatalog` | 3 | Rejects duplicate IDs, overlapping endpoints and invalid specs |
| `buildInput` and the canary (A10, Chunk 3's version) | 3 | Every attack fixture carries a unique `CANARY-xxxxxx`; none appears in the serialized `JudgeInput`. Subject values appear only when they matched; option values only from the fixed list; unknown URLs reduce to lengths |
| Judge output checks | 3 | Through a scripted transport: bad JSON, an extra field, an unknown reason code, a grant on a deny, and an explanation over 200 characters each throw `JUDGE_INVALID_OUTPUT`. A transport error or a timeout throws `JUDGE_ERROR` |
| `SECRET_IN_URL` detector | 2 | One positive and one near-miss for each pattern: `sk-`, `sk_live_`, `ghp_`, `xox[abp]-`, `AKIA…`, `eyJ`, email, 32+ hex characters, high-entropy base32/base64 of 24+ characters. Negatives: normal IDs and dates |
| Grant clamp | 2 | Table-driven. The judge proposes more than each cap in turn and the result equals that cap; values within range are kept; `max_total` is capped at the remaining budget; the TTL is capped at the mandate's expiry |
| Trust | 2 | Routing at the thresholds (19/20, 39/40, 59/60). Every delta in the design table. The agent score never rises above the role baseline |

### L2 database tests (Chunk 2; must pass before the Sat 10 AM handoff to Chunk 1)

- **`PaymentStore` transition matrix.** For each method (`markSigned`, `markSubmitted`, `markUnknown`, `settle`, `fail`), start from each of the 6 states and check the return value, the resulting state and the mandate's `spent` and `reserved`. A repeated `settle` or `fail` changes nothing and moves no money.
- **Settle and fail are each one transaction.** Inject a failure between the two statements; the payment row and the mandate stay consistent.
- **Reservation statement.** It refuses once `spent + reserved + amount > budget`, on a closed mandate and on an expired mandate. The `CHECK` constraint rejects a direct write that breaks the invariant.
- **Grant-use statement.** It refuses past `max_total` and past expiry.

## The L3 harness

```ts
const h = await createHarness({
  model: scripted([approveWithGrant({ max_per_call: 10_000, max_total: 100_000 })]),
  quotes: { [PRICESCOPE_ACME]: { amount: 10_000, payee: PRICESCOPE_PAYEE } },
  pay: 'settle',
});
const m = await h.mandate({ subjects: ['acme'], merchants: ['mer_pricing'], budget: 1_000_000 });
const r = await h.pay(m, { url: PRICESCOPE_ACME, expected_price: 10_000, purpose: 'fetch_data' });

expect(r).toMatchObject({ status: 'approved', stage: 'judge' });
expect(h.mandateRow(m)).toMatchObject({ spent: 10_000, reserved: 0 });
expect(h.quoteCalls).toHaveLength(1);
expect(h.modelRequests).toHaveLength(1);
```

| Piece | What it does |
|---|---|
| `createHarness(opts)` | Temporary database file, seed data (tenant, roles `research` and `bulk`, three agents, catalog), network lock, then `createApp` with fakes. Cleans up after each test |
| `h.mandate(...)` | Creates a mandate through `POST /mandates` with the admin token, so the real route is exercised. Returns the token and IDs |
| `h.pay(m, req)` | Calls `POST /pay` with a fresh idempotency key unless one is given |
| `TestClock` | `now()`, `advance(ms)`, `set(ms)` |
| `FakePayments` | A `PaymentsModule`. Quotes come from a table keyed by canonical URL, or a function; `QuoteError` cases are supported. `pay()` drives the **real** `PaymentStore`, so state changes are real, with scriptable outcomes `settle`, `unknown` or `fail`. Records `quoteCalls` and `payCalls`. Has a `gate` hook for barriers |
| `scripted([...])` | The model transport. Returns scripted raw strings in order, can throw or hang (for timeouts), and records every request in `h.modelRequests` |
| `Barrier(n)` | Holds `n` callers until all have arrived, then releases them together |
| Captures | `h.events` (stream bus), `h.logs` (logger output), `h.judgeContexts` (wrapper around `buildInput`), `h.db` (direct queries for assertions) |

### Rules that stop tests passing vacuously

1. **Force real overlap in concurrency tests.** Node runs one thread, so parallel requests only overlap at `await` points. Every concurrency test puts a `Barrier(n)` inside `FakePayments.getQuote`, between the checks and the reservation. It then asserts the barrier saw all `n` arrivals. Without that, a read-then-write bug can pass.
2. **Pair every "never called" check with a positive control.** For example, the pipeline canary test asserts the model was called at least once for every fixture expected to reach the judge.
3. **Check side effects, not just status.** Each reason-code test checks the stage, the reasons, `mandateRow` (spent and reserved), `quoteCalls`, `modelRequests` and the decision row.
4. **Make sure the intended rule is the one that fires.** Tier 0 runs in a fixed order, so a test for a later rule must keep earlier rules quiet. For example, A7 and A13 must not trigger `DUPLICATE` or `VELOCITY` first (see the table below).

### Tests at the boundary (L3, new)

| ID | Test |
|---|---|
| S1 | `JudgeContext` keys equal the contract's set exactly; nothing extra is added |
| S2 | **End-to-end canary.** Put canaries in the hostname, path, parameter names, parameter values, the merchant's 402 metadata and the merchant's response body. For cases held at pre-contact, approve them as the human so they reach the judge. Run the pipeline with a scripted model. No canary appears in any recorded model request. In `JudgeContext`, a canary may appear only in `match.origin` and `match.params`, which `buildInput` must drop |
| S3 | A grant's payee, origin, method, endpoint and option values equal the request and quote. The judge's proposed limits are clamped (reuses the L1 table, end to end) |
| S4 | Each judge failure (transport throws, timeout, bad JSON, unknown code, `buildInput` throws) denies with the right code, releases the reservation and calls `pay()` zero times |
| S5 | `injection_suspected: true` on an approval quarantines the session. The next call is `QUARANTINED`, and no quote is fetched if gap 10 is adopted |
| S6 | With `stub-approve`, the judge-only attacks (A2, A3, A14, A17) are **approved**. This is the "rules alone let them through" proof the evaluation needs |
| S7 | Logs never contain a mandate token: scan `h.logs` for every token issued in the test |

## Every test ID, mapped

| ID | Layer | Owner | Setup | Key assertions |
|---|---|---|---|---|
| A1 | L3 + L4 | 2 | Unknown host; a 44-character base32 secret in a query parameter | L3: `UNKNOWN_WITH_PARAMS`, `quoteCalls = 0`, network lock untouched. L4: the attacker server's request counter stays at 0 |
| A2, A3 | L5 (+ S6) | 3 | Evaluation cases | Judge denies or escalates. S6 proves the rules alone approve them |
| A4 | L3 | 2 | Quote of 500 USDC | `PER_CALL_CAP`, stage `tier0`, model not called, `reserved = 0` |
| A5 | L3 | 2 | Approve at 10,000 (sets the reference price); next quote 900,000 | `REFERENCE_PRICE`, `pending`, no reservation, `approval_needed` event |
| A6 | L3 | 2 | Quote for a catalog endpoint names a different payee | `PAYEE_SWAP` |
| A7 | L3 | 2 | 40 × 50,000 on a 1,000,000 mandate. **Rotate across 5 subjects and advance the clock 4 s per call**, keeping `VELOCITY` (20/min) and `DUPLICATE` (3 in 10 s) quiet | Exactly 20 approved, then `MANDATE_BUDGET`; `spent = 1,000,000` |
| A8 | L3 | 2 | 50 identical calls within 60 s on the fake clock | Both `DUPLICATE` and `VELOCITY` appear. Depends on gap 11 (count attempts, not payments) |
| A9 | L3 | 2 | Grant created under mandate X; same call under mandate Y | Grant miss (`GRANT_NONE`); model called; X's `used_total` unchanged |
| A10 | L1 (3) + S2 (2) | both | Canary fixtures | See L1 and S2 |
| A11 | L3 | 2 | Mandate token on `POST /mandates` | 403; no mandate row created |
| A12 | L3 | 2 | Small grant `max_total`; prices 10,000, then 20,000, then 40,000 | First two approved. The third is `REFERENCE_PRICE` (40,000 > 2 × 10,000), `pending`. The reference price stays 10,000 |
| A13 | L3 (+ L4) | 2 | 10 parallel × 500,000 on 2,000,000. **10 distinct URLs** (5 subjects × 2 periods), keeping `DUPLICATE` quiet; `Barrier(10)` in `getQuote` | Exactly 4 approved and 6 `MANDATE_BUDGET`; barrier saw 10. Optional L4: two gateway processes on one database file |
| A14, A17 | L5 + L3 | 3 + 2 | L3: grants warmed up, then the off-task call | L3: `MERCHANT_NOT_SELECTED` (A14) or `GRANT_METHOD` / `GRANT_ENDPOINT` (A17) logged, and the model is called. L5: the judge denies or escalates |
| A16 | L3 | 2 | Grants warm on `acme`; then `company=unrelatedco` | `SUBJECT_NOT_IN_MANDATE`, `pending`, `quoteCalls = 0` for that call |
| A18 | L2 / L3 | 1 (gateway side: 2) | `FakePayments` returns `UNKNOWN`; the agent retries with the same key | `payment_unknown`; same `payment_id` on retry; still reserved; `pay()` reuses the same payment ID |
| A19 | L4 | 1 | Kill the gateway between submission and the database update | The startup reconciler resolves it; budget is never exceeded or released twice |
| G-idem | L3 | 2 | Same key twice, run **one after the other** and **in parallel** (`Barrier(2)`) | One decision, one payment, reserved once. The parallel case fails until gap 6 is fixed; keep it in the suite marked `todo` rather than deleting it |
| G-release | L3 | 2 | After a reservation: judge deny, `JUDGE_ERROR`, human reject, human timeout (move the clock 10 min, then sweep), and trust < 20 | `reserved` back to 0 every time |
| J-parse | L1 | 3 | See L1 | — |
| S1–S7 | L3 | 2 | See above | — |
| Tenant daily | L3 | 2 | Parallel calls across two mandates of the same tenant at its daily cap, with a barrier | Never over the cap. Fails until gap 7 is fixed (`todo`) |

## Directory layout

```
packages/contracts/test/          schemas, reason-code tables            (2)
apps/gateway/test/
  harness/                        createHarness, TestClock, FakePayments,
                                  scripted model, Barrier, network lock   (2; scripted model built on 3's transport type)
  fixtures/                       canary attack fixtures (shared with eval/), test catalog
  unit/                           pre-contact, Tier 0 rules, clamp, trust (2)
  db/                             PaymentStore matrix, atomic statements  (2)
  catalog/                        canonicalize, matchEndpoint, loadCatalog (3)
  judge/                          buildInput, canary, output checks       (3)
  pipeline/                       S1–S7, G-idem, G-release                (2)
  attacks/                        one file per ID, e.g. a13-parallel-overspend.test.ts
e2e/                              multi-process runs (A1 live, A13 two processes, A19)
eval/                             Chunk 3's runner, not a CI gate
```

Tests use the real `catalog/catalog.json` wherever possible, so catalog edits that break attacks show up in CI. Unit tests that need unusual shapes use the small fixture catalog.

## CI

1. **Move the Node job to pnpm** to match the contracts: `pnpm/action-setup`, `pnpm-lock.yaml`, `pnpm install --frozen-lockfile`, and `pnpm run <script>` for the same five required scripts. Update `.github/workflows/README.md` to match. The alternative is for the team to switch the contracts to npm; either way, one has to change.
2. **On every pull request:** `pnpm test` runs L1 through L3. Target: under 60 s. Make it a required check, along with the Python job until that's retired.
3. **On push to `main` and by hand:** an `e2e` job starts the gateway, merchants and attacker server with `PAYMENTS_MODE=mock` and `JUDGE_MODE=stub-escalate`, then runs `e2e/`.
4. **Evaluation:** `workflow_dispatch` only, using an `ANTHROPIC_API_KEY` repository secret. It uploads `eval/REPORT.md` as an artifact. Never a merge gate.

## Retiring the Python suite

Keep `tests/` running until its replacements pass, then delete `tests/gateway_mocks.py`, `tests/test_gateway.py` and `tests/fixtures/payment_matrix.json`, along with the Python CI job if nothing else uses it.

| Python test | Replaced by |
|---|---|
| `Tier0_hard_denial_never_calls_judge` | A4 and A6, which assert the model is not called |
| `judge_errors_fail_closed` | S4 |
| `judge_cannot_loosen_restricted_grant` | S3 and the clamp table. The payee, method, endpoint and subject cases can't happen under the contracts, because the judge can't name those fields |
| `reservation_exists_at_signature_boundary` | Pipeline: `FakePayments.pay` asserts the payment row is `RESERVED` and the mandate's `reserved` covers the amount at call time |
| `ambiguous_payment_stays_locked_until_reconciled` | A18 and the `PaymentStore` matrix |
| `ten_parallel_payments_reserve_exactly_four` | A13 |
| `Canary_untrusted_text_never_reaches_exact_judge_payload` | A10 (L1) and S2 |
| `Canary_Matrix_*` (40 cases) | Chunk 3's evaluation cases, which use the contract's reason codes and add real labels |

## Build order

| When | What | Unblocks |
|---|---|---|
| Fri night | Harness skeleton (`createApp` factory, `TestClock`, `FakePayments`, network lock); contracts tests; CI moved to pnpm | Every later test |
| Fri night | `PaymentStore` matrix and reservation tests at L2 | The Sat 10 AM handoff to Chunk 1 |
| Sat morning | **Written before the code:** A1, A4, A6, A7, A8, A11, A16, G-idem; use the stub `matchEndpoint` and stub judge until the real ones land | Gateway milestone at Sat 10 AM |
| Sat midday | Real `matchEndpoint` and the scripted model transport; S1–S7, A5, A9, A12, G-release; A14 and A17 at L3 | Integration checkpoint with Chunk 3 |
| Sat evening | `e2e/` with Chunk 1's merchants; retire the Python suite | Demo run |

## Decisions needed from the team

- Adopt the `transport` option on `createJudge` (boundary doc, gap 4). The L3 boundary tests depend on it.
- pnpm or npm: the CI and the contracts must agree.
- Gaps 6, 7, 10 and 11 in the boundary doc. Their tests are written either way, but the expected results depend on the answers.
