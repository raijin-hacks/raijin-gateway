import { expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  AgentIncidentSchema,
  AgentRestorationSchema,
  RestrictionStateSchema,
  RestoreAgentRequestSchema,
  RestoreAgentResponseSchema,
  StreamEventSchema,
  RESTRICTION_STATES,
  INCIDENT_CODES,
  TRUST_DELTAS,
  type AgentIncident,
  type AgentRestoration,
  type RestrictionState,
  type IncidentCode,
  type RestoreAgentRequest,
  type RestoreAgentResponse,
} from '../src/index.js';
import { CONTRACTS_DOC, jsonExampleAfter } from './doc.js';

it('v1.4 restoration and stream examples satisfy the boundary contracts', () => {
  for (const [heading, schema] of [
    ['### `POST /agents/:id/restore` request', RestoreAgentRequestSchema],
    ['### `POST /agents/:id/restore` response', RestoreAgentResponseSchema],
    ['### Restriction stream examples', StreamEventSchema],
    ['### Restoration stream example', StreamEventSchema],
  ] as const) {
    const example = jsonExampleAfter(heading);
    expect(schema.parse(example)).toEqual(example);
  }
  expect(CONTRACTS_DOC).toContain('v1.4: durable agent restrictions');
  expect(CONTRACTS_DOC).toContain(
    "export type RestrictionState = 'normal' | 'review_required' | 'suspended'",
  );
});

it('restriction schemas and enums exactly match their public types', () => {
  expectTypeOf<z.infer<typeof RestrictionStateSchema>>().toEqualTypeOf<RestrictionState>();
  expectTypeOf<z.infer<typeof AgentIncidentSchema>>().toEqualTypeOf<AgentIncident>();
  expectTypeOf<z.infer<typeof AgentRestorationSchema>>().toEqualTypeOf<AgentRestoration>();
  expectTypeOf<z.infer<typeof RestoreAgentRequestSchema>>().toEqualTypeOf<RestoreAgentRequest>();
  expectTypeOf<z.infer<typeof RestoreAgentResponseSchema>>().toEqualTypeOf<RestoreAgentResponse>();
  expectTypeOf<(typeof RESTRICTION_STATES)[number]>().toEqualTypeOf<RestrictionState>();
  expectTypeOf<(typeof INCIDENT_CODES)[number]>().toEqualTypeOf<IncidentCode>();
});

it('every automatic score delta is nonpositive; payment approvals never restore', () => {
  for (const delta of Object.values(TRUST_DELTAS)) {
    expect(delta.agent).toBeLessThanOrEqual(0);
    expect(delta.session).toBeLessThanOrEqual(0);
  }
  expect(TRUST_DELTAS.approved).toEqual({ agent: 0, session: 0 });
  expect(TRUST_DELTAS.humanApproved).toEqual({ agent: 0, session: 0 });
});

it.each([
  { target: 'suspended', reason: 'Investigated', operator: 'Ada' },
  { target: 'normal', reason: ' ', operator: 'Ada' },
  { target: 'normal', reason: 'Investigated', operator: '' },
  { target: 'normal', reason: 'Investigated', operator: 'Ada', severe: true },
])('rejects malformed restoration %j', (body) => {
  expect(RestoreAgentRequestSchema.safeParse(body).success).toBe(false);
});
