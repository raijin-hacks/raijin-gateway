# Dashboard (Chunk 4)

Live view of the Agent Payment Firewall: create mandates, watch every decision, answer escalations, and follow session trust. Next.js, on `http://localhost:3000`.

The browser only ever talks to this app's own `/api/*` routes. They call the gateway with `ADMIN_TOKEN` on the server, so the token never reaches the browser.

## Run it against the gateway

1. Root `.env` (copy `.env.example`) with an `ADMIN_TOKEN` of at least 16 characters.
2. `apps/dashboard/.env.local` (gitignored):

   ```
   ADMIN_TOKEN=<same value as the root .env>
   GATEWAY_URL=http://localhost:4000
   ```

3. Start the gateway from `apps/gateway`. Real payments are disabled on `main` for now, so use mock payments:

   ```bash
   PAYMENTS_MODE=mock npx tsx --env-file-if-exists=../../.env src/main.ts
   ```

   `JUDGE_MODE` comes from `.env`: `stub-escalate` sends every new purchase to the approval queue, `stub-approve` approves it and issues a grant.

4. Start the dashboard from `apps/dashboard`:

   ```bash
   npx next dev
   ```

5. Until the demo agent exists, send agent traffic with the script (from the repo root):

   ```bash
   node apps/dashboard/scripts/send-traffic.mjs
   ```

   It creates a mandate and tries six purchases: two normal lookups, a subject outside the mandate, an undeclared parameter, a bulk export and an unknown merchant. See the comments at the top of the script for reusing a mandate and getting a grant hit.

## Run it without a gateway

Put `MOCK=1` in `apps/dashboard/.env.local`. Every route then answers with fixed data, and `/api/stream` plays a scripted loop of events.

## What's where

| Path | What |
|---|---|
| `app/mandate-form.tsx` | New mandate form; token shown once; close buttons |
| `app/approval-queue.tsx` | Escalations waiting for a human |
| `app/trust-graph.tsx` | Session trust over time, with the 60/40/20 thresholds |
| `app/stats-header.tsx` | Decisions per minute, judge and grant rates, median latencies |
| `app/event-feed.tsx` | Live decision feed |
| `app/api/*` | Server routes that call the gateway (or answer with mock data) |
| `lib/gateway.ts` | The only code that sends `ADMIN_TOKEN` |
| `lib/stream.ts` | One shared `EventSource` for the whole page |
| `scripts/send-traffic.mjs` | Fake agent traffic for local testing |

## Known gaps

- The approval queue can't show the merchant: `approval_needed` has no merchant field yet (Chunk 2).
- The queue shows a mandate's task only for mandates created on this page (there's no `GET /mandates`).
- `/api/agents` is a fixed list matching the gateway's seed in `apps/gateway/src/db/seed.ts` (there's no `GET /agents`).
- Everything shown is since the page loaded; reloading starts empty.
