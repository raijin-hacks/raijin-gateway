// Stand-in for Chunk 3's loadCatalog (apps/gateway/src/catalog) with the same signature.
// It checks the contract shape only; Chunk 3's version adds cross-entry checks. Swap the
// import for the real one when it lands, then delete this file.
import { readFileSync } from 'node:fs';
import { CatalogSchema, type Catalog } from '@apf/contracts';

export function loadCatalog(path: string): Catalog {
  return CatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
