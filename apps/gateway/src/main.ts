import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createEventBus } from './bus.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { seedDatabase } from './db/seed.js';
import { createLogger, stdoutSink } from './log.js';
import { loadCatalog } from './stubs/catalog-stub.js';

const config = loadConfig(process.env);
const log = createLogger(stdoutSink, { clock: systemClock, secrets: [config.adminToken] });

// The catalog is loaded into the database at every start (final_contracts.md section 1).
const db = openDb(config.databasePath);
const catalog = loadCatalog(config.catalogPath);
seedDatabase(db, catalog, systemClock);

const bus = createEventBus(log);
const app = createApp({ db, clock: systemClock, config, catalog, bus, log });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info('gateway listening', {
    port: info.port,
    payments_mode: config.paymentsMode,
    judge_mode: config.judgeMode,
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => {
    db.sqlite.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
