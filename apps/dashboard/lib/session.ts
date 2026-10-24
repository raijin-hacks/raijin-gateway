// Operator sessions for the dashboard. One shared operator password (DASHBOARD_PASSWORD); a signed
// cookie proves the browser entered it. This authenticates "the dashboard operator", not a named
// person, and it is not a signature over what they approve.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'apf_operator';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

function password(): string | null {
  const p = process.env.DASHBOARD_PASSWORD;
  return p && p.length > 0 ? p : null;
}

// MOCK=1 never sends ADMIN_TOKEN anywhere, so it may run without a password.
export function loginRequired(): boolean {
  return process.env.MOCK !== '1' || password() !== null;
}

export function passwordConfigured(): boolean {
  return password() !== null;
}

// Compares digests so the check takes the same time whatever the input.
export function passwordMatches(input: string): boolean {
  const p = password();
  if (!p) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(p).digest();
  return timingSafeEqual(a, b);
}

// Keyed by the password, so changing it signs every existing session out.
function sign(payload: string): string {
  return createHmac('sha256', `apf-dashboard-session:${password() ?? ''}`)
    .update(payload)
    .digest('base64url');
}

// "<expiry ms>.<signature>"
export function newSession(now = Date.now()): string {
  const expires = String(now + SESSION_MAX_AGE_S * 1000);
  return `${expires}.${sign(expires)}`;
}

export function sessionValid(value: string | undefined, now = Date.now()): boolean {
  if (!value || !password()) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) <= now) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
