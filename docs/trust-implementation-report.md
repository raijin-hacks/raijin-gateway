# Trust restriction implementation handoff

Implemented the complete trust design, including durable state, security taxonomy, all authorization/recovery/signing checks, admin restoration, dashboard controls, contracts v1.4 and an offline scripted demo. No commit, push or branch switch was performed. `todo.md` was not edited.

## Verification

| Command | Result |
|---|---|
| `pnpm lint` | Pass (existing Next pages-directory warning only) |
| `pnpm format:check` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm --filter dashboard exec tsc --noEmit` | Pass |
| `pnpm test` | Sandbox-blocked: 63 files pass; eight TCP-dependent files fail on `listen EPERM` or consequent socket startup timeouts. 1,632 tests pass; 96 fail, 49 skip, one expected failure, three existing todo tests, nine socket errors. No remaining assertion failures outside those TCP files. |
| Suite excluding those eight files | Pass: 63 files, 1,622 tests; one skipped file, one expected failure, three existing todo tests |
| `pnpm build:dashboard` | Sandbox-blocked: Turbopack CSS worker cannot bind a port (`Operation not permitted`) |
| `pnpm --filter dashboard exec next build --webpack` | Sandbox-blocked: `fonts.googleapis.com` DNS/download failure for Geist and Geist Mono |
| `pnpm agent:rehearse` | Pass: six files, 29 tests, including the new restriction beat |
| `pnpm trust:rehearse` | Pass: narrated offline poison → incident → queue → restoration beat |
| Focused policy, store, signer and rehearsal tests after final review | Pass: four files, 125 tests |
| `git diff --check` | Pass |

The eight socket-dependent exclusions are:

- `apps/gateway/src/payments/pay.test.ts`
- `apps/gateway/src/payments/quote.test.ts`
- `apps/gateway/src/payments/reconcile.test.ts`
- `apps/gateway/src/payments/transport.test.ts`
- `apps/gateway/test/process.test.ts`
- `apps/gateway/test/http/payment-recovery.test.ts`
- `apps/merchants/src/attacker.test.ts`
- `apps/merchants/src/pricescope.test.ts`

No external model, real payment, CDP account or live evaluation was called. Existing eval-runner, agent and CDP adapter tests that can run offline pass. Browser rendering and production dashboard completion remain unverified because of the sandbox build limitations; run the build and TCP suite outside the sandbox before the live demo.

## Policy details for owner review

- Approval score deltas are zero. Numeric penalties remain, except infrastructure/quote errors are excluded and off-task penalties stop at 20 without raising a lower score. This prevents review-only signals from themselves quarantining agents.
- Incidents and restorations are append-only (SQLite triggers). Incidents are keyed by decision; retries/replays, including a subsequent rejection of an already recorded review signal, cannot count twice.
- Two security incidents in the same mandate and restoration epoch suspend. Off-task never contributes to that count. The design does not define a standalone severe detector: the trusted internal severe transition is implemented/tested, but no listed first incident was silently reclassified as severe. No public input can assert severity.
- Restoration records a required reason and self-attested operator identity under shared-admin authentication, publishes an event after commit, resets heuristic scores/quarantine for eligible active sessions and increments the incident epoch. It cannot increase mandate/role authority or revive closed/expired mandates. A same-state target is accepted only when score/quarantine recovery is needed; pure no-ops and more restrictive targets return 409.
- Every boundary reads durable agent state. `PaymentStore.canSign` checks before invoking the signer and `markSigned` atomically rechecks before recording/submitting its result. Already-issued external signatures cannot be recalled; unresolved liabilities stay reserved/reconciled.
- The offline beat explicitly stubs the injection flag. Reading the poisoned page alone does not generate an incident, and attacker page prose still never reaches the judge. Injection quarantines its session; the beat uses another already-open session to demonstrate agent-wide review before explicit restoration clears quarantine.
- The dashboard keeps the old trust graph hidden. It shows restriction badges, three recent incidents, the latest restoration, and a restoration form through the existing authenticated, same-origin proxy. It polls durable audit data to recover from missed SSE events.

## Existing test changes explained

- `test/http/pay.test.ts`: clean approvals/replays now create zero trust reward events; mid-judge qualifying incidents route with `AGENT_REVIEW_REQUIRED` instead of relying solely on `TRUST_REQUIRES_HUMAN`.
- `test/http/logging.test.ts`: after its off-task incident, the next purchase now needs its own explicit review. The test still reaches payment/reconciliation and checks credential redaction; a prior payment approval no longer silently recovers routing.
- `test/http/operator-api.test.ts` and contract response fixtures: agents include persistent restriction and audit histories.
- Schema tests: 16 documented tables and four migrations, covering the two new audit tables and agent fields.
- Contract compatibility/scaffold/reason tests: v1.4, 49 reason codes and the new escalation code. New doc-driven tests validate restoration/event examples and enum/type parity. The existing Design.md delta test now reads zero approval rewards from the updated source table.

## Changed files by ownership and area

Every changed/new file is listed below, including every Chunk 2 and Chunk 4 file. The Chunk 1 touch is limited to invoking the new pre-sign guard, its in-memory test-store implementation and one signer refusal test. No judge prompt, catalog, eval fixture, agent production tool or CDP policy was edited.

### Chunk 2 — contracts

- [packages/contracts/src/api.ts](../packages/contracts/src/api.ts)
- [packages/contracts/src/compatibility.test.ts](../packages/contracts/src/compatibility.test.ts)
- [packages/contracts/src/constants.ts](../packages/contracts/src/constants.ts)
- [packages/contracts/src/enums.ts](../packages/contracts/src/enums.ts)
- [packages/contracts/src/index.ts](../packages/contracts/src/index.ts)
- [packages/contracts/src/reasons.ts](../packages/contracts/src/reasons.ts)
- [packages/contracts/src/schemas.ts](../packages/contracts/src/schemas.ts)
- [packages/contracts/src/types.ts](../packages/contracts/src/types.ts)
- [packages/contracts/test/reasons.test.ts](../packages/contracts/test/reasons.test.ts)
- [packages/contracts/test/restrictions.test.ts](../packages/contracts/test/restrictions.test.ts)
- [packages/contracts/test/schemas.test.ts](../packages/contracts/test/schemas.test.ts)

### Chunk 2 — gateway policy, API and persistence

- [apps/gateway/drizzle/0003_flimsy_mauler.sql](../apps/gateway/drizzle/0003_flimsy_mauler.sql)
- [apps/gateway/drizzle/meta/0003_snapshot.json](../apps/gateway/drizzle/meta/0003_snapshot.json)
- [apps/gateway/drizzle/meta/_journal.json](../apps/gateway/drizzle/meta/_journal.json)
- [apps/gateway/src/app.ts](../apps/gateway/src/app.ts)
- [apps/gateway/src/db/payment-store.ts](../apps/gateway/src/db/payment-store.ts)
- [apps/gateway/src/db/schema.ts](../apps/gateway/src/db/schema.ts)
- [apps/gateway/src/payment-events.ts](../apps/gateway/src/payment-events.ts)
- [apps/gateway/src/pipeline/index.ts](../apps/gateway/src/pipeline/index.ts)
- [apps/gateway/src/pipeline/policy.ts](../apps/gateway/src/pipeline/policy.ts)
- [apps/gateway/src/pipeline/precontact.ts](../apps/gateway/src/pipeline/precontact.ts)
- [apps/gateway/src/pipeline/restrictions.ts](../apps/gateway/src/pipeline/restrictions.ts)
- [apps/gateway/src/routes/operators.ts](../apps/gateway/src/routes/operators.ts)

### Chunk 2 — gateway acceptance and compatibility tests

- [apps/gateway/test/db/schema.test.ts](../apps/gateway/test/db/schema.test.ts)
- [apps/gateway/test/harness/trust.ts](../apps/gateway/test/harness/trust.ts)
- [apps/gateway/test/http/logging.test.ts](../apps/gateway/test/http/logging.test.ts)
- [apps/gateway/test/http/operator-api.test.ts](../apps/gateway/test/http/operator-api.test.ts)
- [apps/gateway/test/http/pay.test.ts](../apps/gateway/test/http/pay.test.ts)
- [apps/gateway/test/http/trust-restriction.test.ts](../apps/gateway/test/http/trust-restriction.test.ts)
- [apps/gateway/test/scaffold.test.ts](../apps/gateway/test/scaffold.test.ts)

### Chunk 4 — dashboard (all five touched files)

- [apps/dashboard/app/agent-restrictions.tsx](../apps/dashboard/app/agent-restrictions.tsx)
- [apps/dashboard/app/api/agents/[id]/restore/route.ts](../apps/dashboard/app/api/agents/[id]/restore/route.ts)
- [apps/dashboard/app/api/agents/route.ts](../apps/dashboard/app/api/agents/route.ts)
- [apps/dashboard/app/approval-queue.tsx](../apps/dashboard/app/approval-queue.tsx)
- [apps/dashboard/app/page.tsx](../apps/dashboard/app/page.tsx)

### Chunk 4 — demo and agent rehearsal

- [apps/agent/src/trust-rehearsal.test.ts](../apps/agent/src/trust-rehearsal.test.ts)
- [demo/DEVPOST.md](../demo/DEVPOST.md)
- [demo/SCRIPT.md](../demo/SCRIPT.md)

### Chunk 1 — payment signing boundary (owner review)

- [apps/gateway/src/payments/hardening.test.ts](../apps/gateway/src/payments/hardening.test.ts)
- [apps/gateway/src/payments/pay.ts](../apps/gateway/src/payments/pay.ts)
- [apps/gateway/src/payments/testing/memory-store.ts](../apps/gateway/src/payments/testing/memory-store.ts)

### Shared documentation and command wiring

- [design-docs/Design.md](../design-docs/Design.md)
- [design-docs/final_contracts.md](../design-docs/final_contracts.md)
- [design-docs/trust-design.md](../design-docs/trust-design.md)
- [docs/architecture.md](../docs/architecture.md)
- [docs/open-issues.md](../docs/open-issues.md)
- [docs/trust-implementation-report.md](../docs/trust-implementation-report.md)
- [package.json](../package.json)

## Remaining work

No implementation scope was deferred. Run the sandbox-blocked TCP tests and dashboard production build in an unrestricted demo environment. Severe-signal policy, shared operator identity and the external-signature window are explicit clarifications/limitations above, not hidden automatic recovery paths.
