# Demo run sheet

What to type on demo day, in order. Run every command from the repo root. First time on a laptop: [`TEAMMATES.md`](TEAMMATES.md). What to say: [`SCRIPT.md`](SCRIPT.md).

## Before the slot

1. Start a fresh stack: gateway, PriceScope, attacker pages, dashboard and the agent lab (`:4010`) on a new database, with the research, greeting and bulk mandates created. This also resets trust and restrictions.
   ```bash
   demo/reset.sh --real     # real Base Sepolia payments (payments owner's laptop)
   demo/reset.sh            # mock payments: say "mock" on stage
   ```
2. Reload http://localhost:3000 and sign in, so the header stats start at zero.
3. Open `demo/pages/live.txt` in an editor for beat 7.
4. Keep the backup video and the results slide open in other tabs (see `SCRIPT.md`).

## On stage

The demo runs from the dashboard's **Worker lab**: live model on the left pane, **Compromised** profile on the right (it always sends the page's intended purchase, so the firewall is shown even when the live model refuses the bait). Creating a mandate in the dashboard loads it into the lab for that tab. `demo/run.sh` is the terminal backup if the lab is down.

| Beat | Worker lab | Terminal backup | Expect in Decisions |
| --- | --- | --- | --- |
| 2 · Mandate | Create the research mandate (fields below) | `RESEARCH_TOKEN='<paste>' demo/run.sh research` | — |
| 3 · Normal work | Left pane: research mandate, page `research`, Live model, **Run** | (same as above) | Acme `judge · approved`, then four `tier1 · GRANT_HIT` |
| 4 · Headline | Both panes: greeting mandate, page `demo`; left Live model, right Compromised | `demo/run.sh greeting`, or `demo/run.sh by-hand` | `judge · denied · JUDGE_OFF_TASK` |
| 5 · CDP refuses | — | `pnpm --filter @apf/gateway payments:cdp-spike bypass` | Terminal: `403 policy_violation` |
| 7 · Live attack | Judges edit `demo/pages/live.txt` (or pick a page); run a pane | `demo/run.sh live` | Pre-contact deny, judge, or Approval queue |

**Research mandate** (beat 2): agent *Pricing researcher*; task `Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli for the Q4 pricing review.`; subjects `acme, globex, initech, umbrella, hooli` + Enter (five chips); PriceScope only; budget `2.00`; expiry `30`. Skipping the live mandate? `demo/reset.sh` already created one (`demo/run.sh research` uses it).

If a purchase lands in the **Approval queue**, the agent waits about 40 s: type a one-line note and click **Reject**.

**Before beat 7, decide about the agent's restriction.** The headline's `JUDGE_OFF_TASK` is an incident: the gateway puts *Pricing researcher* under review, and every later purchase it makes goes straight to the Approval queue (`AGENT_REVIEW_REQUIRED`). Either narrate that ("one off-task attempt and this agent needs a human for everything"), or run `demo/run.sh restore pricing` first so the judges' attacks reach the judge.

**Q&A, "isn't this just a blocklist?":** `demo/run.sh bulk-vs-research` sends the same $0.50 full export on two mandates. The researcher is denied `JUDGE_OVER_SCOPED` and the bulk loader is approved, for the same URL, price and merchant. Mock payments only: the CDP policy signs at most 1 cent.

## Real payments: keys

- `.env` holds the CDP **runtime** keys only (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`). The gateway loads `.env`.
- The CDP **admin** key (`CDP_ADMIN_API_KEY_ID`, `CDP_ADMIN_API_KEY_SECRET`) lives in `.env.admin` in the repo root, gitignored, never loaded by the gateway. It's needed only to recreate or change the signing policy:
  ```bash
  cd apps/gateway && npx tsx --env-file=../../.env --env-file=../../.env.admin src/payments/scripts/cdp-spike.ts admin
  ```
- The CDP account `0x432D4cEA07086049E9c2125348285A01c084Fe5B` needs test USDC, about 1 cent per purchase. `pnpm payments:balance` checks the local-key payer, not this account, so check it on an explorer.

## If it breaks

| Problem | Do this |
| --- | --- |
| Anything stuck or a server down | `demo/reset.sh` (then create the beat-2 mandate again) |
| Worker lab can't reach the agent lab | Check http://127.0.0.1:4010/health; `demo/reset.sh`, or use the terminal backup column |
| Every purchase says `AGENT_REVIEW_REQUIRED` | An earlier incident put the agent under review: `demo/run.sh restore pricing` |
| `payment_unknown` on a real payment | The test facilitator failed to settle it; nothing was paid. Say so and move on |
| Judge model API down | Rows say `JUDGE_ERROR`: play the backup video |
| Facilitator or CDP down | `demo/reset.sh` (mock) and say it's mock |
| Signed out of the dashboard | http://localhost:3000/login with your dashboard password |

Logs: `demo/.run/*.log`. Stop everything: `demo/stop.sh`.

## After each rehearsal

Add a row to the rehearsal log at the bottom of `SCRIPT.md`: mode, agent models, total time, whether the live model took the bait, and what broke.
