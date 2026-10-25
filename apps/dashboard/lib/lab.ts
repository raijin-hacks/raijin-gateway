// Server only: the browser talks to /api/workers, never to the agent lab.
// Never import this from a 'use client' file.

const LAB_URL = process.env.AGENT_LAB_URL ?? 'http://127.0.0.1:4010';

export function isMock(): boolean {
  return process.env.MOCK === '1';
}

export function labUnavailable(): Response {
  return Response.json({ error: 'lab needs a live runner' }, { status: 503 });
}

export async function callLab(path: string, init: RequestInit = {}): Promise<Response> {
  if (isMock()) return labUnavailable();
  const upstream = await fetch(`${LAB_URL}${path}`, {
    ...init,
    redirect: 'error',
  }).catch(() => null);
  if (!upstream) return Response.json({ error: 'agent lab unavailable' }, { status: 502 });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': upstream.headers.get('Cache-Control') ?? 'no-cache',
    },
  });
}
