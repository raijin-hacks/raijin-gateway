import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Catalog } from '@apf/contracts';
import { compiledEndpoints, loadCatalog } from './index.js';

const baseline = new URL('../../../../catalog/catalog.json', import.meta.url);
const fresh = (): Catalog => JSON.parse(readFileSync(baseline, 'utf8'));
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function load(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-'));
  directories.push(directory);
  const path = join(directory, 'catalog.json');
  writeFileSync(path, JSON.stringify(value));
  return loadCatalog(path);
}

describe('trusted catalog loading', () => {
  it('admits the honest catalog with actual merchant payees, export and research grant', () => {
    const catalog = load(fresh());
    const payees = JSON.parse(
      readFileSync(new URL('../../../merchants/payees.json', import.meta.url), 'utf8'),
    ).payees;
    expect(catalog.merchants.map((m) => m.payee)).toEqual([
      payees.pricescope,
      payees.skydata,
      payees.newswire,
    ]);
    expect(catalog.merchants.map((m) => m.origin)).toEqual(
      [4101, 4102, 4103].map((port) => `http://localhost:${port}`),
    );
    expect(catalog.merchants[0]!.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/v1/pricing/export',
        category: 'bulk export',
      }),
    );
    expect(catalog.standing_grants).toContainEqual(
      expect.objectContaining({ role: 'research', endpoint_id: 'end_weather_forecast' }),
    );
    expect(compiledEndpoints(catalog)).toHaveLength(4);
    expect(compiledEndpoints(catalog)[0]!.segments[2]).toEqual({ parameter: 'company' });
    expect(Object.isFrozen(catalog.merchants[0]!.endpoints[0]!.params)).toBe(true);
    expect(Object.isFrozen(compiledEndpoints(catalog)[0]!.segments)).toBe(true);
    expect(() => compiledEndpoints(fresh())).toThrow(/not loaded/);
  });

  const bad: [string, (c: Catalog) => void][] = [
    [
      'duplicate merchant',
      (c) => {
        c.merchants.push(structuredClone(c.merchants[0]!));
      },
    ],
    [
      'duplicate endpoint',
      (c) => {
        c.merchants[1]!.endpoints[0]!.id = c.merchants[0]!.endpoints[0]!.id;
      },
    ],
    [
      'dangling grant',
      (c) => {
        c.standing_grants[0]!.endpoint_id = 'end_missing';
      },
    ],
    [
      'duplicate grant',
      (c) => {
        c.standing_grants.push(structuredClone(c.standing_grants[0]!));
      },
    ],
    [
      'invalid grant limits',
      (c) => {
        c.standing_grants[0]!.daily_total = 1;
      },
    ],
    [
      'missing parameter',
      (c) => {
        c.merchants[0]!.endpoints[0]!.params = {};
      },
    ],
    [
      'unused parameter',
      (c) => {
        c.merchants[0]!.endpoints[0]!.path = '/v1/pricing';
      },
    ],
    [
      'wrong parameter location',
      (c) => {
        c.merchants[0]!.endpoints[0]!.params.company!.in = 'query';
      },
    ],
    [
      'repeated variable',
      (c) => {
        c.merchants[0]!.endpoints[0]!.path = '/{company}/{company}';
      },
    ],
    [
      'duplicate enum',
      (c) => {
        c.merchants[0]!.endpoints[0]!.params.period = {
          in: 'query',
          kind: 'option',
          type: 'enum',
          values: ['a', 'a'],
        };
      },
    ],
    [
      'unsafe bound',
      (c) => {
        c.merchants[0]!.endpoints[0]!.params.limit = {
          in: 'query',
          kind: 'option',
          type: 'int',
          min: 0,
          max: 1e20,
        };
      },
    ],
    [
      'reversed bounds',
      (c) => {
        c.merchants[0]!.endpoints[0]!.params.limit = {
          in: 'query',
          kind: 'option',
          type: 'int',
          min: 2,
          max: 1,
        };
      },
    ],
    [
      'noncanonical origin',
      (c) => {
        c.merchants[0]!.origin = 'http://LOCALHOST:4101';
      },
    ],
  ];
  it.each(bad)('rejects %s', (_, mutate) => {
    const c = fresh();
    mutate(c);
    expect(() => load(c)).toThrow();
  });
  it.each([
    '/a//b',
    '/a/',
    '/a/../b',
    '/%2e',
    '/{broken',
    '/prefix{company}',
    '/a?b',
    '/a#b',
    '/a\\b',
  ])('rejects malformed template %s', (path) => {
    const c = fresh();
    c.merchants[0]!.endpoints[1]!.path = path;
    expect(() => load(c)).toThrow();
  });
  it.each(['static', 'template', 'cross-merchant'] as const)('rejects %s overlap', (variant) => {
    const c = fresh();
    const endpoint = structuredClone(c.merchants[0]!.endpoints[0]!);
    endpoint.id = 'end_overlap';
    if (variant === 'static') {
      endpoint.path = '/v1/pricing/Acme';
      endpoint.params = {};
    }
    if (variant === 'cross-merchant') {
      c.merchants[1]!.origin = c.merchants[0]!.origin;
      c.merchants[1]!.endpoints.push(endpoint);
    } else c.merchants[0]!.endpoints.push(endpoint);
    expect(() => load(c)).toThrow(/overlapping/);
  });
  it('allows disjoint static paths, segment counts, methods and origins', () => {
    const c = fresh();
    c.merchants[0]!.endpoints.push({
      id: 'end_root',
      method: 'GET',
      path: '/',
      category: 'root',
      description: 'Root',
      params: {},
    });
    expect(() => load(c)).not.toThrow();
  });
  it.each([null, {}, { ...fresh(), version: 2 }, { ...fresh(), unexpected: true }])(
    'rejects invalid schema %#',
    (value) => {
      expect(() => load(value)).toThrow();
    },
  );
  it('fails on unreadable files and malformed JSON', () => {
    expect(() => loadCatalog('/nonexistent/catalog.json')).toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    directories.push(dir);
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{');
    expect(() => loadCatalog(path)).toThrow();
  });
});
