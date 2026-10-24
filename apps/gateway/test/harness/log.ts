import type { Clock } from '../../src/clock.js';
import { createLogger } from '../../src/log.js';
import { TestClock } from './clock.js';

/** A logger that keeps its lines in memory. */
export function captureLogger(opts: { clock?: Clock; secrets?: string[] } = {}) {
  const lines: string[] = [];
  const log = createLogger(
    { write: (line) => lines.push(line) },
    { clock: opts.clock ?? new TestClock(), secrets: opts.secrets },
  );
  return {
    log,
    lines,
    /** Each line parsed back into an object. */
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
