import type { Clock } from '../../src/clock.js';

/** A clock that only moves when a test moves it. Starts at a fixed instant so runs repeat. */
export class TestClock implements Clock {
  constructor(private current = Date.UTC(2026, 9, 24, 12, 0, 0)) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
