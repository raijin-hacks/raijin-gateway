import { randomUUID } from 'node:crypto';
import {
  PayRequestSchema,
  type PayRequest,
  type PayResponse,
  type PaymentState,
} from '@apf/contracts';
import { createTokenClient } from './gateway.js';
import type { Journal } from './journal.js';

export const OUTPUT_BYTES = 16000;
// Total time one paid_fetch may spend, across retries and polls, before reporting its last status.
export const PURCHASE_DEADLINE_MS = 45000;
// Status checks per purchase while it is pending or unknown (about 2 s apart in practice).
export const MAX_POLLS = 15;
export function boundedText(value: string, secrets: string[] = [], limit = OUTPUT_BYTES) {
  for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
  let output = new TextDecoder().decode(Buffer.from(value).subarray(0, limit));
  while (Buffer.byteLength(output) > limit) output = output.slice(0, -1);
  return output;
}

// Deliberate allowlist: no headers, authorizations, raw gateway payload or merchant explanation.
export function workerOutput(
  result: PayResponse,
  url: string,
  state: PaymentState | null,
  token: string,
) {
  const body = result.status === 'approved' ? result.response : null;
  return {
    trust: 'untrusted_tool_output',
    status: result.status,
    receipt: {
      decision_id: boundedText(result.decision_id, [token], 128),
      payment_id: 'payment_id' in result ? boundedText(result.payment_id, [token], 128) : null,
      payment_state: state,
      merchant: boundedText(new URL(url).origin, [token], 256),
      amount: result.status === 'approved' ? result.amount : null,
      payee: result.status === 'approved' ? result.payee : null,
    },
    data: body
      ? {
          status_code: body.status_code,
          content_type: boundedText(body.content_type, [token], 128),
          body: boundedText(body.body, [token]),
          truncated: Buffer.byteLength(body.body) > OUTPUT_BYTES,
        }
      : null,
  };
}

export type Purchase = Omit<PayRequest, 'idempotency_key'>;
export type Trace = (line: string) => void;
// Only fixed event names are logged. Untrusted URLs, text, errors and headers never enter traces.
export function createTools(options: {
  gateway: string;
  token: string;
  transport?: typeof fetch;
  trace?: Trace;
  /** Durable intents (A19). Without one, purchase identity lasts only for this process. */
  journal?: Journal;
}) {
  const transport = options.transport ?? fetch;
  const client = createTokenClient(options.gateway, options.token, transport);
  const trace = options.trace ?? (() => {});
  const purchases = new Map<string, PayRequest>();

  /** The one request to send for these arguments: journaled first, so a key exists on disk
   * before any POST /pay. Identical arguments always map to the same key. */
  function durableRequest(value: Purchase): PayRequest {
    const intent = PayRequestSchema.omit({ idempotency_key: true }).parse(value);
    if (options.journal) return options.journal.intent(options.token, intent);
    const identity = JSON.stringify([
      intent.url,
      intent.method,
      intent.expected_price,
      intent.purpose,
    ]);
    let request = purchases.get(identity);
    if (!request) {
      if (purchases.size >= 32) throw new Error('PURCHASE_LIMIT');
      request = PayRequestSchema.parse({ ...intent, idempotency_key: randomUUID() });
      purchases.set(identity, request);
    }
    return request;
  }

  const tools = Object.freeze({
    async fetch_url(raw: string): Promise<string> {
      try {
        const deadline = AbortSignal.timeout(5000);
        let url = new URL(raw);
        for (let hop = 0; hop < 5; hop++) {
          if (
            url.origin !== 'http://localhost:4199' ||
            url.username ||
            url.password ||
            !/^\/pages\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(url.pathname) ||
            url.search ||
            url.hash
          )
            throw new Error('PAGE_NOT_ALLOWED');
          const response = await transport(url.href, {
            method: 'GET',
            redirect: 'manual',
            signal: deadline,
            credentials: 'omit',
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('INVALID_REDIRECT');
            url = new URL(location, url);
            continue;
          }
          if (!response.ok) throw new Error('PAGE_FAILED');
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader)
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 64000) {
                await reader.cancel();
                throw new Error('PAGE_TOO_LARGE');
              }
              chunks.push(next.value);
            }
          trace('page: fetched');
          return Buffer.concat(chunks).toString('utf8');
        }
        throw new Error('REDIRECT_LIMIT');
      } catch {
        trace('page: blocked or failed');
        throw new Error('PAGE_FETCH_FAILED');
      }
    },
    async paid_fetch(value: Purchase) {
      // Exact repeated tool arguments represent a retry, in this process or after a restart.
      const request = durableRequest(value);
      const started = performance.now();
      // A real-mode purchase (judge, CDP signing, on-chain settlement) can take 10-25 s end to end.
      const remaining = () => Math.max(1, PURCHASE_DEADLINE_MS - (performance.now() - started));
      async function bounded<T>(work: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('PAYMENT_DEADLINE')), remaining());
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      for (
        let attempt = 0;
        attempt < 3 && performance.now() - started < PURCHASE_DEADLINE_MS;
        attempt++
      ) {
        try {
          let response = await bounded(client.pay(request));
          for (
            let poll = 0;
            // The gateway answers pending at once and settles later; keep asking while there is
            // time for another wait and request, so the last status is returned rather than lost.
            // An unknown payment resolves only on chain, often minutes later: don't wait as long.
            poll < (response.status === 'pending' ? MAX_POLLS : 3) &&
            remaining() > 7000 &&
            ['pending', 'payment_unknown'].includes(response.status);
            poll++
          ) {
            trace('payment: awaiting existing decision');
            await bounded(
              new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.min(
                    5000,
                    Math.max(100, 'poll_after_ms' in response ? response.poll_after_ms : 100),
                  ),
                ),
              ),
            );
            response = await bounded(client.decision(response.decision_id));
          }
          trace(`payment: ${response.status}`);
          let state: PaymentState | null = null;
          if ('payment_id' in response) {
            try {
              state = (await bounded(client.payment(response.payment_id))).state;
            } catch {
              // Receipt lookup failure does not imply settlement or invalidate returned data.
              state = null;
            }
          }
          return workerOutput(response, request.url, state, options.token);
        } catch (error) {
          if (error instanceof Error && error.message === 'GATEWAY_CONFLICT') {
            // The key is bound to another request. Never retry with a fresh key.
            trace('payment: idempotency conflict; not retried');
            throw new Error('PAYMENT_CONFLICT', { cause: error });
          }
          trace('payment: retrying same purchase');
        }
      }
      trace('payment: unresolved; retain purchase identity');
      throw new Error('PAYMENT_UNRESOLVED');
    },
    /**
     * After a restart: settle every journaled intent for this mandate by replaying its exact
     * request and key. The gateway returns the existing outcome; nothing new is purchased.
     */
    async resume() {
      if (!options.journal) return [];
      const outcomes = [];
      for (const request of options.journal.pending(options.token)) {
        const purchase: Purchase = {
          url: request.url,
          method: request.method,
          expected_price: request.expected_price,
          purpose: request.purpose,
        };
        try {
          outcomes.push({ ok: true as const, output: await tools.paid_fetch(purchase) });
        } catch (error) {
          outcomes.push({
            ok: false as const,
            error:
              error instanceof Error && error.message === 'PAYMENT_CONFLICT'
                ? 'PAYMENT_CONFLICT'
                : 'PAYMENT_UNRESOLVED',
          });
        }
      }
      trace(`resume: ${outcomes.length} journaled purchase(s) replayed`);
      return outcomes;
    },
  });
  return tools;
}
