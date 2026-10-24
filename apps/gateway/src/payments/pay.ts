// P4 · pay(paymentId, quote). The order of writes is the whole point:
//   markSigned before anything is sent, markSubmitted before the paid request, then settle or markUnknown.
// pay() never calls store.fail(): a merchant's rejection proves nothing while the authorization can still be cashed.
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { MAX_AUTHORIZATION_SECONDS, NETWORK, usdcAddress, validateTimeout } from './quote.js';
import type { createReconcile, SettlementReceipt } from './reconcile.js';
import { readCappedBody } from './response-body.js';
import type { Clock } from '../clock.js';
import type { PaymentsModule, PaymentStore, Quote } from '@apf/contracts';

const PAID_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_PAID_BODY_BYTES = 1024 * 1024;

type PayResult = Awaited<ReturnType<PaymentsModule['pay']>>;

// The chain proved settlement, but the store refused to record it. Needs a human: money moved that the books don't show.
export class SettlementNotRecordedError extends Error {
  paymentId: string;
  txHash: string;
  state: string;
  constructor(paymentId: string, txHash: string, state: string) {
    super(
      `payment ${paymentId} settled on-chain (tx ${txHash}) but the store refused to record it: row is ${state}`,
    );
    this.name = 'SettlementNotRecordedError';
    this.paymentId = paymentId;
    this.txHash = txHash;
    this.state = state;
  }
}

export function createPay(
  store: PaymentStore,
  walletPrivateKey: `0x${string}`,
  clock: Clock,
  reconcile: ReturnType<typeof createReconcile>,
) {
  const client = new x402Client().register(
    'eip155:*',
    new ExactEvmScheme(privateKeyToAccount(walletPrivateKey)),
  );
  const http = new x402HTTPClient(client);

  // One paid request per payment at a time in this process: a concurrent call joins the one in flight instead of
  // sending the same authorization again. Across processes the store's conditional updates keep the ledger right
  // (an ambiguous answer can't undo SETTLED), but duplicates can still reach the merchant; see STATUS.md.
  const inFlight = new Map<string, { quote: Quote; result: Promise<PayResult> }>();

  return function pay(paymentId: string, quote: Quote): Promise<PayResult> {
    const running = inFlight.get(paymentId);
    if (running) {
      const same =
        running.quote.url === quote.url &&
        running.quote.method === quote.method &&
        running.quote.amount === quote.amount &&
        running.quote.payee.toLowerCase() === quote.payee.toLowerCase();
      return same
        ? running.result
        : Promise.reject(
            new Error(
              `payment ${paymentId} is already being paid with a different quote; nothing was sent`,
            ),
          );
    }
    const result = payOnce(paymentId, quote).finally(() => inFlight.delete(paymentId));
    inFlight.set(paymentId, { quote, result });
    return result;
  };

  async function payOnce(paymentId: string, quote: Quote): Promise<PayResult> {
    const row = await store.get(paymentId);
    if (!row) throw new Error(`payment ${paymentId} not found`);
    if (row.state === 'SETTLED' || row.state === 'FAILED') {
      throw new Error(`payment ${paymentId} is already ${row.state}`);
    }
    // The row's amount and payee are what the gateway approved and reserved budget for. Never pay anything else under it.
    if (quote.amount !== row.amount || quote.payee.toLowerCase() !== row.payee.toLowerCase()) {
      throw new Error(
        `quote (${quote.amount} to ${quote.payee}) does not match the reservation for ${paymentId} ` +
          `(${row.amount} to ${row.payee}); nothing was signed or sent`,
      );
    }

    // 1-2. One authorization per payment: sign only from RESERVED, and store it before anything leaves the process.
    let authorizationJson = row.authorization_json;
    if (row.state === 'RESERVED') {
      authorizationJson = await sign(quote, row);
      const { nonce, validBefore } = JSON.parse(authorizationJson).payload.authorization;
      if (
        !(await store.markSigned(paymentId, {
          nonce,
          validBefore: Number(validBefore) * 1000,
          authorizationJson,
        }))
      ) {
        throw new Error(`payment ${paymentId} changed state while signing; nothing was sent`);
      }
    } else if (!authorizationJson) {
      throw new Error(`payment ${paymentId} is ${row.state} but has no stored authorization`);
    }

    // Recheck stored authorizations too: recovery/retries must not send an unbounded payload.
    const storedAuthorization = JSON.parse(authorizationJson).payload?.authorization;
    validateTimeout((quote.raw as Record<string, unknown>)?.maxTimeoutSeconds);
    signedExpiry(
      storedAuthorization,
      (quote.raw as { maxTimeoutSeconds: number }).maxTimeoutSeconds,
      true,
    );

    // 3. Record the submission before the paid request goes out. A retry (SUBMITTED or UNKNOWN) is already past this.
    // Invariant the reconciler relies on: nothing is ever sent while the row is SIGNED. reconcile() fails SIGNED rows
    // without asking the chain, so any path that sends before markSubmitted succeeds could release a cashable payment.
    if (row.state === 'RESERVED' || row.state === 'SIGNED') {
      if (!(await store.markSubmitted(paymentId))) {
        throw new Error(`payment ${paymentId} could not be marked SUBMITTED; nothing was sent`);
      }
    }

    // 4. Send the stored authorization. Re-encoding the stored JSON gives byte-identical headers on every retry.
    const paymentPayload = JSON.parse(authorizationJson);
    const { value, to } = paymentPayload.payload?.authorization ?? {};
    if (value !== String(row.amount) || String(to).toLowerCase() !== row.payee.toLowerCase()) {
      throw new Error(
        `stored authorization for ${paymentId} does not match its reservation; refusing to send`,
      );
    }
    const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);

    // Act on the current row, not the snapshot read above: the reconciler may have resolved it since.
    const current = await store.get(paymentId);
    if (current?.state === 'FAILED') {
      return {
        state: 'FAILED',
        reason: 'resolved as FAILED by the reconciler before sending; not sent',
      };
    }
    if (current?.state !== 'SUBMITTED' && current?.state !== 'UNKNOWN') return { state: 'UNKNOWN' }; // e.g. SETTLED elsewhere
    // Past validBefore the token rejects the authorization, so a resend can't settle. Leave it to the reconciler.
    if (current.valid_before !== null && clock.now() >= current.valid_before) {
      console.warn(
        `[payments] ${paymentId}: authorization expired, not resending; the reconciler will resolve it`,
      );
      return { state: 'UNKNOWN' };
    }

    let res: Response;
    let body: string;
    try {
      res = await fetch(quote.url, {
        method: quote.method,
        headers: paymentHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS),
      });
      body = await readCappedBody(res, MAX_PAID_BODY_BYTES);
    } catch (err) {
      // Timeout or dropped connection: the merchant may have settled anyway.
      console.warn(`[payments] ${paymentId} UNKNOWN: paid request failed: ${describe(err)}`);
      return markUnknown(paymentId);
    }

    // The merchant controls every header. A successful HTTP response is only a reason to
    // ask the chain; it is never settlement evidence, even if it names a real transaction.
    if (res.status >= 200 && res.status < 300) {
      const receipt: SettlementReceipt = {};
      try {
        const state = await reconcile(paymentId, receipt);
        if (state === 'SETTLED' && (await store.get(paymentId))?.state === 'SETTLED') {
          return {
            state: 'SETTLED',
            txHash: receipt.txHash ?? 'unknown',
            response: {
              status_code: res.status,
              content_type: res.headers.get('content-type') ?? '',
              body,
            },
          };
        }
        if (receipt.txHash) {
          const current = await store.get(paymentId);
          throw new SettlementNotRecordedError(
            paymentId,
            receipt.txHash,
            current?.state ?? 'missing',
          );
        }
        if (state === 'FAILED') return { state: 'FAILED', reason: 'resolved by the chain' };
      } catch (err) {
        if (err instanceof SettlementNotRecordedError) {
          console.error(`[payments] ${err.message}`);
          throw err;
        }
        if (receipt.txHash) {
          // The RPC proved use but recording threw (e.g. a database write error).
          console.error(`[payments] ${paymentId}: chain settlement not recorded: ${describe(err)}`);
          throw err;
        }
        console.warn(`[payments] ${paymentId}: chain verification failed: ${describe(err)}`);
      }
    }
    return markUnknown(paymentId);
  }

  // No proof of settlement. Record UNKNOWN; if the row was resolved meanwhile, report what the store says instead.
  async function markUnknown(paymentId: string): Promise<PayResult> {
    if (!(await store.markUnknown(paymentId)) && (await store.get(paymentId))?.state === 'FAILED') {
      return {
        state: 'FAILED',
        reason: 'resolved as FAILED by the reconciler while the request was in flight',
      };
    }
    return { state: 'UNKNOWN' };
  }

  async function sign(quote: Quote, reserved: { amount: number; payee: string }): Promise<string> {
    const raw = quote.raw as Record<string, unknown>;
    const timeout = raw?.maxTimeoutSeconds;
    validateTimeout(timeout);
    // The requirements must describe exactly the approved payment: exact scheme, Base Sepolia USDC, amount, payee.
    if (
      raw.scheme !== 'exact' ||
      raw.network !== NETWORK ||
      typeof raw.asset !== 'string' ||
      raw.asset.toLowerCase() !== usdcAddress() ||
      raw.amount !== String(quote.amount) ||
      String(raw.payTo).toLowerCase() !== quote.payee.toLowerCase()
    ) {
      throw new Error(
        'quote.raw is not an exact Base Sepolia USDC payment of the approved amount to the approved payee; refusing to sign',
      );
    }

    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: quote.url, description: '', mimeType: '' },
      accepts: [raw],
    } as Parameters<typeof client.createPaymentPayload>[0]);

    // Check what was actually signed against the reservation itself, before it is stored.
    const authorization = (
      payload.payload as { authorization?: { value?: string; to?: string; validBefore?: string } }
    ).authorization;
    if (
      authorization?.value !== String(reserved.amount) ||
      authorization.to?.toLowerCase() !== reserved.payee.toLowerCase()
    ) {
      throw new Error(
        'signed authorization does not match the reservation; refusing to store or send',
      );
    }
    signedExpiry(authorization, timeout);
    return JSON.stringify(payload);
  }
  function signedExpiry(
    authorization: { validBefore?: unknown } | undefined,
    timeout: number,
    allowExpired = false,
  ): void {
    const value = authorization?.validBefore;
    const seconds = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const now = Math.floor(clock.now() / 1000);
    if (
      !Number.isSafeInteger(seconds * 1000) ||
      seconds > now + Math.min(timeout, MAX_AUTHORIZATION_SECONDS) ||
      (!allowExpired && seconds <= now)
    ) {
      throw new Error(
        'signed validBefore exceeds the authorization lifetime or is invalid; refusing to store or send',
      );
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
