import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createEventBus } from './bus.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { seedDatabase } from './db/seed.js';
import { createLogger, stdoutSink } from './log.js';
import { loadCatalog } from './catalog/load.js';
import { createGatewayAdmission } from './judge/gateway.js';
import { createJudge, createStubJudge } from './judge/index.js';
import { createPayments, QuoteError, startReconciler } from './payments/index.js';
import { createPaymentStore } from './db/payment-store.js';
import { createMockPayments } from './mock-payments.js';
import { withPaymentEvents } from './payment-events.js';
import { createPipeline } from './pipeline/index.js';

const config = loadConfig(process.env);
const log = createLogger(stdoutSink, { clock: systemClock, secrets: [config.adminToken] });

// The catalog is loaded into the database at every start (final_contracts.md section 1).
const catalog = loadCatalog(config.catalogPath);
const catalogAdmission = createGatewayAdmission(catalog);
const db = openDb(config.databasePath);
seedDatabase(db, catalog, systemClock);

const bus = createEventBus(log);
const store = withPaymentEvents(createPaymentStore(db, systemClock), bus, systemClock);
const judge =
  config.judgeMode === 'real'
    ? createJudge({
        model: process.env.JUDGE_MODEL ?? '',
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        timeoutMs: 5000,
      })
    : createStubJudge(config.judgeMode);
const walletKey = process.env.WALLET_PRIVATE_KEY;
if (config.paymentsMode === 'real' && !/^0x[0-9a-f]{64}$/i.test(walletKey ?? ''))
  throw new Error('Invalid WALLET_PRIVATE_KEY');
const underlying =
  config.paymentsMode === 'mock'
    ? createMockPayments(store, catalog, systemClock)
    : createPayments({
        store,
        clock: systemClock,
        config: {
          walletPrivateKey: walletKey as `0x${string}`,
          rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
        },
      });
// J2b is a documented follow-up: no live merchant contact/signing through an unchecked
// connector. Reconciliation of already-submitted authorizations remains enabled.
const payments =
  config.paymentsMode === 'mock'
    ? underlying
    : {
        ...underlying,
        async getQuote(): Promise<never> {
          throw new QuoteError('QUOTE_FAILED', 'Pinned transport required');
        },
        async pay(): Promise<never> {
          throw new Error('PINNED_TRANSPORT_REQUIRED');
        },
      };
const deps = {
  db,
  clock: systemClock,
  config,
  catalog,
  catalogAdmission,
  bus,
  log,
  payments,
  judge,
};
const pipeline = createPipeline(deps);
pipeline.recover();
await pipeline.sweep();
const stopReconciler = startReconciler(payments, store);
const sweepTimer = setInterval(() => {
  void pipeline.sweep().catch(() => log.error('payment workflow sweep failed'));
}, 30000);
sweepTimer.unref();
const app = createApp({ ...deps, pipeline });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info('gateway listening', {
    port: info.port,
    payments_mode: config.paymentsMode,
    judge_mode: config.judgeMode,
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  clearInterval(sweepTimer);
  stopReconciler();
  server.close(() => {
    db.sqlite.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
