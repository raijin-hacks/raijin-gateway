#!/usr/bin/env bash
# One-time setup on a new laptop: installs and builds the workspace, then creates the two config
# files the demo needs if they don't exist yet. Never overwrites an existing file.
#
#   .env                         ADMIN_TOKEN (generated here) and your ANTHROPIC_API_KEY (asked once)
#   apps/dashboard/.env.local    the same ADMIN_TOKEN, the gateway URL and a dashboard password
#
# That is all mock mode needs. Real payments also need the CDP runtime keys in .env; ask the
# payments owner, and never put them in chat or git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)){console.error("Node 22.13+ needed, found "+process.versions.node);process.exit(1)}'
command -v pnpm >/dev/null || { echo "pnpm not found: run  corepack enable  (or  npm i -g pnpm@10.34.7)"; exit 1; }

echo "== installing and building"
pnpm install --frozen-lockfile
pnpm build

umask 077
if [ ! -f .env ]; then
  ADMIN_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  printf 'Anthropic API key (input hidden; used by the judge and the demo agent): '
  read -rs ANTHROPIC_API_KEY
  echo
  sed -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$ADMIN_TOKEN|" -e "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY|" \
    .env.example >.env
  echo "created .env"
else
  echo ".env exists, left as is"
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d "\"'")"
fi

if [ ! -f apps/dashboard/.env.local ]; then
  printf 'Pick a dashboard password (input hidden): '
  read -rs DASHBOARD_PASSWORD
  echo
  printf 'ADMIN_TOKEN=%s\nGATEWAY_URL=http://localhost:4000\nDASHBOARD_PASSWORD=%s\n' \
    "$ADMIN_TOKEN" "$DASHBOARD_PASSWORD" >apps/dashboard/.env.local
  echo "created apps/dashboard/.env.local"
else
  echo "apps/dashboard/.env.local exists, left as is (its ADMIN_TOKEN must match .env)"
fi

echo
echo "Setup done. Start the demo with:  demo/reset.sh"
