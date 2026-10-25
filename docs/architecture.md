# how the system fits together

Raijin Gateway sits between an AI agent and its money. A human creates a **mandate** (a task, a budget, an expiry); the agent gets only a token for that mandate. When the agent wants to pay for an API call, it asks the gateway, and the gateway applies catalog/selection checks, hard rules and task-judge or review policy before signing. The current mandate is not an immutable operation/quantity plan; the missing authority fields are documented in [judge advisories](judge-advisories.md).

## The parts

| Part | Path | Owner | What it does |
|---|---|---|---|
| Contracts | `packages/contracts` | chunk 2 | Shared types, zod schemas, reason codes, limits. Every other part imports from here; [`final_contracts.md`](../design-docs/final_contracts.md) is the spec. |
| Gateway API | `apps/gateway/src/app.ts`, `routes/` | chunk 2 | HTTP routes, auth, server-sent events |
| Pipeline | `apps/gateway/src/pipeline/` | chunk 2 | The `/pay` orchestrator: idempotency, pre-contact checks, Tier 0 rules, reservations, trust, grants, human review |
| Database | `apps/gateway/src/db/` | chunk 2 | SQLite schema, budgets and reservations (`funds.ts`), payment ledger (`payment-store.ts`) |
| Payments | `apps/gateway/src/payments/` | chunk 1 | x402 quote, signing and paid request; on-chain reconciliation |
| Catalog | `apps/gateway/src/catalog/`, `catalog/catalog.json` | chunk 3 | Trusted merchant list; URL canonicalizer; endpoint matcher |
| Judge | `apps/gateway/src/judge/` | chunk 3 | Builds the sanitized judge input, calls the model, validates its answer |
| Merchants | `apps/merchants/` | chunk 1 | PriceScope implementation on `:4101`; SkyData, NewsWire and attacker ports are catalog/demo fixture conventions, not implemented sellers here |
| Dashboard | `apps/dashboard/` | chunk 4 | Next.js UI: mandate form, live event feed, approval queue, agent restriction and restoration controls (score graph hidden) |
| Evaluation | `eval/` | chunk 3 | Paper checkpoint, API eval runner, frozen cases, held-out variants, report |
| Demo agent | `apps/agent/` | chunk 3; final demo handoff unconfirmed | Two-tool agent that reads pages and buys through the gateway |

Ports: gateway `4000`, dashboard `3000`, merchants `4101–4103`, attacker `4199`.

## A payment, step by step

The agent calls `POST /pay` with its mandate token, an idempotency key and the merchant URL. `pipeline/index.ts` runs these steps in order; any step can stop the payment.

1. **Claim the request** (`pipeline/idempotency.ts`). The key is bound to the mandate and a fingerprint of the request, so a retry returns the same result instead of paying twice.
2. **Admit the URL** (chunk 3: `catalog/canonicalize.ts`, `catalog/match.ts`, `judge/gateway.ts`). The URL is canonicalized and matched against the catalog. Unknown routes deny here, before any network contact; a catalog update is required, not a generic human override.
3. **Pre-contact checks** (`pipeline/precontact.ts`, `pipeline/secrets.ts`). Secrets in the URL, merchants outside the mandate selection (`MERCHANT_NOT_SELECTED`), parameter violations and subjects not in the mandate are stopped. Merchant-selection failures deny, including V6/A14. Still no network contact.
4. **Quote** (chunk 1: `payments/quote.ts`). The gateway asks the merchant for its x402 price without paying. Startup supplies destination verification and pinned transport to quote and paid requests. Exact catalog loopback origins retain a demo HTTP exception; this is not evidence of an HTTPS or live settlement run.
5. **Tier 0 rules and reservation** (`pipeline/policy.ts`, `db/funds.ts`). Hard caps run, then the budget is reserved atomically.
6. **Trust, grants and the judge** (`pipeline/policy.ts`, chunk 3 `judge/`). Standing grants are disabled by default. Where policy permits an existing matching grant it can approve directly; otherwise trust/policy routes to the judge or human review. This is legacy mandate policy, not immutable operation-plan enforcement. The judge only ever sees sanitized facts, never attacker-written text.
7. **Human review** if escalated. A person approves or rejects through `POST /approvals/:decision_id` (the dashboard's approval queue); a timeout releases the reservation.
8. **Committed approval, then payment** (chunk 1: `payments/pay.ts`). Approval rechecks trust and the new-payee limit inside one transaction. Only then is the authorization signed and sent.
9. **Settlement** (chunk 1: `payments/reconcile.ts`). The payment counts as settled only when the authorization is used on-chain; an ambiguous outcome stays `UNKNOWN` with funds reserved until reconciled.

The agent polls `GET /decisions/:id` and `GET /payments/:id`. The dashboard watches events through `GET /stream`. Its Next proxy requires an operator session before API handlers attach the server-side admin token, including the stream proxy; mutations require the dashboard origin. Non-mock mode requires `DASHBOARD_PASSWORD`. This shared-password session does not identify a named person or sign a plan.

## Where the chunks meet

| Boundary | Interface | Defined in |
|---|---|---|
| Gateway ↔ judge | `JudgeContext` → `buildInput` → `JudgeInput` → `JudgeOutput` | `packages/contracts`, [chunk 2/3 boundary](../design-docs/CHUNK-2-3-BOUNDARY.md) |
| Gateway ↔ catalog | `createCanonicalizer(catalog)`, `matchEndpoint`, admission | [phase 4 decisions](../design-docs/CHUNK-3-PHASE4-DECISIONS.md) |
| Gateway ↔ payments | `PaymentsModule` (`getQuote`, `pay`), `PaymentStore` | `packages/contracts`, [chunk 1 doc](../design-docs/CHUNK-1-PAYMENTS.md) |
| Gateway ↔ dashboard | admin routes and the `/stream` event feed | [contracts](../design-docs/final_contracts.md) section 2 |
| Agent ↔ gateway | `POST /pay` with a mandate token; polling routes | [contracts](../design-docs/final_contracts.md) section 2 |

## Safety rules the code enforces

These are lint rules (`eslint.config.js`) or tests, so breaking one fails CI:

- Only `src/judge/` may call the model or construct `JudgeInput`.
- Pre-network pipeline files may not call `fetch` or import payments code.
- Only `clock.ts` reads the system time; everything else uses the injected clock.
- No empty `catch` blocks: errors on the payment path must deny.
- Canary tests assert that no attacker-controlled string reaches the model.

## Evidence and recovery limits

The [historical report](../eval/REPORT.md) retains its original measurements and labels. Current [supplemental evidence](../eval/supplemental/v1.3-v1/README.md) separates authored task-relevance pairs, deterministic boundary catches, mock transitions and blocked strict-plan cases. Unknown-route or unselected-merchant catches are not judge-only protection. Canary tests demonstrate input-channel exclusion, not universal model correctness.

The worker receives bounded purchased data as untrusted tool output and returns its final answer. Its idempotency map is session-local: gateway replay is durable, but a restarted worker does not yet retain the original purchase key. Recovery can preserve a response durably received by the gateway; a never-received body requires merchant retrieval/replay support. No integrated live-model, chain-settlement or CDP enforcement claim follows from offline tests.


## Durable restriction policy (v1.4)

`agents.restriction` is durable across mandates and sessions. `pipeline/restrictions.ts` records one append-only incident per decision and only tightens `normal → review_required → suspended`. Off-task is a review-only signal; infrastructure, malformed inputs and pre-contact denials are excluded. Two security incidents in a mandate/epoch suspend. All approval rewards are zero.

Every authorization boundary reads agent state: pre-contact, grants, final approval, human resume, recovery, and payment-store signing guards. `PaymentStore.canSign` precedes signer invocation; `markSigned` atomically rechecks. An already issued external signature cannot be recalled. Submitted/unknown liabilities continue through reconciliation.

Admin `POST /agents/:id/restore` is the only upward transition. It atomically stores operator/reason/old/new state, resets heuristic scores and active-session quarantine, and begins a new incident epoch. Shared-admin operator names are self-attested. It never changes caps or reopens closed mandates. Incident/restoration events refresh dashboard cards, backed by `GET /agents` audit history. See [the implemented design](../design-docs/trust-design.md) and [v1.4 contracts](../design-docs/final_contracts.md).
