# Agent Payment Firewall: Contracts v1.4

v1.1: added `GET /catalog`, `PaymentStore`, `EndpointMatch`, `JudgeContext`; grant clamping moved to the gateway; `pay()` never marks a payment failed.

v1.2: added `UNCATALOGED_ENDPOINT`, `INTERNAL_ERROR`, nullable `approved.response`, UUIDv4 idempotency headers, and durable pending review handling.

v1.3: `saveResponse` preserves a merchant's 2xx reply before settlement is proven; `GET /agents` and `GET /approvals` expose operator data; cataloged merchants outside `allowed_merchant_ids` deny at pre-contact; unknown endpoints deny with an instruction to add them to the catalog; standing grants are off by default (`STANDING_GRANTS=off`).

v1.4: durable agent restrictions, append-only incidents and restorations, admin `POST /agents/:id/restore`, expanded `GET /agents`, `agent_incident` / `agent_restored` stream events, `AGENT_SUSPENDED` / `AGENT_REVIEW_REQUIRED`, zero approval trust deltas, and `PaymentStore.canSign` before signer invocation.

The single source of truth for all four people. If code and this file disagree, this file wins until the team agrees to change it. Paste the relevant sections into every coding-agent prompt.

## 0. Decisions and conventions

| Topic | Decision |
|---|---|
| Repo | pnpm workspace monorepo |
| Language | TypeScript everywhere |
| Gateway framework | Hono on Node |
| Database | SQLite through Drizzle ORM (one file, `gateway.db`) |
| Validation | zod schemas generated from the types in section 5; validate every input at the boundary |
| Network | Base Sepolia, CAIP-2 id `eip155:84532` |
| Money | Integer **atomic USDC units** (6 decimals): 1 USDC = 1_000_000. Stored as INTEGER, typed as `number` in TS. Never floats. In JSON, send as integers |
| Time | Unix epoch **milliseconds**, INTEGER |
| IDs | Text with prefix + ULID: `tnt_`, `rol_`, `agt_`, `mnd_`, `ses_`, `dec_`, `pay_`, `grt_`, `mer_`, `end_`, `apr_`, `tev_` |
| Request bodies to merchants | **Not supported in v1.** All merchant parameters go in the query string or path. Simplifies canonicalization and the judge |
| Methods supported | `GET` and `POST` (POST with no body) |

### Repo layout

```
packages/contracts    types, zod schemas, reason codes, catalog loader   (owner: B, everyone reviews)
apps/gateway          Hono API, pipeline, DB, reconciler                  (B, with A's payments module)
apps/gateway/src/payments   getQuote, pay, lifecycle, reconciler          (A)
apps/gateway/src/judge      input builder, prompt, output validation      (C)
apps/merchants        honest and malicious x402 test sellers              (A)
apps/agent            demo agent with paid_fetch                          (D)
apps/dashboard        Next.js dashboard                                   (D)
eval/                 cases, runner, metrics                              (C, attack variants by D)
catalog/catalog.json  merchant catalog                                    (C)
```

## 1. Database schema

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  daily_cap INTEGER NOT NULL,            -- atomic USDC
  created_at INTEGER NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,                    -- 'research', 'bulk'
  policy_text TEXT NOT NULL,             -- trusted, shown to the judge
  per_call_cap INTEGER NOT NULL,
  velocity_per_min INTEGER NOT NULL,
  baseline_trust INTEGER NOT NULL,       -- e.g. 70
  grant_trust_threshold INTEGER NOT NULL -- e.g. 60
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  name TEXT NOT NULL,
  trust REAL NOT NULL,                   -- agent-level score
  restriction TEXT NOT NULL DEFAULT 'normal',
  restriction_epoch INTEGER NOT NULL DEFAULT 0,
  CHECK (restriction IN ('normal','review_required','suspended'))
);

-- Catalog is loaded from catalog/catalog.json at startup into these tables.
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,                   -- 'mer_...'
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  origin TEXT NOT NULL,                  -- canonical 'https://host[:port]'
  payee TEXT NOT NULL,                   -- lowercase 0x address
  category TEXT NOT NULL,
  description TEXT NOT NULL              -- admin-written, trusted
);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,                   -- 'end_...'
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  method TEXT NOT NULL CHECK (method IN ('GET','POST')),
  path TEXT NOT NULL,                    -- exact template, e.g. '/v1/pricing/{company}'
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  params_json TEXT NOT NULL,             -- Record<string, ParamSpec>
  UNIQUE (merchant_id, method, path)
);

CREATE TABLE standing_grants (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  max_per_call INTEGER NOT NULL,
  daily_total INTEGER NOT NULL
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task TEXT NOT NULL,                    -- human-written, trusted
  subjects_json TEXT NOT NULL,           -- string[], normalized (trim, lowercase)
  allowed_merchants_json TEXT NOT NULL,  -- merchant ids[]
  budget INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','closed','expired')),
  token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the token; token itself never stored
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (spent >= 0 AND reserved >= 0 AND spent + reserved <= budget)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  trust REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','quarantined','ended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  payee TEXT NOT NULL,
  method TEXT NOT NULL,
  origin TEXT NOT NULL,
  path TEXT NOT NULL,
  option_values_json TEXT NOT NULL,      -- Record<paramName, value> approved for 'option' params
  max_per_call INTEGER NOT NULL,
  max_total INTEGER NOT NULL,
  used_total INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('judge','human')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE reference_prices (
  tenant_id TEXT NOT NULL,
  payee TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  price INTEGER NOT NULL,                -- first price ever approved
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, payee, endpoint_id)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  canonical_url TEXT NOT NULL,           -- for logs and dashboard only; never sent to the judge
  method TEXT NOT NULL,
  endpoint_id TEXT,                      -- null if not in catalog
  payee TEXT,                            -- null if denied before the quote
  price INTEGER,
  stage TEXT NOT NULL CHECK (stage IN ('precontact','tier0','tier1','judge','human')),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','denied','pending')),
  reasons_json TEXT NOT NULL,            -- ReasonCode[]
  explanation TEXT,
  judge_ms INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (mandate_id, idempotency_key)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,                   -- 'pay_...', stable across retries
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  amount INTEGER NOT NULL,
  payee TEXT NOT NULL,
  nonce TEXT,                            -- EIP-3009 nonce, set at SIGNED
  valid_before INTEGER,                  -- set at SIGNED
  authorization_json TEXT,               -- the signed payload, reused on retry
  state TEXT NOT NULL CHECK (state IN ('RESERVED','SIGNED','SUBMITTED','SETTLED','FAILED','UNKNOWN')),
  tx_hash TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),
  reviewer TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','rejected','timeout')),
  note TEXT NOT NULL,
  issue_grant INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE trust_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  delta_session REAL NOT NULL,
  delta_agent REAL NOT NULL,
  cause TEXT NOT NULL,                   -- a ReasonCode or 'APPROVED'
  decision_id TEXT REFERENCES decisions(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE agent_incidents (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  cause TEXT NOT NULL,
  previous TEXT NOT NULL,
  restriction TEXT NOT NULL,
  restriction_epoch INTEGER NOT NULL,
  severe INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE agent_restorations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  previous TEXT NOT NULL,
  restriction TEXT NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

```

### Required atomic statements

Write these exactly; do not replace them with read-then-write logic.

```sql
-- Reserve (one statement; changes() = 0 means MANDATE_BUDGET denial)
UPDATE mandates SET reserved = reserved + :amount
 WHERE id = :mandate_id AND status = 'active' AND expires_at > :now
   AND spent + reserved + :amount <= budget;

-- Settle (in one transaction; only proceed to the second statement if the first changed 1 row)
UPDATE payments SET state = 'SETTLED', tx_hash = :tx, updated_at = :now
 WHERE id = :payment_id AND state IN ('SIGNED','SUBMITTED','UNKNOWN');
UPDATE mandates SET reserved = reserved - :amount, spent = spent + :amount WHERE id = :mandate_id;

-- Fail (same pattern; only when non-settlement is proven)
UPDATE payments SET state = 'FAILED', updated_at = :now
 WHERE id = :payment_id AND state IN ('RESERVED','SIGNED','SUBMITTED','UNKNOWN');
UPDATE mandates SET reserved = reserved - :amount WHERE id = :mandate_id;

-- Grant use (changes() = 0 means GRANT_EXHAUSTED)
UPDATE grants SET used_total = used_total + :amount
 WHERE id = :grant_id AND used_total + :amount <= max_total AND expires_at > :now;
```

Enable WAL mode and `busy_timeout`. Wrap each settle and fail pair in a transaction.

## 2. Gateway API

All agent calls authenticate with `Authorization: Bearer <mandate_token>`. All admin calls use `Authorization: Bearer <ADMIN_TOKEN>` from `.env`. A mandate token on an admin route returns **403** (attack A11).

### `POST /pay` (agent)

Request:

```json
{
  "url": "https://pricing.example.test/v1/pricing/acme?period=30d",
  "method": "GET",
  "expected_price": 10000,
  "purpose": "fetch_data",
  "idempotency_key": "12345678-1234-4234-8234-123456789abc"
}
```

- `purpose` is one of the `PurposeCode` values (section 5).
- `idempotency_key` and a matching UUIDv4 `Idempotency-Key` header are required (UUID case is normalized). The same key under the same mandate returns the existing decision/payment. A changed authorization-relevant request under that key returns 409. This is how retries stay safe (A18).

Responses: HTTP 200 for decisions; 202 for an in-progress replay handle; 400 for malformed input; 401 for a bad or expired token; 409 for a conflicting idempotency binding:

```json
{ "status": "approved", "decision_id": "dec_...", "payment_id": "pay_...",
  "stage": "tier1", "amount": 10000, "payee": "0xabc...",
  "response": { "status_code": 200, "content_type": "application/json", "body": "..." } }

{ "status": "denied", "decision_id": "dec_...", "stage": "precontact",
  "reasons": ["SUBJECT_NOT_IN_MANDATE"], "explanation": null }

{ "status": "pending", "decision_id": "dec_...", "poll_after_ms": 2000 }

{ "status": "payment_unknown", "decision_id": "dec_...", "payment_id": "pay_...", "poll_after_ms": 5000 }
```

- `pending` means a human must decide. Poll `GET /decisions/:id`.
- `payment_unknown` means the payment was submitted but settlement isn't confirmed yet. Poll `GET /payments/:id`. The agent must not retry with a new idempotency key.
- `response.body` is the merchant's response, returned to the agent as-is. It is never shown to the judge.

### Other endpoints

| Method and path | Caller | Request | Response |
|---|---|---|---|
| `GET /agents` | Admin | none | `AgentSummary[]` (persistent trust, restriction, recent incidents/restorations) |
| `POST /agents/:id/restore` | Admin | `RestoreAgentRequest` (target, reason, operator) | `RestoreAgentResponse` (audit record) |
| `POST /mandates` | Admin | `{ agent_id, task, subjects: string[], allowed_merchant_ids: string[], budget, expires_in_ms }` | `{ mandate_id, session_id, token }` (token shown once) |
| `POST /mandates/:id/close` | Admin | `{}` | `{ ok: true }` (revokes token and grants) |
| `GET /approvals?status=pending` | Admin | `status=pending` (required) | `PendingApproval[]` (durable reviews in `pay_workflows` state `REVIEW`) |
| `GET /decisions/:id` | Agent (own mandate) or admin | none | The same shape as a `/pay` response |
| `GET /payments/:id` | Agent (own mandate) or admin | none | `{ payment_id, state, amount, payee, tx_hash }` |
| `POST /approvals/:decision_id` | Admin | `{ outcome: "approved" \| "rejected", note: string, issue_grant: boolean }` | `{ ok: true }` |
| `GET /stream` | Dashboard (admin) | none | Server-sent events, each `StreamEvent` (section 5) |
| `GET /catalog` | Admin | none | `Catalog` (for the dashboard's merchant checkboxes) |
| `GET /health` | Anyone | none | `{ ok: true }` |

#### `GET /agents` response

`trust` is `agents.trust`, the persistent agent-level score. Session trust is specific to one
mandate and is intentionally not used for this list.

```json
[
  { "id": "agt_bulk", "name": "Bulk loader", "role": "bulk", "trust": 70, "restriction": "normal", "recent_incidents": [], "recent_restorations": [] },
  { "id": "agt_logistics", "name": "Logistics analyst", "role": "research", "trust": 70, "restriction": "normal", "recent_incidents": [], "recent_restorations": [] },
  { "id": "agt_pricing", "name": "Pricing researcher", "role": "research", "trust": 70, "restriction": "normal", "recent_incidents": [], "recent_restorations": [] }
]
```

#### `GET /approvals?status=pending` response

The status query is required; a missing or unsupported status, or any additional query key, returns
400. The endpoint lists only rows whose workflow is currently in `REVIEW`. `merchant`, `endpoint`,
and `price` are null when a review has no catalog match or quote; the canonical URL and decision
facts remain sourced from the stored decision. Prices are integer atomic USDC units. `deadline` is
an epoch timestamp in milliseconds.

```json
[
  {
    "decision_id": "dec_01J00000000000000000000000",
    "mandate_id": "mnd_01J00000000000000000000000",
    "task": "Compile current list prices for the Q4 pricing review.",
    "agent": { "id": "agt_pricing", "name": "Pricing researcher", "role": "research" },
    "merchant": { "id": "mer_pricing", "name": "PriceScope" },
    "endpoint": { "id": "end_pricing_get", "method": "GET", "path": "/v1/pricing/{company}" },
    "canonical_url": "http://localhost:4101/v1/pricing/acme?period=30d",
    "price": 10000,
    "reasons": ["JUDGE_OVER_SCOPED"],
    "judge_explanation": "The purchase appears broader than the assigned task.",
    "stage": "judge",
    "deadline": 1800000000000
  }
]
```

### Reason codes

| Stage | Codes |
|---|---|
| Pre-contact | `AGENT_SUSPENDED`, `NO_MANDATE`, `QUARANTINED`, `DENYLIST`, `SECRET_IN_URL`, `QUERY_TOO_LONG`, `PARAM_NOT_IN_SCHEMA`, `SUBJECT_NOT_IN_MANDATE`, `UNKNOWN_WITH_PARAMS`, `DUPLICATE_PARAM`, `BAD_URL`, `UNCATALOGED_ENDPOINT`, `MERCHANT_NOT_SELECTED` |
| Quote | `QUOTE_FAILED`, `NOT_402`, `QUOTE_INVALID` |
| Tier 0 | `NETWORK`, `PAYEE_SWAP`, `PER_CALL_CAP`, `REFERENCE_PRICE`, `PRICE_MISMATCH`, `MANDATE_BUDGET`, `TENANT_DAILY`, `VELOCITY`, `DUPLICATE`, `NEW_PAYEE_LIMIT`, `INTERNAL_ERROR` |
| Tier 1 (logged on miss; hit approves) | `GRANT_HIT`, `GRANT_NONE`, `GRANT_PRICE`, `GRANT_ENDPOINT`, `GRANT_METHOD`, `GRANT_PARAMS`, `GRANT_TRUST`, `GRANT_EXHAUSTED` |
| Judge | `JUDGE_APPROVED`, `JUDGE_OFF_TASK`, `JUDGE_OVER_SCOPED`, `JUDGE_UNKNOWN_MERCHANT`, `JUDGE_PRICE_UNUSUAL`, `JUDGE_UNEXPECTED_PARAMS`, `JUDGE_INJECTION_SUSPECTED`, `JUDGE_ERROR`, `JUDGE_INVALID_OUTPUT` |
| Human | `HUMAN_APPROVED`, `HUMAN_REJECTED`, `HUMAN_TIMEOUT` |
| Trust routing | `TRUST_REQUIRES_HUMAN`, `AGENT_REVIEW_REQUIRED` |

Which pre-contact and Tier 0 codes escalate instead of deny: `PARAM_NOT_IN_SCHEMA`, `SUBJECT_NOT_IN_MANDATE`, `UNKNOWN_WITH_PARAMS`, `REFERENCE_PRICE`, `NEW_PAYEE_LIMIT`, `TRUST_REQUIRES_HUMAN`, `AGENT_REVIEW_REQUIRED`. Every other code in those stages denies.

An unselected cataloged merchant denies with `MERCHANT_NOT_SELECTED` before any quote. An unknown endpoint denies with `UNCATALOGED_ENDPOINT` and the explanation "add this endpoint to the catalog"; it does not create a review item.

### Pipeline order (fixed)

1. Authenticate token, load mandate and session.
2. Idempotency lookup: existing decision for this key returns its current state.
3. Canonicalize the URL (section 3), match it to a catalog endpoint.
4. Pre-contact checks. **No network call before this step passes.**
5. Fetch the 402 quote (A's `getQuote`).
6. Tier 0, ending with the atomic reservation.
7. Durable agent restriction: `suspended` denies pre-contact with `AGENT_SUSPENDED`; `review_required` disables all grants and queues every purchase reaching authorization with `AGENT_REVIEW_REQUIRED`. Payment approvals do not restore agents. Score routing remains additive: score < 20 deny `QUARANTINED`; 20 to 39 go to human; 40 to 59 skip Tier 1.
8. Tier 1 grant lookup. Per-mandate grants remain available. Standing grants are skipped unless `STANDING_GRANTS=on`; the default is `off`. The pre-contact merchant-selection rule applies before any grant lookup.
9. Judge (C's module).
10. Human queue if escalated (10-minute timeout, then `HUMAN_TIMEOUT`, reservation released).
11. Log the decision, then call A's `pay()`. On denial at any stage after step 6, release the reservation.

## 3. Catalog format

File: `catalog/catalog.json`, loaded at startup. Only admins edit it; it is trusted input.

```json
{
  "version": 1,
  "merchants": [
    {
      "id": "mer_pricing",
      "name": "PriceScope",
      "origin": "https://pricing.example.test",
      "payee": "0x1111111111111111111111111111111111111111",
      "category": "market data",
      "description": "Product pricing for named companies",
      "endpoints": [
        {
          "id": "end_pricing_get",
          "method": "GET",
          "path": "/v1/pricing/{company}",
          "category": "pricing lookup",
          "description": "Current list prices for one company",
          "params": {
            "company": { "in": "path",  "kind": "subject" },
            "period":  { "in": "query", "kind": "option", "type": "enum", "values": ["30d", "90d"] }
          }
        },
        {
          "id": "end_pricing_export",
          "method": "POST",
          "path": "/v1/pricing/export",
          "category": "bulk export",
          "description": "Full historical pricing dataset for all tracked companies",
          "params": {}
        }
      ]
    },
    {
      "id": "mer_weather",
      "name": "SkyData",
      "origin": "https://weather.example.test",
      "payee": "0x2222222222222222222222222222222222222222",
      "category": "weather",
      "description": "Weather forecasts by city",
      "endpoints": [
        {
          "id": "end_weather_forecast",
          "method": "GET",
          "path": "/v1/forecast",
          "category": "weather forecast",
          "description": "7-day forecast for one city",
          "params": {
            "city": { "in": "query", "kind": "subject" },
            "units": { "in": "query", "kind": "option", "type": "enum", "values": ["metric", "imperial"] }
          }
        }
      ]
    }
  ],
  "standing_grants": [
    { "role": "research", "endpoint_id": "end_weather_forecast", "max_per_call": 20000, "daily_total": 500000 }
  ]
}
```

### `ParamSpec`

| `kind` | Meaning | Rule |
|---|---|---|
| `subject` | What the purchase is about | Normalized value (trim, lowercase) must equal one of the mandate's subjects, else `SUBJECT_NOT_IN_MANDATE` |
| `option` | A setting | Must match `type`: `enum` (in `values`), `int` (`min`/`max`), `bool` |
| `forbidden` | Must not appear | Present means `PARAM_NOT_IN_SCHEMA` |

Any parameter not declared at all is treated as `forbidden`.

### Canonical URL rules

1. Parse with the WHATWG `URL` parser; reject anything else as `BAD_URL`.
2. Scheme must be `https`. The operator-bound parser permits exact cataloged HTTP loopback origins only, per `CHUNK-3-PHASE4-DECISIONS.md`; no agent-selectable dev flag or generic `*.test` exception is allowed. Live contact additionally requires the pending J2b checked transport.
3. Lowercase the host; drop default ports, the fragment and userinfo (userinfo present means `BAD_URL`).
4. Percent-decode the path once; reject `..` segments and empty segments.
5. A repeated query parameter means `DUPLICATE_PARAM`.
6. Sort query parameters by name.
7. Match `(origin, method, path)` to exactly one catalog endpoint; path templates match one segment per `{param}`.

## 4. Judge input and output

C's input builder is the **only** code allowed to construct judge input, and it may only read the fields below. Every string in the input comes from the human (mandate, policy) or the admin (catalog). Nothing comes from the agent, a merchant, or a web page.

### Input

```json
{
  "mandate": {
    "task": "Compile current list prices for 5 named competitors for the Q4 pricing review.",
    "subjects": ["acme", "globex", "initech", "umbrella", "hooli"],
    "budget_remaining": 1950000,
    "expires_in_ms": 1500000
  },
  "role_policy": "Research agents may buy market data needed for the assigned report. No bulk datasets, subscriptions or unrelated data.",
  "payment": {
    "price": 10000,
    "purpose": "fetch_data",
    "merchant": { "known": true, "name": "PriceScope", "category": "market data", "description": "Product pricing for named companies", "selected_for_mandate": true },
    "endpoint": { "known": true, "method": "GET", "category": "pricing lookup", "description": "Current list prices for one company" },
    "payee": { "first_seen": false, "prior_calls": 4, "recent_prices": [10000, 10000, 10000, 10000] },
    "params": [
      { "name": "company", "kind": "subject", "value": "acme" },
      { "name": "period", "kind": "option", "value": "30d" }
    ],
    "url_shape": null
  }
}
```

Unknown merchant/endpoint shape is retained for internal diagnostics and compatibility. In v1.3 every unknown route is denied before quote, grants or judge; this shape must never be sent to the model:

```json
"merchant": { "known": false, "selected_for_mandate": false },
"endpoint": { "known": false, "method": "GET" },
"params": [],
"url_shape": { "path_segments": [5, 12], "query_params": [ { "type": "string", "length": 44 } ] }
```

Rules for the builder:

- `params[].value` is included only for subject values that matched a mandate subject (the human's text) and option values from the catalog's fixed list. Otherwise omit the value.
- Unknown URLs are reduced to segment lengths and parameter types and lengths. No names, no values.
- No trust score, no session history, no merchant response, no agent text.
- The canary test: build judge input for every attack fixture and fail if any fixture's canary string appears in the serialized JSON.

### Output

The judge returns only this JSON. It does **not** name a payee, endpoint, method or parameters; code takes those from the request, so the judge can't redirect a grant.

```json
{
  "decision": "approve",
  "reasons": ["JUDGE_APPROVED"],
  "explanation": "A pricing lookup for a listed competitor serves the task.",
  "injection_suspected": false,
  "grant": { "max_per_call": 10000, "max_total": 100000, "ttl_ms": 1800000 }
}
```

Validation in code. Shape checks are the judge module's job (any failure means deny with `JUDGE_INVALID_OUTPUT`); the clamps below are the gateway's job when it creates the grant, because only the gateway has the caps and reference prices:

- `decision` in `approve`, `deny`, `escalate`.
- `reasons` non-empty, all from the judge reason codes.
- `explanation` at most 200 characters.
- `grant` only allowed when `decision` is `approve`.
- `grant.max_per_call` clamped to the minimum of the role's per-call cap, 2× the reference price, and 2× this payment's price.
- `grant.max_total` clamped to the mandate's remaining budget; `ttl_ms` clamped to the mandate's remaining time.

Model settings: temperature 0, pinned model version, 5-second timeout, structured output mode if the provider has one.

## 5. Shared types (`packages/contracts`)

```ts
export type Money = number;          // atomic USDC units, integer
export type EpochMs = number;
export type Address = `0x${string}`; // lowercase

export type PurposeCode = 'fetch_data' | 'fetch_report' | 'verify_access' | 'subscribe' | 'other';
export type HttpMethod = 'GET' | 'POST';
export type Stage = 'precontact' | 'tier0' | 'tier1' | 'judge' | 'human';
export type PaymentState = 'RESERVED' | 'SIGNED' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'UNKNOWN';

export type RestrictionState = 'normal' | 'review_required' | 'suspended';
export type IncidentCode = 'JUDGE_INJECTION_SUSPECTED' | 'PAYEE_SWAP' | 'PRICE_MISMATCH' | 'HUMAN_REJECTED' | 'JUDGE_OFF_TASK';

export type PrecontactCode = 'AGENT_SUSPENDED' | 'NO_MANDATE' | 'QUARANTINED' | 'DENYLIST' | 'SECRET_IN_URL' | 'QUERY_TOO_LONG'
  | 'PARAM_NOT_IN_SCHEMA' | 'SUBJECT_NOT_IN_MANDATE' | 'UNKNOWN_WITH_PARAMS' | 'DUPLICATE_PARAM' | 'BAD_URL' | 'UNCATALOGED_ENDPOINT' | 'MERCHANT_NOT_SELECTED';
export type QuoteCode = 'QUOTE_FAILED' | 'NOT_402' | 'QUOTE_INVALID';
export type Tier0Code = 'NETWORK' | 'PAYEE_SWAP' | 'PER_CALL_CAP' | 'REFERENCE_PRICE' | 'PRICE_MISMATCH'
  | 'MANDATE_BUDGET' | 'TENANT_DAILY' | 'VELOCITY' | 'DUPLICATE' | 'NEW_PAYEE_LIMIT' | 'INTERNAL_ERROR';
export type Tier1Code = 'GRANT_HIT' | 'GRANT_NONE' | 'GRANT_PRICE' | 'GRANT_ENDPOINT' | 'GRANT_METHOD'
  | 'GRANT_PARAMS' | 'GRANT_TRUST' | 'GRANT_EXHAUSTED';
export type JudgeCode = 'JUDGE_APPROVED' | 'JUDGE_OFF_TASK' | 'JUDGE_OVER_SCOPED' | 'JUDGE_UNKNOWN_MERCHANT'
  | 'JUDGE_PRICE_UNUSUAL' | 'JUDGE_UNEXPECTED_PARAMS' | 'JUDGE_INJECTION_SUSPECTED' | 'JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT';
export type HumanCode = 'HUMAN_APPROVED' | 'HUMAN_REJECTED' | 'HUMAN_TIMEOUT';
export type ReasonCode = PrecontactCode | QuoteCode | Tier0Code | Tier1Code | JudgeCode | HumanCode | 'TRUST_REQUIRES_HUMAN' | 'AGENT_REVIEW_REQUIRED';

// ---------- /pay ----------
export interface PayRequest {
  url: string;
  method: HttpMethod;
  expected_price: Money;
  purpose: PurposeCode;
  idempotency_key: string;
}

export type PayResponse =
  | { status: 'approved'; decision_id: string; payment_id: string; stage: Stage; amount: Money; payee: Address;
      response: { status_code: number; content_type: string; body: string } | null }
  | { status: 'denied'; decision_id: string; stage: Stage; reasons: ReasonCode[]; explanation: string | null }
  | { status: 'pending'; decision_id: string; poll_after_ms: number }
  | { status: 'payment_unknown'; decision_id: string; payment_id: string; poll_after_ms: number };

// ---------- Catalog ----------
export type ParamSpec =
  | { in: 'path' | 'query'; kind: 'subject' }
  | { in: 'path' | 'query'; kind: 'option'; type: 'enum'; values: string[] }
  | { in: 'path' | 'query'; kind: 'option'; type: 'int'; min: number; max: number }
  | { in: 'path' | 'query'; kind: 'option'; type: 'bool' }
  | { in: 'path' | 'query'; kind: 'forbidden' };

export interface CatalogEndpoint {
  id: string; method: HttpMethod; path: string;
  category: string; description: string;
  params: Record<string, ParamSpec>;
}
export interface CatalogMerchant {
  id: string; name: string; origin: string; payee: Address;
  category: string; description: string;
  endpoints: CatalogEndpoint[];
}
export interface Catalog {
  version: 1;
  merchants: CatalogMerchant[];
  standing_grants: { role: string; endpoint_id: string; max_per_call: Money; daily_total: Money }[];
}

// ---------- Payments module (owner A) ----------
export interface Quote {
  url: string;               // canonical
  method: HttpMethod;
  network: string;           // must be 'eip155:84532'
  payee: Address;
  amount: Money;
  raw: unknown;              // x402 payment requirements, passed back to pay() unchanged
}
export interface PaymentsModule {
  getQuote(canonicalUrl: string, method: HttpMethod): Promise<Quote>;          // throws QuoteError(code: QuoteCode)
  pay(paymentId: string, quote: Quote): Promise<                               // signs exactly quote.amount
    | { state: 'SETTLED'; txHash: string; response: { status_code: number; content_type: string; body: string } }
    | { state: 'FAILED'; reason: string }
    | { state: 'UNKNOWN' }>;
  reconcile(paymentId: string): Promise<'SETTLED' | 'FAILED' | 'UNKNOWN'>;
}

// Implemented by the gateway (owner B) over the payments table; used by the payments module (owner A).
// Every method is a conditional update on the current state and returns false if it changed nothing.
// pay() never calls fail(): a merchant's rejection proves nothing while a signed authorization is still valid.
export interface PaymentStore {
  canSign(paymentId: string): Promise<boolean>; // durable authority before invoking signer; markSigned checks again atomically
  get(paymentId: string): Promise<{ id: string; mandate_id: string; amount: Money; payee: Address; state: PaymentState;
    nonce: string | null; valid_before: EpochMs | null; authorization_json: string | null } | null>;
  markSigned(paymentId: string, f: { nonce: string; validBefore: EpochMs; authorizationJson: string }): Promise<boolean>; // RESERVED -> SIGNED
  markSubmitted(paymentId: string): Promise<boolean>;                    // SIGNED -> SUBMITTED (before sending)
  markUnknown(paymentId: string): Promise<boolean>;                      // SUBMITTED -> UNKNOWN
  settle(paymentId: string, txHash: string): Promise<boolean>;           // SIGNED|SUBMITTED|UNKNOWN -> SETTLED, moves reserved to spent
  fail(paymentId: string): Promise<boolean>;                             // RESERVED|SIGNED|SUBMITTED|UNKNOWN -> FAILED, releases reserved
  listUnresolved(): Promise<string[]>;                                   // ids in SIGNED, SUBMITTED, UNKNOWN
  // The merchant's 2xx reply, saved when it arrives so a settlement proven later can't lose the purchased data.
  saveResponse(paymentId: string, response: { status_code: number; content_type: string; body: string }): Promise<boolean>; // SUBMITTED|UNKNOWN|SETTLED, first save only
}

// ---------- Catalog matching (owner C) ----------
export type EndpointMatch =
  | { kind: 'known'; merchant: CatalogMerchant; endpoint: CatalogEndpoint;
      params: { name: string; kind: 'subject' | 'option' | 'forbidden' | 'undeclared'; value: string;
                violation: null | 'PARAM_NOT_IN_SCHEMA' }[] }
  | { kind: 'unknown'; origin: string; hasParams: boolean;
      urlShape: { path_segments: number[]; query_params: { type: 'string' | 'int' | 'other'; length: number }[] } };

// ---------- Judge module (owner C) ----------
export interface JudgeParam {
  name: string;
  kind: 'subject' | 'option';
  value?: string;            // only when the builder rules allow it
}
export interface JudgeInput {
  mandate: { task: string; subjects: string[]; budget_remaining: Money; expires_in_ms: number };
  role_policy: string;
  payment: {
    price: Money;
    purpose: PurposeCode;
    merchant: { known: true; name: string; category: string; description: string; selected_for_mandate: boolean }
            | { known: false; selected_for_mandate: false };
    endpoint: { known: true; method: HttpMethod; category: string; description: string }
            | { known: false; method: HttpMethod };
    payee: { first_seen: boolean; prior_calls: number; recent_prices: Money[] };
    params: JudgeParam[];
    url_shape: { path_segments: number[]; query_params: { type: 'string' | 'int' | 'other'; length: number }[] } | null;
  };
}
export interface JudgeOutput {
  decision: 'approve' | 'deny' | 'escalate';
  reasons: JudgeCode[];
  explanation: string;
  injection_suspected: boolean;
  grant?: { max_per_call: Money; max_total: Money; ttl_ms: number };
}
// Built by the gateway (owner B), projected only by buildInput (owner C). Raw match parameter values remain untrusted.
export interface JudgeContext {
  mandate: { task: string; subjects: string[]; allowed_merchant_ids: string[]; budget_remaining: Money; expires_in_ms: number };
  role_policy: string;
  price: Money;
  purpose: PurposeCode;
  method: HttpMethod;
  match: EndpointMatch;
  payee_facts: { first_seen: boolean; prior_calls: number; recent_prices: Money[] };
}
export interface JudgeModule {
  buildInput(ctx: JudgeContext): JudgeInput;
  judge(input: JudgeInput): Promise<JudgeOutput>;   // shape-validated; throws JudgeError('JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT'). Clamping is the gateway's job.
}

// ---------- Dashboard stream ----------
export type StreamEvent =
  | { type: 'agent_incident'; agent_id: string; decision_id: string; mandate_id: string; cause: IncidentCode; previous: RestrictionState; restriction: RestrictionState; at: EpochMs }
  | { type: 'agent_restored'; agent_id: string; restoration_id: string; previous: RestrictionState; restriction: RestrictionState; reason: string; operator: string; at: EpochMs }
  | { type: 'decision'; decision_id: string; mandate_id: string; stage: Stage; outcome: 'approved' | 'denied' | 'pending';
      reasons: ReasonCode[]; price: Money | null; latency_ms: number; at: EpochMs }
  | { type: 'payment'; payment_id: string; state: PaymentState; amount: Money; at: EpochMs }
  | { type: 'trust'; session_id: string; agent_id: string; session_trust: number; agent_trust: number; cause: string; at: EpochMs }
  | { type: 'approval_needed'; decision_id: string; mandate_id: string; explanation: string | null; at: EpochMs };
```

## 6. Changing a contract

1. Propose the change in the team chat with the reason.
2. The owner of `packages/contracts` (B) makes the edit and bumps the version line at the top of this file.
3. Everyone pulls before prompting their coding agent again.

No one changes a contract silently inside their own module.

## v1.3 contract changes

`UNCATALOGED_ENDPOINT` remains a pre-contact reason but now denies without review. `MERCHANT_NOT_SELECTED` is a pre-contact denial before quote contact. `STANDING_GRANTS=off` skips standing grants and lets Tier 1 continue to the judge; explicitly setting it to `on` enables them. The v1.3 contract also records the already-implemented `PaymentStore.saveResponse`, `GET /agents`, and `GET /approvals` changes. `/pay` requires the existing body key and a matching UUIDv4 `Idempotency-Key` header; conflicts return 409, in-progress replays return 202 with the existing pending handle. Other decision responses remain 200. Human approvals are request scoped and cannot override hard checks.


## v1.4 restriction and restoration contract

`GET /agents` is admin only. Each entry includes `restriction: RestrictionState`, `recent_incidents: AgentIncident[]` and `recent_restorations: AgentRestoration[]`, newest first (timestamp then insertion order), at most ten of each. The dashboard displays the latest three incidents and latest restoration. Histories remain append-only in SQLite; UPDATE and DELETE triggers protect both audit tables. Incidents use the decision ID as primary key; decision retries and human resumes cannot count twice.

```ts
export interface AgentIncident {
  decision_id: string; mandate_id: string; cause: IncidentCode;
  previous: RestrictionState; restriction: RestrictionState; created_at: EpochMs;
}
export interface AgentRestoration {
  id: string; previous: RestrictionState; restriction: RestrictionState;
  reason: string; operator: string; created_at: EpochMs;
}
export interface RestoreAgentRequest {
  target: 'normal' | 'review_required'; reason: string; operator: string;
}
export interface RestoreAgentResponse extends AgentRestoration { agent_id: string; }
```

### `POST /agents/:id/restore` request

Admin bearer authentication is required (401 missing, 403 wrong/agent token). The existing dashboard proxy additionally requires an operator session and same-origin writes. `operator` is a required, self-attested name under shared-admin authentication, not a verified individual identity. Required nonblank reason is at most 500 characters; operator at most 100. Unknown fields, invalid states, or malformed JSON return 400. Unknown agent returns 404. Target must be less restrictive, or equal when numeric scores/quarantine need recovery (otherwise 409); no-op and downward requests are rejected. This allows explicit recovery from nonincident score penalties even when the restriction state remains normal. The response is the durable audit record (200).

```json
{ "target": "normal", "reason": "Removed the poisoned source and inspected the agent", "operator": "Demo operator" }
```

### `POST /agents/:id/restore` response

```json
{ "id": "f54d07f4-bf8b-4930-8ddc-a641ebead230", "agent_id": "agt_pricing", "previous": "review_required", "restriction": "normal", "reason": "Removed the poisoned source and inspected the agent", "operator": "Demo operator", "created_at": 1800000000000 }
```

Restoration atomically records the audit, changes restriction, increments the agent's incident epoch, restores its score to the role baseline and clears quarantine/restores scores on unended sessions under active, unexpired mandates. It never reopens ended sessions, revoked/expired mandates, changes budgets, subjects, role caps or liabilities, or replays denied decisions. Restoring to `review_required` retains mandatory human review. Incidents from earlier epochs remain visible but cannot immediately re-suspend a restored agent. Only this endpoint performs upward transitions; a payment approval never does.

A first injection flag, `PAYEE_SWAP`, `PRICE_MISMATCH`, or `HUMAN_REJECTED` incident moves normal to review_required. Two security incidents in the same mandate and epoch suspend when already under review. `JUDGE_OFF_TASK` records a review signal but never contributes to suspension, even with a severe classification. Its numeric penalty is floored at 20 (without raising an already lower score), so it cannot itself quarantine. A trusted internal severe-security classification suspends directly; no existing detector is newly classified severe because the design specifies none. No public/agent input can set severity. Infrastructure/quote errors, malformed input and pre-contact denials are not incidents and do not lower scores. Other valid Tier 0 denials keep existing score penalties without creating security incidents.

All automatic score deltas are nonpositive. Durable state is read before contact, grant use, final approval, human resume, restart recovery and signing. The final approval and `markSigned` guards run in their respective atomic SQLite writes. `canSign` also checks immediately before invoking the signer. A restriction during an asynchronous signer call prevents storing/submitting its result; it cannot recall a signature already issued by the external signer. Submitted liabilities remain reserved and reconciled. Recovery never reauthorizes an unsigned approved payment.

### Restriction stream examples

```json
{ "type": "agent_incident", "agent_id": "agt_pricing", "decision_id": "dec_example", "mandate_id": "mnd_example", "cause": "JUDGE_INJECTION_SUSPECTED", "previous": "normal", "restriction": "review_required", "at": 1800000000000 }
```

### Restoration stream example

```json
{ "type": "agent_restored", "agent_id": "agt_pricing", "restoration_id": "f54d07f4-bf8b-4930-8ddc-a641ebead230", "previous": "review_required", "restriction": "normal", "reason": "Removed the poisoned source and inspected the agent", "operator": "Demo operator", "at": 1800000000000 }
```

These events publish after commit. SSE is a live notification channel, not durable replay; `GET /agents` provides persisted audit history after reconnect/restart.
