import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogSchema } from '@apf/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadCatalog } from '../../src/stubs/catalog-stub.js';
import { FIXTURE_CATALOG_PATH } from '../harness/db.js';

function fileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'apf-catalog-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'catalog.json');
  writeFileSync(path, contents);
  return path;
}

describe('loadCatalog (stub until Chunk 3 ships theirs)', () => {
  it('returns the parsed catalog', () => {
    const catalog = loadCatalog(FIXTURE_CATALOG_PATH);
    expect(CatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.merchants.map((m) => m.id)).toEqual(['mer_pricing', 'mer_weather', 'mer_news']);
  });

  it('throws for a missing file', () => {
    expect(() => loadCatalog(join(tmpdir(), 'no-such-catalog.json'))).toThrow(/ENOENT/);
  });

  it('throws for a file that is not JSON', () => {
    expect(() => loadCatalog(fileWith('{ not json'))).toThrow(SyntaxError);
  });

  it('throws for JSON that is not a valid catalog', () => {
    expect(() => loadCatalog(fileWith('{"version": 1, "merchants": []}'))).toThrow(
      /standing_grants/,
    );
  });
});
