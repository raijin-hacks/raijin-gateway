import { connection } from 'next/server';
import { callGateway, isMock } from '../../../lib/gateway';
import { startMockStream } from '../../../lib/mock-stream';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

// Server-sent events of StreamEvent. The browser connects here, never to the gateway,
// so ADMIN_TOKEN stays on the server. MOCK=1 sends scripted fake events instead.
export async function GET(request: Request) {
  await connection(); // always run at request time, never prerender

  if (isMock()) return mockStream(request.signal);

  const upstream = await callGateway('/stream', {
    headers: { Accept: 'text/event-stream' },
    signal: request.signal, // close the gateway connection when the browser leaves
  });

  if (!upstream.ok || !upstream.body) {
    return new Response('Gateway stream unavailable', { status: 502 });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

function mockStream(signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = startMockStream((event) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });
      signal.addEventListener('abort', () => {
        stop();
        if (closed) return; // the browser already cancelled the stream
        closed = true;
        controller.close();
      });
    },
    cancel() {
      closed = true;
      stop();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
