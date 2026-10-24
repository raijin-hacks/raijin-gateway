import { readFileSync } from 'node:fs';
import { CatalogSchema, type Catalog } from '@apf/contracts';

type Endpoint = Catalog['merchants'][number]['endpoints'][number];
export type TemplateSegment = { literal: string } | { parameter: string };
export interface CompiledEndpoint {
  origin: string;
  method: Endpoint['method'];
  endpointId: string;
  segments: readonly TemplateSegment[];
}

function invalid(message: string): never {
  throw new Error(`Invalid catalog: ${message}`);
}

function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function compile(endpoint: Endpoint): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const names = new Set<string>();
  // Templates are decoded, canonical path segments; URL syntax is not allowed here.
  if (endpoint.path !== '/') {
    for (const segment of endpoint.path.slice(1).split('/')) {
      const variable = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
      if (variable) {
        const name = variable[1]!;
        if (names.has(name)) invalid(`repeated path parameter in ${endpoint.id}`);
        names.add(name);
        const spec = endpoint.params[name];
        if (!spec || spec.in !== 'path') invalid(`missing path parameter in ${endpoint.id}`);
        segments.push({ parameter: name });
      } else {
        if (
          !segment ||
          segment === '.' ||
          segment === '..' ||
          /[{}%?#\\\s]/u.test(segment) ||
          hasControl(segment)
        ) {
          invalid(`invalid path template in ${endpoint.id}`);
        }
        segments.push({ literal: segment });
      }
    }
  }
  for (const [name, spec] of Object.entries(endpoint.params)) {
    if (/\s/u.test(name) || hasControl(name)) invalid(`invalid parameter name in ${endpoint.id}`);
    if (spec.in === 'path' && !names.has(name)) invalid(`unused path parameter in ${endpoint.id}`);
    if (spec.kind === 'option') {
      if (spec.type === 'enum' && new Set(spec.values).size !== spec.values.length) {
        invalid(`duplicate enum value in ${endpoint.id}`);
      }
      if (
        spec.type === 'int' &&
        (!Number.isSafeInteger(spec.min) || !Number.isSafeInteger(spec.max))
      ) {
        invalid(`unsafe integer bound in ${endpoint.id}`);
      }
    }
  }
  return segments;
}

/** Compile and validate all cross-entry rules before exposing any trusted catalog. */
function compileCatalog(catalog: Catalog): readonly CompiledEndpoint[] {
  const ids = new Set<string>();
  const endpointIds = new Set<string>();
  const compiled: CompiledEndpoint[] = [];
  const unique = (id: string) => {
    if (ids.has(id)) invalid(`duplicate id ${id}`);
    ids.add(id);
  };
  for (const merchant of catalog.merchants) {
    unique(merchant.id);
    const origin = new URL(merchant.origin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.origin !== merchant.origin ||
      origin.username ||
      origin.password
    ) {
      invalid(`noncanonical origin for ${merchant.id}`);
    }
    for (const endpoint of merchant.endpoints) {
      unique(endpoint.id);
      endpointIds.add(endpoint.id);
      const segments = compile(endpoint);
      for (const other of compiled) {
        if (
          other.origin === merchant.origin &&
          other.method === endpoint.method &&
          other.segments.length === segments.length &&
          other.segments.every((segment, i) => {
            const next = segments[i]!;
            return (
              !('literal' in segment) || !('literal' in next) || segment.literal === next.literal
            );
          })
        )
          invalid(`overlapping endpoints ${other.endpointId} and ${endpoint.id}`);
      }
      compiled.push({
        origin: merchant.origin,
        method: endpoint.method,
        endpointId: endpoint.id,
        segments,
      });
    }
  }
  const grants = new Set<string>();
  for (const grant of catalog.standing_grants) {
    if (!endpointIds.has(grant.endpoint_id))
      invalid(`dangling standing grant ${grant.endpoint_id}`);
    const key = JSON.stringify([grant.role, grant.endpoint_id]);
    if (!grant.role.trim() || grants.has(key))
      invalid(`invalid or duplicate standing grant ${grant.endpoint_id}`);
    grants.add(key);
    if (grant.max_per_call > grant.daily_total)
      invalid(`standing grant per-call exceeds daily total ${grant.endpoint_id}`);
  }
  return compiled;
}

// Kept by identity for the phase 4 matcher; callers cannot mutate admitted definitions.
const templates = new WeakMap<Catalog, readonly CompiledEndpoint[]>();
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}
export function compiledEndpoints(catalog: Catalog): readonly CompiledEndpoint[] {
  const result = templates.get(catalog);
  if (!result) invalid('catalog was not loaded through loadCatalog');
  return result;
}

export function loadCatalog(path: string): Catalog {
  const catalog = CatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const result = compileCatalog(catalog);
  freeze(catalog);
  freeze(result);
  templates.set(catalog, result);
  return catalog;
}
