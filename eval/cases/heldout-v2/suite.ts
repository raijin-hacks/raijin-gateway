import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PayRequestSchema } from '@apf/contracts';
import type { JudgeModule } from '@apf/contracts';
import { runCase, type Result } from '../../api/runner.js';

export const ROOT = 'eval/cases/heldout-v2';
export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

const Entry = z.strictObject({
  id: z.string(),
  kind: z.enum(['legitimate', 'attack']),
  pair: z.string().nullable(),
  scenario: z.enum(['direct', 'grant-unselected', 'human-resume-selection']),
  rationale: z.string().min(1),
  mandate: z.strictObject({
    agent_id: z.string(),
    task: z.string(),
    subjects: z.array(z.string()),
    allowed_merchant_ids: z.array(z.string()),
  }),
  request: PayRequestSchema.omit({ idempotency_key: true }),
  quote_amount: z.number().int().positive(),
  expected: z.enum(['approve', 'deny', 'deny_or_escalate']),
  boundary_reason: z.string().nullable(),
});
const Page = z.strictObject({
  page: z.string().min(1),
  canary: z.string().regex(/^CANARY-[A-Za-z0-9-]+$/),
});
export const Manifest = z.strictObject({
  version: z.literal('heldout-v2'),
  authored_by: z.string(),
  authored_at: z.string(),
  rules: z.strictObject({
    unknown_routes: z.literal('deny'),
    merchant_selection: z.literal('hard pre-contact'),
    standing_grants: z.literal('off'),
    payments: z.literal('mock'),
    strict_plan_enforcement: z.literal('unavailable'),
  }),
  reviewer: z.strictObject({
    status: z.literal('pending'),
    name: z.null(),
    signed_at: z.null(),
    reviewed_content_sha256: z.null(),
  }),
  label_provenance: z.string(),
  catalog_sha256: z.string(),
  pages: z.record(z.string(), Page),
  cases: z.array(Entry),
});
export type Entry = z.infer<typeof Entry>;
export type Manifest = z.infer<typeof Manifest>;

function pairFacts(entry: Entry) {
  return {
    request: entry.request,
    quote: entry.quote_amount,
    mandate: { ...entry.mandate, task: '' },
    scenario: entry.scenario,
  };
}

export function verifyFrozen(raw: string, digest: string) {
  if (sha256(raw) !== digest.trim()) throw new Error('FROZEN_MANIFEST_CHANGED');
  const manifest = Manifest.parse(JSON.parse(raw));
  const ids = manifest.cases.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ID');
  const attacks = manifest.cases.filter((c) => c.kind === 'attack');
  const pageIds = Object.keys(manifest.pages);
  if (pageIds.length !== attacks.length || pageIds.some((id) => !attacks.some((c) => c.id === id)))
    throw new Error('PAGE_NOT_AN_ATTACK');
  const canaries = Object.values(manifest.pages).map((p) => p.canary);
  if (new Set(canaries).size !== canaries.length) throw new Error('DUPLICATE_CANARY');
  for (const attack of attacks) {
    const page = manifest.pages[attack.id];
    if (!page) throw new Error('MISSING_ATTACK_CANARY');
    const text = readFileSync(`demo/pages/${page.page}.txt`, 'utf8');
    if (!text.includes(page.canary)) throw new Error('PAGE_CANARY_MISSING');
  }
  for (const pair of new Set(manifest.cases.map((c) => c.pair).filter(Boolean))) {
    const rows = manifest.cases.filter((c) => c.pair === pair);
    const legit = rows.find((c) => c.kind === 'legitimate');
    const attack = rows.find((c) => c.kind === 'attack');
    if (rows.length !== 2 || !legit || !attack) throw new Error('INVALID_PAIR');
    if (
      JSON.stringify(pairFacts(legit)) !== JSON.stringify(pairFacts(attack)) ||
      legit.mandate.task === attack.mandate.task
    )
      throw new Error('UNMATCHED_PAIR');
  }
  return manifest;
}

export function loadFrozen() {
  const manifest = verifyFrozen(
    readFileSync(`${ROOT}/manifest.json`, 'utf8'),
    readFileSync(`${ROOT}/manifest.sha256`, 'utf8'),
  );
  if (sha256(readFileSync('catalog/catalog.json')) !== manifest.catalog_sha256)
    throw new Error('CATALOG_CHANGED_REQUIRES_NEW_SUITE_VERSION');
  return manifest;
}

export async function runEntry(
  entry: Entry,
  judge: JudgeModule,
  pages: Manifest['pages'],
): Promise<Result> {
  if (entry.kind === 'attack' && !pages[entry.id]?.canary) throw new Error('MISSING_ATTACK_CANARY');
  return runCase(
    {
      id: entry.id,
      author: 'heldout-v2',
      kind: entry.kind,
      judge_only: entry.pair !== null && entry.kind === 'attack',
      mandate: 'pricing',
      merchant_mode: {},
      request: entry.request,
      expected: entry.expected,
      mock_quote: { amount: entry.quote_amount },
      ...(entry.kind === 'attack' ? { canary: pages[entry.id]!.canary } : {}),
    },
    judge,
    1,
    { mandate: entry.mandate, scenario: entry.scenario },
  );
}
