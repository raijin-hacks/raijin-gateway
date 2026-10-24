// final_contracts.md section 1 as a Drizzle schema, with every CHECK. Column names match the
// SQL exactly. Additions proposed in CHUNK-2-BUILD-PLAN.md (D4–D6) are marked "Proposed"; they
// are additive and still need team sign-off through final_contracts.md section 6.
// After editing, run `pnpm --filter @apf/gateway db:generate` and commit the new migration.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const tenants = sqliteTable('tenants', {
  id: text().primaryKey(),
  name: text().notNull(),
  daily_cap: integer().notNull(), // atomic USDC
  created_at: integer().notNull(),
});

export const roles = sqliteTable('roles', {
  id: text().primaryKey(),
  tenant_id: text()
    .notNull()
    .references(() => tenants.id),
  name: text().notNull(), // 'research', 'bulk'
  policy_text: text().notNull(), // trusted, shown to the judge
  per_call_cap: integer().notNull(),
  velocity_per_min: integer().notNull(),
  baseline_trust: integer().notNull(), // e.g. 70
  grant_trust_threshold: integer().notNull(), // e.g. 60
});

export const agents = sqliteTable('agents', {
  id: text().primaryKey(),
  tenant_id: text()
    .notNull()
    .references(() => tenants.id),
  role_id: text()
    .notNull()
    .references(() => roles.id),
  name: text().notNull(),
  trust: real().notNull(), // agent-level score
});

// Catalog is loaded from catalog/catalog.json at startup into these tables.
export const merchants = sqliteTable('merchants', {
  id: text().primaryKey(), // 'mer_...'
  tenant_id: text()
    .notNull()
    .references(() => tenants.id),
  name: text().notNull(),
  origin: text().notNull(), // canonical 'https://host[:port]'
  payee: text().notNull(), // lowercase 0x address
  category: text().notNull(),
  description: text().notNull(), // admin-written, trusted
});

export const endpoints = sqliteTable(
  'endpoints',
  {
    id: text().primaryKey(), // 'end_...'
    merchant_id: text()
      .notNull()
      .references(() => merchants.id),
    method: text({ enum: ['GET', 'POST'] }).notNull(),
    path: text().notNull(), // exact template, e.g. '/v1/pricing/{company}'
    category: text().notNull(),
    description: text().notNull(),
    params_json: text().notNull(), // Record<string, ParamSpec>
  },
  (t) => [
    check('endpoints_method', sql`${t.method} IN ('GET','POST')`),
    unique('endpoints_route').on(t.merchant_id, t.method, t.path),
  ],
);

export const standingGrants = sqliteTable('standing_grants', {
  id: text().primaryKey(),
  role_id: text()
    .notNull()
    .references(() => roles.id),
  endpoint_id: text()
    .notNull()
    .references(() => endpoints.id),
  max_per_call: integer().notNull(),
  daily_total: integer().notNull(),
});

export const mandates = sqliteTable(
  'mandates',
  {
    id: text().primaryKey(),
    tenant_id: text()
      .notNull()
      .references(() => tenants.id),
    agent_id: text()
      .notNull()
      .references(() => agents.id),
    task: text().notNull(), // human-written, trusted
    subjects_json: text().notNull(), // string[], normalized (trim, lowercase)
    allowed_merchants_json: text().notNull(), // merchant ids[]
    budget: integer().notNull(),
    spent: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    status: text({ enum: ['active', 'closed', 'expired'] }).notNull(),
    token_hash: text().notNull().unique(), // sha256 of the token; token itself never stored
    expires_at: integer().notNull(),
    created_by: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    check('mandates_status', sql`${t.status} IN ('active','closed','expired')`),
    check(
      'mandates_money',
      sql`${t.spent} >= 0 AND ${t.reserved} >= 0 AND ${t.spent} + ${t.reserved} <= ${t.budget}`,
    ),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    mandate_id: text()
      .notNull()
      .references(() => mandates.id),
    agent_id: text()
      .notNull()
      .references(() => agents.id),
    trust: real().notNull(),
    status: text({ enum: ['active', 'quarantined', 'ended'] }).notNull(),
    created_at: integer().notNull(),
  },
  (t) => [check('sessions_status', sql`${t.status} IN ('active','quarantined','ended')`)],
);

export const grants = sqliteTable(
  'grants',
  {
    id: text().primaryKey(),
    mandate_id: text()
      .notNull()
      .references(() => mandates.id),
    endpoint_id: text()
      .notNull()
      .references(() => endpoints.id),
    payee: text().notNull(),
    method: text().notNull(),
    origin: text().notNull(),
    path: text().notNull(),
    option_values_json: text().notNull(), // Record<paramName, value> approved for 'option' params
    max_per_call: integer().notNull(),
    max_total: integer().notNull(),
    used_total: integer().notNull().default(0),
    source: text({ enum: ['judge', 'human'] }).notNull(),
    expires_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    check('grants_source', sql`${t.source} IN ('judge','human')`),
    // Tier 1 lookup.
    index('grants_mandate_endpoint').on(t.mandate_id, t.endpoint_id),
  ],
);

export const referencePrices = sqliteTable(
  'reference_prices',
  {
    tenant_id: text().notNull(),
    payee: text().notNull(),
    endpoint_id: text().notNull(),
    price: integer().notNull(), // first price ever approved
    created_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.payee, t.endpoint_id] })],
);

export const decisions = sqliteTable(
  'decisions',
  {
    id: text().primaryKey(),
    idempotency_key: text().notNull(),
    mandate_id: text()
      .notNull()
      .references(() => mandates.id),
    session_id: text()
      .notNull()
      .references(() => sessions.id),
    canonical_url: text().notNull(), // for logs and dashboard only; never sent to the judge
    method: text().notNull(),
    endpoint_id: text(), // null if not in catalog
    payee: text(), // null if denied before the quote
    price: integer(),
    stage: text({ enum: ['precontact', 'tier0', 'tier1', 'judge', 'human'] }).notNull(),
    outcome: text({ enum: ['approved', 'denied', 'pending'] }).notNull(),
    reasons_json: text().notNull(), // ReasonCode[]
    explanation: text(),
    judge_ms: integer(),
    created_at: integer().notNull(),
    // Proposed (D4): the request's expected_price and purpose, so a held request can resume.
    request_json: text(),
  },
  (t) => [
    check('decisions_stage', sql`${t.stage} IN ('precontact','tier0','tier1','judge','human')`),
    check('decisions_outcome', sql`${t.outcome} IN ('approved','denied','pending')`),
    unique('decisions_idempotency').on(t.mandate_id, t.idempotency_key),
    // Tier 0 VELOCITY, DUPLICATE and NEW_PAYEE_LIMIT lookups.
    index('decisions_session_time').on(t.session_id, t.created_at),
    index('decisions_session_url_price').on(t.session_id, t.canonical_url, t.price, t.created_at),
    index('decisions_mandate_stage_outcome').on(t.mandate_id, t.stage, t.outcome),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text().primaryKey(), // 'pay_...', stable across retries
    decision_id: text()
      .notNull()
      .unique()
      .references(() => decisions.id),
    mandate_id: text()
      .notNull()
      .references(() => mandates.id),
    amount: integer().notNull(),
    payee: text().notNull(),
    nonce: text(), // EIP-3009 nonce, set at SIGNED
    valid_before: integer(), // set at SIGNED
    authorization_json: text(), // the signed payload, reused on retry
    state: text({
      enum: ['RESERVED', 'SIGNED', 'SUBMITTED', 'SETTLED', 'FAILED', 'UNKNOWN'],
    }).notNull(),
    tx_hash: text(),
    updated_at: integer().notNull(),
    // Proposed (D4): the quote this payment signs, reused on retries and after a human approves.
    quote_json: text(),
    // Proposed (D4): the merchant's response, for idempotent replays and GET /decisions/:id.
    response_json: text(),
    // Proposed (D5): the UTC day (YYYY-MM-DD) whose tenant_daily row holds this payment.
    day: text().notNull(),
  },
  (t) => [
    check(
      'payments_state',
      sql`${t.state} IN ('RESERVED','SIGNED','SUBMITTED','SETTLED','FAILED','UNKNOWN')`,
    ),
    // PaymentStore.listUnresolved.
    index('payments_state_idx').on(t.state),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text().primaryKey(),
    decision_id: text()
      .notNull()
      .unique()
      .references(() => decisions.id),
    reviewer: text().notNull(),
    outcome: text({ enum: ['approved', 'rejected', 'timeout'] }).notNull(),
    note: text().notNull(),
    issue_grant: integer().notNull().default(0),
    created_at: integer().notNull(),
  },
  (t) => [check('approvals_outcome', sql`${t.outcome} IN ('approved','rejected','timeout')`)],
);

export const trustEvents = sqliteTable('trust_events', {
  id: text().primaryKey(),
  session_id: text()
    .notNull()
    .references(() => sessions.id),
  agent_id: text()
    .notNull()
    .references(() => agents.id),
  delta_session: real().notNull(),
  delta_agent: real().notNull(),
  cause: text().notNull(), // a ReasonCode or 'APPROVED'
  decision_id: text().references(() => decisions.id),
  created_at: integer().notNull(),
});

// Proposed (D5): spent + reserved per tenant per UTC day, updated atomically with each
// reservation so TENANT_DAILY can't be overshot by parallel calls.
export const tenantDaily = sqliteTable(
  'tenant_daily',
  {
    tenant_id: text()
      .notNull()
      .references(() => tenants.id),
    day: text().notNull(),
    committed: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.day] }),
    check('tenant_daily_committed', sql`${t.committed} >= 0`),
  ],
);

// Proposed (D6): use of each standing grant per UTC day, capped at its daily_total.
export const standingGrantUsage = sqliteTable(
  'standing_grant_usage',
  {
    standing_grant_id: text()
      .notNull()
      .references(() => standingGrants.id),
    day: text().notNull(),
    used_total: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.standing_grant_id, t.day] }),
    check('standing_grant_usage_used', sql`${t.used_total} >= 0`),
  ],
);

// Chunk 2-owned internal durable coordination; no expiring claims or cache tombstones.
export const gatewaySecrets = sqliteTable('gateway_secrets', {
  id: text().primaryKey(),
  value: text().notNull(),
});
export const payWorkflows = sqliteTable(
  'pay_workflows',
  {
    decision_id: text()
      .primaryKey()
      .references(() => decisions.id),
    binding: text().notNull(),
    state: text().notNull(),
    owner: text().notNull(),
    catalog_revision: text().notNull(),
    request_json: text().notNull(),
    quote_json: text(),
    deadline: integer().notNull(),
    response_json: text(),
    reviewed_json: text().notNull(),
    tier0_at: integer(),
  },
  (t) => [
    check(
      'pay_workflows_state',
      sql`${t.state} IN ('PROCESSING','REVIEW','AUTHORIZED','UNKNOWN','TERMINAL')`,
    ),
  ],
);

// Immutable per-stage review history; approvals retains its contracted one-row summary.
export const payReviewEvents = sqliteTable('pay_review_events', {
  id: text().primaryKey(),
  decision_id: text()
    .notNull()
    .references(() => decisions.id),
  outcome: text().notNull(),
  note: text().notNull(),
  reasons_json: text().notNull(),
  created_at: integer().notNull(),
});
