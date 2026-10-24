import { describe, it } from 'vitest';

// Executable coverage inventory for design-docs/chunk3.md. These are TODOs,
// not fake implementations. Catalog load/canonicalize/match acceptance lives in
// apps/gateway/src/catalog/*.test.ts; real judge checkpoint is still unmeasured.
describe('chunk3 design acceptance awaiting production implementations', () => {
  it.todo('J2 gateway integration: wire the tested routeMatch gate before quote/grant/input building for every unknown host/route/method');
  it.todo('J2b (gateway/transport): reject non-HTTPS, private/mapped addresses, mixed DNS answers, redirects and rebinding with zero contact/signatures');
  it.todo('J2c (gateway): bind UUID idempotency keys atomically; replay concurrent purchases, reject conflicts and recover durable payment identity');
  it.todo('J3: project real contexts with subject normalization and enum-only options; independently tamper every raw text/name/value/metadata/credential leaf and capture provider payload');
  it.todo('J6: score observed approvals/denials/escalations separately from system blocks; exclude failed setups/reliability cases and aggregate repeated runs');
  it.todo('gateway integration: grant hits, trust routing, reservation release once, close-during-call, grant clamps, injection quarantine and human continuation');
  it.todo('demo client: constrain URL/redirect fetches, redact headers/logs, reuse retry keys and bound pending/unknown polling');
});
