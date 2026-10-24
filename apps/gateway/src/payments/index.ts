// Payments module (owner A): what Chunk 2's pipeline calls.
import { privateKeyToAccount } from 'viem/accounts';
import { systemClock, type Clock } from '../clock.js';
import { createPay } from './pay.js';
import { getQuote } from './quote.js';
import { createReconcile } from './reconcile.js';
import type { Transport } from './transport.js';
import type { PaymentsModule, PaymentStore } from '@apf/contracts';

export { getQuote, QuoteError } from './quote.js';
export { SettlementNotRecordedError } from './pay.js';
export { startReconciler } from './reconcile.js';
export { createDestinationVerifier, DestinationError } from './destination.js';
export { createPinnedTransport, type Transport } from './transport.js';

export interface PaymentsConfig {
  walletPrivateKey: `0x${string}`; // testnet only
  rpcUrl?: string; // Base Sepolia JSON-RPC, used by reconcile (BASE_SEPOLIA_RPC_URL)
  // A payment the reconciler can't resolve without an operator (e.g. chain unreadable long past expiry). Wire to alerts.
  onStuck?: (paymentId: string, reason: string) => void;
}

export function createPayments(deps: {
  store: PaymentStore;
  config: PaymentsConfig;
  clock?: Clock;
  // How payments reaches merchants. The gateway passes createPinnedTransport (J2b); only tests pass
  // plain fetch. There is deliberately no default, so nothing falls back to an unchecked connection.
  transport: Transport;
}): PaymentsModule {
  const clock = deps.clock ?? systemClock;
  const reconcile = createReconcile(deps.store, {
    rpcUrl: deps.config.rpcUrl,
    wallet: privateKeyToAccount(deps.config.walletPrivateKey).address,
    onStuck: deps.config.onStuck,
    clock,
  });
  return {
    getQuote: (url, method) => getQuote(url, method, deps.transport),
    pay: createPay(deps.store, deps.config.walletPrivateKey, clock, reconcile, deps.transport),
    reconcile,
  };
}
