// P4 · pay(paymentId, quote). The order of writes is the whole point:
//   markSigned before anything is sent, markSubmitted before the paid request, then settle or markUnknown.
// pay() never calls store.fail(): a merchant's rejection proves nothing while the authorization can still be cashed.
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK, usdcAddress } from './quote.js';
import type { Clock } from '../clock.js';
import type { PaymentsModule, PaymentStore, Quote } from '@apf/contracts';

const PAID_REQUEST_TIMEOUT_MS = 15_000;

type PayResult = Awaited<ReturnType<PaymentsModule['pay']>>;

// The merchant proved settlement, but the store refused to record it. Needs a human: money moved that the books don't show.
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

export function createPay(store: PaymentStore, walletPrivateKey: `0x${string}`, clock: Clock) {
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
      body = await res.text();
    } catch (err) {
      // Timeout or dropped connection: the merchant may have settled anyway.
      console.warn(`[payments] ${paymentId} UNKNOWN: paid request failed: ${describe(err)}`);
      return markUnknown(paymentId);
    }

    // 5. Only a 2xx carrying a successful settlement with a tx hash proves payment.
    const txHash = settledTxHash(http, res);
    if (res.status >= 200 && res.status < 300 && txHash) {
      if (!(await store.settle(paymentId, txHash))) {
        // The conditional update changed nothing. Already SETTLED (e.g. by the reconciler) is fine: it is counted once.
        const now = await store.get(paymentId);
        if (now?.state !== 'SETTLED') {
          // Paid on-chain, but the books say otherwise (e.g. FAILED, reservation released). Never report SETTLED here.
          const err = new SettlementNotRecordedError(paymentId, txHash, now?.state ?? 'missing');
          console.error(`[payments] ${err.message}`);
          throw err;
        }
      }
      return {
        state: 'SETTLED',
        txHash,
        response: {
          status_code: res.status,
          content_type: res.headers.get('content-type') ?? '',
          body,
        },
      };
    }

    console.warn(
      `[payments] ${paymentId} UNKNOWN: merchant answered ${res.status}${txHash ? '' : ' without a settlement tx hash'}`,
    );
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
    const authorization = (payload.payload as { authorization?: { value?: string; to?: string } })
      .authorization;
    if (
      authorization?.value !== String(reserved.amount) ||
      authorization.to?.toLowerCase() !== reserved.payee.toLowerCase()
    ) {
      throw new Error(
        'signed authorization does not match the reservation; refusing to store or send',
      );
    }
    return JSON.stringify(payload);
  }
}

function settledTxHash(http: x402HTTPClient, res: Response): string | null {
  let settle: { success?: boolean; transaction?: string };
  try {
    settle = http.getPaymentSettleResponse((name) => res.headers.get(name));
  } catch (err) {
    // Missing or undecodable header: no proof of settlement, so the caller marks UNKNOWN.
    console.warn(`[payments] no usable settlement header: ${describe(err)}`);
    return null;
  }
  return settle.success && settle.transaction ? settle.transaction : null;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
