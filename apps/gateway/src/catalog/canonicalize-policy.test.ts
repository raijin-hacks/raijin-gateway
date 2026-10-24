import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { Catalog } from '@apf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  createCanonicalizer,
  loadCatalog,
  matchEndpoint,
  routeMatch,
} from './index.js';

const baseline = fileURLToPath(new URL('../../../../catalog/catalog.json', import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configuredCatalog(origin: string) {
  const value: Catalog = JSON.parse(readFileSync(baseline, 'utf8'));
  value.merchants[0]!.origin = origin;
  const dir = mkdtempSync(join(tmpdir(), 'catalog-http-policy-'));
  directories.push(dir);
  const file = join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify(value));
  return loadCatalog(file);
}

describe('operator catalog HTTP exception', () => {
  it('admits all three honest demo routes without changing the catalog or merchant transport', () => {
    const catalog = loadCatalog(baseline);
    const parse = createCanonicalizer(catalog);
    for (const raw of [
      'http://localhost:4101/v1/pricing/acme?period=30d',
      'http://localhost:4102/v1/forecast?city=Oakland&units=metric',
      'http://localhost:4103/v1/headlines?topic=shipping',
    ]) {
      const result = parse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(parse(result.url)).toEqual(result);
      const match = matchEndpoint(result, 'GET', catalog);
      expect(match).toMatchObject({ kind: 'known' });
      expect(
        match.kind === 'known' && match.params.every((param) => param.violation === null),
      ).toBe(true);
      expect(routeMatch(match).kind).toBe('judge-eligible');
    }
  });

  it.each([
    'http://localhost:4101',
    'http://127.0.0.1:4101',
    'http://127.42.3.4:4101',
    'http://[::1]:4101',
    'http://localhost',
  ])('admits only the exact configured loopback origin %s', (origin) => {
    const parse = createCanonicalizer(configuredCatalog(origin));
    const result = parse(`${origin}/v1/pricing/acme?period=30d#ignored`);
    expect(result).toMatchObject({ ok: true, origin });
    if (result.ok) expect(parse(result.url)).toEqual(result);
  });

  it('normalizes host/default port and alternate IPv4 spelling before exact origin comparison', () => {
    expect(
      createCanonicalizer(configuredCatalog('http://localhost'))('HTTP://LOCALHOST:80/'),
    ).toMatchObject({ ok: true, origin: 'http://localhost', url: 'http://localhost/' });
    const parse = createCanonicalizer(configuredCatalog('http://127.0.0.1:4101'));
    for (const host of ['127.1', '2130706433', '0x7f000001']) {
      expect(parse(`http://${host}:4101/`)).toMatchObject({
        ok: true,
        origin: 'http://127.0.0.1:4101',
      });
    }
  });

  it('does not downgrade a cataloged HTTPS loopback origin to HTTP', () => {
    const parse = createCanonicalizer(configuredCatalog('https://localhost:4101'));
    expect(parse('https://localhost:4101/')).toMatchObject({ ok: true });
    expect(parse('http://localhost:4101/')).toEqual({ ok: false, code: 'BAD_URL' });
  });

  it.each([
    'http://merchant.test:4101',
    'http://example.com:4101',
    'http://localhost.evil.test:4101',
    'http://sub.localhost:4101',
    'http://localhost.:4101',
    'http://127.evil.test:4101',
    'http://0.0.0.0:4101',
    'http://128.0.0.1:4101',
    'http://10.0.0.1:4101',
    'http://169.254.169.254:4101',
    'http://[::]:4101',
    'http://[::ffff:7f00:1]:4101',
  ])('rejects non-loopback or unsupported aliases even when cataloged: %s', (origin) => {
    expect(createCanonicalizer(configuredCatalog(origin))(`${origin}/`)).toEqual({
      ok: false,
      code: 'BAD_URL',
    });
  });

  it.each([
    'http://localhost:4199/',
    'http://localhost:4104/',
    'http://localhost/',
    'http://127.0.0.1:4101/',
    'http://[::1]:4101/',
    'http://LOCALHOST.evil.test:4101/',
    'http://localhost.:4101/',
  ])('rejects non-catalog origins without hostname, alias or port fallback: %s', (raw) => {
    expect(createCanonicalizer(loadCatalog(baseline))(raw)).toEqual({
      ok: false,
      code: 'BAD_URL',
    });
  });

  it('cannot enable HTTP using agent fields, query options, or an unvalidated catalog', () => {
    const parse = createCanonicalizer(loadCatalog(baseline));
    const agentOptions = { allowHttp: true, httpOrigins: ['http://localhost:4199'] };
    // Deliberately bypass TS to exercise attempts to pass extra runtime arguments.
    expect(
      Reflect.apply(canonicalize, undefined, ['http://localhost:4101/', agentOptions]),
    ).toEqual({ ok: false, code: 'BAD_URL' });
    expect(
      Reflect.apply(parse, undefined, ['http://localhost:4199/?allowHttp=true', agentOptions]),
    ).toEqual({ ok: false, code: 'BAD_URL' });
    expect(
      parse('http://localhost:4199/?origin=http%3A%2F%2Flocalhost%3A4101&allowHttp=true'),
    ).toEqual({ ok: false, code: 'BAD_URL' });
    const forged: Catalog = JSON.parse(readFileSync(baseline, 'utf8'));
    expect(() => createCanonicalizer(forged)).toThrow(/not loaded/);
    expect(() => createCanonicalizer({ ...agentOptions } as unknown as Catalog)).toThrow(
      /not loaded/,
    );
  });

  it('retains traversal, malformed encoding, duplicate, and userinfo defenses for allowed HTTP', () => {
    const parse = createCanonicalizer(loadCatalog(baseline));
    for (const path of [
      '/a/../b',
      '/a/%2E%2e/b',
      '/a/%252e%252e/b',
      '/a%2fb',
      '/a%5Cb',
      '/a%252fb',
      '/a\\b',
      '/a//b',
      '/a/',
      '/%GG',
      '/%FF',
      '/?x=%FF',
    ]) {
      expect(parse(`http://localhost:4101${path}`)).toEqual({ ok: false, code: 'BAD_URL' });
    }
    expect(parse('http://user@localhost:4101/')).toEqual({ ok: false, code: 'BAD_URL' });
    expect(parse('http://@localhost:4101/')).toEqual({ ok: false, code: 'BAD_URL' });
    expect(parse('http://localhost:4101/?x=1&%78=2')).toEqual({
      ok: false,
      code: 'DUPLICATE_PARAM',
    });
    expect(parse('ftp://localhost:4101/')).toEqual({ ok: false, code: 'BAD_URL' });
    expect(parse('https://public.example.test/')).toMatchObject({ ok: true });
  });

  it('still intercepts unknown routes/methods on admitted HTTP origins', () => {
    const catalog = loadCatalog(baseline);
    const parse = createCanonicalizer(catalog);
    for (const path of ['/unknown', '/unknown?x=canary', '/v1/pricing/acme']) {
      const result = parse(`http://localhost:4101${path}`);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(routeMatch(matchEndpoint(result, 'POST', catalog))).toEqual({
          kind: 'escalate',
          reason: 'UNCATALOGED_ENDPOINT',
        });
    }
  });

  it('builds and uses independent operator policies without DNS or HTTP', () => {
    const network = [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
    ];
    const first = createCanonicalizer(configuredCatalog('http://127.0.0.1:4101'));
    const second = createCanonicalizer(configuredCatalog('http://127.0.0.1:4201'));
    expect(first('http://127.0.0.1:4101/')).toMatchObject({ ok: true });
    expect(second('http://127.0.0.1:4101/')).toEqual({ ok: false, code: 'BAD_URL' });
    expect(first('http://127.0.0.1:4201/')).toEqual({ ok: false, code: 'BAD_URL' });
    for (const spy of network) expect(spy).not.toHaveBeenCalled();
  });
});
