# Agent Payment Firewall

Spending caps check how much an AI agent pays. This gateway checks *why*.

AI agents can now pay for APIs on their own over [x402](https://x402.org): the API answers `402 Payment Required` with a price, and the agent signs a USDC payment. Caps and allowlists check the amount and the payee. They don't check whether the purchase serves the task the agent was given, so a prompt-injected agent making a small purchase from an approved vendor gets through. Agent Payment Firewall sits between the agent and its money, and checks every payment against the human's task before anything is signed.

Built at Cal Hacks 13.0. Testnet only (USDC on Base Sepolia).

## How it works

```
 human ──creates──▶ mandate (task, subjects, merchants, budget, expiry)
                        │ token
                        ▼
 agent ──POST /pay──▶ gateway ──────────────────────────────▶ CDP signer ──▶ x402 merchant
                        │  1. pre-contact check (catalog, URL, subjects)      (signing policy)
                        │  2. hard rules + atomic budget reservation
                        │  3. grants (exact-match earlier approvals)
                        │  4. task judge (Claude, never sees attacker text)
                        │  5. human review (dashboard approval queue)
                        ▼
                    dashboard (live decisions, approvals, agent restrictions)
```

- **Mandates.** A human creates a mandate on the dashboard: the task in plain language, the subjects it covers, the catalog merchants allowed, a budget and an expiry. The agent gets a token for that one mandate and never holds a wallet key.
- **Tiers.** Every payment runs through the five tiers above, in order. Any of them can stop it. Rules handle everything they can see (unknown sites, unknown routes, secrets in URLs, caps, payee swaps). The judge handles what's left: a purchase that looks the same whether or not the task needs it.
- **The judge reads no attacker text.** It gets the human's task, the admin's catalog labels, prices and counts. URL paths, query strings, page content and merchant descriptions reach it only as numbers, lengths or fixed-list values, or not at all. A canary test enforces this in CI.
- **Trust only tightens.** Each session has a score that only falls; below 60 it loses grants, below 40 everything goes to a human, below 20 it's quarantined. Security incidents move the agent itself from `normal` to `review_required` to `suspended`, across all its sessions and mandates. Clean purchases never earn trust back. Only an admin restoration, with a name and reason, loosens it. Trust never raises a limit, and the judge never sees it.
- **The signer is a second check.** In real mode the gateway signs through a Coinbase CDP server account with a policy attached: only Base Sepolia USDC, only to the merchant's payee, at most 0.01 USDC per signature. The gateway holds only the runtime key, which can't edit or detach that policy.

For the full design, see [Design.md](design-docs/Design.md), [architecture](docs/architecture.md) and [trust design](design-docs/trust-design.md).

## Quick start (offline, no keys)

Needs Node 22.13 or later (`.nvmrc`) and pnpm. Corepack installs the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install
cp .env.example .env
```

Then try any of these. None of them needs a network connection or an API key.

```bash
pnpm test               # all tests
pnpm agent:rehearse     # demo agent: legit flow and off-task attack, end to end, mock payments
pnpm trust:rehearse     # narrated trust beat: incident → review queue → restoration
pnpm eval:v13:offline   # matched-pair evaluation with stub judges
```

To look at the dashboard without a gateway, put `MOCK=1` in `apps/dashboard/.env.local` and run `pnpm --filter dashboard dev`. Every route then returns fixed data and the live feed plays a scripted loop.

## Running the full stack locally

Five processes. Each command runs from the repo root unless noted.

### 1. Configure

Root `.env`:

| Variable | What to set |
|---|---|
| `ADMIN_TOKEN` | Any string of 16+ characters. The dashboard uses the same value. |
| `JUDGE_MODE` | `real` for Claude; `stub-escalate` (send everything to a human) or `stub-approve` for offline runs |
| `JUDGE_MODEL` | `claude-sonnet-4-5-20250929` or `claude-haiku-4-5-20251001`. Anything else fails at startup. |
| `ANTHROPIC_API_KEY` | Needed when `JUDGE_MODE=real` and for live agents in the worker lab |
| `PAYMENTS_MODE` | `mock` (no merchant contact, every quote is $0.01) or `real` (settles on Base Sepolia) |
| `PAYMENT_SIGNER` | `local` (uses `WALLET_PRIVATE_KEY`) or `cdp` (needs `CDP_SIGNER_ADDRESS` and the CDP runtime keys `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) |

Keep the CDP **admin** key out of the gateway's environment; it's the key that can change the signing policy. Never use a mainnet key. Never commit `.env`.

`apps/dashboard/.env.local`:

```
ADMIN_TOKEN=<same value as the root .env>
GATEWAY_URL=http://localhost:4000
DASHBOARD_PASSWORD=<any operator password>
```

### 2. Start everything

| Service | Command | Port |
|---|---|---|
| Gateway | `pnpm --filter @apf/gateway dev` | 4000 |
| PriceScope (honest merchant) | `pnpm merchants:pricescope` | 4101 |
| Attacker pages | `pnpm merchants:attacker` | 4199 |
| Dashboard | `pnpm --filter dashboard dev` | 3000 |
| Worker lab | `pnpm agent:lab` | 4010 |

The gateway creates and seeds its SQLite database (`apps/gateway/gateway.db`) on first start. Delete it, along with its `-wal` and `-shm` files, to reset agents' trust.

For real payments, fund the payer with Base Sepolia test USDC. `pnpm payments:wallets` generates test wallets and `pnpm payments:balance` checks the local-key payer. A CDP account's balance has to be checked on an explorer.

### 3. Use it

1. Open `http://localhost:3000` and sign in with `DASHBOARD_PASSWORD`.
2. **Create a mandate.** Pick an agent, write the task (be specific: "Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli"), add the subjects, tick the merchants, and set a budget and expiry. The dashboard shows the mandate token once; it's also loaded into the worker lab for that tab.
3. **Run a worker.** In **Worker lab**, pick the mandate and a page served by the attacker server (`research`, `demo`, `live` and the others listed in `demo/pages/manifest.json`). Choose **Live model** to let Claude decide what to buy, or **Compromised** to always attempt the page's intended purchase. Two panes let you run them side by side.
4. **Watch decisions.** Each payment appears in **Decisions** with its tier, outcome, reason code and latency. Click a row for the full event. Payments show their status and, in real mode, a link to the transaction.
5. **Answer escalations.** Purchases routed to a human wait in **Approval queue**. Approve or reject with a note. Unanswered requests auto-deny after 10 minutes.
6. **Restore an agent.** Agent cards show restriction state and recent incidents. Restoring takes an operator name and a reason, and is logged.

To try the headline attack: create a mandate with the task "Write a short greeting for Acme's partnerships team" (subject `acme`, merchant PriceScope), then run the **Compromised** profile on the `demo` page. Expect `judge · denied · JUDGE_OFF_TASK`. Run it again and the agent is in review: `pending · AGENT_REVIEW_REQUIRED`. The full demo is in [demo/SCRIPT.md](demo/SCRIPT.md).

Edit `demo/pages/live.txt` to write your own injection. The attacker server re-reads it on every request.

### Calling the gateway from your own agent

Agents call one endpoint with their mandate token, then poll the decision:

```bash
K=$(uuidgen | tr A-Z a-z)
curl -s http://localhost:4000/pay \
  -H "authorization: Bearer $MANDATE_TOKEN" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $K" \
  -d '{"url":"http://localhost:4101/v1/pricing/acme?period=30d","method":"GET",
       "expected_price":10000,"purpose":"fetch_data","idempotency_key":"'$K'"}'
```

Prices are in atomic USDC (`10000` = $0.01). Retrying with the same key returns the same result and never pays twice. Poll `GET /decisions/:id` and `GET /payments/:id` for the outcome. An agent can't create, edit or close mandates; those routes return 403 for a mandate token. All routes and schemas are in [final_contracts.md](design-docs/final_contracts.md).

## Evaluation

Matched pairs: the same merchant and URL under two different human tasks, one that needs the purchase and one that doesn't.

| | Rules-only baseline | Live judge, Sonnet 4.5 (3 runs) |
|---|---|---|
| Set v1.3-v1 (6 pairs): off-task stopped | 1 / 6 | 6 / 6 / 6 |
| Set v1.3-v1: legitimate auto-approved | 5 / 6 | 5 / 6, 6 / 6, 6 / 6 |
| Held-out v2 (8 pairs, written without seeing the judge prompt): off-task stopped | 2 / 8 | 7 / 8, 6 / 8, 6 / 8 |
| Held-out v2: legitimate auto-approved | 6 / 8 | 8 / 8 / 8 |

Mock payments, 2026-10-24. Labels are authored by the team and not independently reviewed. One known miss: summarizing a press release still buys an off-task lookup on every run. Full results: [v1.3-v1](eval/supplemental/v1.3-v1/results/), [held-out v2](eval/cases/heldout-v2/RESULTS.md). The older [`eval/REPORT.md`](eval/REPORT.md) is a stub run, not a live model.

```bash
pnpm eval:v13:offline         # stub judges, no key
pnpm eval:heldout-v2:offline
pnpm eval:v13:live            # live Claude, needs ANTHROPIC_API_KEY exported; costs money
pnpm eval:heldout-v2:live
```

## Repository layout

| Path | What's there |
|---|---|
| `packages/contracts` | Shared types, zod schemas, reason codes and limits. The source of truth for every interface. |
| `apps/gateway` | Hono API and the `/pay` pipeline: pre-contact checks, rules, reservations, grants, trust, judge, human review |
| `apps/gateway/src/payments` | x402 quotes, signing (local or CDP), payment lifecycle and on-chain reconciler |
| `apps/gateway/src/judge` | Builds the sanitized judge input, calls Claude, validates the answer |
| `apps/merchants` | PriceScope (honest x402 seller) and the attacker page server |
| `apps/dashboard` | Next.js operator UI: mandates, decisions, approvals, agent restrictions, worker lab |
| `apps/agent` | Two-tool Claude worker (`fetch_url`, `paid_fetch`), the lab server and rehearsals |
| `catalog/catalog.json` | Merchant catalog: endpoints, categories, parameter rules |
| `eval/` | Evaluation cases, runners and reports |
| `demo/` | Demo script, run sheet and injected pages |
| `design-docs/`, `docs/` | Design specs and team docs |

## Development

| Command | What it does |
|---|---|
| `pnpm test` | All workspace tests (Vitest), including `eval/` |
| `pnpm test:coverage` | Tests with a coverage report |
| `pnpm run typecheck` | TypeScript project build, then `eval/` and colocated tests |
| `pnpm run lint` | ESLint, including the project's safety rules |
| `pnpm run format:check` | Prettier check (`pnpm run format` to fix) |
| `pnpm run build` | Compile every package to `dist/` |

Some safety rules are enforced by lint and tests, so breaking one fails CI: only `src/judge/` may call the model, pre-network pipeline files can't call `fetch` or import payments code, empty `catch` blocks are banned, and no attack fixture's canary string may appear in a judge request.

Payment and gateway-startup tests open local TCP sockets, so they fail in sandboxes that block `listen`. Run them on your own machine.

## Limitations

- **Free requests.** A payment gateway only sees payments. A hijacked agent can still leak data through ordinary requests.
- **Testnet only.** Base Sepolia test USDC; nothing here has handled real money.
- **Loopback HTTP.** The only merchant runs on `http://localhost:4101` under an explicit exception, not HTTPS.
- **The CDP policy is per signature.** It checks payee, value, token and type, not endpoints, subjects or running totals. Those are the gateway's job.
- **Trust thresholds are a starting policy,** not a tuned or validated model.
- **Who still has to be trusted:** the gateway operator, whoever holds the CDP admin key, CDP itself, and whoever writes the catalog.

More in [open-issues.md](docs/open-issues.md).

## Contributing

Squash and merge PRs. Change the docs in the same PR as the code they describe. Keys are testnet only, and `.env` is never committed.

Team docs start at [docs/README.md](docs/README.md). Chunk specs: [payments](design-docs/CHUNK-1-PAYMENTS.md), [gateway](design-docs/CHUNK-2-GATEWAY.md), [judge, agent and eval](design-docs/CHUNK-3-JUDGE-AGENT-EVAL.md), [dashboard and demo](design-docs/CHUNK-4-DASHBOARD-DEMO.md).
