// Chunk 2-owned HTTP boundary. Authentication precedes request parsing and key claims.
import { ApprovalRequestSchema, PayRequestSchema } from '@apf/contracts';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Deps } from '../deps.js';
import { adminAuth, agentAuth } from '../auth.js';
import { readJson } from '../http.js';
import { UUID_V4 } from '../pipeline/idempotency.js';
import type { Pipeline } from '../pipeline/index.js';

export function payRoute(pipeline: Pipeline | undefined): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const body = await readJson(c, PayRequestSchema);
    if (!body.ok) return body.response;
    const key = c.req.header('Idempotency-Key');
    if (
      !key ||
      !UUID_V4.test(key) ||
      key.toLowerCase() !== body.value.idempotency_key.toLowerCase()
    )
      return c.json({ error: 'invalid_idempotency_key' }, 400);
    if (!pipeline) return c.json({ error: 'payment_pipeline_unavailable' }, 503);
    const result = await pipeline.run(c.get('agent'), {
      ...body.value,
      idempotency_key: key.toLowerCase(),
    });
    if ('conflict' in result) return c.json({ error: 'idempotency_conflict' }, 409);
    return c.json(result.response, result.processing ? 202 : 200);
  };
}
/** Polling supports admins and scoped agents; never put admin credentials in agent clients. */
export function pollAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const admin = adminAuth(deps.config);
  const agent = agentAuth(deps);
  return async (c, next) => {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
    // Admin middleware performs the constant-time comparison; try it without revealing data.
    let accepted = false;
    await admin(c, async () => {
      accepted = true;
    });
    if (accepted) {
      c.set('pollAdmin', true);
      await next();
      return;
    }
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    return agent(c, next);
  };
}
export function decisionRoute(
  deps: Deps,
  pipeline: Pipeline | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const row = deps.db.sqlite
      .prepare('SELECT mandate_id FROM decisions WHERE id = ?')
      .get(c.req.param('id')) as { mandate_id: string } | undefined;
    if (!row || (!c.get('pollAdmin') && row.mandate_id !== c.get('agent').mandate.id))
      return c.json({ error: 'not_found' }, 404);
    if (!pipeline) return c.json({ error: 'payment_pipeline_unavailable' }, 503);
    await pipeline.sweep();
    return c.json(pipeline.replay(c.req.param('id')!));
  };
}
export function paymentRoute(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const row = deps.db.sqlite
      .prepare(
        'SELECT id AS payment_id, mandate_id, state, amount, payee, tx_hash FROM payments WHERE id = ?',
      )
      .get(c.req.param('id')) as
      | {
          payment_id: string;
          mandate_id: string;
          state: string;
          amount: number;
          payee: string;
          tx_hash: string | null;
        }
      | undefined;
    if (!row || (!c.get('pollAdmin') && row.mandate_id !== c.get('agent').mandate.id))
      return c.json({ error: 'not_found' }, 404);
    const { mandate_id: _mandate, ...response } = row;
    void _mandate;
    return c.json(response);
  };
}
export function approvalRoute(pipeline: Pipeline | undefined): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const body = await readJson(c, ApprovalRequestSchema);
    if (!body.ok) return body.response;
    if (!pipeline) return c.json({ error: 'payment_pipeline_unavailable' }, 503);
    if (!(await pipeline.review(c.req.param('decision_id')!, body.value)))
      return c.json({ error: 'review_unavailable' }, 409);
    return c.json({ ok: true });
  };
}
