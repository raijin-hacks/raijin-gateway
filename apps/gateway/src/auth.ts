// Admin and agent authentication (final_contracts.md section 2).
// Admin: no usable Bearer header is 401; any other token, including a mandate token, is 403 (A11).
// Agent: a mandate token that is unknown, closed or expired is 401.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Config } from './config.js';
import { createMandateRepo } from './db/repos/mandates.js';
import type { AppEnv, Deps } from './deps.js';

/** SHA-256 hex. Mandate tokens are stored only in this form. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes in base64url (43 characters). Returned to the admin once, never stored. */
export function newMandateToken(): string {
  return randomBytes(32).toString('base64url');
}

function bearerToken(header: string | undefined): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1] ?? null;
}

export function adminAuth(config: Pick<Config, 'adminToken'>): MiddlewareHandler<AppEnv> {
  const expected = createHash('sha256').update(config.adminToken).digest();
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (token === null) return c.json({ error: 'unauthorized' }, 401);
    // Compare fixed-length digests so the comparison takes the same time for any token.
    const given = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(given, expected)) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}

export function agentAuth(deps: Pick<Deps, 'db' | 'clock'>): MiddlewareHandler<AppEnv> {
  const mandates = createMandateRepo(deps.db);
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const agent =
      token === null ? null : mandates.findActiveByTokenHash(hashToken(token), deps.clock.now());
    if (agent === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent', agent);
    await next();
  };
}
