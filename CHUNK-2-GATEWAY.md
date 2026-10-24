# Chunk 2 · Gateway core

**Size:** large, the largest. **Security-critical:** yes, the most.
**Read first:** all of `contracts.md`. You also own `packages/contracts`, so you are the contracts gatekeeper.

## Your job in one sentence

Build the gateway that every request passes through, in the exact order the contracts define, so that no rule can be skipped and no budget can be overspent.

## You own

| Path | What |
|---|---|
| `packages/contracts/` | Types and zod schemas from `contracts.md` section 5, reason-code tables, constants |
| `apps/gateway/` | Everything **except** `src/payments/` (Chunk 1) and `src/judge/` (Chunk 3) |
| `apps/gateway/src/db/` | Drizzle schema, migrations, seed, repositories, `PaymentStore` implementation |

## Shared facts (identical in all four chunk files)

| Item | Value |
|---|---|
| Gateway | `http://localhost:4000` |
| Dashboard | `http://localhost:3000` |
| PriceScope merchant | `http://localhost:4101` |
| SkyData merchant | `http://localhost:4102` |
| NewsWire merchant | `http://localhost:4103` |
| Attacker server (pages + malicious endpoints) | `http://localhost:4199` |
| Network | `eip155:84532` (Base Sepolia) |
| Facilitator | `https://x402.org/facilitator` (testnet) |
| Money | Integer atomic USDC (1 USDC = 1,000,000) |
| Feature flags | `PAYMENTS_MODE=real\|mock`, `JUDGE_MODE=real\|stub-escalate\|stub-approve` |

Environment variables (`.env`, never committed): `ADMIN_TOKEN`, `DATABASE_PATH`, `WALLET_PRIVATE_KEY` (testnet only), `FACILITATOR_URL`, `BASE_SEPOLIA_RPC_URL`, `USDC_ADDRESS`, `ANTHROPIC_API_KEY`, `JUDGE_MODEL`, `MERCHANT_KEYS_JSON`, `PAYMENTS_MODE`, `JUDGE_MODE`.

## Interfaces

### You provide

| To | What |
|---|---|
| Everyone | `packages/contracts`: all shared types and zod schemas |
| Chunk 1 | `PaymentStore` implementation (atomic SQL from `contracts.md` section 1) |
| Chunk 3 | `JudgeContext` objects passed to `buildInput` (type in `contracts.md` section 5) |
| Chunk 3, Chunk 4 | The HTTP API in `contracts.md` section 2, plus `GET /catalog` |
| Chunk 4 | `/stream` server-sent events |

### You consume

| From | What | Until it's ready, use |
|---|---|---|
| Chunk 1 | `PaymentsModule`, `startReconciler` | `createMockPayments` (Chunk 1 ships it first) or your own stub |
| Chunk 3 | `canonicalize`, `matchEndpoint`, `loadCatalog` | A stub that treats every URL as unknown with no params |
| Chunk 3 | `JudgeModule` | `JUDGE_MODE=stub-escalate` (always escalate) and `stub-approve` |

## Tasks, in order

### G1 · Contracts package (Fri, right after the team meeting)
- TypeScript types exactly as `contracts.md` section 5; zod schemas for `PayRequest`, `JudgeOutput`, `Catalog`, admin request bodies.
- `REASON_STAGE` and `REASON_ACTION` maps (`deny` or `escalate`) for every reason code.
- Constants: `NETWORK`, trust thresholds (quarantine 20, human 40, grants 60), trust deltas from the design doc, pre-contact limits.
- Publish it to the workspace before anyone else writes code against it.

### G2 · Database (Fri night)
- Drizzle schema matching `contracts.md` section 1, including every `CHECK`. WAL mode, `busy_timeout = 5000`.
- Seed script: tenant, roles `research` (per-call cap 1,000,000; velocity 20/min; baseline 70) and `bulk`, three demo agents, catalog loaded through Chunk 3's `loadCatalog`.
- Repositories. The four atomic statements in section 1 are written **exactly** as given.
- `PaymentStore` with every transition conditional on the current state. Hand it to Chunk 1 by Sat 10 AM with its test suite passing.

### G3 · Auth and mandates (Fri night)
- Admin routes check `ADMIN_TOKEN`. A mandate token on an admin route returns 403 (A11).
- `POST /mandates`: validate `allowed_merchant_ids` against the catalog, normalize subjects (trim, lowercase, dedupe), generate a token (32 random bytes, base64url), store only its SHA-256, create a session at the agent's trust. Return the token once.
- `POST /mandates/:id/close` revokes the token and deletes the mandate's judge grants.
- `GET /catalog` (admin) returns merchants and endpoints for the dashboard form.

### G4 · The `/pay` pipeline (Sat morning)
Implement `contracts.md` section 2, "Pipeline order," as one function with one step per numbered stage. Rules:
- **No network call before pre-contact passes.** Chunk 1's `getQuote` is the first network call.
- The decision row is written as soon as a stage decides. Every response includes `decision_id`.
- Idempotency: `(mandate_id, idempotency_key)` is unique. A repeat returns the existing decision's current state; if a payment exists and is unresolved, retry `pay` with the same `paymentId`.
- After the reservation succeeds, **any** later denial or human rejection releases it.
- Publish a `StreamEvent` for every decision, payment state change, trust change and escalation.

### G5 · Pre-contact checks
Use Chunk 3's `matchEndpoint` result, then map to reason codes:

| Code | Rule |
|---|---|
| `SECRET_IN_URL` | Any of: `sk-`, `sk_live_`, `ghp_`, `xox[abp]-`, `AKIA[0-9A-Z]{16}`, `eyJ` (JWT), an email address, hex of 32+ chars, or a base64/base32-looking token of 24+ chars with Shannon entropy above 3.5 bits/char, anywhere in path or query |
| `QUERY_TOO_LONG` | Raw query over 256 chars |
| `PARAM_NOT_IN_SCHEMA`, `DUPLICATE_PARAM`, `BAD_URL` | From the match result's violations |
| `SUBJECT_NOT_IN_MANDATE` | A subject param whose normalized value isn't in the mandate's subjects |
| `UNKNOWN_WITH_PARAMS` | Unknown endpoint with any query param or any path segment over 24 chars |

Escalations at this stage hold the request with **no** quote fetched; if a human approves, continue from step 5.

### G6 · Tier 0 (Sat morning)
Rules in this order: `NETWORK`, `PAYEE_SWAP` (known endpoint whose stored reference payee differs), `PER_CALL_CAP`, `REFERENCE_PRICE` (above 2× reference: escalate), `PRICE_MISMATCH` (over 10% from `expected_price`), `TENANT_DAILY` (today's spent plus reserved across the tenant), `VELOCITY` (role limit, per session, sliding 60 s), `DUPLICATE` (same canonical URL and price 3 times in 10 s), `NEW_PAYEE_LIMIT` (more than 3 judge-approved first-time payees in this mandate: escalate), then the **atomic reservation** last (`MANDATE_BUDGET` on failure).

### G7 · Trust routing and scoring
- Before Tier 1: session score < 20 deny `QUARANTINED`; 20 to 39 send to human with `TRUST_REQUIRES_HUMAN`; 40 to 59 skip Tier 1.
- After every decision, write a `trust_events` row using the deltas in the design doc and update session and agent scores (agent never above role baseline).
- An injection flag from the judge quarantines the session immediately.

### G8 · Tier 1 grants (Sat midday)
- Match on mandate, payee, origin, method, endpoint, every subject value in the mandate's list, and option values equal to the grant's stored ones. Price ≤ `max_per_call`. Then the atomic grant-use update; zero rows is `GRANT_EXHAUSTED`.
- Standing grants: only if the endpoint's merchant is in the mandate's `allowed_merchants`; else log `MERCHANT_NOT_SELECTED` and continue to the judge.
- **Creating a grant from a judge approval is your job, including the clamping** in `contracts.md` section 4: `max_per_call` = min(judge value, role per-call cap, 2× reference price, 2× this price); `max_total` ≤ remaining budget; expiry ≤ mandate expiry. Payee, origin, method, endpoint and option values come from the request, never the judge.
- Set the reference price on the first approval for a `(tenant, payee, endpoint)`.
- Renewal: an exhausted grant sends the next call to the judge once; a new approval issues a new grant under the same reference cap.

### G9 · Judge call and human queue
- Build the `JudgeContext` (fields defined in `contracts.md` section 5) and call Chunk 3's `buildInput` then `judge`. Any throw is `JUDGE_ERROR`, which denies.
- Escalations create a `pending` decision and an `approval_needed` event. Auto-reject after 10 minutes with `HUMAN_TIMEOUT` and release the reservation.
- `POST /approvals/:decision_id`: record it; on approval continue to payment and, if `issue_grant`, create a human grant with the same clamps.

### G10 · Stream and health
- `/stream`: in-process event bus to SSE, admin token required, heartbeat every 15 s.
- `/health`.

## Your tests

| ID | Test |
|---|---|
| A1 | Unknown host with a 44-char query param: `UNKNOWN_WITH_PARAMS`, and the attacker server receives **zero** requests |
| A4 | 500 USDC quote: `PER_CALL_CAP` |
| A5 | After a grant at 10,000, a 900,000 quote: `REFERENCE_PRICE` escalation |
| A6 | Payee swap: `PAYEE_SWAP` |
| A7 | 40 × 50,000 on a 1,000,000 mandate: exactly 20 approved, then `MANDATE_BUDGET` |
| A8 | 50 identical calls: `DUPLICATE` and `VELOCITY` fire |
| A9 | A grant from mandate X never matches under mandate Y |
| A11 | Mandate token on `POST /mandates`: 403 |
| A12 | Ratchet 10,000, 20,000, 40,000: the third escalates |
| A13 | 10 parallel 500,000 payments on a 2,000,000 mandate: exactly 4 approved |
| A16 | Subject outside the mandate: `SUBJECT_NOT_IN_MANDATE`, no request sent |
| G-idem | Same idempotency key twice: one decision, one payment |
| G-release | A judge denial after reservation releases the reservation |

## Hard rules
- No read-then-write on budgets or grant totals. Use the given statements.
- No empty `catch` blocks. Errors on the payment path deny.
- Never pass raw URL text, agent text or merchant text into `JudgeContext` fields that `contracts.md` doesn't list.
- Never log mandate tokens.

## Integration checkpoints

| When | With | Check |
|---|---|---|
| Fri night | Everyone | Contracts package published; mock `/stream` event shapes agreed with Chunk 4 |
| Sat 10 AM | Chunk 1 | `PaymentStore` passes Chunk 1's test suite |
| Sat midday | Chunk 3 | Real `matchEndpoint` and `JUDGE_MODE=real` wired; A2, A3, A14, A17 flow through |
| Sat evening | Chunk 1, Chunk 4 | `PAYMENTS_MODE=real`; dashboard connected to the real stream |

## Cross-review
You review Chunk 1's payment lifecycle and Chunk 3's judge input builder. If you're behind on Saturday morning, Chunk 1 takes G8 (grants).
