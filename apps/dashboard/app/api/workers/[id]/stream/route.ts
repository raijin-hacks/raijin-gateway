import { connection } from 'next/server';
import { callLab, isMock, labUnavailable } from '../../../../../lib/lab';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (isMock()) return labUnavailable();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: 'unknown run' }, { status: 404 });
  const upstream = await callLab(`/runs/${id}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: request.signal,
  });
  if (!upstream.ok || !upstream.body) {
    return new Response('Agent lab stream unavailable', { status: upstream.status || 502 });
  }
  return new Response(upstream.body, { headers: SSE_HEADERS });
}
