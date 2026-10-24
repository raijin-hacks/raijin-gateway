// Chunk 2-owned. Bound judge renewal concurrency for the supported single-process host.
// Durable per-purchase claims still prevent duplicate signatures across SQLite workers.
import type { Db } from '../db/client.js';
const queues = new WeakMap<Db, Map<string, Promise<void>>>();
export async function withRenewal<T>(db: Db, scope: string, work: () => Promise<T>): Promise<T> {
  let queue = queues.get(db);
  if (!queue) {
    queue = new Map();
    queues.set(db, queue);
  }
  const previous = queue.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(scope, turn);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queue.get(scope) === turn) queue.delete(scope);
  }
}
