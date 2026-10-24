// The whole gateway in-process: real routes, middleware and database, a test clock, and
// captured logs and stream events. Later phases add fake payments and a scripted judge.
import {
  StreamEventSchema,
  type Catalog,
  type CreateMandateRequest,
  type CreateMandateResponse,
  type StreamEvent,
} from '@apf/contracts';
import { expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { createEventBus } from '../../src/bus.js';
import type { Config } from '../../src/config.js';
import type { Deps } from '../../src/deps.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from './clock.js';
import { FIXTURE_CATALOG_PATH, seededDb } from './db.js';
import { captureLogger } from './log.js';

export const ADMIN_TOKEN = 'test-admin-token-not-a-real-secret';

export const MANDATE_BODY: CreateMandateRequest = {
  agent_id: 'agt_pricing',
  task: 'Compile current list prices for 5 named competitors for the Q4 pricing review.',
  subjects: ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli'],
  allowed_merchant_ids: ['mer_pricing'],
  budget: 2_000_000,
  expires_in_ms: 30 * 60_000,
};

type RequestOptions = Omit<RequestInit, 'headers'> & {
  token?: string;
  headers?: Record<string, string>;
};

export function createHarness(
  overrides: Partial<Config> = {},
  { catalog = loadCatalog(FIXTURE_CATALOG_PATH) }: { catalog?: Catalog } = {},
) {
  const clock = new TestClock();
  const { db } = seededDb(clock);
  const {
    log,
    lines: logs,
    records: logRecords,
  } = captureLogger({ clock, secrets: [ADMIN_TOKEN] });
  const bus = createEventBus(log);
  const events: StreamEvent[] = [];
  // Every published event must match the contract exactly.
  bus.subscribe((event) => events.push(StreamEventSchema.parse(event)));

  const config: Config = {
    adminToken: ADMIN_TOKEN,
    databasePath: db.sqlite.name,
    catalogPath: FIXTURE_CATALOG_PATH,
    port: 0,
    paymentsMode: 'mock',
    judgeMode: 'stub-escalate',
    streamHeartbeatMs: 15_000,
    ...overrides,
  };
  const deps: Deps = { db, clock, config, catalog, bus, log };
  const app = createApp(deps);
  const issuedTokens: string[] = [];

  const request = (path: string, { token, headers, ...init }: RequestOptions = {}) =>
    app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
    });
  const admin = (path: string, init: RequestOptions = {}) =>
    request(path, { token: ADMIN_TOKEN, ...init });

  /** POST /mandates with MANDATE_BODY plus `patch` (raw string bodies go through unchanged). */
  const postMandate = (patch: Record<string, unknown> | string = {}, token = ADMIN_TOKEN) =>
    request('/mandates', {
      method: 'POST',
      token,
      body: typeof patch === 'string' ? patch : JSON.stringify({ ...MANDATE_BODY, ...patch }),
    });

  async function createMandate(
    patch: Partial<CreateMandateRequest> = {},
  ): Promise<CreateMandateResponse> {
    const res = await postMandate(patch);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateMandateResponse;
    issuedTokens.push(body.token);
    return body;
  }

  const closeMandate = (mandateId: string) =>
    admin(`/mandates/${mandateId}/close`, { method: 'POST', body: '{}' });

  return {
    app,
    deps,
    db,
    clock,
    bus,
    events,
    logs,
    logRecords,
    issuedTokens,
    request,
    admin,
    postMandate,
    createMandate,
    closeMandate,
  };
}

export type Harness = ReturnType<typeof createHarness>;
