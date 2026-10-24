// Gateway settings from the environment, checked once at startup. A bad value stops the
// process with a message naming the variable (never its value).
import { TIMING } from '@apf/contracts';
import { z } from 'zod';

/** Relative paths resolve from the working directory: apps/gateway when run through pnpm. */
export const DEFAULT_CATALOG_PATH = '../../catalog/catalog.json';

export interface Config {
  adminToken: string;
  databasePath: string;
  catalogPath: string;
  port: number;
  paymentsMode: 'real' | 'mock';
  judgeMode: 'real' | 'stub-escalate' | 'stub-approve';
  standingGrants: boolean;
  /** Not an environment setting; tests shorten it. */
  streamHeartbeatMs: number;
  denylistHosts?: string[];
}

const EnvSchema = z.object({
  ADMIN_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  DATABASE_PATH: z.string().min(1).default('./gateway.db'),
  CATALOG_PATH: z.string().min(1).default(DEFAULT_CATALOG_PATH),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  PAYMENTS_MODE: z.enum(['real', 'mock']).default('mock'),
  JUDGE_MODE: z.enum(['real', 'stub-escalate', 'stub-approve']).default('stub-escalate'),
  STANDING_GRANTS: z.enum(['on', 'off']).default('off'),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid gateway configuration. ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    ...(env.DENYLIST_HOSTS
      ? {
          denylistHosts: env.DENYLIST_HOSTS.split(',')
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        }
      : {}),
    adminToken: e.ADMIN_TOKEN,
    databasePath: e.DATABASE_PATH,
    catalogPath: e.CATALOG_PATH,
    port: e.PORT,
    paymentsMode: e.PAYMENTS_MODE,
    judgeMode: e.JUDGE_MODE,
    standingGrants: e.STANDING_GRANTS === 'on',
    streamHeartbeatMs: TIMING.streamHeartbeatMs,
  };
}
