import { connection } from "next/server";
import { startMockStream } from "../../../lib/mock-stream";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:4000";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

// Server-sent events of StreamEvent. The browser connects here, never to the gateway,
// so ADMIN_TOKEN stays on the server. MOCK=1 sends scripted fake events instead.
export async function GET(request: Request) {
  await connection(); // always run at request time, never prerender

  if (process.env.MOCK === "1") return mockStream(request.signal);

  const upstream = await fetch(`${GATEWAY_URL}/stream`, {
    headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, Accept: "text/event-stream" },
    signal: request.signal, // close the gateway connection when the browser leaves
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response("Gateway stream unavailable", { status: 502 });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

function mockStream(signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let stop = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = startMockStream((event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });
      signal.addEventListener("abort", () => {
        stop();
        try { controller.close(); } catch {} // already closed
      });
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
