import { StreamEventSchema, type StreamEvent } from '@apf/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../harness/app.js';
import { dataLines, openStream } from '../harness/sse.js';

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
  {
    type: 'trust',
    session_id: 'ses_1',
    agent_id: 'agt_pricing',
    session_trust: 55,
    agent_trust: 67,
    cause: 'JUDGE_OFF_TASK',
    at: 1_761_307_200_002,
  },
  { type: 'approval_needed', decision_id: 'dec_2', mandate_id: 'mnd_1', explanation: null, at: 1 },
];

describe('GET /stream', () => {
  it('sends each published event as one plain SSE message, in order', async () => {
    const h = createHarness();
    const stream = await openStream(h);
    for (const event of EVENTS) h.bus.publish(event);
    const text = await stream.readUntil((t) => dataLines(t).length === EVENTS.length);
    expect(dataLines(text).map((e) => StreamEventSchema.parse(e))).toEqual(EVENTS);
    // No `event:` names, so a browser EventSource's onmessage receives every message.
    expect(text).not.toMatch(/^event:/m);
    await stream.close();
  });

  it('does not replay events published before the client connected', async () => {
    const h = createHarness();
    h.bus.publish(EVENTS[0] as StreamEvent);
    const stream = await openStream(h);
    h.bus.publish(EVENTS[1] as StreamEvent);
    const text = await stream.readUntil((t) => dataLines(t).length >= 1);
    expect(dataLines(text)).toEqual([EVENTS[1]]);
    await stream.close();
  });

  it('sends every event to every connected client', async () => {
    const h = createHarness();
    const a = await openStream(h);
    const b = await openStream(h);
    for (const event of EVENTS) h.bus.publish(event);
    for (const stream of [a, b]) {
      const text = await stream.readUntil((t) => dataLines(t).length === EVENTS.length);
      expect(dataLines(text)).toEqual(EVENTS);
      await stream.close();
    }
  });

  it('sends a heartbeat comment on the configured interval', async () => {
    const h = createHarness({ streamHeartbeatMs: 10 });
    const stream = await openStream(h);
    const text = await stream.readUntil((t) => (t.match(/: heartbeat\n\n/g) ?? []).length >= 2);
    expect(dataLines(text)).toEqual([]);
    await stream.close();
  });

  it('unsubscribes when the client disconnects', async () => {
    const h = createHarness();
    const stream = await openStream(h);
    await stream.close();
    await vi.waitFor(() => expect(h.bus.listenerCount()).toBe(stream.listenersBefore));
  });

  it('drops connections whose write fails, logs each, and serves new connections normally', async () => {
    const h = createHarness();
    const healthy = await openStream(h);
    const broken = await openStream(h);
    const before = h.bus.listenerCount();
    // An event that cannot be serialized makes every connection's write fail...
    h.bus.publish({ ...EVENTS[1], amount: 10n } as unknown as StreamEvent);
    await vi.waitFor(() => expect(h.bus.listenerCount()).toBe(before - 2));
    expect(h.logRecords().filter((r) => r.msg === 'stream write failed')).toHaveLength(2);
    await healthy.close();
    await broken.close();
    // ...and a fresh connection afterwards works normally.
    const fresh = await openStream(h);
    h.bus.publish(EVENTS[0] as StreamEvent);
    expect(dataLines(await fresh.readUntil((t) => dataLines(t).length === 1))).toEqual([EVENTS[0]]);
    await fresh.close();
  });
});
