# Chunk 1 · Payments

**Size:** large. **Security-critical:** yes.
**Read first:** `contracts.md` (sections 0, 1, 2 and 5). It is the source of truth; if this file disagrees with it, stop and raise it with the team.

## Your job in one sentence

Make real x402 payments on Base Sepolia that can never be double-counted or lost, and run the merchants every test and demo depends on.

## You own

| Path | What |
|---|---|
| `apps/gateway/src/payments/` | `getQuote`, `pay`, `reconcile`, the reconciler loop, merchant-key injection |
| `apps/merchants/` | All honest and malicious test servers |
| `loadtest/` | The 100,000-request load-test script |

Do not edit files outside these paths. If you need a change elsewhere, ask the owner.

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

```ts
// apps/gateway/src/payments/index.ts
export function createPayments(deps: { store: PaymentStore; config: PaymentsConfig }): PaymentsModule;
export function createMockPayments(deps: { store: PaymentStore }): PaymentsModule; // for PAYMENTS_MODE=mock
export function startReconciler(payments: PaymentsModule, store: PaymentStore, intervalMs?: number): () => void;
export class QuoteError extends Error { code: QuoteCode }
```

`PaymentsModule` is defined in `contracts.md` section 5. The mock settles instantly with a fake tx hash, never touches the network, and is what Chunk 2 uses until Saturday evening and what the load test uses.

### You consume

`PaymentStore`, implemented by Chunk 2 (defined in `contracts.md` section 5). You never write SQL yourself. Until Chunk 2 delivers it, use your own in-memory fake that obeys the same rules: every transition is conditional on the current state.

### Who calls you

Only Chunk 2's pipeline, at step 5 (`getQuote`) and step 11 (`pay`). Nothing else may call `pay`.

## Tasks, in order

### P1 · Setup (Fri, first hour after contracts)
- Pin exact versions of `@x402/core`, `@x402/fetch`, `@x402/evm`, `@x402/express`, `viem`. Paste the current x402 quickstart into your coding-agent prompt; the packages change quickly.
- Generate test wallets: one payer (gateway) and one payee per merchant, plus an attacker payee. Fund the payer from the CDP faucet (Base Sepolia ETH and test USDC).
- A script `pnpm payments:balance` that prints the payer's USDC balance.

### P2 · First real payment (Fri 11 PM milestone)
- One honest endpoint on PriceScope with `@x402/express`, priced 10,000 (0.01 USDC).
- A throwaway script that pays it with `@x402/fetch` and prints the tx hash.
- **Done when** the tx appears on a Base Sepolia explorer. If this isn't done by Sat 2 AM, tell the team; everyone swarms.

### P3 · `getQuote(canonicalUrl, method)`
- Send the request **without payment**. Timeout 3 s. **Do not follow redirects** (`redirect: 'manual'`); any 3xx is `QUOTE_INVALID`, since a redirect could point the gateway at an attacker.
- Response must be 402, else `NOT_402`. Network error or timeout is `QUOTE_FAILED`.
- Parse the payment requirements. Pick the one for `eip155:84532` and the USDC asset. None, or malformed, is `QUOTE_INVALID`.
- Cap the response size you read at 64 KB.
- Return `Quote` with `raw` set to the exact requirements object; `pay` must reuse it unchanged.

### P4 · `pay(paymentId, quote)` and the lifecycle
Follow the state table in the design doc. The order of writes is the whole point:

1. Create the authorization for **exactly** `quote.amount` to `quote.payee`. Set the validity window to about 5 minutes if the client allows it; otherwise record whatever it uses.
2. `store.markSigned(paymentId, { nonce, validBefore, authorizationJson })` **before** sending anything.
3. `store.markSubmitted(paymentId)` **before** sending the paid request.
4. Send the paid request to the merchant with the payment header. Attach the merchant API key from `MERCHANT_KEYS_JSON` if one exists for this origin. Timeout 15 s.
5. Outcomes:
   - 2xx with a settlement response header carrying a tx hash: `store.settle(paymentId, txHash)`; return `SETTLED` with the merchant response body.
   - Anything else (timeout, dropped connection, 402, 5xx, missing header): `store.markUnknown(paymentId)`; return `UNKNOWN`. **Never `FAILED` here.** A merchant that holds a signed authorization can still settle it until it expires, so a merchant's rejection proves nothing.
- A retry for the same `paymentId` must load the stored `authorizationJson` and resend it. Never sign a second authorization for the same payment.

### P5 · `reconcile(paymentId)` and the loop
- `SIGNED` (never sent): `store.fail(paymentId)`. It never left the process, so it can't settle.
- `SUBMITTED` or `UNKNOWN`: read whether the authorization's nonce has been used on-chain (EIP-3009 tokens expose this; confirm the exact call against the USDC contract on Base Sepolia before relying on it).
  - Used: `store.settle(paymentId, txHash)` (look the hash up from the transfer event if possible; otherwise store `"unknown"`).
  - Not used and `now > validBefore`: `store.fail(paymentId)`.
  - Otherwise: leave it.
- `startReconciler` runs once at startup, then every 10 s over `store.listUnresolved()`.

### P6 · Test merchants (Sat midday)
One app, several servers. Each merchant has its own payee wallet.

| Server | Endpoint | Price | Used by |
|---|---|---|---|
| PriceScope 4101 | `GET /v1/pricing/{company}?period=` | 10,000 | Normal work, A5, A6, A12, A16 |
| PriceScope 4101 | `POST /v1/pricing/export` | 500,000 | A3, A17 |
| SkyData 4102 | `GET /v1/forecast?city=&units=` | 10,000 | Weather mandate, A14 |
| NewsWire 4103 | `GET /v1/headlines?topic=` | 5,000 | News mandate |
| Attacker 4199 | `GET /premium-summary` | 400,000 | A2 |
| Attacker 4199 | `GET /verify?token=` | 10,000 | A1 |
| Attacker 4199 | `GET /unlock` | 500,000,000 | A4 |
| Attacker 4199 | Free HTML pages `/pages/{id}` containing injected instructions | free | The demo agent reads these |

Control endpoint on each merchant, **not** reachable through the gateway: `POST /_control` with `{ "mode": "normal" | "price_switch" | "ratchet" | "payee_swap" | "drop_after_settle" }`.

- `price_switch`: next quotes cost 900,000 (A5).
- `ratchet`: price doubles on each settled payment (A12).
- `payee_swap`: quotes name the attacker payee (A6).
- `drop_after_settle`: settle, then destroy the connection without responding (A18).

Chunk 4 writes the text of the injected pages; you serve them as given in `eval/cases/variants/PAGES.md`.

### P7 · Load test (Sat evening)
- `loadtest/run.ts` sends 100,000 synthetic `/pay` requests (concurrency 50) to a gateway running with `PAYMENTS_MODE=mock` and `JUDGE_MODE=stub-approve`, spread across 3 mandates and the honest endpoints.
- Report: requests per second, judge-call rate, grant hit rate, p50 and p95 latency. Write `loadtest/REPORT.md`.

## Your tests

| ID | Test |
|---|---|
| A18 | `drop_after_settle`: payment ends `UNKNOWN`, budget stays reserved, retry with the same idempotency key resends the same authorization, reconciler marks it `SETTLED`, mandate spent increases exactly once |
| A19 | Kill the gateway process after `markSubmitted` and before the response (use a test hook that throws); restart; reconciler resolves it; budget never exceeded or released twice |
| P-redirect | A merchant answering 302 makes `getQuote` throw `QUOTE_INVALID` and makes no second request |
| P-exact | The signed amount always equals `quote.amount` (property test across random prices) |
| P-signed | A payment left in `SIGNED` is failed by the reconciler and its reservation released |

## Hard rules
- Testnet only. `WALLET_PRIVATE_KEY` lives in `.env`; `.env` is in `.gitignore`.
- No empty `catch` blocks on the payment path. Every error ends in a store transition or a thrown, typed error.
- Never call `store.fail` from `pay`.

## Integration checkpoints

| When | With | Check |
|---|---|---|
| Fri 11 PM | Team | P2 tx hash posted in chat |
| Sat 10 AM | Chunk 2 | Chunk 2's `PaymentStore` passes your fake's test suite |
| Sat midday | Chunk 3 | Catalog origins and payees match your servers exactly |
| Sat evening | Chunk 2 | Gateway switches to `PAYMENTS_MODE=real`; A18 and A19 pass end to end |

## Cross-review
You review Chunk 2's atomic reservation and the pre-contact ordering (no network call before step 4 passes).
