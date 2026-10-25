import {
  AddressSchema,
  PaymentStateSchema,
  PayRequestSchema,
  PayResponseSchema,
} from '@apf/contracts';
import { z } from 'zod';
import type { PaymentStatusResponse, PayRequest, PayResponse } from '@apf/contracts';

/** One mandate's raw, once-issued token only. Never accept a token digest or admin key.
 * Transport is injected for tests; URLs and redirects cannot move the bearer elsewhere.
 * No automatic retry: callers retain the same request/key after transport uncertainty.
 */
export function createTokenClient(
  gatewayOrigin: string,
  token: string,
  transport: typeof fetch = fetch,
) {
  const gateway = new URL(gatewayOrigin);
  if (
    gateway.origin !== gatewayOrigin ||
    gateway.username ||
    gateway.password ||
    (gateway.protocol !== 'https:' &&
      !(gateway.protocol === 'http:' && gateway.hostname === 'localhost'))
  ) {
    throw new Error('INVALID_GATEWAY_ORIGIN');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('INVALID_MANDATE_TOKEN');

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let conflict = false;
    try {
      const response = await transport(gatewayOrigin + path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...init.headers,
        },
        redirect: 'error',
        // /pay answers only after the judge, signing and settlement, which take over 5 s in real mode.
        signal: AbortSignal.timeout(30000),
      });
      // 409 on /pay means this key is bound to a different request. Retrying cannot fix that,
      // and minting a new key would risk a second purchase, so callers must stop.
      if (response.status === 409) {
        conflict = true;
        await response.body?.cancel();
      }
      if (!response.ok) throw new Error('GATEWAY_REJECTED');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 256000) {
            await reader.cancel();
            throw new Error('GATEWAY_RESPONSE_TOO_LARGE');
          }
          chunks.push(next.value);
        }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Never propagate transport exceptions, response bodies, bearer values or URLs.
      throw new Error(conflict ? 'GATEWAY_CONFLICT' : 'GATEWAY_REQUEST_FAILED');
    }
  }
  return Object.freeze({
    async pay(value: PayRequest): Promise<PayResponse> {
      const parsed = PayRequestSchema.safeParse(value);
      if (
        !parsed.success ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parsed.data.idempotency_key,
        )
      ) {
        throw new Error('INVALID_PAY_REQUEST');
      }
      const result = await request('/pay', {
        method: 'POST',
        headers: { 'Idempotency-Key': parsed.data.idempotency_key },
        body: JSON.stringify(parsed.data),
      });
      const output = PayResponseSchema.safeParse(result);
      if (!output.success) throw new Error('INVALID_GATEWAY_RESPONSE');
      return output.data;
    },
    async payment(id: string): Promise<PaymentStatusResponse> {
      if (!/^pay_[A-Za-z0-9_]+$/.test(id)) throw new Error('INVALID_PAYMENT_ID');
      const schema = z.strictObject({
        payment_id: z.string(),
        state: PaymentStateSchema,
        amount: z.number().int().nonnegative(),
        payee: AddressSchema,
        tx_hash: z.string().nullable(),
      });
      const result = schema.safeParse(await request(`/payments/${id}`));
      if (!result.success) throw new Error('INVALID_GATEWAY_RESPONSE');
      return result.data;
    },
    async decision(id: string): Promise<PayResponse> {
      if (!/^dec_[A-Za-z0-9_-]+$/.test(id)) throw new Error('INVALID_DECISION_ID');
      const result = PayResponseSchema.safeParse(await request(`/decisions/${id}`));
      if (!result.success) throw new Error('INVALID_GATEWAY_RESPONSE');
      return result.data;
    },
  });
}
