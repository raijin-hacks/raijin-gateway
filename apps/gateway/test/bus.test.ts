import type { StreamEvent } from '@apf/contracts';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../src/bus.js';
import { createLogger } from '../src/log.js';
import { TestClock } from './harness/clock.js';

const event = (n: number): StreamEvent => ({
  type: 'payment',
  payment_id: `pay_${n}`,
  state: 'SETTLED',
  amount: n,
  at: n,
});

function setup() {
  const lines: string[] = [];
  const bus = createEventBus(
    createLogger({ write: (l) => lines.push(l) }, { clock: new TestClock() }),
  );
  return { bus, lines };
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

  it('stops delivering after unsubscribe', () => {
    const { bus } = setup();
    const seen: StreamEvent[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e));
    expect(bus.listenerCount()).toBe(1);
    unsubscribe();
    bus.publish(event(1));
    expect(seen).toEqual([]);
    expect(bus.listenerCount()).toBe(0);
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
});
