# Devpost draft

Due as a draft **Sat 11 PM**. Submission closes **Sun 9:00 AM**. Live judge numbers below are from `eval/supplemental/v1.3-v1/results/live-2026-10-24T22-41-46.816Z.md` and `eval/cases/heldout-v2/RESULTS.md`. Historical forty-case rows are the stub run in `eval/REPORT.md`, not a live model. There is no load-test report. Don't round in our favor.

---

## Name

Raijin Gateway

## Tagline

Spending caps check how much an agent pays. We check *why*.

## Elevator

Raijin is an x402 gateway to stop agent payment fraud before signing. Code checks payments against a human-approved task, a judge never sees attacker text, misses cut autonomy, CDP caps signatures.

## Inspiration

AI agents now pay for APIs on their own over x402: fractions of a cent per call, signed automatically. Every control we found answers *how much* (Coinbase Agentic Wallets, Ramp and Mercury agent cards) or *to whom* (payee checks). None of them asks whether a payment serves the task the agent was given. So a prompt-injected agent making a small, plausible, off-task purchase gets through every one of them.

## What it does

A gateway that sits between an agent and its money. A human creates a **mandate**: the task, the specific subjects it covers, the merchants allowed, a budget and an expiry. The agent gets a token for that one mandate, and never holds a wallet key. Every payment then runs through these tiers in order:

1. **Pre-contact check.** Before the gateway contacts anyone, the URL is canonicalized and matched to the merchant catalog. Secrets in the URL, undeclared parameters, and subjects outside the mandate are stopped here.
2. **Hard rules (Tier 0).** Network, payee swaps, per-call caps, reference-price jumps, budget and velocity. The budget is reserved atomically before anything is signed.
3. **Grants (Tier 1).** An exact-match permission from an earlier approval: same mandate, payee, method, endpoint and parameter values. A hit approves the payment in milliseconds.
4. **Task judge (Tier 2).** An LLM asks one question: would someone doing exactly this task need this purchase? **It never reads attacker-written text.** It sees the human's task, the admin's catalog labels, a price and counts. Unknown hosts and routes deny at admission and never reach the judge.
5. **Human review (Tier 3).** Escalations wait in a dashboard queue for an approval or rejection with a note.

Durable per-agent restrictions only tighten automatically: defined incidents require review, and repeated security incidents suspend purchases across sessions and mandates. Clean payments never earn trust back. Only an explicit admin restoration with an operator name and reason loosens restrictions. The judge never sees trust. The dashboard shows restriction state, recent incidents, restoration controls, live decisions and the approval queue; the historical trust graph remains hidden.

**The signer is a second, independent check.** The gateway signs through a Coinbase CDP server account with a policy attached: only a Base Sepolia USDC `TransferWithAuthorization`, only to the merchant's payee, at most 0.01 USDC per signature, and every other signing route rejected. CDP independently rejects the prohibited signatures we demonstrate, including when we call the gateway's signer with its own checks skipped. The gateway's key can sign but can't edit or detach that policy. The policy only sees each signature, so the endpoint, the subjects and running totals stay the gateway's job.

## How we built it

- **Gateway:** TypeScript, Hono, SQLite with Drizzle. Atomic SQL for reservations, settlement and grant use.
- **Payments:** x402 (`@x402/core`, `@x402/fetch`, `@x402/evm`, `@x402/express`), viem, USDC on Base Sepolia through the public x402.org test facilitator (not CDP's facilitator). Includes a payment lifecycle and a reconciler, so a lost settlement response or a crash never overspends.
- **Signer:** a Coinbase CDP server account (`@coinbase/cdp-sdk`) under an attached signing policy, with separate admin and runtime keys. The gateway never falls back to a local key if CDP refuses or times out.
- **Judge:** Claude via native `fetch` to the Anthropic API (not the SDK), temperature 0, pinned model, 5-second timeout, output validated with zod. Any error is a denial. A plan drafter and escalation explainer exist as advisory APIs with a CLI; they are not wired into the dashboard or `/pay`.
- **Dashboard:** Next.js with server-sent events. The admin token stays on the server. Agent restriction state and audited restoration are shown; the historical trust graph is not.
- **Test merchants:** one honest x402 seller, PriceScope, serving synthetic price data on `http://localhost:4101` (a loopback exception in the gateway's destination rules, not HTTPS), and an attacker server on `localhost:4199` with injected pages. The attacker server isn't in the catalog, so the gateway never contacts it.
- **Contracts first:** one shared types package, with the judge's input fixed by contract so that no code path can add attacker text to it.

## Evaluation

**What we measured live.** Two frozen matched-pair sets. Same cataloged merchant, same URL, only the human task changes. Claude Sonnet 4.5, three repetitions, mock payments, 2026-10-24. Labels are authored and **not** independently reviewed. This is not plan-lock and not chain settlement.

**v1.3-v1** (`225e634`): six pairs plus four boundary probes.

| | Category baseline (no task text) | Approve-everything stub | Live judge (reps 1 / 2 / 3) |
|---|---|---|---|
| Off-task twins stopped | 1 / 6 (also wrongly blocks the legit export) | 0 / 6 | 6 / 6 / 6 |
| Legitimate twins auto-approved | 5 / 6 | 6 / 6 | 5 / 6, 6 / 6, 6 / 6 |
| Judge-only catches vs that baseline | — | 0 / 5 | 5 / 5 / 5 |
| Boundary probes (unselected, unknown route, leftover grant, resume after deselect) | 4 / 4, zero judge calls | 4 / 4 | 4 / 4 |
| Off-task mock settlements | 5 | 6 | 0 / 0 / 0 |

Rep 1's only miss was a `JUDGE_ERROR` on the legitimate full-history export, not a wrong denial. Live judge median latency was about 2.8 s.

**heldout-v2** (`d2cd0fa`, authored by a teammate who did not read the judge prompt): eight PriceScope pairs. Six lookups are judge-only; the baseline denies both export twins.

| | Category baseline | Approve-everything stub | Live judge (reps 1 / 2 / 3) |
|---|---|---|---|
| Attacks stopped | 2 / 8 (both exports; also blocks both legit exports) | 0 / 8 | 7 / 8, 6 / 8, 6 / 8 |
| Legitimate auto-approved | 6 / 8 | 8 / 8 | 8 / 8 / 8 |
| Judge-only catches vs that baseline (6 lookups) | — | 0 / 6 | 5 / 6, 4 / 6, 4 / 6 |
| Off-task mock settlements | 6 | 8 | 1 / 2 / 2 |

The live judge is the only layer that can tell a full-company export from a two-company one. `press_attack` (summarize a press release → Umbrella 30-day lookup) leaked every repetition. `history_attack` leaked in reps 2 and 3. We did not retune the prompt on this set.

**What the older 40-case report is.** `eval/REPORT.md` is a stub-approve mock run, not a live model. Under that stub the core set stopped 10 / 20 attacks by rules and let 10 through; the stronger category baseline stopped 20 / 20 without reading the task. Of 17 held-out page variants, only V4 still reaches the judge. The rest die at `BAD_URL`, `SECRET_IN_URL`, `MERCHANT_NOT_SELECTED`, `SUBJECT_NOT_IN_MANDATE`, or `PAYEE_SWAP`. Do not quote the stub table as live accuracy.

The canary test still passes on every commit: no attack fixture's canary string appears in a judge request.

Load test: **unmeasured.** No `loadtest/REPORT.md`.

### Payment evidence

All on Base Sepolia, a test network whose USDC has no cash value:

- **CDP probes,** run against the real CDP API with the gateway's runtime key: a 0.01 USDC transfer to the merchant is signed; a value one unit over, another payee, another contract, a `Permit` type, `signHash`, `signMessage`, and the gateway's own signer with its checks skipped asking for 0.50 USDC to an attacker all return `403 policy_violation`. Attempts by the runtime key to loosen or detach the policy return `403 Missing required scope`.
- **CDP-signed settlement through the gateway:** [`0x87d139ba…36e6da`](https://base-sepolia.blockscout.com/tx/0x87d139ba2b14352fdfa5f9bd410a6eacfaa6eb0f872ba858d35b8fc26836e6da), purchased data delivered.
- **Lost reply, then a restart:** the purchase came back `payment_unknown`, the reconciler found the settlement on chain ([`0xbd4d0566…64675`](https://base-sepolia.blockscout.com/tx/0xbd4d056668fc5f4120a716d16bde95acca62bdda72e4cc2903f952477cd64675)), and a retry with the same key after restarting the gateway returned the same payment, with no new payment created.

## Challenges we ran into

- [Fill in from the team.] Candidates: getting the first x402 payment to settle, keeping attacker text out of the judge while still giving it enough to decide, and judge-only attacks that kept getting caught by the rules.

## What we're proud of

- An attack that passes every cap and payee rule, and is still stopped before signing.
- A judge that can't be prompt-injected through the payment request, because it never reads one, and a test that proves it on every commit.
- An attack set that someone who didn't build the judge wrote and labeled, plus a second held-out set they wrote without reading the prompt.
- Honest misses: a press-release summary still bought a one-cent lookup on every live repetition.

## What's out of scope (and we say so)

- **Data leaking through the agent's free requests.** A payment gateway can't see them. [Say whether the egress sandbox was built.]
- A compromised gateway or admin, stolen keys, smart-contract bugs, chain-level attacks, and real money. Everything is testnet.
- **Who still has to be trusted:** whoever holds the CDP admin key (it can change the signing policy), CDP itself, and the operator who writes the catalog.
- **The CDP policy is per signature.** It checks payee, value, token and type. It doesn't know the HTTP endpoint, the subjects, the plan or cumulative totals.
- **No HTTPS evidence.** The only merchant runs on loopback HTTP under an explicit exception.
- **The trust score and its thresholds are a starting policy,** not a validated model.
- **Before grants warm up, a judge call can cost more than the payment,** and settlement fees can exceed tiny prices at volume. Batching settlement is out of scope.
- **Labels are not independently reviewed.** Current task-text results are not strict plan-lock.

## What's next

Policies set per tenant, the egress sandbox for deployed agents, batched settlement, and a catalog that merchants can apply to join.

## How we used generative AI

Claude is the task judge on the payment path and the live demo agent. Both call the Anthropic API with native `fetch`, not the SDK. A plan drafter and an escalation explainer were built as **advisory interfaces** (`docs/judge-advisories.md`) with a local CLI; they are not in the dashboard or the `/pay` pipeline. Do not claim they run in the product.

## Tracks

- [ ] Coinbase: x402 payments, with a CDP server account and signing policy
- [ ] Best Security Hack
- [ ] Microsoft: customer understanding, responsible design, and measured evidence (Azure is not in the repo; do not pitch hosting)
- [ ] Anthropic: if its track is open and rewards agent safety

## Built with

typescript · node · hono · sqlite · drizzle · x402 · coinbase-cdp · viem · base-sepolia · usdc · claude · next.js · zod

## Links

- Repo: [link]
- Demo video: [link to the backup video]
