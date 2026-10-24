// Everything the app needs, passed in rather than imported, so tests can swap in fakes.
// Later phases add payments, judge and catalog matching.
import type { Catalog, JudgeModule, PaymentsModule } from '@apf/contracts';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { MandateRow, SessionRow } from './db/repos/mandates.js';
import type { Logger } from './log.js';
import type { Pipeline } from './pipeline/index.js';
import type { createGatewayAdmission } from './judge/gateway.js';

export interface Deps {
  db: Db;
  clock: Clock;
  config: Config;
  catalog: Catalog;
  catalogAdmission?: ReturnType<typeof createGatewayAdmission>;
  pipeline?: Pipeline;
  payments?: PaymentsModule;
  judge?: JudgeModule;
  bus: EventBus;
  log: Logger;
}

/** Set by agentAuth: the caller's mandate and its session. */
export interface AgentContext {
  mandate: MandateRow;
  session: SessionRow;
}

export interface AppEnv {
  Variables: {
    agent: AgentContext;
    pollAdmin: boolean;
    catalogAdmission: ReturnType<typeof createGatewayAdmission> | undefined;
  };
}
