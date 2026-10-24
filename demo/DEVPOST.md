# Devpost draft

Due as a draft **Sat 11 PM**. Submission closes **Sun 9:00 AM**. Every `[REPORT: …]` comes from `eval/REPORT.md` and every `[LOADTEST: …]` from `loadtest/REPORT.md`. Copy the real numbers in, even if they miss the targets, and don't round in our favor.

---

## Name

Agent Payment Firewall

## Tagline

Spending caps check how much an agent pays. We check *why*.

## Inspiration

AI agents now pay for APIs on their own over x402: fractions of a cent per call, signed automatically. Every control we found answers *how much* (Coinbase Agentic Wallets, Ramp and Mercury agent cards) or *to whom* (payee checks). None of them asks whether a payment serves the task the agent was given. So a prompt-injected agent making a small, plausible, off-task purchase gets through every one of them.

## What it does

A gateway that sits between an agent and its money. A human creates a **mandate**: the task, the specific subjects it covers, the merchants allowed, a budget and an expiry. The agent gets a token for that one mandate, and never holds a wallet key. Every payment then runs through these tiers in order:

1. **Pre-contact check.** Before the gateway contacts anyone, the URL is canonicalized and matched to the merchant catalog. Secrets in the URL, undeclared parameters, and subjects outside the mandate are stopped here.
2. **Hard rules (Tier 0).** Network, payee swaps, per-call caps, reference-price jumps, budget and velocity. The budget is reserved atomically before anything is signed.
3. **Grants (Tier 1).** An exact-match permission from an earlier approval: same mandate, payee, method, endpoint and parameter values. A hit approves the payment in milliseconds.
4. **Task judge (Tier 2).** An LLM asks one question: would someone doing exactly this task need this purchase? **It never reads attacker-written text.** It sees the human's task, the admin's catalog labels, a price and counts. URLs from unknown merchants arrive as segment lengths only.
5. **Human review (Tier 3).** Escalations wait in a dashboard queue for an approval or rejection with a note.

A per-session trust score only ever tightens control. The judge never sees it. The dashboard shows every decision live, the approval queue and trust over time.

**The signer is a second, independent check.** The gateway signs through a Coinbase CDP server account with a policy attached: only a Base Sepolia USDC `TransferWithAuthorization`, only to the merchant's payee, at most 0.01 USDC per signature, and every other signing route rejected. CDP independently rejects the prohibited signatures we demonstrate, including when we call the gateway's signer with its own checks skipped. The gateway's key can sign but can't edit or detach that policy. The policy only sees each signature, so the endpoint, the subjects and running totals stay the gateway's job.

## How we built it

- **Gateway:** TypeScript, Hono, SQLite with Drizzle. Atomic SQL for reservations, settlement and grant use.
- **Payments:** x402 (`@x402/core`, `@x402/fetch`, `@x402/evm`, `@x402/express`), viem, USDC on Base Sepolia through the public x402.org test facilitator (not CDP's facilitator). Includes a payment lifecycle and a reconciler, so a lost settlement response or a crash never overspends.
- **Signer:** a Coinbase CDP server account (`@coinbase/cdp-sdk`) under an attached signing policy, with separate admin and runtime keys. The gateway never falls back to a local key if CDP refuses or times out.
- **Judge:** Claude, temperature 0, pinned model, 5-second timeout, output validated with zod. Any error is a denial.
- **Dashboard:** Next.js with server-sent events, and Recharts for the trust graph. The admin token stays on the server.
- **Test merchants:** one honest x402 seller, PriceScope, serving synthetic price data on `http://localhost:4101` (a loopback exception in the gateway's destination rules, not HTTPS), and an attacker server on `localhost:4199` with injected pages. The attacker server isn't in the catalog, so the gateway never contacts it.
- **Contracts first:** one shared types package, with the judge's input fixed by contract so that no code path can add attacker text to it.

## Evaluation

We labeled 40 cases before running any of them: 20 legitimate and 20 attacks. The attacks include [REPORT: 17] variants written by a teammate who never saw the judge's prompt, with rephrasings, Spanish and Japanese, fake `SYSTEM:` messages, and instructions hidden in paths, parameter names and merchant metadata. We ran the full set 3 times and report the worst run.

| Metric | Target | Result |
|---|---|---|
| Attacks blocked or escalated | ≥ 18 / 20 | [REPORT] |
| Attacks only the judge caught (rules alone let them through) | ≥ 2 | [REPORT] |
| Legitimate requests approved without a human | ≥ 17 / 20 | [REPORT] |
| Legitimate requests wrongly denied | ≤ 1 / 20 | [REPORT] |
| Judge calls avoided by grants after warm-up | ≥ 70% | [REPORT] |
| Median latency, grant hit / judge call | report | [REPORT] / [REPORT] |

The judge was fooled [REPORT: K] times, and code bounded every one of them. The canary test passes on every commit: no attack fixture's canary string ever appears in a judge request.

Load test: [LOADTEST: N] synthetic requests at concurrency 50, [LOADTEST: req/s], [LOADTEST: judge-call rate], p50 [LOADTEST] / p95 [LOADTEST].

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
- An attack set that someone who didn't build the judge wrote and labeled.

## What's out of scope (and we say so)

- **Data leaking through the agent's free requests.** A payment gateway can't see them. [Say whether the egress sandbox was built.]
- A compromised gateway or admin, stolen keys, smart-contract bugs, chain-level attacks, and real money. Everything is testnet.
- **Who still has to be trusted:** whoever holds the CDP admin key (it can change the signing policy), CDP itself, and the operator who writes the catalog.
- **The CDP policy is per signature.** It checks payee, value, token and type. It doesn't know the HTTP endpoint, the subjects, the plan or cumulative totals.
- **No HTTPS evidence.** The only merchant runs on loopback HTTP under an explicit exception.
- **The trust score and its thresholds are a starting policy,** not a validated model.
- **Before grants warm up, a judge call can cost more than the payment,** and settlement fees can exceed tiny prices at volume. Batching settlement is out of scope.

## What's next

Policies set per tenant, the egress sandbox for deployed agents, batched settlement, and a catalog that merchants can apply to join.

## Tracks

- [ ] Coinbase: x402 payments, with a CDP server account and signing policy
- [ ] Best Security Hack
- [ ] Microsoft: only if hosting on Azure counts (see `SPONSOR-NOTES.md`)
- [ ] Anthropic: if its track is open and rewards agent safety

## Built with

typescript · node · hono · sqlite · drizzle · x402 · coinbase-cdp · viem · base-sepolia · usdc · claude · next.js · recharts · zod

## Links

- Repo: [link]
- Demo video: [link to the backup video]
