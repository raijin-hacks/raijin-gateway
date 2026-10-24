// J2b: the only way payments reaches a merchant. Each request:
//   1. resolves and classifies the destination once (destination.ts: catalog-bound origins only,
//      every DNS answer public, or loopback for an exact cataloged demo origin);
//   2. connects to exactly that address, with no second DNS lookup, so DNS rebinding can't swap it;
//   3. keeps TLS checking the certificate against the real hostname (SNI and identity check);
//   4. confirms the connected peer is the verified address;
//   5. never follows redirects and never goes through a proxy (a fresh, unpooled connection).
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { DestinationError, type PinnedDestination } from './destination.js';

export interface TransportInit {
  method: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  redirect?: 'manual'; // accepted for fetch compatibility; this transport never redirects
}
export type Transport = (url: string, init: TransportInit) => Promise<Response>;

type Verify = (url: string, signal: AbortSignal) => Promise<PinnedDestination>;

// Statuses a Response may not carry a body for.
const NULL_BODY = new Set([204, 205, 304]);

export function createPinnedTransport(verify: Verify): Transport {
  return async (url, init) => {
    const pin = await verify(url, init.signal);
    const target = new URL(pin.canonicalUrl);
    const secure = target.protocol === 'https:';

    // Answer every lookup with the verified address: the connection can't resolve the name again.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
      else callback(null, pin.address, pin.family);
    };

    return new Promise<Response>((resolve, reject) => {
      const req = (secure ? https : http).request(
        {
          method: init.method,
          host: pin.hostname, // TLS verifies the certificate against this name
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          headers: init.headers,
          lookup,
          family: pin.family,
          agent: false, // a fresh socket per request: never pooled, never proxied
          signal: init.signal,
          ...(secure ? { servername: pin.hostname } : {}),
        },
        (res) => {
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                headers.append(name, v);
              }
            }
            const status = res.statusCode ?? 0;
            const body = NULL_BODY.has(status)
              ? null
              : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
            resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
          } catch (err) {
            // e.g. a status outside 200..599, which Response can't represent
            res.destroy();
            reject(err);
          }
        },
      );
      req.once('socket', (socket: Socket) => {
        const check = () => {
          if (!samePeer(socket.remoteAddress, pin.address)) {
            req.destroy(new DestinationError('connected peer is not the verified address'));
          }
        };
        if (socket.remoteAddress) check();
        else socket.once('connect', check);
      });
      req.once('error', reject);
      req.end();
    });
  };
}

function samePeer(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const normalize = (address: string) => address.replace(/^::ffff:/i, '').toLowerCase();
  return normalize(actual) === normalize(expected);
}
