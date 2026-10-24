import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, loginRequired, sessionValid } from './lib/session';

// Runs before every page and API route. The API routes attach ADMIN_TOKEN when they call the
// gateway, so nothing reaches them without an operator session, and no write is accepted unless
// it comes from this dashboard's own pages.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  // Writes must come from our own origin (blocks another site posting through a logged-in browser).
  if (isApi && request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin !== request.nextUrl.origin) {
      return NextResponse.json({ error: 'cross-origin request refused' }, { status: 403 });
    }
  }

  if (pathname === '/login' || pathname === '/api/login') return NextResponse.next();
  if (!loginRequired()) return NextResponse.next();
  if (sessionValid(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
