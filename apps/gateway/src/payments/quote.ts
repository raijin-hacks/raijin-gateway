// P3 · getQuote: ask the merchant for its price without paying.
import type { Address, HttpMethod, Quote, QuoteCode } from '@apf/contracts';

export const NETWORK = 'eip155:84532';
// Circle's test USDC on Base Sepolia.
const DEFAULT_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 64 * 1024;

// The only asset the gateway pays in: atomic USDC on Base Sepolia.
export function usdcAddress(): string {
  return (process.env.USDC_ADDRESS || DEFAULT_USDC).toLowerCase();
}

export class QuoteError extends Error {
  code: QuoteCode;
  constructor(code: QuoteCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QuoteError';
    this.code = code;
  }
}

export async function getQuote(canonicalUrl: string, method: HttpMethod): Promise<Quote> {
  // One signal for the whole exchange, so a body that stalls after the headers also times out.
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  let res: Response;
  try {
    // A redirect could point the gateway at an attacker: never follow it.
    res = await fetch(canonicalUrl, { method, redirect: 'manual', signal });
  } catch (err) {
    throw new QuoteError('QUOTE_FAILED', `quote request failed: ${describe(err)}`, { cause: err });
  }

  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    throw new QuoteError('QUOTE_INVALID', `merchant answered ${res.status} redirect`);
  }
  if (res.status !== 402) {
    await discard(res);
    throw new QuoteError('NOT_402', `merchant answered ${res.status}, expected 402`);
  }

  const paymentRequired = await readPaymentRequired(res);
  const raw = selectRequirements(paymentRequired);
  return {
    url: canonicalUrl,
    method,
    network: NETWORK,
    payee: (raw.payTo as string).toLowerCase() as Address,
    amount: Number(raw.amount),
    raw,
  };
}

// x402 v2 sends the requirements base64-encoded in PAYMENT-REQUIRED. Without the header, fall back to a JSON body.
async function readPaymentRequired(res: Response): Promise<unknown> {
  const header = res.headers.get('PAYMENT-REQUIRED');
  if (header) {
    await discard(res);
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch (err) {
      throw new QuoteError('QUOTE_INVALID', 'PAYMENT-REQUIRED header is not base64 JSON', {
        cause: err,
      });
    }
  }

  const body = await readCapped(res);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new QuoteError('QUOTE_INVALID', '402 body is not JSON', { cause: err });
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new QuoteError('QUOTE_INVALID', `402 body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof QuoteError) throw err;
    throw new QuoteError('QUOTE_FAILED', `reading 402 body failed: ${describe(err)}`, {
      cause: err,
    });
  }
  return Buffer.concat(chunks).toString('utf8');
}

function selectRequirements(paymentRequired: unknown): Record<string, unknown> {
  const accepts = (paymentRequired as { accepts?: unknown } | null)?.accepts;
  if (!Array.isArray(accepts))
    throw new QuoteError('QUOTE_INVALID', 'payment requirements have no accepts list');

  const usdc = usdcAddress();
  const match = accepts.find(
    (r): r is Record<string, unknown> =>
      typeof r === 'object' &&
      r !== null &&
      r.scheme === 'exact' &&
      r.network === NETWORK &&
      typeof r.asset === 'string' &&
      r.asset.toLowerCase() === usdc,
  );
  if (!match) throw new QuoteError('QUOTE_INVALID', `no exact ${NETWORK} USDC option offered`);

  if (
    typeof match.amount !== 'string' ||
    !/^[1-9]\d*$/.test(match.amount) ||
    !Number.isSafeInteger(Number(match.amount))
  ) {
    throw new QuoteError(
      'QUOTE_INVALID',
      `amount ${JSON.stringify(match.amount)} is not a positive integer`,
    );
  }
  if (typeof match.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(match.payTo)) {
    throw new QuoteError('QUOTE_INVALID', `payTo ${JSON.stringify(match.payTo)} is not an address`);
  }
  return match;
}

// Release the connection without reading a body we don't need.
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
