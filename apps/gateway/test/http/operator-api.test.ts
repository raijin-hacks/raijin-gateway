import { AgentsResponseSchema, PendingApprovalsResponseSchema } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createHarness } from '../harness/app.js';

describe('GET /agents', () => {
  it('requires admin authentication', async () => {
    const h = createHarness();
    const response = await h.request('/agents');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns database agents with their persistent trust scores and role names', async () => {
    const h = createHarness();
    h.db.sqlite.prepare("UPDATE agents SET trust = 72.5 WHERE id = 'agt_pricing'").run();

    const response = await h.admin('/agents');
    expect(response.status).toBe(200);
    expect(AgentsResponseSchema.parse(await response.json())).toEqual([
      { id: 'agt_bulk', name: 'Bulk loader', role: 'bulk', trust: 70 },
      { id: 'agt_logistics', name: 'Logistics analyst', role: 'research', trust: 70 },
      { id: 'agt_pricing', name: 'Pricing researcher', role: 'research', trust: 72.5 },
    ]);
  });
});

describe('GET /approvals?status=pending', () => {
  it('requires admin authentication', async () => {
    const h = createHarness();
    const response = await h.request('/approvals?status=pending');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns an empty list when no workflow is waiting for review', async () => {
    const h = createHarness();
    const response = await h.admin('/approvals?status=pending');
    expect(response.status).toBe(200);
    expect(PendingApprovalsResponseSchema.parse(await response.json())).toEqual([]);
  });

  it.each([
    ['/approvals', 'missing status'],
    ['/approvals?status=approved', 'unsupported status'],
    ['/approvals?status=', 'empty status'],
    ['/approvals?status=approved&status=pending', 'duplicate status values'],
    ['/approvals?status=pending&limit=10', 'unsupported query key'],
  ] as const)('answers 400 to %s (%s)', async (path, _why) => {
    const h = createHarness();
    const response = await h.admin(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'bad_request' });
  });
});
