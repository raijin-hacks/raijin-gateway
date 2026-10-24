# Chunk 3 phase 6: mixed gateway integration and failure behavior

## Implemented scope and remaining transport boundary

This mixed Chunk 2/3 change implements the previously missing `/pay` orchestration,
review continuation and polling, using the real Chunk 3 catalog, builder and judge
interfaces and the SQLite payment store. Mock mode exercises the whole lifecycle
without merchant sockets. Startup wires Chunk 1's real module and reconciler;
**new real quote/payment calls are deliberately disabled pending J2b**. They fail
closed with `QUOTE_FAILED` before any live merchant contact or signature. There
is no opt-in flag or localhost shortcut around this block. Existing real submitted
payments can still reconcile. Production readiness, live payment acceptance and
live judge accuracy are not claimed.

## Pipeline and durable ownership

`apps/gateway/src/pipeline/index.ts` is the fixed-order orchestrator:

1. Agent middleware authenticates the raw scoped token. Missing/closed/expired
   credentials fail before body parsing or merchant contact.
2. Require matching UUIDv4 header/body keys (case normalized). SQLite claims the
   mandate/key in an IMMEDIATE transaction before external work, persisting both
   the decision and workflow. The HMAC-SHA-256 binding covers a version tag,
   tenant, agent, mandate, method, complete canonical URL/values, expected price
   and purpose. Strict request validation admits no other purchase/body fields.
   A dedicated random server secret is durably stored in `gateway_secrets`, never
   derived from wallet/admin/mandate credentials and never sent to the judge.
3. Use the catalog-bound `createCanonicalizer` and phase 6 admission callback,
   then pre-contact checks. Startup and the pipeline verify the same immutable
   catalog identity. Every unknown origin/route/method escalates before quote,
   grant lookup, input building or signing, including unknowns without parameters.
4. Run mandate/session, denylist, decoded secret, raw-query, parameter and subject
   policy. Only the specifically reviewed parameter/subject escalation can be
   skipped on continuation; secrets and every hard gate still apply.
5. Fetch and validate the quote. Tier 0 checks network, payee, role cap, immutable
   first-price anchor, expected-price tolerance, tenant exposure, velocity,
   duplicates and new payees in order. Reservation and payment creation are atomic
   and last. Outstanding prior-day holds remain exposed against today's cap.
6. Route trust (<20 quarantine denial; 20–39 human; 40–59 judge only; >=60 grants,
   also subject to the role threshold). Reusable grants bind mandate, payee,
   origin, method, endpoint, subject membership and exact options. Standing grants
   require merchant selection and atomic daily consumption.
7. Build only the shared JudgeContext; the phase 5 builder remains the sole
   projection into the provider. Typed failures retain their codes; builder and
   unexpected errors deny without fallback. Injection overrides every decision,
   discards grants, and durably quarantines immediately. A five-second deadline
   discards late completion. No token, digest, trust or merchant response is added
   to model input.
8. Clamp grant proposals to role cap, 2x original reference, 2x quote, remaining
   budget and mandate lifetime. Reference prices use INSERT OR IGNORE and never
   ratchet. Recheck current mandate/session, role cap and reference before commit.
9. Commit approval before `pay(paymentId, checkedQuote)`. The durable signing
   transition additionally rejects revoked/expired/quarantined authority. Only
   the owning workflow calls payment, once. Payment store state is authoritative;
   a returned success cannot move money without its conditional ledger transition.

Same-key retries immediately replay the existing handle/result; conflicting
bindings return 409 without new work. No cache eviction or lease expiry creates a
new operation. SQLite claims/CAS remain authoritative across worker objects and
connections. Processing/review claims time out into terminal denials, never fresh
work. Restart recovery releases an authorized but still unsigned crash hold;
SIGNED/SUBMITTED/UNKNOWN remain reserved and go to Chunk 1's reconciler. Settlement
replay derives from the original ledger even if the response/cache write was lost;
no retry signs a new authorization.

Grant renewal is serialized per scope for the supported single-process host,
including multiple pipeline objects sharing its Db. This limits judge storms but
is not a multi-host distributed renewal service. Durable per-purchase claims and
atomic money totals do not depend on that in-memory queue.

## Human continuation and failure accounting

Review stores the held request, catalog content revision, quote, approved reasons,
owner and deadline durably. Exactly one pending-to-processing transition wins a
review/timeout race. A winning approval receives a separate execution deadline,
so crossing the original review deadline cannot undo it. Each new escalation gets
its own review window; immutable `pay_review_events` preserves multi-stage history
while the contracted unique `approvals` row retains the first review summary.

Continuation rematches the pinned catalog and repeats pre-contact policy. A changed
catalog revision invalidates held authority; a fresh request must be reviewed under
the new snapshot. Unknown admission can never be approved into contact. Reviewed
pre-contact work resumes at quote/Tier 0; reviewed Tier 0 work repeats hard checks
and reservation; reviewed judge/trust work resumes toward payment after fresh quote
comparison and current hard checks. A refreshed quote must preserve payee, network
and amount. Human approval of unusual subjects/parameters cannot issue reusable
grants outside the mandate.

Rejection, timeout, close/expiry, judge failure and unexpected pre-sign errors
release only a conditionally RESERVED payment, in the same transaction as money
accounting. Replays/late workers cannot release twice. No gateway error handler
releases SIGNED/SUBMITTED/UNKNOWN. Trust deltas are recorded once per decision;
provider/internal failures do not penalize trust. Committed transitions publish the
contracted SSE events; the reconciler's payment store also publishes state changes.

## Explicit contract amendments for Chunk 2 owner review

The mixed PR updates `design-docs/final_contracts.md` and shared exports to v1.2:

- `UNCATALOGED_ENDPOINT`: accurate pre-contact escalation for shape-free unknown
  routes; not silently mislabeled `UNKNOWN_WITH_PARAMS`.
- `INTERNAL_ERROR`: fail-closed internal denial, without attributing infrastructure
  failures to agent behavior.
- `approved.response` may be null when reconciliation proves settlement but the
  merchant response was lost. Chunk 1's successful `pay()` response stays non-null.
- Matching UUIDv4 `Idempotency-Key` header and existing body key are required;
  conflicts are 409 and in-progress replays return 202 with the existing handle.
- The context comment now explicitly identifies raw match values as untrusted.

These changes are explicit; no external team sign-off is claimed. The existing
reason-table/type/version tests are updated alongside the source-of-truth doc.

## Every Chunk 2-owned file touched (including files from the staged phase 6 work)

Application and composition:
- `apps/gateway/src/app.ts`
- `apps/gateway/src/deps.ts`
- `apps/gateway/src/config.ts`
- `apps/gateway/src/main.ts`
- `apps/gateway/src/routes/mandates.ts`
- `apps/gateway/src/routes/pay.ts` (new pay, polling and approval handlers)
- `apps/gateway/src/mock-payments.ts`
- `apps/gateway/src/payment-events.ts`

Pipeline:
- `apps/gateway/src/pipeline/index.ts`
- `apps/gateway/src/pipeline/idempotency.ts`
- `apps/gateway/src/pipeline/precontact.ts`
- `apps/gateway/src/pipeline/secrets.ts`
- `apps/gateway/src/pipeline/policy.ts`
- `apps/gateway/src/pipeline/renewal.ts`

Database and generated migrations:
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/src/db/statements.ts`
- `apps/gateway/src/db/payment-store.ts`
- `apps/gateway/drizzle/0001_silent_machine_man.sql`
- `apps/gateway/drizzle/0002_ambitious_silvermane.sql`
- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/drizzle/meta/0001_snapshot.json`
- `apps/gateway/drizzle/meta/0002_snapshot.json`

Gateway tests:
- `apps/gateway/test/http/pay.test.ts`
- `apps/gateway/test/payment-events.test.ts`
- `apps/gateway/test/db/funds.test.ts`
- `apps/gateway/test/db/schema.test.ts`
- `apps/gateway/test/scaffold.test.ts`

Shared contracts (also Chunk 2-owned):
- `packages/contracts/src/types.ts`
- `packages/contracts/src/schemas.ts`
- `packages/contracts/src/reasons.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/compatibility.test.ts`
- `packages/contracts/test/reasons.test.ts`
- `design-docs/final_contracts.md`

No Chunk 1 payment source files were edited. Pre-network pipeline files contain no
fetch calls or payment imports; root ESLint enforces that boundary.

## Chunk 3 files and evaluation

The staged `judge/gateway.ts`, its tests and index exports are retained, with
catalog identity exposed for composition verification. `eval/api/client.ts` sends
only the once-issued raw mandate token in bearer headers, uses fixed same-origin
pay/decision/payment paths, disables redirects, validates wire responses, redacts
errors and never automatically retries with a new key. Its client tests and
`eval/api/gateway.test.ts` exercise the actual in-process authenticated API.
The phase 5 canary suite still runs; pipeline capture tests also inspect the actual
real-adapter request after human review of an unusual parameter.

## Remaining handoff

1. J2b: implement reviewed DNS/IP classification, all-answer checks, pinned
   connections, peer verification, TLS hostname preservation and redirect/proxy
   rejection for both quote and paid contact. Carry phase 4's exact operator-bound
   loopback exception through that transport. Only then remove the startup block
   on new real merchant work. Do not substitute ordinary hostname fetch.
2. Phase 7: run frozen/held-out API evaluation, live judge accuracy and latency,
   and external merchant/restart acceptance outside the TCP-restricted sandbox.
   These integration tests are security behavior measurements, not model accuracy.
3. Owner review: v1.2 amendments, server HMAC-key storage/backup policy, first-row
   approvals summary versus append-only review history, and deployment policy for
   single-process renewal coordination. Durable keys/workflows must not be pruned
   into reusable identities; back up the SQLite DB and its dedicated HMAC secret
   together. Multi-host deployment needs a separate renewal/load review.
4. Chunk 1 cross-review: the tightened signing guard and fail-only-unsigned gateway
   cleanup. Reconciler shutdown retains Chunk 1's existing non-awaiting stop API;
   operational shutdown/recovery should be exercised with live chain fixtures.

## Verification

Results are recorded after the final verification loop below. TCP listening tests
are sandbox-blocked (`listen EPERM` on 127.0.0.1); they are not application failures.
No commit or branch switch is part of this work.

Final verification:
- `pnpm lint`: pass (existing Next pages-directory warning only).
- `pnpm format:check`: pass.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- `pnpm test`: attempted exactly; interrupted after the sandbox TCP stall. A
  separately bounded quote test confirms `listen EPERM` on `127.0.0.1`.
- Executable remainder: **1,281 passed, one skipped, three TODOs**, 42 passing
  files and one skipped file, using:
  `pnpm exec vitest run --exclude '**/payments/*.test.ts' -t '^(?!.*seeds the database, serves requests).*$'`.
  This includes **71 HTTP/SQLite pipeline tests**, payment-event/reconciler tests,
  the evaluation client against the actual API, and all phase 5 canaries.
- Explicit root-config ESLint and Prettier checks for otherwise ignored Chunk 3
  files pass; `git diff --check` passes. Remaining TODOs are J2b, phase 7 measured
  evaluation and the later demo client; completed gateway/idempotency inventory
  entries were removed from `eval/chunk3-design.test.ts`.
- Branch remains `chunk3/phase5`. Prior staged work is retained; no commit or
  branch switch was performed.
