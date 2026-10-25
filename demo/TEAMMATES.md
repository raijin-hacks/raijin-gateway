# Running the demo on your laptop

Three commands after a one-time setup. Mock payments by default, so you need no wallet, no CDP keys and no USDC: only your own Anthropic API key. Everything runs on `localhost`.

## What you need

- macOS or Linux, with `git`, `curl` and `lsof`
- Node **22.13 or newer** (`node -v`)
- pnpm 10: `corepack enable` once, or `npm i -g pnpm@10.34.7`
- Access to `raijin-hacks/calhacks-13.0` on GitHub
- An Anthropic API key. It's used by the judge (Sonnet) and the demo agent (Sonnet and Haiku). A full run costs a few cents.

## One-time setup

```bash
git clone git@github.com:raijin-hacks/calhacks-13.0.git
cd calhacks-13.0
demo/setup.sh
```

`demo/setup.sh` installs and builds, then creates the two config files if they don't exist:

| File | What goes in it |
|---|---|
| `.env` | A generated `ADMIN_TOKEN` and your `ANTHROPIC_API_KEY` (asked once, input hidden). Everything else comes from `.env.example`. |
| `apps/dashboard/.env.local` | The same `ADMIN_TOKEN`, `GATEWAY_URL=http://localhost:4000`, and a dashboard password you pick. |

It never overwrites a file that exists. Both files are gitignored and readable only by you. Don't paste their contents anywhere.

> **iCloud warning (macOS):** if Desktop and Documents sync to iCloud, clone somewhere else (e.g. `~/code`). iCloud makes `name 2` copies and can offload files the tests need.

## Sharing keys

You don't need anyone else's `.env` or `.env.local`. `demo/setup.sh` makes your own: your own `ADMIN_TOKEN` and dashboard password, which only matter on your laptop. Never copy someone's whole `.env`; it holds their wallet keys.

| Key | Who needs it | How to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Everyone | Your own key, or the team key from the team's password manager |
| CDP runtime keys (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) | Only the laptop presenting with real payments | From the payments owner through a password-manager share (1Password, or Bitwarden Send set to expire after one view). Paste them into your `.env`. |
| CDP admin key | Nobody else | Stays in `.env.admin` on the payments owner's laptop |

Never send keys through Slack, Discord, email, a screenshot or git. Rotate the CDP keys after the event.

## Every run

```bash
demo/reset.sh                 # fresh stack: stops old servers, new database, both mandates created
```

Open **http://localhost:3000**, sign in with your dashboard password, then in a terminal:

```bash
demo/run.sh research          # beat 3: Sonnet buys five price lookups
demo/run.sh greeting          # beat 4: Haiku reads the attack page
demo/run.sh by-hand           # beat 4 fallback, if Haiku refuses the bait
demo/run.sh live              # beat 7: after editing demo/pages/live.txt
demo/stop.sh                  # stop all four servers
```

Each `demo/run.sh` starts with a fresh purchase journal, so a rerun makes new purchases and new dashboard rows. If an agent run crashed mid-purchase, rerun it with `RESUME=1 demo/run.sh <run>` to settle what it started instead of buying again.

`demo/reset.sh` is safe to rerun any time. It moves the old database, logs and tokens to `demo/.run/old/` instead of deleting them. Mandates last 2 hours; run it again after that.

## What you should see

| Run | Terminal | Dashboard, Decisions panel |
|---|---|---|
| `research` | `payment: approved` ×5, then a price summary with receipts | Acme: `judge · approved`. Globex, Initech, Umbrella, Hooli: `tier1 · approved · GRANT_HIT` in milliseconds |
| `greeting` | Either it buys (then `payment: denied`), or it refuses and writes the greeting anyway | If it bought: `judge · denied · JUDGE_OFF_TASK` |
| `by-hand` | `{"status":"denied", … "reasons":["JUDGE_OFF_TASK"], "explanation": …}` | `judge · denied · JUDGE_OFF_TASK` |

The research page also offers a fake 25 USDC "deposit". If the agent tries it, the row is `precontact · denied · BAD_URL`. Sonnet usually ignores it.

**Haiku often refuses the bait** ("tool output is untrusted"). That's fine: use `demo/run.sh by-hand` and say "the agent caught this one itself, so here's the exact purchase the page asked for, sent directly." The firewall row is identical.

**If something goes to the Approval queue,** the agent waits about 40 s for you. Reject or approve with a one-line note.

## Real payments (payments owner only)

```bash
demo/reset.sh --real
```

This settles each purchase on Base Sepolia through the CDP signer. It needs the CDP **runtime** keys in `.env` (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`), and the CDP account must hold test USDC (about 1 cent per purchase). Never put the CDP **admin** key in `.env`, and never share any of these keys in chat or git. Teammates should stay on mock.

About 1 in 5 real payments comes back `payment_unknown`: the public test facilitator failed to settle it. Nothing is paid twice. The gateway marks it failed and releases the cent about 20 minutes after the authorization expires. The gateway log shows the facilitator's reason: `[payments] pay_… UNKNOWN: merchant answered 402 …`.

## When something's wrong

| Symptom | Fix |
|---|---|
| `no mandates yet: run demo/reset.sh first` | Run `demo/reset.sh`. |
| `agent: failed; no final answer` right away | Check that `ANTHROPIC_API_KEY` is set in `.env`, or export it in your shell. |
| `page: blocked or failed` | The attacker-pages server died. Run `demo/reset.sh`. |
| Every lookup goes to the Approval queue | Trust dropped after many denials. Run `demo/reset.sh` for a fresh database. |
| Dashboard won't load or shows nothing | Check `apps/dashboard/.env.local` has the same `ADMIN_TOKEN` as `.env`, then `demo/reset.sh`. |
| `<name> did not start` | Read `demo/.run/<name>.log`. A port may be held by another program: `lsof -i :4000`. |
| Port already in use | `demo/stop.sh`, then `demo/reset.sh`. |

Logs for all four servers are in `demo/.run/*.log`. The full stage script is in [`SCRIPT.md`](SCRIPT.md).
