// Shared request and response helpers for the routes.
import type { Context } from 'hono';
import type { z } from 'zod';

export interface Issue {
  path: string;
  message: string;
}

export function badRequest(c: Context, issues: Issue[]): Response {
  return c.json({ error: 'bad_request', issues }, 400);
}

export function notFound(c: Context): Response {
  return c.json({ error: 'not_found' }, 404);
}

/** Parses the JSON body against `schema`. Anything malformed becomes a 400 response. */
export async function readJson<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: badRequest(c, [{ path: '', message: 'Body is not valid JSON' }]),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return { ok: false, response: badRequest(c, issues) };
  }
  return { ok: true, value: parsed.data };
}
