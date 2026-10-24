import { expect, it } from 'vitest';
import { loadCatalog } from '../../../apps/gateway/src/catalog/index.js';
import { createStubPlanDrafter } from '../../../apps/gateway/src/judge/advisory.js';
import { differences, parsePlan, propose, reference, tasks } from './setup.js';
const catalog = loadCatalog('catalog/catalog.json');
it('records null drafts and outages as failures without inventing edits or task success', async () => {
  const plan = reference(tasks[0]!);
  const stub = await propose(createStubPlanDrafter(), plan.task, catalog);
  expect(stub.proposal?.draft).toBeNull();
  expect(differences(null, plan)).toHaveLength(5);
  expect(
    (
      await propose(
        {
          draft: async () => {
            throw new Error('secret');
          },
        },
        plan.task,
        catalog,
      )
    ).error,
  ).toBe('DRAFT_FAILED');
  expect(differences({ ...plan, budget: 1 }, plan)).toEqual(['budget']);
  expect(() =>
    parsePlan({ ...plan, allowed_merchant_ids: ['unknown'] }, plan.task, catalog),
  ).toThrow();
  expect(() => parsePlan({ ...plan, task: 'changed' }, plan.task, catalog)).toThrow();
});
