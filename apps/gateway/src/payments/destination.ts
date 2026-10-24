// J2b groundwork only: verified resolution is NOT a transport. Do not pass this
// result to ordinary hostname fetch. main.ts must stay blocked until a connector
// consumes this pin, verifies its peer and preserves TLS/Host identity.
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { Catalog } from '@apf/contracts';
import { createCanonicalizer } from '../catalog/index.js';

// Conservative snapshot of IANA special-purpose registries, retrieved 2026-10-24:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Deny entire special-purpose parent prefixes, including their public exceptions.
// IPv6 additionally requires global unicast 2000::/3. This intentionally excludes
// transition/translation ranges (including ALL IPv4-mapped IPv6), scoped addresses,
// future/reserved space and multicast. Changes to these tables require review.
const specialV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  specialV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6');
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !specialV4.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}
function isLoopback(address: string): boolean {
  const family = isIP(address);
  return (
    family !== 0 &&
    !address.includes('%') &&
    loopback.check(address, family === 4 ? 'ipv4' : 'ipv6')
  );
}

export class DestinationError extends Error {
  readonly code = 'TIER_0_DENIAL';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DestinationError';
  }
}
export interface PinnedDestination {
  readonly canonicalUrl: string;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

// Operator-bound loopback policy is preserved, not decided here. Only an exact HTTP
// origin accepted by the catalog-bound phase-4 canonicalizer can use loopback, and
// ALL its answers must remain loopback. HTTPS/private destinations get no exception.
export function createDestinationVerifier(
  catalog: Catalog,
  resolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  const canonicalize = createCanonicalizer(catalog);
  return async (rawUrl: string, signal: AbortSignal): Promise<PinnedDestination> => {
    const canonical = canonicalize(rawUrl);
    if (!canonical.ok) throw new DestinationError('invalid merchant destination');
    const url = new URL(canonical.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const local = url.protocol === 'http:'; // only exact operator-bound loopback origins canonicalize
    const literalFamily = isIP(hostname);
    if (literalFamily && (!local || !isLoopback(hostname)))
      throw new DestinationError('IP literal destination');

    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DestinationError('destination resolution aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Do not retain pins between calls. Each future connection must call again.
      const answers = await Promise.race([
        literalFamily
          ? Promise.resolve([{ address: hostname, family: literalFamily }])
          : resolve(hostname),
        aborted,
      ]);
      signal.throwIfAborted();
      if (
        answers.length === 0 ||
        answers.some(
          (answer) =>
            (answer.family !== 4 && answer.family !== 6) ||
            isIP(answer.address) !== answer.family ||
            !(local ? isLoopback(answer.address) : isPublicAddress(answer.address)),
        )
      )
        throw new DestinationError('empty, mixed or prohibited DNS answer set');
      const selected = answers[0]!;
      return Object.freeze({
        canonicalUrl: canonical.url,
        hostname,
        address: selected.address,
        family: selected.family as 4 | 6,
      });
    } catch (cause) {
      if (cause instanceof DestinationError) throw cause;
      throw new DestinationError('safe destination resolution failed', { cause });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
}
