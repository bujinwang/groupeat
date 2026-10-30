import { NextResponse, type NextRequest } from 'next/server';

import {
  SESSION_COOKIE,
  SESSION_SLIDING_MINUTES,
  needsRefresh,
  roleHome,
  signSession,
  verifySession,
} from '@/lib/auth/jwt';
import type { SessionClaims, SessionRole } from '@/lib/auth/jwt';

/**
 * The optimistic gate (ARCHITECTURE-sprint1 P-4).
 *
 * Runs on the Edge runtime, so it may only use `jose` and the session payload —
 * no Prisma, no bcrypt. It answers one question per request: "should this caller
 * be allowed to *reach* this route?" It is a convenience and a redirect, **not
 * the authorisation gate**: every route handler and layout re-checks with
 * `requireRole()`. If this file were deleted, the app would be slower to reject
 * but not less secure.
 *
 * Responsibilities, in order:
 *   1. verify the cookie (signature, expiry, absolute cap);
 *   2. send an unauthenticated caller to `/login` (or a 401 for `/api/*`);
 *   3. hold a `mustChangePassword` user on `/change-password` and nowhere else
 *      (S1-019);
 *   4. gate `/merchant`, `/admin`, `/organiser` by role;
 *   5. slide the session forward when it is inside the refresh window.
 */

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/me', '/api/auth/logout'];

/** Reachable while `mustChangePassword` is set — everything else is not. */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = [
  '/change-password',
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
];

const ROLE_GATES: readonly { prefix: string; role: SessionRole }[] = [
  { prefix: '/merchant', role: 'MERCHANT' },
  { prefix: '/api/merchant', role: 'MERCHANT' },
  { prefix: '/admin', role: 'ADMIN' },
  { prefix: '/api/admin', role: 'ADMIN' },
  { prefix: '/organiser', role: 'ORGANISER' },
  { prefix: '/api/organiser', role: 'ORGANISER' },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isApi(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

function deny(request: NextRequest, status: 401 | 403, code: string, message: string): NextResponse {
  if (isApi(request.nextUrl.pathname)) {
    return NextResponse.json({ error: code, message }, { status });
  }
  const target = status === 401 ? '/login' : '/change-password';
  const url = new URL(target, request.url);
  if (status === 401) {
    url.searchParams.set('next', request.nextUrl.pathname);
  }
  return NextResponse.redirect(url, 307);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session: SessionClaims | null = token ? await verifySession(token) : null;

  // ---- 1. no session -------------------------------------------------------
  if (!session) {
    if (PUBLIC_PATHS.includes(pathname)) {
      return NextResponse.next();
    }
    return deny(request, 401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  }

  // ---- 2. already signed in, on the login page -----------------------------
  if (pathname === '/login') {
    return NextResponse.redirect(
      new URL(session.mustChangePassword ? '/change-password' : roleHome(session.role), request.url),
      307,
    );
  }

  // ---- 3. forced password change ------------------------------------------
  if (session.mustChangePassword && !ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.includes(pathname)) {
    return deny(
      request,
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'Change your password before continuing.',
    );
  }

  // ---- 4. role gate --------------------------------------------------------
  const gate = ROLE_GATES.find((entry) => matchesPrefix(pathname, entry.prefix));
  if (gate && session.role !== gate.role) {
    if (isApi(pathname)) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'You do not have access to this resource.' },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL(roleHome(session.role), request.url), 307);
  }

  // ---- 5. sliding refresh --------------------------------------------------
  const response = NextResponse.next();
  if (needsRefresh(session)) {
    const refreshed = await signSession(session);
    response.cookies.set({
      name: SESSION_COOKIE,
      value: refreshed,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_SLIDING_MINUTES * 60,
    });
  }
  return response;
}

export const config = {
  // Everything except Next's own assets and static files.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|woff|woff2)$).*)',
  ],
};
