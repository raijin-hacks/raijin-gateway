import type { Catalog, EndpointMatch, HttpMethod, ParamSpec } from '@apf/contracts';
import type { Canonical } from './canonicalize.js';
import { compiledEndpoints } from './load.js';

const integer = /^-?(?:0|[1-9]\d*)$/u;

function validOption(spec: ParamSpec, value: string): boolean {
  if (spec.kind !== 'option') return spec.kind === 'subject';
  switch (spec.type) {
    case 'enum':
      return spec.values.includes(value);
    case 'bool':
      return value === 'true' || value === 'false';
    case 'int': {
      const number = Number(value);
      return (
        integer.test(value) &&
        Number.isSafeInteger(number) &&
        number >= spec.min &&
        number <= spec.max
      );
    }
  }
}

/** Only loaded, immutable catalogs are admitted; selection never uses option validity. */
export function matchEndpoint(
  canonical: Canonical,
  method: HttpMethod,
  catalog: Catalog,
): EndpointMatch {
  const segments = canonical.path === '/' ? [] : canonical.path.slice(1).split('/');
  const compiled = compiledEndpoints(catalog).find(
    (endpoint) =>
      endpoint.origin === canonical.origin &&
      endpoint.method === method &&
      endpoint.segments.length === segments.length &&
      endpoint.segments.every(
        (segment, i) => !('literal' in segment) || segment.literal === segments[i],
      ),
  );
  if (!compiled) {
    return {
      kind: 'unknown',
      origin: canonical.origin,
      hasParams: canonical.query.length > 0,
      urlShape: {
        path_segments: segments.map((segment) => segment.length),
        query_params: canonical.query.map(([, value]) => ({
          type: integer.test(value) ? 'int' : value ? 'string' : 'other',
          length: value.length,
        })),
      },
    };
  }
  const merchant = catalog.merchants.find((m) =>
    m.endpoints.some((e) => e.id === compiled.endpointId),
  )!;
  const endpoint = merchant.endpoints.find((e) => e.id === compiled.endpointId)!;
  const params: Extract<EndpointMatch, { kind: 'known' }>['params'] = [];
  const add = (name: string, value: string, location: 'path' | 'query') => {
    const spec = Object.hasOwn(endpoint.params, name) ? endpoint.params[name] : undefined;
    params.push({
      name,
      value,
      kind: spec?.kind ?? 'undeclared',
      violation:
        !spec || spec.in !== location || !validOption(spec, value) ? 'PARAM_NOT_IN_SCHEMA' : null,
    });
  };
  compiled.segments.forEach((segment, i) => {
    if ('parameter' in segment) add(segment.parameter, segments[i]!, 'path');
  });
  for (const [name, value] of canonical.query) add(name, value, 'query');
  return { kind: 'known', merchant, endpoint, params };
}

export type VerificationRoute =
  | { kind: 'judge-eligible'; match: Extract<EndpointMatch, { kind: 'known' }> }
  | { kind: 'escalate'; reason: 'UNCATALOGED_ENDPOINT' };

/** Call before quote contact, grant lookup or buildInput. Approval cannot bypass admission. */
export function routeMatch(match: EndpointMatch): VerificationRoute {
  return match.kind === 'known'
    ? { kind: 'judge-eligible', match }
    : { kind: 'escalate', reason: 'UNCATALOGED_ENDPOINT' };
}
