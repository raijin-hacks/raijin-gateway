import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { canonicalize } from './index.js';

afterEach(() => vi.restoreAllMocks());

describe('pure canonicalization', () => {
  it.each([
    [
      'HTTPS://ExAmPlE.test:443/v1/%41cme?z=2&a=one%20two#ignored',
      'https://example.test/v1/Acme?a=one+two&z=2',
      '/v1/Acme',
    ],
    ['https://example.test:8443/a', 'https://example.test:8443/a', '/a'],
    ['https://example.test', 'https://example.test/', '/'],
    ['https://example.test/?', 'https://example.test/', '/'],
    ['https://example.test/#fragment', 'https://example.test/', '/'],
    ['https://EXAMPLE.test/a%3Fb%23c%25d', 'https://example.test/a%3Fb%23c%25d', '/a?b#c%d'],
    [
      'https://example.test/caf%C3%A9/%E2%98%83?%C3%A9=%E2%98%83',
      'https://example.test/caf%C3%A9/%E2%98%83?%C3%A9=%E2%98%83',
      '/café/☃',
    ],
    [
      'https://example.test/x?a=%252F&b=%25&c=%2B&d=+&empty',
      'https://example.test/x?a=%252F&b=%25&c=%2B&d=+&empty=',
      '/x',
    ],
    ['https://example.test/?&=value&&a=', 'https://example.test/?=value&a=', '/'],
    ['https://BÜCHER.test:443/', 'https://xn--bcher-kva.test/', '/'],
    ['https://[2001:DB8::1]:443/', 'https://[2001:db8::1]/', '/'],
  ])('normalizes and stably re-canonicalizes %s', (raw, url, path) => {
    const result = canonicalize(raw);
    expect(result).toMatchObject({ ok: true, url, path, origin: new URL(url).origin });
    expect(canonicalize(url)).toEqual(result);
  });

  it('sorts decoded query names without changing case or normalizing subject values', () => {
    expect(canonicalize('https://example.test/%20ACME%20?z=last&%61=first&A=upper')).toEqual({
      ok: true,
      origin: 'https://example.test',
      path: '/ ACME ',
      url: 'https://example.test/%20ACME%20?A=upper&a=first&z=last',
      query: [
        ['A', 'upper'],
        ['a', 'first'],
        ['z', 'last'],
      ],
    });
  });

  it('preserves reserved characters and Unicode across repeated canonicalization', () => {
    const values = [
      'alpha',
      'A B',
      '#?&=+',
      'café',
      '☃',
      '🚀',
      '100%',
      'a%20b',
      ':@;[]!',
      '\u2028',
      '\uFF0F',
    ];
    for (const path of values) {
      for (const value of values) {
        const raw = `https://example.test/${encodeURIComponent(path)}?${new URLSearchParams([[value, value]])}`;
        const result = canonicalize(raw);
        expect(result).toMatchObject({ ok: true, path: `/${path}`, query: [[value, value]] });
        if (result.ok) expect(canonicalize(result.url)).toEqual(result);
      }
    }
  });

  it.each([
    '',
    '/relative',
    '//example.test/a',
    'not a URL',
    'https:example.test/a',
    'https:///example.test/a',
    'https://',
    'ftp://example.test/a',
    'http://localhost:4101/a',
    'http://merchant.test/a',
    'http://example.com/a',
    'https://user:pass@example.test/a',
    'https://user@example.test/a',
    'https://@example.test/a',
    'https://example.test:99999/a',
    'https://example.test:abc/a',
    'https://[fe80::1%25eth0]/',
    ' https://example.test/a',
    'https://example.test/a ',
    'https://exa\nmple.test/a',
    'https://example.test/a\tb',
    'https://example.test/a\u0000b',
    'https://example.test/a\\b',
    'https:\\example.test/a',
    'https://example.test/a/../b',
    'https://example.test/a/./b',
    'https://example.test/..',
    'https://example.test/%2e',
    'https://example.test/a/%2E%2e/b',
    'https://example.test/a/.%2e/b',
    'https://example.test/a/%2e./b',
    'https://example.test/a/%252e%252e/b',
    'https://example.test/a/%25252e%25252e/b',
    'https://example.test/a%2fb',
    'https://example.test/a%2Fb',
    'https://example.test/a%5Cb',
    'https://example.test/a%252fb',
    'https://example.test/a%255cb',
    'https://example.test/a%25252fb',
    'https://example.test//a',
    'https://example.test/a//b',
    'https://example.test/a/',
    'https://example.test/%',
    'https://example.test/%2',
    'https://example.test/%GG',
    'https://example.test/%C0%AF',
    'https://example.test/%ED%A0%80',
    'https://example.test/%00',
    'https://example.test/%0a',
    'https://example.test/%7f',
    'https://example.test/?x=%',
    'https://example.test/?%=a',
    'https://example.test/?x=%FF',
    'https://example.test/?x=%0d%0a',
    'https://example.test/?%00=x',
    'https://example.test/#%',
    'https://example.test/\ud800',
    'https://example.test/?x=\ud800',
  ])('rejects ambiguous, unsafe or malformed syntax %j', (raw) => {
    expect(canonicalize(raw)).toEqual({ ok: false, code: 'BAD_URL' });
  });

  it.each([
    '?x=1&x=2',
    '?x=1&%78=2',
    '?%61=1&a=1',
    '?a+b=1&a%20b=2',
    '?a&a=',
    '?=a&=b',
    '?__proto__=a&%5f_proto__=b',
    '?constructor=a&constructor=b',
  ])('rejects duplicate decoded names %s', (query) => {
    expect(canonicalize(`https://example.test/${query}`)).toEqual({
      ok: false,
      code: 'DUPLICATE_PARAM',
    });
  });

  it('never resolves or contacts accepted, unknown or rejected destinations', () => {
    const network = [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
    ];
    for (const url of [
      'https://example.test/a?b=1',
      'https://127.0.0.1/',
      'http://localhost/a',
      'https://attacker.test/%2e%2e/a',
    ])
      canonicalize(url);
    for (const spy of network) expect(spy).not.toHaveBeenCalled();
  });
});
