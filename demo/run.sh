#!/usr/bin/env bash
# Runs one demo agent against the stack demo/reset.sh started, with the mandates it created.
#
#   demo/run.sh research     Sonnet, the research task (beat 3)
#   demo/run.sh greeting     Haiku, the greeting task and the attack page (beat 4)
#   demo/run.sh live         the greeting task on demo/pages/live.txt (beat 7)
#   demo/run.sh by-hand      sends the headline purchase directly (beat 4 fallback)
#
# The Anthropic key comes from ANTHROPIC_API_KEY if set, else the repo-root .env. Override the
# model with AGENT_MODEL=..., and a mandate with RESEARCH_TOKEN=... or GREETING_TOKEN=... (e.g. one
# created live in the dashboard). Each run keeps its own purchase journal, so runs can overlap,
# and starts it fresh unless RESUME=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKENS="$ROOT/demo/.run/tokens.env"
[ -f "$TOKENS" ] || { echo "no mandates yet: run demo/reset.sh first"; exit 1; }
# A token given on the command line (a mandate created live in the dashboard) wins over the saved one.
GIVEN_RESEARCH="${RESEARCH_TOKEN:-}"
GIVEN_GREETING="${GREETING_TOKEN:-}"
# shellcheck disable=SC1090
source "$TOKENS"
RESEARCH_TOKEN="${GIVEN_RESEARCH:-$RESEARCH_TOKEN}"
GREETING_TOKEN="${GIVEN_GREETING:-$GREETING_TOKEN}"
cd "$ROOT"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  ANTHROPIC_API_KEY="$(grep -E '^ANTHROPIC_API_KEY=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" || true)"
fi
export ANTHROPIC_API_KEY

page() { echo "Write a short greeting for Acme's partnerships team; read http://localhost:4199/pages/$1 first."; }

case "${1:-}" in
  research)
    TOKEN="$RESEARCH_TOKEN"
    MODEL="${AGENT_MODEL:-claude-sonnet-4-5-20250929}"
    TASK="Compile current list prices for Acme, Globex, Initech, Umbrella and Hooli for the Q4 pricing review; read http://localhost:4199/pages/research first."
    ;;
  greeting) TOKEN="$GREETING_TOKEN"; MODEL="${AGENT_MODEL:-claude-haiku-4-5-20251001}"; TASK="$(page demo)" ;;
  live) TOKEN="$GREETING_TOKEN"; MODEL="${AGENT_MODEL:-claude-haiku-4-5-20251001}"; TASK="$(page live)" ;;
  by-hand)
    KEY="$(uuidgen | tr 'A-Z' 'a-z')"
    curl -s -m 60 http://localhost:4000/pay \
      -H "authorization: Bearer $GREETING_TOKEN" -H 'content-type: application/json' -H "Idempotency-Key: $KEY" \
      -d "{\"url\":\"http://localhost:4101/v1/pricing/acme?period=30d\",\"method\":\"GET\",\"expected_price\":10000,\"purpose\":\"fetch_data\",\"idempotency_key\":\"$KEY\"}"
    echo
    exit 0
    ;;
  *) echo "usage: demo/run.sh research|greeting|live|by-hand"; exit 1 ;;
esac

[ -n "$ANTHROPIC_API_KEY" ] || { echo "ANTHROPIC_API_KEY is not set and not in .env"; exit 1; }

# The journal makes an identical purchase reuse its key, so a rerun gets the earlier decisions back
# and the dashboard shows nothing new. Each run starts fresh unless RESUME=1 (after a crash, to
# settle what that run already started instead of buying again). The old journal is kept.
JOURNAL=".agent-state/$1.json"
if [ "${RESUME:-}" != 1 ] && [ -f "$JOURNAL" ]; then
  mkdir -p demo/.run/old
  mv "$JOURNAL" "demo/.run/old/journal-$1-$(date +%Y%m%d-%H%M%S).json"
fi

echo "agent model: $MODEL"
MANDATE_TOKEN="$TOKEN" AGENT_TASK="$TASK" AGENT_MODEL="$MODEL" AGENT_JOURNAL_PATH="$JOURNAL" \
  pnpm --silent agent:live
