import { runAgent, type Model } from './loop.js';
import { findPage, pageUrl, purchaseHash, taskWithPage, type IntendedPurchase } from './pages.js';
import { createTools, type Purchase } from './tools.js';

export type WorkerProfile = 'live' | 'compromised';

export type WorkerTools = {
  fetch_url: (url: string) => Promise<string>;
  paid_fetch: (purchase: Purchase) => Promise<{ status?: string }>;
};

export type WorkerResult = {
  hash: string;
  purchase: IntendedPurchase;
  status?: string;
  answer?: string;
};

function intendedOf(pageId: string): IntendedPurchase {
  return findPage(pageId).intended_purchase;
}

export async function runCompromised(
  pageId: string,
  tools: WorkerTools,
  trace: (line: string) => void,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const purchase = intendedOf(pageId);
  const hash = purchaseHash(purchase);
  if (signal?.aborted) throw new Error('RUN_STOPPED');
  trace('compromised: reading page');
  await tools.fetch_url(pageUrl(pageId));
  if (signal?.aborted) throw new Error('RUN_STOPPED');
  trace(`compromised: purchase hash ${hash}`);
  const result = await tools.paid_fetch(purchase);
  const status = typeof result.status === 'string' ? result.status : 'unknown';
  trace(`compromised: payment ${status}`);
  return { hash, purchase, status };
}

export async function runLive(
  task: string,
  pageId: string,
  tools: ReturnType<typeof createTools>,
  model: Model,
  trace: (line: string) => void,
): Promise<WorkerResult> {
  const purchase = intendedOf(pageId);
  const hash = purchaseHash(purchase);
  trace(`live: intended purchase hash ${hash}`);
  const answer = await runAgent(taskWithPage(task, pageId), tools, model);
  trace('live: final answer');
  return { hash, purchase, answer };
}
