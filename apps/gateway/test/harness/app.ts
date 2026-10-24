// The whole gateway in-process: real routes, middleware and database, a test clock, and
// captured logs and stream events. Later phases add fake payments and a scripted judge.
import {
  StreamEventSchema,
  type CreateMandateRequest,
  type CreateMandateResponse,
  type StreamEvent,
} from '@apf/contracts';
import { expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { createEventBus } from '../../src/bus.js';
import type { Config } from '../../src/config.js';
import type { Deps } from '../../src/deps.js';
import { createLogger } from '../../src/log.js';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { TestClock } from './clock.js';
import { FIXTURE_CATALOG_PATH, seededDb } from './db.js';

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

export function createHarness(overrides: Partial<Config> = {}) {
  const clock = new TestClock();
  const { db } = seededDb(clock);
  const logs: string[] = [];
  const log = createLogger({ write: (line) => logs.push(line) }, { clock, secrets: [ADMIN_TOKEN] });
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
  const deps: Deps = { db, clock, config, catalog: loadCatalog(FIXTURE_CATALOG_PATH), bus, log };
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

  async function createMandate(
    overrides: Partial<CreateMandateRequest> = {},
  ): Promise<CreateMandateResponse> {
    const res = await admin('/mandates', {
      method: 'POST',
      body: JSON.stringify({ ...MANDATE_BODY, ...overrides }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateMandateResponse;
    issuedTokens.push(body.token);
    return body;
  }

  return { app, deps, db, clock, bus, events, logs, issuedTokens, request, admin, createMandate };
}

export type Harness = ReturnType<typeof createHarness>;
