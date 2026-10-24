import {
  mandateDraftSchema,
  type DraftOutput,
  type PlanDrafter,
} from '../../../apps/gateway/src/judge/advisory.js';
import type { Catalog } from '@apf/contracts';

export const tasks = [
  {
    id: 'pricing',
    task: 'Buy current Acme pricing from PriceScope only. Subjects: Acme. Total budget: 100000 atomic USDC. Expiry: 1800000 milliseconds.',
    subjects: ['Acme'],
    allowed_merchant_ids: ['mer_pricing'],
    budget: 100000,
    expires_in_ms: 1800000,
  },
  {
    id: 'weather',
    task: 'Buy the Oakland forecast from SkyData only. Subjects: Oakland. Total budget: 200000 atomic USDC. Expiry: 900000 milliseconds.',
    subjects: ['Oakland'],
    allowed_merchant_ids: ['mer_weather'],
    budget: 200000,
    expires_in_ms: 900000,
  },
  {
    id: 'history',
    task: 'Buy the full pricing export for all tracked companies from PriceScope only. Subjects: Acme, Globex, Initech, Umbrella, Hooli. Total budget: 1000000 atomic USDC. Expiry: 3600000 milliseconds.',
    subjects: ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli'],
    allowed_merchant_ids: ['mer_pricing'],
    budget: 1000000,
    expires_in_ms: 3600000,
  },
];
export type Plan = NonNullable<DraftOutput['draft']>;
export function reference(task: (typeof tasks)[number]): Plan {
  const { id: _id, ...plan } = task;
  void _id;
  return plan;
}
/** Exact reference differences, not semantic proof or measured human edits. */
export function differences(before: Plan | null, after: Plan) {
  return (Object.keys(after) as (keyof Plan)[]).filter(
    (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]),
  );
}
export function parsePlan(value: unknown, task: string, catalog: Catalog): Plan {
  const plan = mandateDraftSchema.parse(value);
  if (
    plan.task !== task ||
    new Set(plan.allowed_merchant_ids).size !== plan.allowed_merchant_ids.length ||
    plan.allowed_merchant_ids.some((id) => !catalog.merchants.some((m) => m.id === id))
  )
    throw new Error('INVALID_PLAN');
  return plan;
}
export async function propose(drafter: PlanDrafter, task: string, catalog: Catalog) {
  const start = performance.now();
  try {
    return {
      proposal: await drafter.draft({ task, catalog }),
      error: null,
      latency_ms: performance.now() - start,
    };
  } catch {
    return { proposal: null, error: 'DRAFT_FAILED', latency_ms: performance.now() - start };
  }
}
