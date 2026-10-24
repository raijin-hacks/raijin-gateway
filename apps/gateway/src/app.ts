import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminAuth } from './auth.js';
import type { AppEnv, Deps } from './deps.js';
import { notFound } from './http.js';
import { closeMandate, createMandate } from './routes/mandates.js';
import { stream } from './routes/stream.js';

export type { AppEnv } from './deps.js';

/** Larger bodies get 413. The biggest legitimate body is a mandate with a long task. */
const MAX_BODY_BYTES = 64 * 1024;

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestLog(deps));
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  const admin = adminAuth(deps.config);

  // Every route and who may call it (final_contracts.md section 2).
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/mandates', admin, createMandate(deps));
  app.post('/mandates/:id/close', admin, closeMandate(deps));
  app.get('/catalog', admin, (c) => c.json(deps.catalog));
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
