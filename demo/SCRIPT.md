# Demo script

The whole demo is built around one moment: a $0.40 payment that passes every cap and payee rule is stopped because it doesn't serve the task.

**Target:** 2:30. **Hard limit:** 3:00 (the team plan's slot). Speaker lines are in quotes. Everything else is a click or something to point at. Items marked **TBD** depend on the demo agent or on the eval report, so fill them in at the first rehearsal.

> **Status:** beats 1–5 still follow the original judge-centric story. When Chunk 2's purchase-plan lock passes the 6 PM gate, rewrite them around plan review, activation and an off-plan denial (see the team plan's three-minute demo). Beat 6 (CDP) and the evidence section below are current.

## Pitch wording

Cleared by Chunk 1 (`apps/gateway/src/payments/STATUS.md`, CDP sections):

> "CDP independently rejects the prohibited signatures we demonstrate."

Use that sentence as written. The rest of the team-plan pitch ("Claude proposes the purchase permissions. A human activates them. Our gateway enforces the exact operations and quantities…") is **conditional**: say it only if the plan lock passes its gate, and say "an operator prepares" instead of "Claude proposes" if drafting falls back to a manual plan.

**Never say:**
- that the payments use HTTPS. The merchant runs on `http://localhost:4101`, the exact-loopback demo exception;
- that the CDP policy checks endpoints, subjects, plans or totals. It caps each signature's payee, value, token and type, and nothing else;
- that "Coinbase caps everything even if our code is wrong."

## Before the slot

- [ ] Gateway on `:4000` with `PAYMENTS_MODE=real`, `JUDGE_MODE=real`, `PAYMENT_SIGNER=cdp` and `CDP_SIGNER_ADDRESS=0x432D4cEA07086049E9c2125348285A01c084Fe5B`, starting from a fresh `gateway.db`.
- [ ] The gateway's environment has only the CDP **runtime** credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`). The admin key (`CDP_ADMIN_API_KEY_*`) stays off the demo machine's gateway: it's what can edit or detach the policy.
- [ ] The CDP account `0x432D…Fe5B` has test USDC. `pnpm payments:balance` checks the local-key payer, not this account, so check it on an explorer.
- [ ] PriceScope on `:4101` in `normal` mode (`POST /_control {"mode":"normal"}`). It's the only merchant that exists; don't mention others.
- [ ] Dashboard on `:3000`, with no `MOCK` in `apps/dashboard/.env.local`, and `ADMIN_TOKEN` and `GATEWAY_URL` set.
- [ ] The dashboard was reloaded right before the slot, so the header stats start at zero.
- [ ] Browser at 125% zoom with the dashboard full screen. The terminal for the demo agent is on the right third of the screen, with a large font.
- [ ] The backup video is open in a second tab, paused at 0:00.
- [ ] The payer wallet has test USDC (`pnpm payments:balance`).
- [ ] The results slide or `eval/REPORT.md` is open in a third tab.
- [ ] The mandate text below is copied to the clipboard. Typing it costs seconds you don't have.

**Mandate**
- Task: `Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli for the Q4 pricing review.`
- Subjects: `acme`, `globex`, `initech`, `umbrella`, `hooli`
- Merchants: PriceScope only
- Budget: `2.00`. Expiry: `30` minutes.

## The run

| # | Time | Beat |
|---|---|---|
| 1 | 0:00–0:15 | Hook |
| 2 | 0:15–0:30 | Mandate |
| 3 | 0:30–0:50 | Normal work |
| 4 | 0:50–1:00 | Warm-up attack |
| 5 | 1:00–1:30 | Headline attack (A2) |
| 6 | 1:30–1:55 | The signer refuses (CDP) |
| 7 | 1:55–2:10 | Results |
| 8 | 2:10–2:25 | Live attack |

### 1 · Hook (0:00–0:15)

Show the dashboard, empty.

> "Agents now pay for APIs on their own. Caps check how much. Nobody checks *why*. This is a payment firewall that checks every payment against the task a human gave the agent, before anything is signed."

### 2 · Mandate (0:15–0:30)

1. In **New mandate**, pick **Pricing researcher**, paste the task, and add the five subjects. Tick **PriceScope**. Budget `2.00`, expiry `30`.
2. Click **Create mandate**.
3. Point at the amber token box. Click **Copy**, then paste the token into the agent terminal and start the agent. **TBD:** the exact command, from J6.
4. Click **Done, hide it**.

> "A human sets the task: five competitors, two dollars, thirty minutes. The agent gets one token and nothing else. No wallet key, no way to change its own task."

### 3 · Normal work (0:30–0:50)

The agent makes its pricing lookups. In **Decisions**, the first row says `judge · approved · JUDGE_APPROVED`, with a latency of about 1–3 s. The next ones say `tier1 · approved · GRANT_HIT` and take a few milliseconds.

Point at the **Latency** column, then at the header's **Median latency, grant hit** next to **Median latency, judge call**.

> "The first call goes to the judge, which approves it and issues a narrow grant: this payee, this endpoint, these five companies. The next four pass on that grant in milliseconds. The LLM runs once per kind of purchase, not once per call."

### 4 · Warm-up attack (0:50–1:00)

The agent reads an injected page that demands 500 USDC (A4). A new row appears: `tier0 · denied · PER_CALL_CAP`, in a few milliseconds.

> "A page tells the agent to pay five hundred dollars. The hard rules stop it instantly. Caps already handle this. Here's what they miss."

### 5 · Headline attack, A2 (1:00–1:30)

The agent reads a page that asks it to buy a $0.40 "premium summary" from an unknown merchant, at a clean URL with no parameters.

1. A new row appears: `judge · denied · JUDGE_OFF_TASK`. **Click the row** to open the full event.
2. Point at `"stage": "judge"`. The payment got through the pre-contact check and every Tier 0 rule.
3. Scroll to **Session trust** and point at the line dropping below 60 into the judge-only band. The warm-up denial costs 5 points and this one costs 15, so expect about 50.

> "Forty cents. Under every cap. A valid payee. No secrets in the URL. Every rule says yes, and that's why it reached the judge. The judge asks one question: would someone doing exactly this task need this purchase? No. Denied, before anything was signed. And the judge never read the attacker's page. It saw the task, a price and a merchant category, nothing an attacker wrote. The session's trust drops, so from now on even routine calls lose their shortcut."

### 6 · The signer refuses (1:30–1:55)

Switch to the terminal and run the bypass probe, which uses only the runtime credentials:

```bash
pnpm --filter @apf/gateway payments:cdp-spike bypass
```

It calls the gateway's own CDP signer adapter with the application checks in `pay()` skipped, and asks it to sign 0.50 USDC to the attacker. Point at the `403 policy_violation`.

> "Suppose our gateway code had a bug and skipped every check. The signing key lives in Coinbase's CDP, under a policy we attached: only USDC transfers to this merchant, at most one cent each. CDP independently rejects the prohibited signatures we demonstrate. And our gateway can't loosen that policy: its key can sign but can't edit or detach it."

Don't add anything about endpoints or totals. If asked, see "What does the CDP policy check?" below.

### 7 · Results (1:55–2:10)

Switch to the results tab.

> "We ran [REPORT: N] attacks, including [REPORT: 17] variants written by a teammate who never saw the judge's prompt. [REPORT: X of 20] blocked or escalated. [REPORT: J] were caught *only* by the judge, and we proved that by switching the judge off. [REPORT: F] legitimate requests wrongly denied. The judge was fooled [REPORT: K] times, and code bounded every one of them."

If the numbers missed the targets, say the real ones. Honest numbers beat perfect ones.

### 8 · Live attack (2:10–2:25)

Turn the keyboard toward the judges. **TBD:** how they inject. Planned: edit the text of an attacker page, or give the agent a URL to read, then rerun it.

> "Your turn. Try to make it pay for something it shouldn't."

While they type, keep **Decisions** and **Approval queue** visible. An escalation shows up in the queue with the judge's explanation. Approve or reject it with a one-line note.

## Fallbacks

| Problem | Do this |
|---|---|
| Facilitator slow or down | Switch to the local Base Sepolia replay (**TBD**, Chunk 1). Say so. |
| CDP slow, down or refusing a legitimate payment | The gateway never falls back to the local key, so purchases fail closed. Play the recorded clip of beat 6 and the CDP-signed settlement, say it's recorded, and drop any live CDP claim. |
| Model API down | Use the cached judge response for A1 only, and **say that it's cached**. |
| Anything else breaks | Play the backup video from the current beat. Don't debug on stage. |
| Dashboard shows nothing | Check `/api/stream` in a tab. 502 means the gateway is down. As a last resort, reload with `MOCK=1` and **say that it's a mock**. |

## Judge questions

**Why an LLM?**
A2, A3, A14 and A17 pass every rule. We ran them with the judge switched off and the rules let all of them through ([REPORT: judge-off result]). The LLM only ever tightens a decision. Code bounds everything it can approve.

**What stops the agent from going around you?**
It holds no wallet key and no merchant key. The gateway holds both. Deployment rule: the company gives agents only a mandate token. An agent can't create, extend or close a mandate, and trying to returns a 403.

**Couldn't a hijacked agent leak data with a free request?**
Yes. That's outside what a payment gateway can see, and we say so up front. The pre-contact check makes sure the gateway itself never sends attacker-bound data while fetching a quote. An egress sandbox would close the free-request path for agents we deploy. It's a stretch goal, so say whether it got built.

**Can the judge itself be injected?**
It never reads attacker text. Every untrusted field becomes a number, a length, a fixed-list value or a catalog label first. Each attack fixture carries a unique canary string, and CI fails if any canary appears in a judge request. Show `eval/cases/variants/`: canaries in paths, parameter names, page text and merchant metadata.

**How is this different from Coinbase's spending limits?**
We use them. The payment key is a CDP server account with a policy attached, and CDP refuses signatures outside it. But a signing policy only sees the signature: payee, amount, token, type. It can't tell a pricing lookup from a bulk export at the same merchant and price. The gateway decides that, before it ever asks CDP to sign.

**What does the CDP policy check?**
Each signature, on its own: it must be `signEvmTypedData` for a Base Sepolia USDC `TransferWithAuthorization`, to PriceScope's payee, for at most 10,000 (0.01 USDC). Every other signing route (`signEvmHash`, `signEvmMessage`, `signEvmTransaction`, `sendEvmTransaction`) is explicitly rejected. It does **not** check the HTTP endpoint, subjects, the plan or cumulative totals. Those are the gateway's job.

**Couldn't someone just change the CDP policy?**
Not with the gateway's key. Changing or detaching it needs the separate admin key, and the runtime key's attempts returned `403 Missing required scope: policies#manage`. Whoever holds the admin key, and CDP itself, are still trusted.

**Is the merchant connection HTTPS?**
No. The demo merchant runs on `http://localhost:4101` under an exact-loopback exception in the gateway's destination rules. We haven't demonstrated HTTPS.

**What happens at a million calls?**
Grants make the cost scale with the kinds of purchase, not the number of calls: a million calls to five endpoints under one mandate need about five judge calls. Load test: [LOADTEST: requests/s, judge-call rate, p50/p95]. At volume, on-chain settlement is the bottleneck, not the gateway.

**What does a judge call cost compared with the payment?**
Before grants warm up, a judge call can cost more than a $0.01 payment, and we accept that. After warm-up, [REPORT: % of judge calls avoided by grants].

**Isn't the trust score made up?**
Yes. It's a reasonable starting policy, not a validated model. It only ever tightens controls, and the judge never sees it, so it can't bias the decision.

## Payment evidence (from Chunk 1's `STATUS.md`)

Every payment below is real, on **Base Sepolia** (a test network; the USDC has no cash value). All used the public test facilitator `https://x402.org/facilitator`, not CDP's. The merchant is PriceScope on `http://localhost:4101` with synthetic fixture content.

**CDP setup**
- Server account: `0x432D4cEA07086049E9c2125348285A01c084Fe5B`
- Policy: `60fd197c-c874-4b81-9497-aaf8968a66a1`, created and attached with the admin key; the gateway uses only the runtime key.

**CDP probes (real CDP API, run with the runtime key only)**

| Probe | Result |
|---|---|
| 0.01 USDC to PriceScope | signed |
| value 10001 (just over 0.01 USDC) | 403 policy_violation |
| payee = attacker | 403 policy_violation |
| different verifying contract | 403 policy_violation |
| type `Permit` | 403 policy_violation |
| `signHash` of an over-cap transfer | 403 policy_violation |
| `signMessage` | 403 policy_violation |
| gateway's CDP adapter with `pay()` checks skipped, 0.50 USDC to the attacker | 403 policy_violation |
| runtime key tries to loosen or detach the policy | 403 Missing required scope |

**Settled transactions**

| Signer | What | Transaction | Block |
|---|---|---|---|
| CDP account | Allowed purchase through the gateway (`pay_01M5QQP5…`), body delivered | `0x87d139ba2b14352fdfa5f9bd410a6eacfaa6eb0f872ba858d35b8fc26836e6da` | 49749161 |
| CDP account | Dropped reply: `/pay` returned `payment_unknown`, the reconciler found the settlement, and a same-key retry after a restart returned the same payment | `0xbd4d056668fc5f4120a716d16bde95acca62bdda72e4cc2903f952477cd64675` | 49751035 |
| Local key | Integrated proof through the gateway (`pay_01M5QP2Y…`); a same-key replay made no new signature | `0xf37bcfdcd361ac3072299e4f15636b17a5ea47dfd36d515b76dd7474309abcb4` | 49740769 |
| Local key | First payment, standalone script before the gateway existed | `0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15` | 49499677 |

Label each one by its signer on screen. Only the CDP rows count as CDP evidence; the local-key rows prove settlement, not the CDP backstop.

Explorer links: `https://sepolia.basescan.org/tx/<hash>` (has a bot check) or `https://base-sepolia.blockscout.com/tx/<hash>`.

## Rehearsal log

Record every run. The **Sat evening** checkpoint requires one full run on the real system. **Sun 7 AM**: three rehearsals after code freeze.

| # | When | Total | Slowest beat | What broke | Fix |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

## Backup video

- Record by **Sat 11 PM**: one clean full run on the real system, screen plus voice.
- Keep it under 3:00. Save it as `demo/backup.mp4`, or link it here if it's too large for git.
- Check that it plays offline on the demo laptop.
