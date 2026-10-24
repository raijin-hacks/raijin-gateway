// Server only: route handlers call the gateway through here, so ADMIN_TOKEN never reaches the browser.
// Never import this from a 'use client' file.

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:4000';

// MOCK=1 makes every route answer with fixed data instead of calling the gateway.
export function isMock(): boolean {
  return process.env.MOCK === '1';
}

// Calls the gateway as admin and passes its status and body back unchanged.
// A gateway that can't be reached becomes a 502.
export async function callGateway(path: string, init: RequestInit = {}): Promise<Response> {
  const upstream = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  }).catch(() => null);

  if (!upstream) return Response.json({ error: 'gateway unavailable' }, { status: 502 });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
  });
}

// POSTs a JSON body to the gateway.
export function postToGateway(path: string, body: unknown): Promise<Response> {
  return callGateway(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
