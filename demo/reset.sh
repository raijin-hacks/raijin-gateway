#!/usr/bin/env bash
# Fresh demo stack in one command: stops the five servers, starts them on a new database, and
# creates the research and greeting mandates. Then run agents with demo/run.sh.
#
#   demo/reset.sh            mock payments (no CDP or USDC needed; say "mock" on stage)
#   demo/reset.sh --real     real Base Sepolia payments through the CDP signer
#
# Needs: repo-root .env with ADMIN_TOKEN and ANTHROPIC_API_KEY (the judge), plus the CDP runtime
# keys for --real; apps/dashboard/.env.local for the dashboard. Prints no secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/demo/.run"
MODE=mock
[ "${1:-}" = "--real" ] && MODE=real

cd "$ROOT"
[ -f .env ] || { echo "missing $ROOT/.env (copy .env.example and fill it in)"; exit 1; }
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d "\"'")"
[ -n "$ADMIN_TOKEN" ] || { echo "ADMIN_TOKEN is empty in .env"; exit 1; }
[ -f apps/dashboard/.env.local ] || echo "warning: apps/dashboard/.env.local is missing; the dashboard won't reach the gateway"

# Dashboard, gateway, agent lab (Worker lab), PriceScope, attacker pages.
PORTS="3000 4000 4010 4101 4199"
echo "== stopping old servers"
for port in $PORTS; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
for _ in $(seq 1 20); do
  busy=0
  for port in $PORTS; do lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null && busy=1; done
  [ $busy = 0 ] && break
  sleep 0.5
done

# Old databases, logs, tokens and agent journals go to demo/.run/old/<time>, never deleted.
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN/old/$STAMP" .agent-state
mv "$RUN"/gateway-*.db* "$RUN"/*.log "$RUN"/tokens.env .agent-state/*.json "$RUN/old/$STAMP/" 2>/dev/null || true
DB="$RUN/gateway-$STAMP.db"

echo "== starting servers ($MODE payments)"
GATEWAY_ENV=(DATABASE_PATH="$DB" JUDGE_MODE=real JUDGE_MODEL=claude-sonnet-4-5-20250929 PAYMENTS_MODE="$MODE")
if [ "$MODE" = real ]; then
  GATEWAY_ENV+=(PAYMENT_SIGNER=cdp CDP_SIGNER_ADDRESS=0x432D4cEA07086049E9c2125348285A01c084Fe5B)
fi
(cd apps/gateway && env "${GATEWAY_ENV[@]}" nohup npx tsx --env-file-if-exists=../../.env src/main.ts </dev/null >"$RUN/gateway.log" 2>&1 &)
nohup pnpm merchants:pricescope </dev/null >"$RUN/pricescope.log" 2>&1 &
nohup pnpm merchants:attacker </dev/null >"$RUN/attacker.log" 2>&1 &
(cd apps/dashboard && nohup pnpm dev </dev/null >"$RUN/dashboard.log" 2>&1 &)
# The agent lab's live panes call the model with the same key as the judge.
LAB_KEY="$(grep -E '^ANTHROPIC_API_KEY=' .env | tail -1 | cut -d= -f2- | tr -d "\"'")"
ANTHROPIC_API_KEY="$LAB_KEY" nohup pnpm agent:lab </dev/null >"$RUN/agent-lab.log" 2>&1 &

wait_for() { # url, name
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" || true)"
    [ "$code" != 000 ] && return 0
    sleep 1
  done
  echo "$2 did not start; see $RUN/${2}.log"
  exit 1
}
wait_for http://localhost:4000/health gateway
wait_for "http://localhost:4101/v1/pricing/acme?period=30d" pricescope
wait_for http://localhost:4199/pages/demo attacker
wait_for http://localhost:3000/login dashboard
wait_for http://127.0.0.1:4010/health agent-lab
curl -s -m 5 -X POST http://localhost:4101/_control -H 'content-type: application/json' -d '{"mode":"normal"}' >/dev/null

echo "== creating mandates"
mandate() { # agent id, task, subjects JSON array -> prints the token
  curl -s -m 10 http://localhost:4000/mandates \
    -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d "{\"agent_id\":\"$1\",\"task\":\"$2\",\"subjects\":$3,\"allowed_merchant_ids\":[\"mer_pricing\"],\"budget\":2000000,\"expires_in_ms\":7200000}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.token){console.error("mandate not created: "+s.slice(0,200));process.exit(1)}process.stdout.write(j.token)})'
}
FIVE='["acme","globex","initech","umbrella","hooli"]'
RESEARCH_TOKEN="$(mandate agt_pricing 'Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli for the Q4 pricing review.' "$FIVE")"
GREETING_TOKEN="$(mandate agt_pricing "Write a short greeting for Acme's partnerships team." '["acme"]')"
# Bulk loader (bulk role: volume data allowed) for demo/run.sh bulk-vs-research.
BULK_TOKEN="$(mandate agt_bulk "Backfill the pricing warehouse with PriceScope's full historical pricing dataset for all tracked companies." "$FIVE")"
umask 077
printf "RESEARCH_TOKEN='%s'\nGREETING_TOKEN='%s'\nBULK_TOKEN='%s'\nPAYMENTS_MODE='%s'\n" \
  "$RESEARCH_TOKEN" "$GREETING_TOKEN" "$BULK_TOKEN" "$MODE" >"$RUN/tokens.env"

cat <<EOF

Ready ($MODE payments, fresh database, mandates valid for 2 hours).
  Dashboard:  http://localhost:3000  (reload it, then sign in; Worker lab runs the agents)
  Logs:       demo/.run/*.log
Next:
  demo/run.sh research     beat 3, Sonnet
  demo/run.sh greeting     beat 4, Haiku (if it refuses the bait: demo/run.sh by-hand)
  demo/run.sh live         beat 7, after editing demo/pages/live.txt
  demo/run.sh bulk-vs-research   Q&A: the same \$0.50 export, two roles
  demo/stop.sh             stop all five servers
EOF
