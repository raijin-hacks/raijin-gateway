import type { Catalog, EndpointMatch, HttpMethod } from '@apf/contracts';

// Interface only: loader and parser/matcher are PR 3 and PR 4 respectively.
// Inline the documented canonical result until Chunk 2 agrees a named shared export.
export interface CatalogModule {
  loadCatalog(path: string): Catalog;
  canonicalize(rawUrl: string):
    | { ok: true; url: string; origin: string; path: string; query: [string, string][] }
    | { ok: false; code: 'BAD_URL' | 'DUPLICATE_PARAM' };
  matchEndpoint(
    canonical: Extract<ReturnType<CatalogModule['canonicalize']>, { ok: true }>,
    method: HttpMethod,
    catalog: Catalog,
  ): EndpointMatch;
}
