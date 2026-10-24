// Payments module (owner A): what Chunk 2's pipeline calls.
import { privateKeyToAccount } from 'viem/accounts';
import { systemClock, type Clock } from '../clock.js';
import { createPay } from './pay.js';
import { getQuote } from './quote.js';
import { createReconcile } from './reconcile.js';
import type { PaymentsModule, PaymentStore } from '@apf/contracts';

export { getQuote, QuoteError } from './quote.js';
export { SettlementNotRecordedError } from './pay.js';
export { startReconciler } from './reconcile.js';

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
}): PaymentsModule {
  const clock = deps.clock ?? systemClock;
  return {
    getQuote,
    pay: createPay(deps.store, deps.config.walletPrivateKey, clock),
    reconcile: createReconcile(deps.store, {
      rpcUrl: deps.config.rpcUrl,
      wallet: privateKeyToAccount(deps.config.walletPrivateKey).address,
      onStuck: deps.config.onStuck,
      clock,
    }),
  };
}
