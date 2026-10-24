// Payments module (owner A): what Chunk 2's pipeline calls.
import { systemClock, type Clock } from '../clock.js';
import { createPay } from './pay.js';
import { getQuote } from './quote.js';
import { createReconcile } from './reconcile.js';
import { localSigner, type PaymentSigner } from './signer.js';
import type { Transport } from './transport.js';
import type { PaymentsModule, PaymentStore } from '@apf/contracts';

export { getQuote, QuoteError } from './quote.js';
export { SettlementNotRecordedError } from './pay.js';
export { startReconciler } from './reconcile.js';
export { createDestinationVerifier, DestinationError } from './destination.js';
export { createPinnedTransport, type Transport } from './transport.js';
export { createCdpSigner, localSigner, type PaymentSigner } from './signer.js';

export interface PaymentsConfig {
  // Testnet only. Used only when no `signer` is passed (the local-key signer).
  walletPrivateKey?: `0x${string}`;
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
  // Who signs authorizations; defaults to the local key in config. Pass createCdpSigner for CDP.
  signer?: PaymentSigner;
}): PaymentsModule {
  const clock = deps.clock ?? systemClock;
  const signer =
    deps.signer ??
    (deps.config.walletPrivateKey ? localSigner(deps.config.walletPrivateKey) : undefined);
  if (!signer) throw new Error('createPayments needs a signer or walletPrivateKey');
  const reconcile = createReconcile(deps.store, {
    rpcUrl: deps.config.rpcUrl,
    wallet: signer.address, // the payer: every authorization is signed as this address
    onStuck: deps.config.onStuck,
    clock,
  });
  return {
    getQuote: (url, method) => getQuote(url, method, deps.transport),
    pay: createPay(deps.store, signer, clock, reconcile, deps.transport),
    reconcile,
  };
}
