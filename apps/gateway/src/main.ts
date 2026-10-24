import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port}`);
});
