# Demo script (2 minutes)

The whole demo is built around one moment: a $0.40 payment that passes every cap and payee rule is stopped because it doesn't serve the task.

**Target:** 2:00. **Hard limit:** 2:15 (check D-demo). Speaker lines are in quotes. Everything else is a click or something to point at. Items marked **TBD** depend on the demo agent (J6) or on the eval report, so fill them in at the first rehearsal.

## Before the slot

- [ ] Gateway on `:4000` with `PAYMENTS_MODE=real` and `JUDGE_MODE=real`, starting from a fresh `gateway.db`.
- [ ] Merchants on `:4101`–`:4103` and the attacker server on `:4199`, all in `normal` mode (`POST /_control {"mode":"normal"}`).
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
| 6 | 1:30–1:45 | Results |
| 7 | 1:45–2:00 | Live attack |

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

### 6 · Results (1:30–1:45)

Switch to the results tab.

> "We ran [REPORT: N] attacks, including [REPORT: 17] variants written by a teammate who never saw the judge's prompt. [REPORT: X of 20] blocked or escalated. [REPORT: J] were caught *only* by the judge, and we proved that by switching the judge off. [REPORT: F] legitimate requests wrongly denied. The judge was fooled [REPORT: K] times, and code bounded every one of them."

If the numbers missed the targets, say the real ones. Honest numbers beat perfect ones.

### 7 · Live attack (1:45–2:00)

Turn the keyboard toward the judges. **TBD:** how they inject. Planned: edit the text of an attacker page, or give the agent a URL to read, then rerun it.

> "Your turn. Try to make it pay for something it shouldn't."

While they type, keep **Decisions** and **Approval queue** visible. An escalation shows up in the queue with the judge's explanation. Approve or reject it with a one-line note.

## Fallbacks

| Problem | Do this |
|---|---|
| Facilitator slow or down | Switch to the local Base Sepolia replay (**TBD**, Chunk 1). Say so. |
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
They answer *how much*. We answer *why*. We sit on top of caps, not instead of them, and Tier 0 is caps.

**What happens at a million calls?**
Grants make the cost scale with the kinds of purchase, not the number of calls: a million calls to five endpoints under one mandate need about five judge calls. Load test: [LOADTEST: requests/s, judge-call rate, p50/p95]. At volume, on-chain settlement is the bottleneck, not the gateway.

**What does a judge call cost compared with the payment?**
Before grants warm up, a judge call can cost more than a $0.01 payment, and we accept that. After warm-up, [REPORT: % of judge calls avoided by grants].

**Isn't the trust score made up?**
Yes. It's a reasonable starting policy, not a validated model. It only ever tightens controls, and the judge never sees it, so it can't bias the decision.

## Rehearsal log

Record every run. The **Sat evening** checkpoint requires one full run on the real system. **Sun 7 AM**: three rehearsals after code freeze.

| # | When | Total | Slowest beat | What broke | Fix |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

## Backup video

- Record by **Sat 11 PM**: one clean full run on the real system, screen plus voice.
- Keep it under 2:15. Save it as `demo/backup.mp4`, or link it here if it's too large for git.
- Check that it plays offline on the demo laptop.
