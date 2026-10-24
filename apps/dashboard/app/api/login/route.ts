import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  newSession,
  passwordConfigured,
  passwordMatches,
} from '../../../lib/session';

// POST { password } → sets the operator session cookie.
export async function POST(request: Request) {
  if (!passwordConfigured()) {
    return Response.json(
      { error: 'DASHBOARD_PASSWORD is not set in apps/dashboard/.env.local' },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const input = typeof body?.password === 'string' ? body.password : '';
  if (!passwordMatches(input)) {
    await new Promise((r) => setTimeout(r, 500)); // slow down guessing
    return Response.json({ error: 'wrong password' }, { status: 401 });
  }

  const response = Response.json({ ok: true });
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${newSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure}`,
  );
  return response;
}
