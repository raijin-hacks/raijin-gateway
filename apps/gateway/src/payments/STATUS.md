# Payments status log — append only, newest at bottom

## 2026-10-23 · P1 Setup (branch `chunk1/p1-setup`)

**Done**
- pnpm workspace at the root (`package.json`, `pnpm-workspace.yaml`, `.npmrc` with `save-exact`), pnpm 10.34.7, Node >= 22.18 (runs `.ts` natively, no tsx).
- Pinned exact versions, following the official x402 TypeScript examples (`coinbase/x402` main: `examples/typescript/clients/fetch/index.ts` and `servers/express/index.ts`):
  - `apps/gateway`: `@x402/core` 2.28.0, `@x402/fetch` 2.28.0, `@x402/evm` 2.28.0, `viem` 2.57.7
  - `apps/merchants`: `@x402/express` 2.28.0, `@x402/paywall` 2.28.0 (peer of express), `@x402/core`/`@x402/evm` 2.28.0, `express` 5.3.0, `viem` 2.57.7
  - Client pattern: `new x402Client()` → `register('eip155:*', new ExactEvmScheme(privateKeyToAccount(key)))` → `wrapFetchWithPayment(fetch, client)`. Server: `paymentMiddleware(routes, new x402ResourceServer(new HTTPFacilitatorClient({ url })).register('eip155:84532', new ExactEvmScheme()))`.
- `pnpm payments:wallets` (`scripts/gen-wallets.ts`): generates the payer and the PriceScope, SkyData, NewsWire and attacker payee wallets. Keys go to root `.env` (`WALLET_PRIVATE_KEY`, `PAYEE_{PRICESCOPE,SKYDATA,NEWSWIRE,ATTACKER}_PRIVATE_KEY`), prints addresses only, idempotent. Public payee addresses are in `apps/merchants/payees.json` for the catalog (Chunk 3).
- `pnpm payments:balance` (`scripts/balance.ts`): prints the payer's USDC (atomic + formatted) and ETH on Base Sepolia. USDC defaults to `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; overridable with `USDC_ADDRESS`, `BASE_SEPOLIA_RPC_URL`.
- `.env` and `node_modules/` added to `.gitignore`.

**Wallets (Base Sepolia, testnet only)**

| Role | Address |
|---|---|
| payer (gateway) | `0x34bed74915ca69fdd99b23e28b949d4afc89a582` |
| PriceScope payee | `0x0d972d44bda2bc27420debd711395729480186ae` |
| SkyData payee | `0xd78e8d21837b7957b53251fae747e58c6e71df3c` |
| NewsWire payee | `0x9b9454a6605a8cb0a552c4fbc7db76b6a55aa614` |
| Attacker payee | `0xca7c3c3ac945e0febcebae02de1fbe847bcd4d19` |

Balance check run: payer has 0 USDC, 0 ETH (not funded yet).

**Open**
- Fund the payer from the CDP faucet (Base Sepolia USDC; ETH optional, since x402 exact/EIP-3009 settlement is paid by the facilitator). Not done by the agent, on purpose.
- `.env` was already tracked by git. It must be untracked (`git rm --cached .env`) before any commit, or the new keys get committed.
- CI conflict: `.github/workflows/ci.yml` requires npm (`package-lock.json` plus `lint`, `format:check`, `typecheck`, `test`, `build` scripts) once a root `package.json` exists, but contracts §0 says pnpm. CI fails on this branch until the workflow (or the decision) changes. Needs the team.
- Contracts §0 lists env vars without per-payee keys. The `PAYEE_*_PRIVATE_KEY` vars are new and only needed to sweep funds; propose adding them per §6.
- `apps/gateway/package.json` and the root workspace files sit in B's area. Created minimally so the payments scripts can run; B should review.
## 2026-10-23 · P2 First real payment (branch `chunk1/p1-setup`)

**Done**
- `apps/merchants/src/pricescope.ts`: PriceScope on :4101 (`PRICESCOPE_PORT`), `GET /v1/pricing/:company?period=` behind `@x402/express` `paymentMiddleware`. Price is an explicit `AssetAmount`: `10000` atomic of USDC `0x036C…dCF7e` with EIP-712 domain `{ name: 'USDC', version: '2' }`, `payTo` from `payees.json` (`pricescope`). Facilitator from `FACILITATOR_URL`, default `https://x402.org/facilitator`. Run: `pnpm merchants:pricescope`.
- `apps/gateway/src/payments/scripts/pay-once.ts` (throwaway): `wrapFetchWithPayment` pays the URL (default `http://localhost:4101/v1/pricing/acme?period=30d`, or pass one as the first arg), then prints the body, the decoded `PAYMENT-RESPONSE` settlement, the tx hash and a basescan link. On a failed payment it prints the facilitator's reason. Run: `pnpm payments:pay-once`.
- Checked: an unpaid request returns 402 with `accepts[0] = { scheme: exact, network: eip155:84532, amount: "10000", payTo: 0x0d97…86ae, maxTimeoutSeconds: 300 }`. Dry run with a random unfunded key: the client signs, the facilitator verifies, and the payment is rejected with `invalid_exact_evm_insufficient_balance`. The whole path works up to the balance check.

**Open**
- Not done yet: a real settled tx. It needs the payer funded with at least 0.01 test USDC, then `pnpm merchants:pricescope` and `pnpm payments:pay-once`, and the tx posted in chat.
- The x402 route pattern `GET /v1/pricing/:company` also matches `/v1/pricing/export`, but only for GET. When P6 adds `POST /v1/pricing/export`, give it its own route entry.
