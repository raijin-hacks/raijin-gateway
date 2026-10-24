# Dashboard (Chunk 4)

Live view of the Agent Payment Firewall: create mandates, watch every decision, answer escalations, and follow each payment to its settlement. Next.js, on `http://localhost:3000`.

The browser only ever talks to this app's own `/api/*` routes. They call the gateway with `ADMIN_TOKEN` on the server, so the token never reaches the browser.

## Access

- **Sign-in:** every page and API route needs an operator session. Sign in at `/login` with `DASHBOARD_PASSWORD`; the session cookie (`httpOnly`, `SameSite=Strict`) lasts 12 hours. Changing the password signs everyone out.
- **Writes:** `/api/*` refuses any write whose `Origin` isn't the dashboard itself (`403`), so another site can't post through a signed-in browser.
- **No password set:** everything is refused, except with `MOCK=1`, which never uses `ADMIN_TOKEN`.
- **What this proves:** that the browser knew the shared operator password. It doesn't identify a named person, and an approval isn't a cryptographic signature.

## Run it against the gateway

1. Root `.env` (copy `.env.example`) with an `ADMIN_TOKEN` of at least 16 characters.
2. `apps/dashboard/.env.local` (gitignored):

   ```
   ADMIN_TOKEN=<same value as the root .env>
   GATEWAY_URL=http://localhost:4000
   DASHBOARD_PASSWORD=<any password for the operator>
   ```

3. Start the gateway from `apps/gateway`:

   ```bash
   npx tsx --env-file-if-exists=../../.env src/main.ts
   ```

   `PAYMENTS_MODE` and `JUDGE_MODE` come from `.env`. Prefix `PAYMENTS_MODE=mock` to skip real payments. `JUDGE_MODE=stub-escalate` sends every new purchase to the approval queue; `stub-approve` approves it.

4. For real payments, start PriceScope from `apps/merchants`:

   ```bash
   npx tsx --env-file-if-exists=../../.env src/pricescope.ts
   ```

5. Start the dashboard from `apps/dashboard`:

   ```bash
   npx next dev
   ```

6. Until the demo agent is wired in, send agent traffic with the script (from the repo root):

   ```bash
   node apps/dashboard/scripts/send-traffic.mjs
   ```

   It signs in with `DASHBOARD_PASSWORD`, creates a mandate and tries six purchases: two normal lookups, a subject outside the mandate, an undeclared parameter, a bulk export and an unknown merchant. See the comments at the top of the script for reusing a mandate and getting a grant hit.

## Run it without a gateway

Put `MOCK=1` in `apps/dashboard/.env.local`. Every route then answers with fixed data, and `/api/stream` plays a scripted loop of events.

## What's where

| Path | What |
|---|---|
| `proxy.ts` | Sign-in and same-origin checks before every page and API route |
| `lib/session.ts` | Operator password check and signed session cookie |
| `app/login/page.tsx` | Sign-in page |
| `app/mandate-form.tsx` | New mandate form; agents with their trust; token shown once; close buttons |
| `app/approval-queue.tsx` | Escalations waiting for a human, loaded from the gateway's `GET /approvals` |
| `app/payments-panel.tsx` | Each payment's state, payee and settlement transaction (explorer link) |
| `app/stats-header.tsx` | Decisions per minute, judge and grant rates, median latencies |
| `app/event-feed.tsx` | Live decision feed |
| `app/trust-graph.tsx` | Session trust graph; not on the page (the team plan cuts trust displays) |
| `app/api/*` | Server routes that call the gateway (or answer with mock data) |
| `lib/gateway.ts` | The only code that sends `ADMIN_TOKEN` |
| `lib/stream.ts` | One shared `EventSource` for the whole page |
| `scripts/send-traffic.mjs` | Fake agent traffic for local testing |

## Known gaps

- One shared operator password, not per-person accounts.
- The payments and decisions panels show what happened since the page loaded; the gateway has no list endpoint for past payments.
- Payment events don't say which decision they belong to, so the payments panel can't link a payment to its decision yet.
- A mandate's task shows in the form's list only for mandates created on that page (there's no `GET /mandates`). The approval queue gets tasks from the gateway.
