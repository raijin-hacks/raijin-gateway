import type { Catalog, EndpointMatch, HttpMethod } from '@apf/contracts';
import type { Canonical, CanonicalResult } from './canonicalize.js';

export interface CatalogModule {
  loadCatalog(path: string): Catalog;
  canonicalize(rawUrl: string): CanonicalResult;
  createCanonicalizer(catalog: Catalog): CatalogModule['canonicalize'];
  matchEndpoint(canonical: Canonical, method: HttpMethod, catalog: Catalog): EndpointMatch;
}

export { loadCatalog, compiledEndpoints } from './load.js';
export { canonicalize, createCanonicalizer } from './canonicalize.js';
export type { Canonical, CanonicalResult } from './canonicalize.js';
export { matchEndpoint, routeMatch } from './match.js';
export type { VerificationRoute } from './match.js';
