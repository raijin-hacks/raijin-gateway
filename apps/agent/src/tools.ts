import { randomUUID } from 'node:crypto';
import { PayRequestSchema, type PayRequest } from '@apf/contracts';
import { createTokenClient } from './gateway.js';

export type Purchase = Omit<PayRequest, 'idempotency_key'>;
export type Trace = (line: string) => void;
// Only fixed event names are logged. Untrusted URLs, text, errors and headers never enter traces.
export function createTools(options: {
  gateway: string;
  token: string;
  transport?: typeof fetch;
  trace?: Trace;
}) {
  const transport = options.transport ?? fetch;
  const client = createTokenClient(options.gateway, options.token, transport);
  const trace = options.trace ?? (() => {});
  const purchases = new Map<string, PayRequest>();
  return Object.freeze({
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
      const parsed = PayRequestSchema.parse({ ...value, idempotency_key: randomUUID() });
      // Exact repeated tool arguments represent a retry for this agent session.
      const identity = JSON.stringify([
        parsed.url,
        parsed.method,
        parsed.expected_price,
        parsed.purpose,
      ]);
      let request = purchases.get(identity);
      if (!request) {
        if (purchases.size >= 32) throw new Error('PURCHASE_LIMIT');
        request = parsed;
        purchases.set(identity, request);
      }
      const started = performance.now();
      const remaining = () => Math.max(1, 15000 - (performance.now() - started));
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
      for (let attempt = 0; attempt < 3 && performance.now() - started < 15000; attempt++) {
        try {
          let response = await bounded(client.pay(request));
          for (
            let poll = 0;
            poll < 3 && ['pending', 'payment_unknown'].includes(response.status);
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
          return response;
        } catch {
          trace('payment: retrying same purchase');
        }
      }
      trace('payment: unresolved; retain purchase identity');
      throw new Error('PAYMENT_UNRESOLVED');
    },
  });
}
