// Payments module (owner A): what Chunk 2's pipeline calls.
import { privateKeyToAccount } from 'viem/accounts';
import { createPay } from './pay.ts';
import { getQuote } from './quote.ts';
import { createReconcile } from './reconcile.ts';
import type { PaymentsModule, PaymentStore } from './types.ts';

export { getQuote, QuoteError } from './quote.ts';
export { SettlementNotRecordedError } from './pay.ts';
export { startReconciler } from './reconcile.ts';

export interface PaymentsConfig {
  walletPrivateKey: `0x${string}`; // testnet only
  rpcUrl?: string; // Base Sepolia JSON-RPC, used by reconcile (BASE_SEPOLIA_RPC_URL)
  // A payment the reconciler can't resolve without an operator (e.g. chain unreadable long past expiry). Wire to alerts.
  onStuck?: (paymentId: string, reason: string) => void;
}

export function createPayments(deps: { store: PaymentStore; config: PaymentsConfig }): PaymentsModule {
  return {
    getQuote,
    pay: createPay(deps.store, deps.config.walletPrivateKey),
    reconcile: createReconcile(deps.store, {
      rpcUrl: deps.config.rpcUrl,
      wallet: privateKeyToAccount(deps.config.walletPrivateKey).address,
      onStuck: deps.config.onStuck,
    }),
  };
}
