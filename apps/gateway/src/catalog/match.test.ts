import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { Catalog, HttpMethod } from '@apf/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, loadCatalog, matchEndpoint, routeMatch } from './index.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function catalog() {
  const value: Catalog = {
    version: 1,
    standing_grants: [],
    merchants: [
      {
        id: 'mer_test',
        name: 'Trusted merchant',
        origin: 'https://merchant.test',
        payee: '0x1111111111111111111111111111111111111111',
        category: 'data',
        description: 'Admin text',
        endpoints: [
          {
            id: 'end_item',
            method: 'GET',
            path: '/v1/items/{subject}',
            category: 'item',
            description: 'One subject',
            params: {
              subject: { in: 'path', kind: 'subject' },
              period: { in: 'query', kind: 'option', type: 'enum', values: ['30d', '90d'] },
              count: { in: 'query', kind: 'option', type: 'int', min: -2, max: 10 },
              enabled: { in: 'query', kind: 'option', type: 'bool' },
              secret: { in: 'query', kind: 'forbidden' },
            },
          },
          {
            id: 'end_root',
            method: 'GET',
            path: '/',
            category: 'root',
            description: 'Root',
            params: {},
          },
          {
            id: 'end_bool',
            method: 'POST',
            path: '/flags/{enabled}',
            category: 'flag',
            description: 'Flag',
            params: { enabled: { in: 'path', kind: 'option', type: 'bool' } },
          },
          {
            id: 'end_forbidden',
            method: 'GET',
            path: '/forbidden/{secret}',
            category: 'forbidden',
            description: 'Forbidden',
            params: { secret: { in: 'path', kind: 'forbidden' } },
          },
          {
            id: 'end_int',
            method: 'GET',
            path: '/counts/{count}',
            category: 'count',
            description: 'Count',
            params: { count: { in: 'path', kind: 'option', type: 'int', min: -2, max: 10 } },
          },
          {
            id: 'end_enum',
            method: 'GET',
            path: '/periods/{period}',
            category: 'period',
            description: 'Period',
            params: {
              period: { in: 'path', kind: 'option', type: 'enum', values: ['30d', '90d'] },
            },
          },
          {
            id: 'end_own',
            method: 'GET',
            path: '/own/{constructor}',
            category: 'own',
            description: 'Own',
            params: {
              constructor: { in: 'path', kind: 'subject' } as const,
              toString: { in: 'query', kind: 'option', type: 'bool' } as const,
            },
          },
        ],
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), 'match-catalog-'));
  directories.push(dir);
  const file = join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify(value));
  return loadCatalog(file);
}
function canonical(raw: string) {
  const result = canonicalize(raw);
  if (!result.ok) throw new Error(result.code);
  return result;
}
const url = (path: string) => canonical(`https://merchant.test${path}`);

describe('exact catalog matching', () => {
  it('returns the original trusted objects, decoded parameters, and no subject authorization', () => {
    const loaded = catalog();
    const result = matchEndpoint(
      url('/v1/items/%20OUTSIDE%20?period=30d&count=10&enabled=false'),
      'GET',
      loaded,
    );
    expect(result.kind).toBe('known');
    if (result.kind !== 'known') return;
    expect(result.merchant).toBe(loaded.merchants[0]);
    expect(result.endpoint).toBe(loaded.merchants[0]!.endpoints[0]);
    expect(result.params).toEqual([
      { name: 'subject', value: ' OUTSIDE ', kind: 'subject', violation: null },
      { name: 'count', value: '10', kind: 'option', violation: null },
      { name: 'enabled', value: 'false', kind: 'option', violation: null },
      { name: 'period', value: '30d', kind: 'option', violation: null },
    ]);
    expect(routeMatch(result)).toEqual({ kind: 'judge-eligible', match: result });
  });

  it.each([
    ['count', '-2', true],
    ['count', '0', true],
    ['count', '10', true],
    ['count', '-3', false],
    ['count', '11', false],
    ['count', '', false],
    ['count', '1.0', false],
    ['count', '1e1', false],
    ['count', '0xA', false],
    ['count', '01', false],
    ['count', '+1', false],
    ['count', ' 1', false],
    ['count', 'Infinity', false],
    ['count', '9007199254740993', false],
    ['period', '30d', true],
    ['period', '90d', true],
    ['period', '30D', false],
    ['period', '', false],
    ['enabled', 'true', true],
    ['enabled', 'false', true],
    ['enabled', 'TRUE', false],
    ['enabled', '1', false],
    ['enabled', '', false],
    ['secret', '', false],
    ['secret', 'value', false],
    ['extra', 'value', false],
    ['subject', 'acme', false],
    ['__proto__', 'x', false],
    ['constructor', 'x', false],
    ['toString', 'x', false],
    ['hasOwnProperty', 'x', false],
  ])('validates query %s=%j (valid=%s)', (name, value, valid) => {
    const result = matchEndpoint(
      url(`/v1/items/acme?${new URLSearchParams([[name, value]])}`),
      'GET',
      catalog(),
    );
    expect(result.kind).toBe('known');
    if (result.kind !== 'known') return;
    const param = [...result.params].reverse().find((p) => p.name === name)!;
    expect(param.violation).toBe(valid ? null : 'PARAM_NOT_IN_SCHEMA');
    if (['__proto__', 'constructor', 'toString', 'hasOwnProperty'].includes(name))
      expect(param.kind).toBe('undeclared');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('validates path options and forbidden path values', () => {
    const loaded = catalog();
    for (const [path, method, violation] of [
      ['/flags/true', 'POST', null],
      ['/flags/false', 'POST', null],
      ['/flags/1', 'POST', 'PARAM_NOT_IN_SCHEMA'],
      ['/forbidden/value', 'GET', 'PARAM_NOT_IN_SCHEMA'],
      ['/counts/-2', 'GET', null],
      ['/counts/10', 'GET', null],
      ['/counts/11', 'GET', 'PARAM_NOT_IN_SCHEMA'],
      ['/counts/1e1', 'GET', 'PARAM_NOT_IN_SCHEMA'],
      ['/periods/30d', 'GET', null],
      ['/periods/30D', 'GET', 'PARAM_NOT_IN_SCHEMA'],
    ] as const) {
      const result = matchEndpoint(url(path), method, loaded);
      expect(result.kind === 'known' && result.params[0]!.violation).toBe(violation);
    }
  });

  it('honors own declarations even when names coincide with Object.prototype', () => {
    expect(matchEndpoint(url('/own/acme?toString=true'), 'GET', catalog())).toMatchObject({
      kind: 'known',
      params: [
        { name: 'constructor', kind: 'subject', value: 'acme', violation: null },
        { name: 'toString', kind: 'option', value: 'true', violation: null },
      ],
    });
  });

  it('does not require absent query parameters (ParamSpec has no required field)', () => {
    const result = matchEndpoint(url('/'), 'GET', catalog());
    expect(result).toMatchObject({ kind: 'known', params: [] });
  });

  it.each([
    ['https://other.test/v1/items/acme', 'GET'],
    ['https://merchant.test:8443/v1/items/acme', 'GET'],
    ['https://merchant.test/unknown', 'GET'],
    ['https://merchant.test/v1/items', 'GET'],
    ['https://merchant.test/v1/items/acme/extra', 'GET'],
    ['https://merchant.test/V1/items/acme', 'GET'],
    ['https://merchant.test/v1/items/acme', 'POST'],
    ['https://merchant.test/v1/items/acme', 'get'],
  ])('keeps origin, method and segment mismatch unknown: %s %s', (raw, method) => {
    const result = matchEndpoint(canonical(raw), method as HttpMethod, catalog());
    expect(result).toMatchObject({ kind: 'unknown', hasParams: false });
    expect(routeMatch(result)).toEqual({ kind: 'deny', reason: 'UNCATALOGED_ENDPOINT' });
    expect(result).not.toHaveProperty('merchant');
    expect(result).not.toHaveProperty('endpoint');
  });

  it('returns only shape diagnostics for unknown routes, without query names or values', () => {
    const result = matchEndpoint(
      url('/canary/DO_NOT_COPY?SECRET_NAME=CANARY_VALUE&n=-12&empty='),
      'GET',
      catalog(),
    );
    expect(result).toEqual({
      kind: 'unknown',
      origin: 'https://merchant.test',
      hasParams: true,
      urlShape: {
        path_segments: [6, 11],
        query_params: [
          { type: 'string', length: 12 },
          { type: 'other', length: 0 },
          { type: 'int', length: 3 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/canary|DO_NOT_COPY|SECRET_NAME|CANARY_VALUE/);
  });

  it('requires a validated catalog even for unknown routes', () => {
    expect(() => matchEndpoint(url('/'), 'GET', structuredClone(catalog()))).toThrow(/not loaded/);
  });

  it('matches and intercepts known and unknown routes without DNS or HTTP', () => {
    const network = [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
    ];
    const loaded = catalog();
    for (const path of ['/', '/v1/items/acme', '/unknown', '/unknown?x=canary']) {
      routeMatch(matchEndpoint(url(path), 'GET', loaded));
    }
    for (const spy of network) expect(spy).not.toHaveBeenCalled();
  });
});
