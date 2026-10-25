import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminAuth, agentAuth } from './auth.js';
import type { AppEnv, Deps } from './deps.js';
import { notFound } from './http.js';
import { closeMandate, createMandate } from './routes/mandates.js';
import { stream } from './routes/stream.js';
import { createPipeline } from './pipeline/index.js';
import { approvalRoute, decisionRoute, payRoute, paymentRoute, pollAuth } from './routes/pay.js';
import { agentsRoute, approvalsRoute, restoreAgentRoute } from './routes/operators.js';

export type { AppEnv } from './deps.js';

/** Larger bodies get 413. The biggest legitimate body is a mandate with a long task. */
const MAX_BODY_BYTES = 64 * 1024;

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('catalogAdmission', deps.catalogAdmission);
    await next();
  });
  app.use(requestLog(deps));
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  const admin = adminAuth(deps.config);
  const pipeline =
    deps.pipeline ??
    (deps.payments && deps.judge
      ? createPipeline({ ...deps, payments: deps.payments, judge: deps.judge })
      : undefined);

  // Every route and who may call it (final_contracts.md section 2).
  app.post('/pay', agentAuth(deps), payRoute(pipeline));
  app.get('/decisions/:id', pollAuth(deps), decisionRoute(deps, pipeline));
  app.get('/payments/:id', pollAuth(deps), paymentRoute(deps));
  app.post('/approvals/:decision_id', admin, approvalRoute(pipeline));
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/mandates', admin, createMandate(deps));
  app.post('/mandates/:id/close', admin, closeMandate({ ...deps, pipeline }));
  app.get('/catalog', admin, (c) => c.json(deps.catalog));
  app.post('/agents/:id/restore', admin, restoreAgentRoute(deps));
  app.get('/agents', admin, agentsRoute(deps));
  app.get('/approvals', admin, approvalsRoute(deps, pipeline));
  app.get('/stream', admin, stream(deps));

  app.notFound((c) => notFound(c));
  app.onError((error, c) => {
    deps.log.error('unhandled error', { error, method: c.req.method, path: c.req.path });
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}

/** One line per request: method, path, status, duration. Never headers or bodies. */
function requestLog(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = deps.clock.now();
    await next();
    deps.log.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: deps.clock.now() - start,
    });
  };
}
