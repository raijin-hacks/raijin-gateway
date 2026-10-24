# Chunk 2 finish plan

Oct 24, 2026 · Status: accepted, owner decisions O1–O8 at their defaults · Supersedes phases 4–7 of `CHUNK-2-BUILD-PLAN.md`

## Where things stand

Overnight, most of Chunk 2's remaining code was written, but not by us and not on `main`. Chunk 3's stack (`chunk3/phase6` and the branches on top of it) implements the `/pay` pipeline, human review, trust, grants and polling, with 46 `/pay` tests. What's missing is the Chunk 2 owner's review to land it, and fixes for what `critic.md` found in the gateway.

| Task | Status | Where |
|---|---|---|
| G1 contracts | Done; v1.2 amendments waiting for owner sign-off | `main` (#8); amendments in `chunk3/phase6` |
| G2 database, `PaymentStore` | Done; review and secret tables added | `main` (#8); migrations 0001–0002 in `chunk3/phase6` |
| G3 auth, mandates | Done | `main` (#8) |
| G4 `/pay` pipeline, idempotency | Done, unmerged | `chunk3/phase6` |
| G5 pre-contact | Done, unmerged (canonicalizer and matcher are on `main`, #15) | `chunk3/phase6` |
| G6 Tier 0 | Done, unmerged | `chunk3/phase6` |
| G7 trust | Done, unmerged; approval-time rechecks in a fix PR | `chunk3/phase6`, `fix/approve-time-rechecks` |
| G8 grants | Done, unmerged; **standing grants bypass the task check** | `chunk3/phase6` |
| G9 judge, human queue | Done, unmerged | `chunk3/phase6` |
| G10 stream, health | Done | `main` (#8); more events in `chunk3/phase6` |

Test IDs covered on the stack: A1, A4, A5/A12, A6, A7, A8, A9, A13, A16, G-idem, G-release, trust routing, injection quarantine, timeouts, restart recovery. A11 is on `main`. **S7 (no tokens in logs) only covers the routes from Phase 3**; nothing checks `/pay` or approvals.

Real payments: Chunk 1's `pay()` and reconciler are on `main` (#9, #10). New real quotes and payments are blocked at startup until J2b (pinned, classified outbound connections) is done. Hardening is in `fix/payments-hardening`.

## Decisions the Chunk 2 owner makes first

These block everything below. Each has a default; the work proceeds on the default unless you say otherwise.

| # | Decision | Default | Why |
|---|---|---|---|
| O1 | Accept `INTERNAL_ERROR` (v1.2) | Accept | Same as our proposal D10 |
| O2 | Accept a nullable `approved.response` (v1.2) | Accept | Same as D14; still needed after the response fix in phase C |
| O3 | Accept the required UUIDv4 `Idempotency-Key` header, 409 on conflict, 202 while in progress (v1.2) | Accept | The demo agent and eval client already use it; it fixes the race we flagged as gap 6 |
| O4 | Unknown routes (`UNCATALOGED_ENDPOINT`, v1.2) | **Deny**, not escalate. Explanation: "add this endpoint to the catalog" | A human can't approve an unknown route into contact anyway (critic #9). Escalating leaves unresolvable items in the queue |
| O5 | "Allowed merchants" | **Hard rule**: a cataloged merchant not selected for the mandate is denied before contact | The UI says "allowed"; the critic reproduced V6 buying from an unselected merchant (critic #3) |
| O6 | Standing grants | **Off** for the submission (config flag, default off) | The critic reproduced a greeting-only mandate buying weather with zero judge calls (critic #2) |
| O7 | Localhost exception for J2b | Keep the exact-loopback exception for the demo merchants only | Moving the demo merchants to HTTPS isn't worth it in the time left. Decide with Chunks 1 and 3 by the J2b checkpoint |
| O8 | Contract v1.3 | One bundled change: O4–O6 rules, `recordResponse` (phase C), operator endpoints (phase D) | One version bump, one review, one doc update |

O4 and O5 change what the judge sees: A14 (unselected weather merchant) becomes a rule catch, and the headline attack can no longer use an unknown merchant. Chunk 3's eval and Chunk 4's demo script have to follow (critic #10). Tell them when O4–O5 are decided, not after.

## Phases

### A · Land the stack (Sat morning, ~3 h, blocks B–D)

1. **Review `chunk3/phase6` as owner.** It is ~6,900 lines, so read for invariants, not style:
   - the four contract statements unchanged, and every new money movement conditional;
   - reservations released exactly once, never for SIGNED, SUBMITTED or UNKNOWN;
   - nothing reaches the network before pre-contact passes;
   - the idempotency binding and its HMAC secret;
   - migrations 0001–0002 against `schema.ts` (our schema test checks this);
   - v1.2 amendments against O1–O4.
   Record approve or change-request per item in the PR.
2. **Merge in order** (the team squash-merges, so rebase each next branch onto `main` before merging it): phase 6 → `fix/approve-time-rechecks` → `fix/payments-hardening` → phase 7 → phase 8. Brian's `docs/status.md` has the rebase commands. The J2b classifier waits for J2b.
3. **After each merge**, run the five checks plus the process tests on `main`.

Done when `main` contains phase 8 and is green.

### B · Authorization fixes (Sat late morning, ~3 h)

Implements O4–O6 in `pipeline/precontact.ts` and `pipeline/policy.ts`, with the v1.3 contract update.

1. **Merchant selection (O5).** Before the quote: a cataloged merchant not in `allowed_merchant_ids` is denied `MERCHANT_NOT_SELECTED`. The code moves from the Tier 1 row to pre-contact, action deny. Regression tests: V6, A14.
2. **Unknown routes (O4).** `UNCATALOGED_ENDPOINT` denies; no review item is created. Regression: the existing pre-contact table, with `pending` changed to `denied`.
3. **Standing grants (O6).** `STANDING_GRANTS=off` by default; when off, Tier 1 skips them and the judge decides. Regression: the critic's greeting-only weather mandate now reaches the judge.
4. Update `final_contracts.md` to v1.3, the reason tables and the doc-driven tests (they will fail until the doc and code agree, which is the point).

Done when the three regressions pass and Chunk 3 and Chunk 4 have the new rules.

### C · Keep what was paid for (Sat midday, ~3 h, with Chunk 1)

Fixes critic #6: a merchant returns data, settlement is confirmed later, and the agent never gets the data.

1. **Contract (v1.3):** add `PaymentStore.recordResponse(paymentId, response)`. Chunk 1's `pay()` calls it as soon as the merchant answers 2xx, before settlement is known. Bounded at 1 MiB (the hardening cap).
2. **Gateway:** store it in `payments.response_json`. Release it to the agent only once the payment is SETTLED. Until then the answer stays `payment_unknown`.
3. **Tests:** delayed settlement, repeated polling, same-key replay, and a restart after the response is stored. None of them may sign a second time.

Done when the critic's reproduction returns the merchant body instead of `response: null`.

### D · Operator API for the dashboard (Sat afternoon, ~3 h, can run alongside B and C)

The dashboard's agent list, mandate creation, approvals and close are hardcoded mocks (critic #4). Chunk 4 owns the dashboard routes; Chunk 2 owns the endpoints they call.

1. **`GET /agents`** (admin): `[{ id, name, role, trust }]`. Fixes the ID mismatch (dashboard `agt_research`/`agt_briefing` vs seeded `agt_pricing`/`agt_logistics`/`agt_bulk`).
2. **`GET /approvals?status=pending`** (admin): each pending review with authoritative details (task, agent, merchant and endpoint, canonical URL, price, reasons, judge explanation, stage, deadline). The queue then survives a page refresh, and the reviewer sees what they are approving (critic #9).
3. Contract v1.3 section 2 gains both. Hand the shapes to Chunk 4 with the existing `POST /mandates`, `POST /mandates/:id/close`, `POST /approvals/:id` and `GET /catalog`, which are already real.
4. **Acceptance test** (critic #12), in-process: an admin creates a mandate, the agent pays, the judge escalates, the admin lists approvals and approves, the agent polls and receives the merchant body. Then the same flow against real processes in `e2e/`.

Done when Chunk 4 can delete every mock route except the `MOCK=1` stream.

### E · Demo readiness (Sat evening to the Sun 7 AM freeze)

1. **J2b checkpoint, Sat 6 PM.** If the pinned transport is done for both quote and paid requests, remove the startup block last and make one real Base Sepolia payment through the firewall, with the body delivered to the agent. If not, keep the block and label settlement as simulated in the demo and Devpost. Don't remove the block without J2b (critic #7).
2. **S7 everywhere:** extend the log test to `/pay`, approvals, polling and the reconciler.
3. **Final checks** include the dashboard's own `next build` (root `tsc -b` doesn't cover it).
4. **Freeze** Sun 7 AM: `main` green, demo recorded on `PAYMENTS_MODE=mock` at minimum.

## Cut order if behind

1. The `e2e/` real-process version of the acceptance test (keep the in-process one)
2. `GET /agents` trust field
3. Real payment through the firewall (fall back to labeled simulation, per E1)

Never cut: owner review of phase 6, the merchant-selection and standing-grant fixes, response persistence, and the operator endpoints. Without them the demo shows behavior the system doesn't have.

## Out of scope

Two-process A13, tenant-local days, multi-host grant renewal, the SDK credential redesign for the judge (an open Chunk 3 decision).
