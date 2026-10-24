# how the system fits together

The Agent Payment Firewall sits between an AI agent and its money. A human creates a **mandate** (a task, a budget, an expiry); the agent gets only a token for that mandate. When the agent wants to pay for an API call, it asks the gateway, and the gateway decides whether the payment serves the task before anything is signed.

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
| Merchants | `apps/merchants/` | chunk 1 | Demo x402 merchants (PriceScope on `:4101`; SkyData `:4102`, NewsWire `:4103`, attacker `:4199` per the chunk 1 doc) |
| Dashboard | `apps/dashboard/` | chunk 4 | Next.js UI: mandate form, live event feed, approval queue, trust graph |
| Evaluation | `eval/` | chunk 3 | Paper checkpoint, API eval runner, frozen cases, held-out variants, report |
| Demo agent | `apps/agent/` | chunk 3 or 4 (unconfirmed) | Two-tool agent that reads pages and buys through the gateway |

Ports: gateway `4000`, dashboard `3000`, merchants `4101–4103`, attacker `4199`.

## A payment, step by step

The agent calls `POST /pay` with its mandate token, an idempotency key and the merchant URL. `pipeline/index.ts` runs these steps in order; any step can stop the payment.

1. **Claim the request** (`pipeline/idempotency.ts`). The key is bound to the mandate and a fingerprint of the request, so a retry returns the same result instead of paying twice.
2. **Admit the URL** (chunk 3: `catalog/canonicalize.ts`, `catalog/match.ts`, `judge/gateway.ts`). The URL is canonicalized and matched against the catalog. Unknown routes escalate to a human here, before any network contact.
3. **Pre-contact checks** (`pipeline/precontact.ts`, `pipeline/secrets.ts`). Secrets in the URL, parameter violations and subjects not in the mandate are stopped. Still no network contact.
4. **Quote** (chunk 1: `payments/quote.ts`). The gateway asks the merchant for its x402 price without paying. Real mode is blocked until J2b.
5. **Tier 0 rules and reservation** (`pipeline/policy.ts`, `db/funds.ts`). Hard caps run, then the budget is reserved atomically.
6. **Trust, grants and the judge** (`pipeline/policy.ts`, chunk 3 `judge/`). A matching grant can approve directly; otherwise the judge decides whether the purchase serves the task. The judge only ever sees sanitized facts, never attacker-written text.
7. **Human review** if escalated. A person approves or rejects through `POST /approvals/:decision_id` (the dashboard's approval queue); a timeout releases the reservation.
8. **Committed approval, then payment** (chunk 1: `payments/pay.ts`). Approval rechecks trust and the new-payee limit inside one transaction. Only then is the authorization signed and sent.
9. **Settlement** (chunk 1: `payments/reconcile.ts`). The payment counts as settled only when the authorization is used on-chain; an ambiguous outcome stays `UNKNOWN` with funds reserved until reconciled.

The agent polls `GET /decisions/:id` and `GET /payments/:id`. The dashboard watches everything through `GET /stream`.

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
