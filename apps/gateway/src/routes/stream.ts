// GET /stream (admin): every StreamEvent as a plain SSE message (no `event:` name, so a
// browser EventSource's onmessage receives it), plus a comment heartbeat.
import type { Handler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv, Deps } from '../deps.js';

export function stream(deps: Deps): Handler<AppEnv> {
  return (c) =>
    streamSSE(c, async (sse) => {
      // Writes are async; chain them so events go out in the order they were published.
      let pending = Promise.resolve();
      const send = (write: () => Promise<unknown>) => {
        pending = pending
          .then(write)
          .then(() => undefined)
          .catch((error: unknown) => {
            deps.log.warn('stream write failed', { error });
            sse.abort();
          });
      };

      const unsubscribe = deps.bus.subscribe((event) =>
        send(() => sse.writeSSE({ data: JSON.stringify(event) })),
      );
      const heartbeat = setInterval(
        () => send(() => sse.write(': heartbeat\n\n')),
        deps.config.streamHeartbeatMs,
      );

      await new Promise<void>((resolve) =>
        sse.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        }),
      );
    });
}
