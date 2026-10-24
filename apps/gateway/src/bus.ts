// In-process fan-out of StreamEvents to /stream connections.
import type { StreamEvent } from '@apf/contracts';
import type { Logger } from './log.js';

export type StreamListener = (event: StreamEvent) => void;

export interface EventBus {
  publish(event: StreamEvent): void;
  /** Returns the function that unsubscribes. */
  subscribe(listener: StreamListener): () => void;
  listenerCount(): number;
}

export function createEventBus(log: Logger): EventBus {
  const listeners = new Set<StreamListener>();
  return {
    publish(event) {
      for (const listener of [...listeners]) {
        // The payment path publishes; a broken dashboard connection must never fail it.
        try {
          listener(event);
        } catch (error) {
          log.warn('stream subscriber failed', { error });
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}
