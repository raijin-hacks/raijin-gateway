import type { Catalog, EndpointMatch, HttpMethod } from '@apf/contracts';

// Parser/matcher implementations arrive in PR 4; the loader is exported below.
// Inline the documented canonical result until Chunk 2 agrees a named shared export.
export interface CatalogModule {
  loadCatalog(path: string): Catalog;
  canonicalize(
    rawUrl: string,
  ):
    | { ok: true; url: string; origin: string; path: string; query: [string, string][] }
    | { ok: false; code: 'BAD_URL' | 'DUPLICATE_PARAM' };
  matchEndpoint(
    canonical: Extract<ReturnType<CatalogModule['canonicalize']>, { ok: true }>,
    method: HttpMethod,
    catalog: Catalog,
  ): EndpointMatch;
}

export { loadCatalog, compiledEndpoints } from './load.js';
