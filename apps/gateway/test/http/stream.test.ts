import { StreamEventSchema, type StreamEvent } from '@apf/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../harness/app.js';

const EVENTS: StreamEvent[] = [
  {
    type: 'decision',
    decision_id: 'dec_1',
    mandate_id: 'mnd_1',
    stage: 'judge',
    outcome: 'denied',
    reasons: ['JUDGE_OFF_TASK'],
    price: 400_000,
    latency_ms: 1_800,
    at: 1_761_307_200_000,
  },
  { type: 'payment', payment_id: 'pay_1', state: 'SETTLED', amount: 10_000, at: 1_761_307_200_001 },
];

/** Opens /stream and returns a reader that collects the raw SSE text. */
async function openStream(h: Harness) {
  const listenersBefore = h.bus.listenerCount();
  const res = await h.admin('/stream');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const body = res.body;
  if (!body) throw new Error('No response body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // The handler subscribes asynchronously; wait until it has.
  await vi.waitFor(() => expect(h.bus.listenerCount()).toBe(listenersBefore + 1));

  return {
    listenersBefore,
    /** Reads until `done(text)` holds, failing after a second. */
    async readUntil(done: (text: string) => boolean): Promise<string> {
      const deadline = Date.now() + 1_000;
      while (!done(text)) {
        if (Date.now() > deadline) throw new Error(`Timed out; stream so far: ${text}`);
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    close: () => reader.cancel(),
  };
}

const dataLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);

describe('GET /stream', () => {
  it('sends each published event as one SSE message, in order', async () => {
    const h = createHarness();
    const stream = await openStream(h);
    for (const event of EVENTS) h.bus.publish(event);
    const text = await stream.readUntil((t) => dataLines(t).length === EVENTS.length);
    expect(dataLines(text).map((e) => StreamEventSchema.parse(e))).toEqual(EVENTS);
    // Plain messages (no `event:` name) so a browser EventSource's onmessage receives them.
    expect(text).not.toMatch(/^event:/m);
    await stream.close();
  });

  it('sends a heartbeat comment on the configured interval', async () => {
    const h = createHarness({ streamHeartbeatMs: 10 });
    const stream = await openStream(h);
    const text = await stream.readUntil((t) => t.includes(': heartbeat'));
    expect(text).toContain(': heartbeat\n\n');
    await stream.close();
  });

  it('unsubscribes when the client disconnects', async () => {
    const h = createHarness();
    const stream = await openStream(h);
    await stream.close();
    await vi.waitFor(() => expect(h.bus.listenerCount()).toBe(stream.listenersBefore));
  });
});
