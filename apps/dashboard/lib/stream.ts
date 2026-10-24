import type { StreamEvent } from "./contracts";

// One EventSource for the whole page, shared by every component that subscribes.
type Listener = (events: StreamEvent[]) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
// Collect events and deliver them in batches, so a burst doesn't re-render per event.
// A timer, not requestAnimationFrame, so a hidden tab keeps up instead of buffering forever.
const FLUSH_MS = 50;
let buffer: StreamEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const batch = buffer;
  buffer = [];
  for (const listener of listeners) listener(batch);
}

// Calls `listener` with each batch of events, oldest first. Returns a function that unsubscribes.
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) {
    // Our own route; it proxies the gateway or sends mock events when MOCK=1
    source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      buffer.push(JSON.parse(message.data));
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    };
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) { // close the stream when nothing is listening
      source.close();
      source = null;
      if (timer) clearTimeout(timer);
      timer = null;
      buffer = [];
    }
  };
}
