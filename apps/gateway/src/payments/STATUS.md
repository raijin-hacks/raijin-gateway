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

| Role             | Address                                      |
| ---------------- | -------------------------------------------- |
| payer (gateway)  | `0x34bed74915ca69fdd99b23e28b949d4afc89a582` |
| PriceScope payee | `0x0d972d44bda2bc27420debd711395729480186ae` |
| SkyData payee    | `0xd78e8d21837b7957b53251fae747e58c6e71df3c` |
| NewsWire payee   | `0x9b9454a6605a8cb0a552c4fbc7db76b6a55aa614` |
| Attacker payee   | `0xca7c3c3ac945e0febcebae02de1fbe847bcd4d19` |

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

**Milestone met:** first real payment settled on Base Sepolia: `0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15` (block 49499677, 10000 atomic USDC, payer to PriceScope). https://sepolia.basescan.org/tx/0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15

- Payer funded with 20 USDC from faucet.circle.com (Base Sepolia).
- The first attempts failed at settlement with `invalid_exact_evm_transaction_failed` / "replacement transaction underpriced". That was a nonce collision on the shared x402.org facilitator's gas wallet, not our code; a retry settled. `pay-once` now prints the `PAYMENT-RESPONSE` failure reason. P4's "anything else is UNKNOWN, never FAILED" rule covers exactly this case.

**Open**

- The x402 route pattern `GET /v1/pricing/:company` also matches `/v1/pricing/export`, but only for GET. When P6 adds `POST /v1/pricing/export`, give it its own route entry.

## 2026-10-24 · P3 `getQuote(canonicalUrl, method)`

**Done**

- `quote.ts`: `getQuote` and `QuoteError` (`code: QuoteCode`). It sends no payment header, uses `redirect: 'manual'`, and has one 3 s `AbortSignal` that covers both the headers and the body.
  - A 3xx is `QUOTE_INVALID` and is never followed. A non-402 is `NOT_402`. A network error, a timeout, or a body that stalls is `QUOTE_FAILED`.
  - Requirements come from the base64 `PAYMENT-REQUIRED` header (x402 v2), falling back to a JSON body read with a 64 KB cap; over the cap is `QUOTE_INVALID`.
  - It picks the `scheme: exact`, `eip155:84532`, USDC option (`USDC_ADDRESS` or the default, compared ignoring case). The amount must be a positive whole number and `payTo` an address, or the result is `QUOTE_INVALID`.
  - `Quote.raw` is that selected `accepts[]` entry, unchanged. `payee` is lowercased.
- `types.ts`: the §5 types `getQuote` needs, copied until `packages/contracts` exists (TODO: import from `@apf/contracts`).
- `quote.test.ts`: 24 test cases against throwaway local merchants, written before the implementation. Run with `pnpm payments:test` (about 6 s; two tests wait out the real 3 s timeout).
  - Mutation-checked: switching to `redirect: 'follow'` fails all 5 redirect tests, and removing the size cap fails both 64 KB tests.
- Checked against the live PriceScope: it returns `{ amount: 10000, payee: 0x0d97…86ae, network: eip155:84532 }`.

**Open**

- P4: the x402 client builds a payment from the whole 402 response (`x402Version`, `resource`, `accepts`), so `pay` has to wrap `quote.raw` back into that shape (`x402Version: 2`, `accepts: [raw]`). If that proves awkward, propose a §6 change so `raw` holds the whole 402 response.
- The JSON-body fallback expects the v2 shape (`network: eip155:84532`, `amount`). v1 bodies (`base-sepolia`, `maxAmountRequired`) come back as `QUOTE_INVALID`. None of our merchants send v1.
- B: once `packages/contracts` lands, swap `types.ts` for the import.

## 2026-10-24 · P4 `pay(paymentId, quote)` (branch `chunk1/p4-pay`)

**Done**

- `pay.ts`, wired into `createPayments({ store, config: { walletPrivateKey, rpcUrl } })` in `index.ts`. The order of writes:
  1. From `RESERVED`, sign once with x402 `ExactEvmScheme`. Before signing, check that `quote.raw` matches `quote.amount`, `quote.payee` and `eip155:84532`; after signing, check that the authorization's `value` and `to` match the quote. Either mismatch throws, and nothing is stored or sent.
  2. `markSigned(nonce, validBefore in ms, authorizationJson)` before anything is sent.
  3. `markSubmitted` before the paid request. On a retry from `SUBMITTED` or `UNKNOWN` the payment is already past this point, so the step is skipped.
  4. Send `PAYMENT-SIGNATURE` re-encoded from the stored JSON (byte-identical on every retry), with `redirect: 'manual'` and a 15 s timeout.
  5. A 2xx whose `PAYMENT-RESPONSE` has `success` and a tx hash calls `settle` and returns `SETTLED`. Anything else (timeout, dropped connection, 402, 5xx, missing or bad header) calls `markUnknown` and returns `UNKNOWN`. `pay` never calls `store.fail`.
- Calling `pay` on a payment that is already `SETTLED` or `FAILED`, or on an unknown id, throws.
- Codex adversarial review (High): `pay` checked the signature only against the `Quote`, never against the payment row, so a quote for more money or another payee could be paid under a smaller reservation. Fixed: `pay` throws before signing or sending unless `quote.amount` and `quote.payee` equal the row's `amount` and `payee`, and it re-checks the authorization (fresh or stored) against the row before every send. Covered by the 4 `(d)` tests (larger amount, smaller amount, other payee, mismatched retry); removing the guard fails all 4.
- Codex adversarial review (High): `pay` ignored `store.settle()` returning `false`, so it could report `SETTLED` while the row stayed e.g. `FAILED` with the reservation released. Fixed: on `false`, `pay` re-reads the row. If it is already `SETTLED` (recorded elsewhere), `pay` returns `SETTLED`. Otherwise it logs and throws `SettlementNotRecordedError { paymentId, txHash, state }`, and never reports `SETTLED`. Covered by the 2 `(e)` tests.
  - Needs the team: the store has no `FAILED -> SETTLED` transition, so a late settlement after the reconciler failed a payment can't be recorded. The gateway should surface this error to an operator. A §6 proposal for a "late settle" transition (re-reserve, then spend) would close the gap.
- Codex adversarial review (Medium x2):
  - The signed authorization is now checked against the reservation (the row's `amount` and `payee`) right after signing, before `markSigned`, so a mismatched signature is never stored.
  - Before signing, `quote.raw` must also be `scheme: exact` and name the USDC asset (`usdcAddress()`, shared with `getQuote`), not only the right network, amount and payee. Covered by the 2 `(d) quote.raw names ...` tests; removing the asset check fails the token test.
  - The post-sign row check has no test of its own: the x402 client always signs what `raw` says, so a mismatch can't be produced without a fake signer.
- Codex adversarial review (Medium): concurrent `pay()` calls for one payment could each send the stored authorization.
  - The ledger was already safe, and a test now proves it: every write is conditional, so an ambiguous answer's `markUnknown` can't undo `SETTLED`, and the nonce prevents a second transfer. Two separate payments modules on one store (like two gateway processes) retrying at once still end `SETTLED`, never `FAILED`; one caller hears `UNKNOWN`, which is ambiguous but not wrong.
  - Fixed within one process: an in-flight guard per `paymentId`. A concurrent call with the same quote joins the running one and gets the same result, sending nothing. One with a different quote is refused. A retry after the first call finishes sends as before. 3 new `(f)` tests plus the cross-process one; turning the guard off fails 2.
  - Needs the team: across gateway processes, duplicate sends can still reach the merchant (harmless to the ledger, as above). Preventing them needs a store-level lease or claim (a §6 proposal), or one gateway process, or B's `idempotency_key` deduplication upstream of `pay()`.
- Codex adversarial review (Medium): `pay()` acted on its first read of the row, so it could send after the reconciler had already marked the payment `FAILED`.
  - Already harmless after the P5 finality fix: the reconciler only fails `SUBMITTED`/`UNKNOWN` once a finalized block is past `validBefore`, when USDC rejects the authorization, so a send in that window can't settle. A merchant claiming otherwise still raises `SettlementNotRecordedError`.
  - Fixed anyway, to stop pointless sends and misleading answers:
    - `pay()` re-reads the row right before sending. `FAILED` returns `{ state: 'FAILED' }` without sending; any other non-sendable state returns `UNKNOWN`.
    - A retry whose stored `validBefore` has passed by the local clock is not resent (it can't settle); the reconciler resolves it. Using the local clock is safe here: skew can only cause a skipped send, never a wrong decision.
    - If `markUnknown` changes nothing because the row became `FAILED` in flight, `pay()` reports `FAILED` instead of `UNKNOWN`.
  - `pay()` still never calls `store.fail`; it only reports the store's answer. 3 new `(g)` tests; removing each protection fails its test.
- `testing/memory-store.ts`: an in-memory `PaymentStore` with conditional transitions and a call log, used until Chunk 2's store lands.
- `pay.test.ts`: (a) a dropped connection, a 402, a 500, and a 200 without a settlement header all end `UNKNOWN` with no `fail` call, and the row is already `SUBMITTED` when the merchant receives the payment. (b) A retry sends a byte-identical header, `markSigned` is called once, and the retry settles. (c) is `reconcile`, still marked `todo` until P5.
  - Mutation-checked: moving `markSubmitted` after the send fails (a); calling `fail` on a bad merchant response fails the 3 variants; re-signing on retry fails (b).

**Open**

- Not run against the live merchant with the real wallet yet: that spends 0.01 test USDC and needs the `.env` key.
- The validity window is `maxTimeoutSeconds` from the merchant's requirements (300 s = 5 min for PriceScope). We can't shorten it without the merchant rejecting the payment, so a merchant asking for a long window gets one. Tier 0 could cap `maxTimeoutSeconds`.
- `MERCHANT_KEYS_JSON` is not attached yet: the spec doesn't name the header, so this needs a decision.
- The merchant response body is read in full (no cap). Decide whether `/pay` needs one.
- Design.md says a "definitive facilitator rejection" means `FAILED`; the chunk file and P4 say `pay` never fails. We follow the chunk file, so only the reconciler fails payments. Flag to the team.

## 2026-10-24 · P5 `reconcile(paymentId)` and `startReconciler` (branch `chunk1/p4-pay`)

**Done**

- `reconcile.ts`, wired into `createPayments` (`rpcUrl` comes from `BASE_SEPOLIA_RPC_URL`); `startReconciler` is exported from `index.ts`.
  - `SIGNED` -> `fail`, with no chain or merchant contact. If `pay` is mid-flight, its `markSubmitted` then fails and it sends nothing.
  - `SUBMITTED` / `UNKNOWN`: read `USDC.authorizationState(authorizer, nonce)` at the latest block (the authorizer comes from the stored authorization).
    - Used: find the `AuthorizationUsed(authorizer, nonce)` event and `settle(txHash)`, or `settle("unknown")` if it can't be found.
    - Unused and that block's timestamp >= `validBefore`: `fail`. USDC rejects an authorization once `block.timestamp >= validBefore`, so this is proof it can never settle. Expiry is judged by chain time, never the local clock.
    - Otherwise, or if the RPC fails: left as is, returns `UNKNOWN`.
  - `SETTLED` / `FAILED` are returned as they are; `RESERVED` returns `UNKNOWN`. Every transition goes through the store's conditional updates, so running the reconciler twice changes nothing.
  - `startReconciler(payments, store, intervalMs = 10_000)`: one pass immediately, then one every interval after the previous pass ends (passes never overlap). An error on one payment is logged and the pass continues. Returns `stop()`; the timer is `unref`'d.
- Confirmed on-chain before relying on it: for the P2 settlement (block 49499677), `authorizationState` returns `true` for its nonce and `false` for a random one, and its receipt has `AuthorizationUsed` with the nonce as topic 2.
- Tx-hash lookup: the public RPC caps `eth_getLogs` at 200 blocks, so the search goes backwards in 200-block windows from just past `validBefore`, covering 15 min of chain time (at most 50 queries).
  - The first version assumed 2 s blocks. Real Base Sepolia runs at about 0.2 s, so the live check recorded `"unknown"` for the real P2 payment. Fixed by measuring block time over the last 1,000 blocks. A regression test uses 1 s fake blocks.
- Live check (read-only, no key needed): an `UNKNOWN` row for the real P2 nonce -> `SETTLED` with tx `0xbcf31d3f…a41abb15`; an expired, unused nonce -> `FAILED`; a still-valid, unused nonce -> left `UNKNOWN`.
- `reconcile.test.ts`: 14 tests against a fake JSON-RPC endpoint whose clock is far behind the local clock, so a `Date.now()` implementation fails. `(c)` in `pay.test.ts` is no longer `todo`.
  - Mutation-checked: a local-clock expiry fails 2 tests; leaving `SIGNED` alone fails 3; ignoring `authorizationState` fails 5.
- Codex adversarial review (High): an RPC failure, or a row missing data, could leave a payment unresolved forever. We kept "never fail without proof" (an unreadable chain is not evidence the merchant didn't settle) and fixed what was wrong:
  - Wrong-chain RPC: every chain read is now preceded by a `chainId === 84532` check. Before, an RPC on another network read every nonce as unused and **failed payments that had settled**. Verified live: pointed at Base mainnet, both payments stay `UNKNOWN`; before the fix, the expired one was failed.
  - Unreadable `authorization_json`: the authorizer falls back to our own wallet (we only sign as it), so the payment still resolves.
  - Not silent: `config.onStuck(paymentId, reason)` plus `console.error('[reconciler] STUCK …')`, once per payment. It fires for a chain that is still unreadable 10 min past `validBefore` (local clock, used only for alerting, never for decisions), a missing nonce, or a missing `validBefore` with an unused nonce. Chunk 2 should wire `onStuck` to an operator alert.
  - 5 new tests; removing the chain-id check fails the wrong-chain test.
- Codex adversarial review (High): `fail` was decided on the `latest` block, which can be reorged away. A fork without the settlement could read "unused, past validBefore", the row became `FAILED` with the budget released, and the canonical chain then held the settlement. Fixed: `FAILED` now needs the **finalized** block (Base Sepolia: about 16 min / 4,700 blocks behind latest, measured live) to be at or past `validBefore` with the nonce unused **at that finalized block**. Finalized blocks can't change and USDC rejects the authorization after `validBefore`, so this is real proof. A nonce used at the finalized block settles.
  - Cost: an expired, unused payment releases its budget about 16 min after `validBefore` instead of right away. `STUCK_AFTER` was raised to 30 min so payments waiting for finality aren't reported as stuck.
  - Settling on a "used" reading at `latest` is unchanged. If that block is reorged away, the budget was counted as spent early, which is conservative.
  - 3 new tests (expired at latest but not at finalized -> wait; finalized proof -> `FAILED`, read at the finalized block; reorg -> `SETTLED`, never `FAILED`). Deciding on `latest` again fails all 3. Live: an old expired nonce -> `FAILED`, a nonce expired 60 s ago -> `UNKNOWN`, the real P2 payment -> `SETTLED` with its tx.
  - With this, the reconciler can no longer cause the "late settlement after `FAILED`" case. `SettlementNotRecordedError` now only fires if a merchant claims a settlement that the finalized chain shows never happened.
- Suite: 59 tests, 59 pass.
- Codex adversarial review, round 2 (1 Medium, 2 Low), reviewed with no behavior change:
  - Snapshot vs. later state, non-atomic chain read and update: `reconcile(id)` re-reads the row, so the ID snapshot can't go stale in a harmful way. Both facts acted on can't be reversed (a finalized "unused past validBefore" never changes; a used nonce only reverses by reorg, which would just mean the budget was counted as spent early). Conditional updates block regressions. Races with `pay()` are covered by the `(f)` and `(g)` tests. Option for B: expose a promise for the first pass so the gateway can wait for startup recovery.
  - Tx hash `"unknown"`: as specified. The row keeps the nonce, and `AuthorizationUsed` indexes it, so the transaction can be found later.
  - `SIGNED` failed without a chain check: as specified, and test `(c)` asserts no chain calls. The invariant (never send before `markSubmitted`) is enforced by the order of writes plus the pre-send re-read, and tested by `(a)`. A comment at `markSubmitted` in `pay.ts` now states the dependency.

**Open**

- A late settlement after `FAILED` still can't be recorded (no `FAILED -> SETTLED` transition); see the P4 note. The reconciler only fails at or after `validBefore` on chain time, which makes this rare. `pay`'s `SettlementNotRecordedError` still covers it.
- Chunk 2 must call `startReconciler` at gateway startup and `stop()` it on shutdown.
- Not yet covered: A19 (kill the gateway between `markSubmitted` and the response, restart, reconciler resolves it) needs B's real store.

## 2026-10-24 · Merged `main` (B's gateway foundation) into the chunk-1 branch

**Done**

- Resolved the 6 add/add and content conflicts (root `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.env.example`, `apps/gateway/package.json`, `pnpm-lock.yaml`). Kept `main`'s workspace, tooling and gateway config, and added our scripts, our x402/viem dependencies and the `PAYEE_*` keys in `.env.example`. The lockfile was regenerated, passes `--frozen-lockfile`, and our pinned versions pass `minimumReleaseAge`.
- Adopted B's conventions:
  - Types now come from `@apf/contracts` (identical to §5); `types.ts` is deleted.
  - Relative imports use `.js` (NodeNext build); scripts run with `tsx`.
  - Tests run on vitest.
  - Time comes from an injected `Clock`: `createPayments({ store, config, clock? })`, default `systemClock`, per B's "only clock.ts reads the system time" lint rule.
  - Prettier-formatted.
- Full CI set on the merged tree: `lint`, `format:check`, `typecheck` and `build` all pass, and `test` gives 918 passed / 11 todo (all packages, including our 66 payments tests, now `pnpm payments:test`). Smoke-checked: PriceScope answers 402 via `tsx`, and `payments:balance` runs.

**Open**

- B's real `PaymentStore` is now on `main`. Run the payments tests against it (and A19) in addition to `MemoryPaymentStore`.

## 2026-10-24 · critic.md item: keep purchased results (branch `chunk1/codex-fixes`)

**Done**

- Contract: new `PaymentStore.saveResponse(paymentId, { status_code, content_type, body })`, in `packages/contracts/src/types.ts` and `final_contracts.md` §5, marked there as a proposed amendment pending team sign-off. It saves only in `SUBMITTED`/`UNKNOWN`/`SETTLED`, and only the first reply is kept.
- B's SQLite store (`db/payment-store.ts`): one conditional `UPDATE` into the existing `payments.response_json` column. It doesn't touch state, money or `updated_at`. B's tests cover each of the six states, first save wins, survival across a database close/reopen plus a later settle, and an unknown id.
- `pay()`: saves any 2xx body (within the 1 MB cap) **before** deciding settled or unknown. A failed save is logged and never blocks settling. PR #17's `replay()` already returns `payments.response_json` once a payment is `SETTLED`, so a settlement the reconciler finds later now delivers the data instead of `response: null`.
- Tests: 5 new `(i)` tests in `pay.test.ts` (delayed proof, retry keeps the first reply, 402/500/oversized not saved, a failing save still settles) and 9 in B's store test.
  - Mutation-checked: removing the save from `pay()` fails 2 `(i)` tests; dropping the first-save rule from the store fails its test.
- Full CI set passes: lint, format, typecheck, build; tests 1256 passed / 6 todo.

**Open**

- PR #17 must add one pass-through line, `saveResponse: (id, r) => store.saveResponse(id, r)`, to `withPaymentEvents` (and its mock store if typed as `PaymentStore`), or its typecheck fails after rebasing on this. Its own write of `response_json` after a synchronous settle becomes redundant but harmless.
- The end-to-end pipeline test (delayed settlement, then poll and same-key retry return the data) needs PR #17 merged.

## 2026-10-24 · J2b pinned transport (branch `chunk1/j2b`, stacked on `chunk2/land-stack`)

**Done**
- `transport.ts`: the only way payments reaches a merchant. Per request: classify and pin the destination once (brians242's `destination.ts`), connect to exactly that address with no second lookup, keep TLS verifying the real hostname (SNI and identity check), confirm the connected peer, never follow redirects, never use a proxy (fresh unpooled socket).
- `destination.ts` now also requires the origin to be a cataloged merchant. Before this, any public HTTPS host passed (found by the live check).
- `getQuote` and `pay()` take the transport explicitly. `createPayments({ transport })` has no default; tests pass plain `fetch` on purpose.
- `main.ts`: real mode passes `createPinnedTransport(createDestinationVerifier(catalog))`, and the startup block that refused real quotes and payments is removed.
- Tests: 8 transport tests against a real local merchant and a loader-admitted catalog (pinned quote, one lookup per request, rebinding refused, mixed answers refused, uncataloged HTTP/HTTPS refused, redirect not followed, proxy env ignored, `.invalid` hostname proves the pin). Mutation-checked: removing the pin or the catalog check fails its test.
- Live, read-only: `example.com` pinned to a public address and fetched over verified TLS; a wrong hostname on that address refused at TLS; `example.org` (uncataloged) and plain-HTTP public hosts refused.

**Open**
- Not yet done: one real Base Sepolia payment through the gateway in `PAYMENTS_MODE=real` (needs the wallet key in `.env`). This is the 6 PM checkpoint.
- Peer verification is defensive; no test forces a mismatched peer.
- A destination refused inside `pay()` happens after `markSubmitted`, so the payment goes `UNKNOWN` and the reconciler fails it after expiry (nothing was sent).

## 2026-10-24 · Integrated settlement proof (branch `chunk1/settlement-proof`)

**Proven (live, Base Sepolia, through the actual gateway)**
- Setup: gateway in `PAYMENTS_MODE=real` with the J2b pinned transport, `JUDGE_MODE=stub-approve`, temp SQLite DB; PriceScope at `http://localhost:4101`. **This is the exact-loopback demo exception, not HTTPS evidence.** Facilitator: `https://x402.org/facilitator` (the public test facilitator, not CDP's). Signer: local key (`WALLET_PRIVATE_KEY`), payer `0x34be…a582`. Merchant content is synthetic fixture data.
- Mandate `mnd_01M5QP2YJNX6YEHJEHHXHCDMFW` (agt_pricing, subject acme, PriceScope only) → `/pay` → `approved` at stage judge, decision `dec_01M5QP2YJYVV2KT42KGF2GF1XT`, payment `pay_01M5QP2YKFRAX7G2P1FBY2HS9V`, 1.8 s, with PriceScope's Acme body delivered.
- Chain: tx `0xf37bcfdcd361ac3072299e4f15636b17a5ea47dfd36d515b76dd7474309abcb4`, block 49740769, status success. USDC logs show `AuthorizationUsed(0x34Be…, 0x7ab3…a7c4)` and `Transfer 0x34Be… → 0x0d97… 10000`. The stored nonce reads as used on-chain.
- Ledger: payment `SETTLED` with that tx hash; mandate spent 10000, reserved 0; one payments row; saved response sha256 `498d541e…`.
- Same-key replay: same decision and payment returned in 34 ms; still one payments row, spent 10000, same response hash, no new signature.
- Forbidden destinations, live through `/pay`: uncataloged HTTPS host → `UNCATALOGED_ENDPOINT`; `169.254.169.254` → `BAD_URL`; uncataloged path → `UNCATALOGED_ENDPOINT`; all denied at pre-contact with no payment row.

**Bug found and fixed (Chunk 2, pre-contact order)**
- Live: an unselected merchant (SkyData) whose subject also wasn't in the mandate went to human review (`SUBJECT_NOT_IN_MANDATE`, escalate) instead of being denied `MERCHANT_NOT_SELECTED`. Hard denials now run before escalating checks. Regression test added; confirmed live afterwards (`denied MERCHANT_NOT_SELECTED precontact`).

**Not yet proven live**
- Dropped reply + restart and delayed proof on the real chain: these need a merchant failure mode (`/_control drop_after_settle`, P6). Covered by in-process tests with injected timing (Codex, `chunk1/recovery-tests`), labeled as simulated.

## 2026-10-24 · CDP spike: passed (policy enforced remotely, admin/runtime keys separated)
Script: `pnpm --filter @apf/gateway payments:cdp-spike admin` then `... runtime`, as separate processes; `@coinbase/cdp-sdk` pinned at 1.59.0 (1.60.0 is under the 7-day release-age rule). CDP server account `0x432D4cEA07086049E9c2125348285A01c084Fe5B`; policy `60fd197c-c874-4b81-9497-aaf8968a66a1`, created and attached by the admin key; all probes below ran under the runtime key alone.

**Policy:** accept `signEvmTypedData` only when the verifying contract is Base Sepolia USDC, the type is `TransferWithAuthorization`, `to` is PriceScope `0x0d97…86ae` and `value` <= 10000; reject `signEvmHash`, `signEvmMessage`, `signEvmTransaction`, `sendEvmTransaction`.

**Remote results (real CDP API, not a simulator, not client spendControls):**

| Probe | Result |
|---|---|
| 10000 to PriceScope, USDC | signed; signature recovers to the account |
| value 10001 | 403 policy_violation |
| payee = attacker | 403 policy_violation |
| different verifying contract | 403 policy_violation |
| primaryType Permit | 403 policy_violation |
| signHash of an over-cap transfer | 403 policy_violation (**allowed in the first run**, before explicit reject rules) |
| signMessage | 403 policy_violation (**allowed in the first run**) |

**No-match behavior (observed):** within an operation that has rules, a non-matching request is rejected. An operation with **no rules at all is allowed**. So every other signing route needs an explicit reject rule; without one, `signHash` of an over-cap transfer bypasses the typed-data rule.

| runtime key `updatePolicy` (loosen) | 403 Missing required scope: policies#manage |
| runtime key detaches the account policy | 403 Missing required scope: policies#manage; the policy is still attached afterwards |

**Separation: passing.** Policy administration needs the admin key (`CDP_ADMIN_API_KEY_*`); the gateway's runtime key can sign but can't edit or detach its policy.
- Gotcha found: `@coinbase/cdp-sdk` keeps one module-level HTTP client, so the last `CdpClient` constructed in a process decides which key every call uses. An earlier single-process run therefore sent the "runtime" probes with the admin key and wrongly showed separation failing. The gateway must only ever construct the runtime client.
- Remaining trust: whoever holds the admin key, and CDP itself. The wallet secret is shared by both keys in this setup.

**What the policy does NOT check:** HTTP endpoint, subjects, plan or cumulative totals. It is a per-signature cap on payee, value, token and type only.

## 2026-10-24 · CDP signer integrated and proven through the gateway
- Code: `payments/signer.ts` (`PAYMENT_SIGNER=cdp`, pinned `CDP_SIGNER_ADDRESS`); the default stays `local`. No fallback to `WALLET_PRIVATE_KEY`; a CDP refusal or timeout throws before anything is stored or sent.
- Live allowed purchase, gateway in `PAYMENTS_MODE=real PAYMENT_SIGNER=cdp`: payment `pay_01M5QQP5GEAVG0G8XYV3GGR8KD`, decision `dec_01M5QQP5G8RT1NMJZG2K6TDVRM`, approved in 2.0 s with the body delivered. Chain: tx `0x87d139ba2b14352fdfa5f9bd410a6eacfaa6eb0f872ba858d35b8fc26836e6da`, block 49749161, success; `AuthorizationUsed` by CDP account `0x432D4cEA07086049E9c2125348285A01c084Fe5B` and `Transfer 0x432D… → 0x0d97… 10000`; stored nonce used on-chain. Ledger: `SETTLED`, mandate spent 20000 (two purchases), reserved 0.
- Same-key replay: same payment in 31 ms; still 2 payment rows, spent 20000, no new signature.
- Bypassed application check (live): the gateway's CDP adapter, called directly with `pay()`'s checks skipped, asked to sign 500000 to the attacker → `403 policy_violation`.
- Facilitator: public x402.org test facilitator (not CDP's). Merchant: exact-loopback demo exception, synthetic content.
- Not claimed: the CDP policy doesn't know HTTP endpoints, subjects, plans or cumulative totals; it caps each signature's payee, value, token and type.
