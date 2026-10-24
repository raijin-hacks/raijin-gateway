import { SESSION_COOKIE } from '../../../lib/session';

// POST → clears the operator session cookie.
export async function POST() {
  const response = Response.json({ ok: true });
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
  return response;
}
