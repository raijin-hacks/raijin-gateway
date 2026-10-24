import { ID_PREFIX } from '@apf/contracts';
import { decodeTime } from 'ulid';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../src/clock.js';
import { newId, type IdKind } from '../src/ids.js';

describe('systemClock', () => {
  it('reads the real time in milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('newId', () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

  it.each(Object.keys(ID_PREFIX) as IdKind[])(
    '%s ids use the contract prefix and a ULID',
    (kind) => {
      const id = newId(kind, NOW);
      expect(id.startsWith(ID_PREFIX[kind])).toBe(true);
      expect(id.slice(ID_PREFIX[kind].length)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    },
  );

  it('stamps the ULID with the given time, so ids sort by creation', () => {
    expect(decodeTime(newId('decision', NOW).slice(4))).toBe(NOW);
    expect(newId('decision', NOW) < newId('decision', NOW + 1)).toBe(true);
  });

  it('never repeats, even within one millisecond', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => newId('payment', NOW)));
    expect(ids.size).toBe(1_000);
  });
});
