"use client";

import { useEffect, useState } from "react";
import type { StreamEvent } from "../lib/contracts";
import { startMockStream } from "../lib/mock-stream";
import { formatMoney } from "../lib/money";

const MAX_EVENTS = 500;

export default function EventFeed() {
  const [events, setEvents] = useState<StreamEvent[]>([]);

  useEffect(() => {
    const stop = startMockStream((event) => {
      // newest first, keep at most 500
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    });
    return stop; // stop the stream when the page closes
  }, []);

  return (
    <ul className="space-y-1 font-mono text-sm">
      {events.map((e, i) => (
        <li key={i} className="border-b border-gray-700 py-1">
          {new Date(e.at).toLocaleTimeString()} · {describe(e)}
        </li>
      ))}
    </ul>
  );
}

function describe(e: StreamEvent): string {
  switch (e.type) {
    case "decision":
      return `decision ${e.outcome} at ${e.stage} [${e.reasons.join(", ")}]` +
        (e.price !== null ? ` ${formatMoney(e.price)}` : "") + ` (${e.latency_ms} ms)`;
    case "payment":
      return `payment ${e.state} ${formatMoney(e.amount)}`;
    case "trust":
      return `trust: session ${e.session_trust}, agent ${e.agent_trust} (${e.cause})`;
    case "approval_needed":
      return `approval needed: ${e.explanation ?? "no explanation"}`;
  }
}