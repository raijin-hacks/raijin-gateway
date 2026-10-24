# Chunk 2 build plan: gateway core

Oct 23, 2026 · Status: phases 0–3 done; phases 4–7 superseded by `CHUNK-2-FINISH-PLAN.md`

This is the order and shape for coding Chunk 2. **What** to build is in `CHUNK-2-GATEWAY.md` (tasks G1–G10) and `final_contracts.md`. This doc adds how the code is laid out, the order to build it in, and the decisions to lock first. Related: `CHUNK-2-3-BOUNDARY.md` (gaps 1–14) and `TEST-HARNESS-PLAN.md`.

## Done means

- Every Chunk 2 test passes in CI: A1, A4–A9, A11–A13, A16, G-idem, G-release, plus S1–S7 and the L2 database tests from the harness plan.
- The four integration checkpoints in `CHUNK-2-GATEWAY.md` are met on time.
- The demo script runs end to end on `PAYMENTS_MODE=real` and `JUDGE_MODE=real`.
- No empty `catch` blocks; no read-then-write on money; no mandate token in any log.

## Decisions to lock first

Most of these change the contracts, so they go through `final_contracts.md` section 6. To avoid blocking, **build with the default** unless the team objects by Sat 9 AM.

| # | Decision | Default we build with | Contract change |
|---|---|---|---|
| D1 | Package manager | pnpm, as the contracts say; update CI to match | CI only |
| D2 | Idempotency race (boundary gap 6) | Claim the key at step 2 by inserting a `pending` decision row; later steps update it | No |
| D3 | Creating and releasing reservations | In one transaction at the end of Tier 0: the reserve statement plus inserting a `RESERVED` payment row. Every later denial releases through `PaymentStore.fail()`, which moves the money back exactly once | No |
| D4 | Where held state lives | Add `decisions.request_json` (expected price and purpose, so a pre-contact hold can resume). Add `payments.quote_json` (the quote, needed for retries and resuming after a human approves). Add `payments.response_json` (the merchant's response, needed for idempotent replays and `GET /decisions/:id`) | Yes, schema |
| D5 | `TENANT_DAILY` (gap 7) | A `tenant_daily(tenant_id, day, amount)` row, updated conditionally in the same transaction as the reservation; settle leaves it alone; `fail()` lowers it | Yes, schema |
| D6 | Standing-grant usage (gap 8) | `standing_grant_usage(standing_grant_id, day, used_total)` with a conditional update | Yes, schema |
| D7 | Resuming after a Tier 0 escalation (gap 9) | After a human approves: fetch the quote again; deny unless payee and amount are unchanged; re-run Tier 0 skipping only the approved rule; reserve | No |
| D8 | Quarantined sessions (gap 10) | Deny `QUARANTINED` right after the step 2 claim (so the denial has a decision row) when the session is `quarantined`, before any URL work | No |
| D9 | What `VELOCITY` and `DUPLICATE` count (gap 11) | Decisions in this session that reached Tier 0, whatever their outcome | No |
| D10 | An unexpected error after the reservation | Release the reservation and deny with a new code, `INTERNAL_ERROR`, at the stage where the error happened | Yes, reason code |
| D11 | `DENYLIST` storage | There's no table for it. Use a `DENYLIST_HOSTS` environment variable, empty by default | Env only |
| D12 | `NEW_PAYEE_LIMIT` | Escalate when this payee is new to the mandate and 3 first-time payees have already been approved by the judge (so the 4th escalates) | No |
| D13 | Logging rejected URLs | For `SECRET_IN_URL` and `QUERY_TOO_LONG`, store `canonical_url` with query values replaced by `***` | No |
| D14 | Response body after `UNKNOWN` | A payment that settles later through the reconciler has lost the merchant's response. `GET /decisions/:id` returns `approved` with `response: null`. Needs the response field to allow null | Yes, type |

## Code layout

```
apps/gateway/
  src/
    main.ts                 reads config, wires the real pieces, starts the server, reconciler and timeout sweep
    app.ts                  createApp(deps): the Hono app, with no globals
    deps.ts                 the Deps interface
    config.ts               environment variables checked with zod; fails fast
    clock.ts                the only place allowed to read the system time
    ids.ts                  prefix + ULID helpers
    log.ts                  logger that redacts Bearer tokens and token-shaped strings
    bus.ts                  in-process event bus for StreamEvent
    auth.ts                 admin and mandate middleware; token hashing; constant-time compare
    routes/                 mandates, pay, decisions, payments, approvals, stream, catalog, health
    pipeline/
      index.ts              runPay: steps 1–11 in order; the only place the order is written
      outcome.ts            Outcome types and finish(): update decision, trust, events, response
      idempotency.ts        claim the key, or replay an existing decision
      precontact.ts         pre-contact rules (G5)
      secrets.ts            SECRET_IN_URL detector
      tier0.ts              Tier 0 rules plus the reserve transaction (G6)
      hold.ts               withHold(): any non-approved exit or throw releases the reservation
      trust.ts              routing thresholds and score updates (G7)
      grants.ts             lookup, atomic use, clamp, create, reference price (G8)
      judge-step.ts         build JudgeContext, call buildInput and judge, map the result (G9)
      human.ts              escalate, approve or reject, timeout sweep, resume (G9)
      settle.ts             call pay(), retry unresolved payments, map pay() results
    db/
      schema.ts             Drizzle schema = contracts section 1 + D4–D6 + indexes
      client.ts             opens SQLite: WAL, busy_timeout = 5000, foreign_keys = ON
      statements.ts         the four atomic statements, copied verbatim
      payment-store.ts      the PaymentStore that Chunk 1 uses
      repos/                mandates, sessions, decisions, grants, payments, trust, reference prices
      seed.ts               tenant, roles, agents, catalog
    stubs/                  catalog-stub.ts, until Chunk 3's code lands
    catalog/                Chunk 3
    judge/                  Chunk 3
    payments/               Chunk 1
  test/                     see TEST-HARNESS-PLAN.md
packages/contracts/src/     types.ts, schemas.ts, reasons.ts, constants.ts, index.ts
```

Indexes the Tier 0 queries need:
- `decisions(session_id, created_at)` for `VELOCITY`
- `decisions(session_id, canonical_url, price, created_at)` for `DUPLICATE`
- `decisions(mandate_id, stage, outcome)` for `NEW_PAYEE_LIMIT`
- `grants(mandate_id, endpoint_id)`

## Core shapes

### Dependencies are passed in, never imported as globals

```ts
export interface Deps {
  db: Db;
  clock: Clock;
  config: Config;
  catalog: Catalog;
  catalogFns: { canonicalize: typeof canonicalize; matchEndpoint: typeof matchEndpoint };
  payments: PaymentsModule;   // Chunk 1, or createMockPayments
  judge: JudgeModule;         // Chunk 3, or createStubJudge
  bus: EventBus;
  log: Logger;
}
```

`main.ts` chooses the real pieces or the mocks from `PAYMENTS_MODE` and `JUDGE_MODE`. Tests pass in fakes. This is what lets the harness run the whole pipeline in-process.

### The pipeline is one readable function

```ts
export async function runPay(deps: Deps, agent: AgentAuth, req: PayRequest): Promise<PayResponse> {
  // 1. Authentication happened in middleware: agent.mandate and agent.session are loaded and active.
  const claim = claimDecision(deps, agent, req);                       // 2
  if (claim.kind === 'existing') return replay(deps, claim.decision);

  const d = claim.decision;
  const pre = checkPrecontact(deps, agent, req);                       // 3–4
  if (pre.kind !== 'continue') return finish(deps, d, pre);

  const quote = await fetchQuote(deps, pre.canonical, req.method);     // 5: first network call
  if (quote.kind !== 'continue') return finish(deps, d, quote);

  const t0 = runTier0(deps, agent, d, req, pre, quote.quote);          // 6: ends by reserving
  if (t0.kind !== 'reserved') return finish(deps, d, t0);

  return withHold(deps, d, t0.hold, async () => {                      // 7–11
    const routed = routeByTrust(agent.session);                        // 7
    if (routed.kind !== 'continue') return routed;
    if (!routed.skipGrants) {
      const hit = useGrant(deps, agent, pre.match, t0.hold);           // 8
      if (hit.kind === 'approved') return hit;
    }
    return askJudge(deps, agent, req, pre.match, t0.hold);             // 9 (10 happens on escalation)
  });
}
```

Rules that keep it correct:
- **Every exit goes through `finish()`.** It updates the decision row, writes the trust event, publishes stream events and builds the response. Nothing else writes decisions.
- **`withHold()` owns the reservation.** If the result is `approved`, it calls `pay()` (step 11). If `pending`, the reservation stays held. If `denied`, or anything throws, it calls `PaymentStore.fail()` and finishes with the denial (D10). This removes the "forgot to release on one branch" bug.
- **Nothing before step 5 calls the network.** Lint rules ban the `fetch` global and payments imports in `precontact.ts`, `secrets.ts` and `idempotency.ts`.

### How a decision row changes

```
claim:     stage 'precontact', outcome 'pending', reasons []
   ├─ a stage denies     → stage X, 'denied', reasons [...]               (final)
   ├─ a stage escalates  → stage X, 'pending', reasons [...]              (waits for a human)
   │      └─ approve / reject / timeout → 'approved' or 'denied' at stage 'human'
   └─ approved           → stage X, 'approved' → payment SETTLED / UNKNOWN
```

The claim row is a valid state: `pending` at `precontact`. If the process crashes before a stage decides, the timeout sweep turns it into `HUMAN_TIMEOUT` after 10 minutes. The sweep only releases a payment that is still `RESERVED`; anything signed or later belongs to Chunk 1's reconciler.

## Build phases

Each phase lists what to build, which tests to write first, and when it's done. The design doc says it plainly: an agent that writes both the code and its tests will make them agree. **Write the tests first.**

### Phase 0 · Scaffold (Fri night, about 1 hour)

- pnpm workspace with `packages/contracts` and `apps/gateway`. Shared `tsconfig`, ESLint (`no-empty`, banned `Date.now`, banned imports), Prettier, Vitest.
- Root scripts CI requires: `lint`, `format:check`, `typecheck`, `test`, `build`.
- Update `.github/workflows/ci.yml` and its README for pnpm (D1).
- Install Hono, `@hono/node-server`, `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `zod`, `ulid`, `vitest`. Pin exact versions (`pnpm add -E`).
- Untrack `.env` and add it to `.gitignore`.

**Done when** CI is green on an empty test, with Node checks running.

### Phase 1 · G1 contracts package (Fri night, right after Phase 0)

- `types.ts`: section 5 copied exactly.
- `schemas.ts`: zod for `PayRequest`, `JudgeOutput`, `Catalog` and the admin request bodies.
- `reasons.ts`: `REASON_STAGE` and `REASON_ACTION`, typed `Record<ReasonCode, …>` so a missing code fails the typecheck.
- `constants.ts`: `NETWORK`, trust thresholds (20, 40, 60), trust deltas, pre-contact limits (query 256, segment 24, entropy 3.5, secret length 24).
- Tests first: the contracts tests in the harness plan, including the six escalating codes.

**Done when** it's published to the workspace and announced. Everyone codes against it from here.

### Phase 2 · G2 database and PaymentStore (Fri night; hard deadline Sat 10 AM)

- `schema.ts` with every `CHECK`, plus D4–D6 and the indexes. Generate migrations with drizzle-kit.
- `statements.ts`: the four atomic statements verbatim, run through prepared statements.
- `payment-store.ts`: every method a conditional update. `settle` and `fail` each run in one transaction that also updates `tenant_daily`.
- `seed.ts`: tenant, roles `research` (cap 1,000,000; 20/min; baseline 70; grant threshold 60) and `bulk`, three agents, and the catalog. Until Chunk 3's `loadCatalog` lands, use `Catalog.parse(JSON)`.
- Tests first: the `PaymentStore` transition matrix, reservation refusals, the `CHECK` constraint, grant use.

**Done when** Chunk 1's `PaymentStore` test suite passes against it. Hand off by **Sat 10 AM**.

### Phase 3 · App, auth, mandates, stream skeleton (Fri night)

- `createApp(deps)`, `clock.ts`, `ids.ts`, `log.ts` (redaction), `bus.ts`, `config.ts`.
- Authentication:
  - **Admin routes:** no Bearer token is 401; any Bearer that isn't `ADMIN_TOKEN` is 403 (A11). Compare SHA-256 hashes with `timingSafeEqual`.
  - **Agent routes:** hash the token and look up the mandate and session. Missing, closed or expired is 401. (The quarantine check is in the pipeline, D8.)
- G3 routes:
  - `POST /mandates`: check merchants against the catalog; normalize subjects; 32-byte base64url token; store only its hash; create a session at the agent's trust; return the token once.
  - `POST /mandates/:id/close`: revoke and delete the mandate's grants.
  - `GET /catalog`.
- G10 early: `GET /stream` (SSE from the bus, admin only, heartbeat every 15 s) and `GET /health`. Ship it on Fri night so Chunk 4 can check event shapes against it.
- Tests first: A11; mandate validation; S7 (no token in logs).

**Done when** the dashboard can create a mandate and connect to `/stream`.

### Phase 4 · `/pay` through Tier 0 (Sat morning; milestone Sat 10 AM)

Uses `createMockPayments` and `stub-escalate`. Tests use the harness's scripted catalog functions, so this doesn't wait on Chunk 3.

- `idempotency.ts`: claim with `INSERT … ON CONFLICT DO NOTHING`; on conflict, replay the existing decision. If its payment is unresolved, retry `pay()` with the same ID and the stored quote.
- `precontact.ts` and `secrets.ts`: G5 in the order listed. Escalations are stored as `pending` with no quote fetched.
- `fetchQuote`: `QuoteError` becomes a denial with its code.
- `tier0.ts`: G6 in the exact order, then the reserve transaction (D3, D5).
- `withHold`, `finish`, `replay`; `GET /decisions/:id` and `GET /payments/:id` with ownership checks.
- At first, `withHold` approves straight away so the reservation and `pay()` paths can be tested before Tier 1 and the judge exist.
- Tests first: A1, A4, A6, A7, A8, A13, A16, G-idem (both versions), and the network lock. Design A7 and A13 as the harness plan describes, so earlier rules stay quiet.

**Done when** those tests pass. That covers the Sat 10 AM milestone except A11, which Phase 3 already covers.

### Phase 5 · Trust, grants, judge, human queue (Sat midday)

- `trust.ts` (G7): routing; deltas from the design table; agent score never above the role baseline. An injection flag quarantines the session.
- `grants.ts` (G8):
  - Exact match, then the atomic grant use. Zero rows changed is `GRANT_EXHAUSTED`.
  - Standing grants only for merchants selected for this mandate, with D6 usage.
  - Clamp, then create the grant.
  - Set the reference price on the first approval for a payee and endpoint.
  - Renewal: an exhausted grant goes to the judge once.
- `judge-step.ts` (G9): build `JudgeContext` from the contract's fields only, then `buildInput`, then `judge`. Any throw is `JUDGE_ERROR`; a thrown `JUDGE_INVALID_OUTPUT` keeps that code.
- `human.ts` (G9):
  - `POST /approvals/:decision_id` records the approval and resumes. A pre-contact hold resumes at step 5; a Tier 0 hold follows D7; a post-reservation hold goes to `pay()`.
  - `issue_grant` creates a human grant with the same clamps.
  - A timeout sweep every 30 s.
- Tests first: A5, A9, A12, G-release (all 5 paths), S1–S6.
- If behind at Sat 9 AM: hand G8 (grants) to Chunk 1, as `CHUNK-2-GATEWAY.md` allows.

**Done when** the above pass with `stub-approve` and `stub-escalate`, and A14 and A17 reach the judge at L3.

### Phase 6 · Integration (Sat midday to evening)

| When | With | Do |
|---|---|---|
| Sat midday | Chunk 3 | Replace `stubs/` with the real `canonicalize`, `matchEndpoint`, `loadCatalog`. Switch to `JUDGE_MODE=real`. Run S2 (end-to-end canary) on the real `buildInput`. Watch A2, A3, A14 and A17 flow through |
| Sat evening | Chunk 1 | Switch to `PAYMENTS_MODE=real`. Run `startReconciler` at startup. Run A18 and A19 together |
| Sat evening | Chunk 4 | Dashboard on the real `/stream`. Approval queue calls `POST /approvals` |
| Sat evening | Everyone | `e2e/` job green; demo script dry run |

### Phase 7 · Hardening (Sat evening, before the code freeze)

- Read every line of the critical paths by hand: `auth.ts`, `idempotency.ts`, `precontact.ts`, `tier0.ts`, `hold.ts`, `grants.ts`, `judge-step.ts`, `payment-store.ts`. Chunk 1 cross-reviews reservation and pre-contact order.
- Grep for `catch` blocks, `Date.now`, `console.log` and raw SQL outside `db/`.
- Support Chunk 1's load test: 100,000 requests through pre-contact, Tier 0 and Tier 1 with mock payments. Report median latency.

## Prompts for coding agents

One phase per agent session. Paste in:
1. The phase section above, plus the related G task from `CHUNK-2-GATEWAY.md`.
2. The contract sections it touches: section 1 for Phase 2; section 2 for Phases 3–5; section 4 for Phase 5; section 5 always.
3. The 14 invariants from `Design.md` section 3, and the hard rules from `CHUNK-2-GATEWAY.md`.
4. The tests for that phase, already written and failing.
5. The traps, by name: the reservation is one conditional `UPDATE`; no network before step 5; every non-approved exit after reserving releases; no empty `catch`; never log a token; never put text that isn't in the contract into `JudgeContext`.

## If behind

Cut in this order. Never cut pre-contact checks, Tier 0, the atomic reservation, idempotency, or release on denial.

1. A two-process A13 run (the in-process version stays)
2. `DENYLIST` (D11)
3. Agent-level trust (keep session trust)
4. Standing-grant usage counter (D6): cap standing grants by per-call max only
5. Grants (G8): hand to Chunk 1

## Risks

| Risk | Mitigation |
|---|---|
| The schema changes in D4–D6 and D10 get argued about mid-build | Build with the defaults now; each is a small migration if the team decides differently |
| Chunk 3's `matchEndpoint` is late, blocking A16 | Phase 4 tests use scripted catalog functions; the real matcher only has to pass the same tests at Sat midday |
| The x402 quote expires while a human decides | D7 and the resume path fetch a fresh quote and check that nothing changed |
| A single-threaded test hides a race | Barrier rule from the harness plan; optional two-process A13 |
| Phases 4 and 5 overrun into Sat afternoon | Grants go to Chunk 1 at Sat 9 AM if Phase 4 isn't green |
