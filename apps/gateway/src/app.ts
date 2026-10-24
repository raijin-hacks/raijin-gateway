import { Hono } from 'hono';

// Phase 3 turns this into createApp(deps); see CHUNK-2-BUILD-PLAN.md.
export function createApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
