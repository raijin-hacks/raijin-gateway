import type { StreamEvent } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../src/bus.js';
import { captureLogger } from './harness/log.js';

const event = (n: number): StreamEvent => ({
  type: 'payment',
  payment_id: `pay_${n}`,
  state: 'SETTLED',
  amount: n,
  at: n,
});

function setup() {
  const { log, lines } = captureLogger();
  return { bus: createEventBus(log), lines };
}

describe('createEventBus', () => {
  it('delivers every event to every subscriber, in order', () => {
    const { bus } = setup();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.publish(event(1));
    bus.publish(event(2));
    expect(a).toEqual([event(1), event(2)]);
    expect(b).toEqual(a);
  });

  it('publishes to nobody without error', () => {
    expect(() => setup().bus.publish(event(1))).not.toThrow();
  });

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
    const { bus } = setup();
    const seen: StreamEvent[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e));
    expect(bus.listenerCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    bus.publish(event(1));
    expect(seen).toEqual([]);
    expect(bus.listenerCount()).toBe(0);
  });

  it('delivers once to a listener subscribed twice', () => {
    const { bus } = setup();
    const seen: StreamEvent[] = [];
    const listener = (e: StreamEvent) => seen.push(e);
    bus.subscribe(listener);
    bus.subscribe(listener);
    bus.publish(event(1));
    expect(seen).toHaveLength(1);
  });

  it('keeps delivering to others when one subscriber throws, and logs it', () => {
    const { bus, lines } = setup();
    const seen: StreamEvent[] = [];
    bus.subscribe(() => {
      throw new Error('dashboard went away');
    });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.publish(event(1))).not.toThrow();
    expect(seen).toEqual([event(1)]);
    expect(lines.join('\n')).toContain('dashboard went away');
  });

  it('lets a subscriber unsubscribe while an event is being delivered', () => {
    const { bus } = setup();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe(() => {
      seen.push('first');
      unsubscribe();
    });
    bus.subscribe(() => seen.push('second'));
    bus.publish(event(1));
    bus.publish(event(2));
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  it('does not deliver the current event to a subscriber added during delivery', () => {
    const { bus } = setup();
    const late: StreamEvent[] = [];
    bus.subscribe(() => {
      if (bus.listenerCount() === 1) bus.subscribe((e) => late.push(e));
    });
    bus.publish(event(1));
    bus.publish(event(2));
    expect(late).toEqual([event(2)]);
  });
});
