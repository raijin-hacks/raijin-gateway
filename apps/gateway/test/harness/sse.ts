// Reading /stream from a test: opens the connection, waits until the handler has subscribed,
// and collects the raw SSE text.
import { expect, vi } from 'vitest';
import type { Harness } from './app.js';

export async function openStream(h: Harness) {
  const listenersBefore = h.bus.listenerCount();
  const res = await h.admin('/stream');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  await vi.waitFor(() => expect(h.bus.listenerCount()).toBe(listenersBefore + 1));

  return {
    listenersBefore,
    /** Reads until `done(text)` holds, failing after a second. */
    async readUntil(done: (text: string) => boolean): Promise<string> {
      const deadline = performance.now() + 1_000;
      while (!done(text)) {
        if (performance.now() > deadline) throw new Error(`Timed out; stream so far: ${text}`);
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    close: () => reader.cancel(),
  };
}

/** The JSON payload of every `data:` line. */
export function dataLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
}
