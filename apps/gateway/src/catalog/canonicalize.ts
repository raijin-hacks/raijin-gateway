import type { Catalog } from '@apf/contracts';
import { compiledEndpoints } from './load.js';

/** Decoded path/query facts plus an independently escaped URL safe to reparse. */
export interface Canonical {
  url: string;
  origin: string;
  path: string;
  query: [string, string][];
}

export type CanonicalResult =
  ({ ok: true } & Canonical) | { ok: false; code: 'BAD_URL' | 'DUPLICATE_PARAM' };

const badUrl = Object.freeze({ ok: false, code: 'BAD_URL' } as const);
const hasControl = (value: string) => /[\p{Cc}]/u.test(value);
const httpsOnly: ReadonlySet<string> = new Set();

/** Bind once to the operator's validated catalog, never to request-supplied options. */
export function createCanonicalizer(catalog: Catalog): typeof canonicalize {
  // Require loader admission before treating catalog entries as operator policy.
  compiledEndpoints(catalog);
  const httpOrigins = new Set<string>();
  for (const merchant of catalog.merchants) {
    const origin = new URL(merchant.origin);
    if (
      origin.protocol === 'http:' &&
      (origin.hostname === 'localhost' ||
        origin.hostname === '[::1]' ||
        /^127\.\d+\.\d+\.\d+$/u.test(origin.hostname))
    ) {
      httpOrigins.add(origin.origin);
    }
  }
  return (rawUrl: string) => canonicalizeWithOrigins(rawUrl, httpOrigins);
}

/** Pure syntax boundary. No DNS, contact, catalog admission or subject authorization. */
export function canonicalize(rawUrl: string): CanonicalResult {
  return canonicalizeWithOrigins(rawUrl, httpsOnly);
}

function canonicalizeWithOrigins(
  rawUrl: string,
  httpOrigins: ReadonlySet<string>,
): CanonicalResult {
  // WHATWG silently strips controls, treats backslashes as slashes and removes dot
  // segments. Inspect the original spelling before allowing any such normalization.
  if (
    typeof rawUrl !== 'string' ||
    /[\s\\]/u.test(rawUrl) ||
    hasControl(rawUrl) ||
    /%(?![\da-f]{2})/iu.test(rawUrl)
  )
    return badUrl;
  const raw = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/iu.exec(rawUrl);
  if (!raw || raw[1]!.includes('@')) return badUrl;
  try {
    // Reject lone surrogates rather than letting URL/URLSearchParams replace them.
    encodeURI(rawUrl);
    const rawPath = raw[2] || '/';
    const segments =
      rawPath === '/'
        ? []
        : rawPath
            .slice(1)
            .split('/')
            .map((segment) => {
              const decoded = decodeURIComponent(segment);
              // One decode only. Residual encoded dots/separators/percent are rejected
              // conservatively, including arbitrarily nested encodings via residual %25.
              if (
                !decoded ||
                decoded === '.' ||
                decoded === '..' ||
                /[/\\]/u.test(decoded) ||
                hasControl(decoded) ||
                /%(?:2e|2f|5c|25)/iu.test(decoded)
              )
                throw new Error('unsafe path');
              return decoded;
            });
    const parsed = new URL(rawUrl);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== 'https:' &&
        (parsed.protocol !== 'http:' || !httpOrigins.has(parsed.origin)))
    )
      return badUrl;

    const query: [string, string][] = [];
    const names = new Set<string>();
    // URLSearchParams is forgiving of broken UTF-8; validate/decode strictly first.
    for (const pair of (raw[3] ?? '').split('&')) {
      if (!pair) continue;
      const equals = pair.indexOf('=');
      const decode = (part: string) => decodeURIComponent(part.replace(/\+/gu, ' '));
      const name = decode(equals < 0 ? pair : pair.slice(0, equals));
      const value = decode(equals < 0 ? '' : pair.slice(equals + 1));
      if (hasControl(name) || hasControl(value)) return badUrl;
      if (names.has(name)) return { ok: false, code: 'DUPLICATE_PARAM' };
      names.add(name);
      query.push([name, value]);
    }
    query.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const path = `/${segments.join('/')}`;
    const escapedPath = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    const search = new URLSearchParams(query).toString();
    return {
      ok: true,
      url: `${parsed.origin}${escapedPath}${search ? `?${search}` : ''}`,
      origin: parsed.origin,
      path,
      query,
    };
  } catch {
    return badUrl;
  }
}
