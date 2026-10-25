#!/usr/bin/env bash
# Stops the demo servers (dashboard, gateway, agent lab, PriceScope, attacker pages). Keeps all data.
for port in 3000 4000 4010 4101 4199; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null && echo "stopped :$port"
done
echo "done"
