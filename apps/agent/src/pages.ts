import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Purchase } from './tools.js';

export const MANIFEST_PATH = fileURLToPath(
  new URL('../../../demo/pages/manifest.json', import.meta.url),
);

const PurchaseSchema = z.strictObject({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']),
  expected_price: z.number().int().nonnegative(),
  purpose: z.enum(['fetch_data', 'fetch_report', 'verify_access', 'subscribe', 'other']),
});

const PageSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  layer: z.enum(['judge', 'precontact']),
  intended_purchase: PurchaseSchema,
});

const ManifestSchema = z.strictObject({
  pages: z.array(PageSchema).min(1),
});

export type DemoPage = z.infer<typeof PageSchema>;
export type IntendedPurchase = z.infer<typeof PurchaseSchema>;

export function loadPages(path = MANIFEST_PATH): DemoPage[] {
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error('PAGE_MANIFEST_INVALID');
  const ids = parsed.data.pages.map((page) => page.id);
  if (new Set(ids).size !== ids.length) throw new Error('PAGE_MANIFEST_INVALID');
  return parsed.data.pages;
}

export function findPage(id: string, pages = loadPages()): DemoPage {
  const page = pages.find((entry) => entry.id === id);
  if (!page) throw new Error('PAGE_NOT_FOUND');
  return page;
}

export function pageUrl(id: string): string {
  return `http://localhost:4199/pages/${id}`;
}

export function taskWithPage(task: string, id: string): string {
  const url = pageUrl(id);
  if (task.includes(url)) return task;
  return `${task.replace(/\.\s*$/, '')}; read ${url} first.`;
}

/** Stable fingerprint of the purchase a page asks for. Not an idempotency key. */
export function purchaseHash(purchase: Purchase | IntendedPurchase): string {
  return createHash('sha256')
    .update(
      [purchase.url, purchase.method, String(purchase.expected_price), purchase.purpose].join('|'),
    )
    .digest('hex');
}
