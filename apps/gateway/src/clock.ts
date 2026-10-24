/** The gateway's only source of time. Code takes a Clock; tests pass one they control. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
