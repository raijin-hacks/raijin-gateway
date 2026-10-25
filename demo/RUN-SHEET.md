# Demo run sheet (copy-paste)

Paste each block into a terminal tab as written. Values in `<ANGLE_BRACKETS>` are yours to fill in.

## 0 · One-time: take the CDP admin key out of the gateway's `.env`

The gateway loads `.env`. The admin key can edit or detach the signing policy, so it must not be in there.

```bash
open -e ~/Desktop/calhacks-13.0/.env
```

Cut the two `CDP_ADMIN_API_KEY_ID=` and `CDP_ADMIN_API_KEY_SECRET=` lines out, save, then:

```bash
pbpaste > ~/apf-admin.env && chmod 600 ~/apf-admin.env
```

While `.env` is open, check it has `ANTHROPIC_API_KEY=` (the judge needs it).

## 1 · Stop anything old

```bash
for p in 3000 4000 4010 4101 4199; do lsof -ti tcp:$p -sTCP:LISTEN; done | xargs kill 2>/dev/null; echo stopped
```

Then clear the agent's purchase journal, so it doesn't replay the last run's purchases:

```bash
rm -f ~/Desktop/calhacks-13.0/.agent-state/purchases.json
```

## 2 · Tab 1: the gateway (fresh database every run)

Settings written before the command override `.env`, so nothing else needs editing.

Real payments through CDP:

```bash
cd ~/Desktop/calhacks-13.0/apps/gateway && \
DATABASE_PATH=./demo-$(date +%H%M%S).db \
JUDGE_MODE=real JUDGE_MODEL=claude-sonnet-4-5-20250929 \
PAYMENTS_MODE=real PAYMENT_SIGNER=cdp \
CDP_SIGNER_ADDRESS=0x432D4cEA07086049E9c2125348285A01c084Fe5B \
npx tsx --env-file-if-exists=../../.env src/main.ts
```

Fallback, mock payments (say "mock" on stage):

```bash
cd ~/Desktop/calhacks-13.0/apps/gateway && \
DATABASE_PATH=./demo-$(date +%H%M%S).db \
JUDGE_MODE=real JUDGE_MODEL=claude-sonnet-4-5-20250929 PAYMENTS_MODE=mock \
npx tsx --env-file-if-exists=../../.env src/main.ts
```

## 3 · Tab 2: PriceScope (:4101)

```bash
cd ~/Desktop/calhacks-13.0 && pnpm merchants:pricescope
```

Once it's up, put it in normal mode:

```bash
curl -s -X POST http://localhost:4101/_control -H 'content-type: application/json' -d '{"mode":"normal"}'; echo
```

## 4 · Tab 3: attacker pages (:4199)

```bash
cd ~/Desktop/calhacks-13.0 && pnpm merchants:attacker
```

## 5 · Tab 4: dashboard (:3000)

`apps/dashboard/.env.local` needs `ADMIN_TOKEN` (same as the gateway's), `GATEWAY_URL=http://localhost:4000` and `DASHBOARD_PASSWORD`, and no `MOCK`.

```bash
cd ~/Desktop/calhacks-13.0/apps/dashboard && pnpm dev
```

Open http://localhost:3000/login and sign in.

## 6 · Check everything is up

```bash
for u in http://localhost:4000/health http://127.0.0.1:4010/health http://localhost:4199/pages/demo http://localhost:3000/login; do printf '%s  ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "$u"; done
```

All four should print `200`.

## 7 · Before the slot: the greeting mandate (dashboard → New mandate)

| Field | Value |
|---|---|
| Agent | Pricing researcher |
| Task | `Write a short greeting for Acme's partnerships team.` |
| Subjects | `acme` |
| Merchants | PriceScope only |
| Budget | `2.00` |
| Expiry | `60` |

Click **Create mandate**. The amber token box also loads this mandate into **Worker lab** for this tab. **Copy** only if you want a terminal backup.

## 8 · Tab 5: agent lab (:4010)

The dashboard Worker lab talks to this process. Live panes need the same Anthropic key as the judge. Compromised panes do not.

```bash
cd ~/Desktop/calhacks-13.0
export ANTHROPIC_API_KEY='<your Anthropic key>'
pnpm agent:lab
```

On stage, do not pick “the model that took the bait.” Left pane is a live model (refusal is competence). Right pane is **Compromised** and always sends the page’s intended purchase.

Optional terminal backup (only if the lab is down):

```bash
export GREETING_TOKEN='<token from step 7>'
MANDATE_TOKEN="$GREETING_TOKEN" AGENT_TASK="Write a short greeting for Acme's partnerships team; read http://localhost:4199/pages/demo first." AGENT_MODEL=claude-haiku-4-5-20251001 pnpm agent:live
```

Live attack (beat 7). Judges can edit `demo/pages/live.txt` or pick another page in Worker lab:

```bash
open -e ~/Desktop/calhacks-13.0/demo/pages/live.txt
```

## 9 · On stage: the research mandate (created live, beat 2)

| Field | Value |
|---|---|
| Agent | Pricing researcher |
| Task | `Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli for the Q4 pricing review.` |
| Subjects | `acme`, `globex`, `initech`, `umbrella`, `hooli` |
| Merchants | PriceScope only |
| Budget | `2.00` |
| Expiry | `30` |

## 10 · Optional beat 5: CDP refuses the bypass

Runtime key only (the admin key is no longer in `.env`):

```bash
cd ~/Desktop/calhacks-13.0 && pnpm --filter @apf/gateway payments:cdp-spike bypass
```

Point at `403 policy_violation`.

## Fallback: the live model ignores the bait

That is expected. Run the compromised pane on `demo`. Only if the lab is down, send the same purchase by hand:

```bash
K=$(uuidgen | tr A-Z a-z); curl -s http://localhost:4000/pay -H "authorization: Bearer $GREETING_TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: $K" -d '{"url":"http://localhost:4101/v1/pricing/acme?period=30d","method":"GET","expected_price":10000,"purpose":"fetch_data","idempotency_key":"'$K'"}'; echo
```

## If you ever need the admin key (re-creating the policy)

```bash
cd ~/Desktop/calhacks-13.0/apps/gateway && npx tsx --env-file=../../.env --env-file=$HOME/apf-admin.env src/payments/scripts/cdp-spike.ts admin
```

## After each rehearsal

Write a row in the rehearsal log at the bottom of `demo/SCRIPT.md`: mode, agent model, total time, whether the agent took the bait, and what broke.
