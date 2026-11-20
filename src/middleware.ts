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

const PUBLIC_PATHS = [
  '/login',
  '/set-password',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/logout',
];

/**
 * Prefixes anyone may reach, signed in or not.
 *
 * `/d/*` is the deal page and its `opengraph-image`. PRD-v1 §3.2 makes "no
 * account" a hard requirement for a diner, so gating this route would gate the
 * entire distribution model — the whole product reaches people by a stranger
 * tapping a link in a group chat. The credential is the `publicCode` in the path,
 * which is generated from `node:crypto` and filtered by status in
 * `lib/public/public-drops.ts`.
 *
 * `/api/public/*` is that same surface's counter. It returns five numbers and a
 * sentence, never a participant.
 *
 * `/api/jobs/cutoff` is the settlement scheduler's entry point, and it is here for
 * a reason that is not about being public at all: **the scheduler has no session.**
 * A platform cron invocation carries `Authorization: Bearer $CRON_SECRET` and no
 * cookie, so this file would answer `401 UNAUTHENTICATED` on the way in — before
 * `route.ts`'s constant-time bearer check ever ran. The route would look correct,
 * its tests would pass (they call the handler directly, past the middleware), and
 * in production no drop would ever settle. The symptom would be a diner whose card
 * was authorised a week ago and never charged.
 *
 * So the gate moves to the route, which is the right place for it: the route's
 * `CRON_SECRET` check is a real authorisation decision on a real credential, and
 * it **refuses** with `503` when the secret is unset rather than falling open.
 * Nothing is exposed by skipping this file that the route does not itself refuse.
 * `PUBLIC_PREFIXES` is a list of paths whose *own* check is sufficient; it is not
 * a list of paths with no check.
 *
 * The entry is the **exact** route, not the `/api/jobs` prefix. A prefix would
 * mean that the next job route somebody adds inherits "reachable without a
 * session" from this line, silently, and the failure mode of that is a public
 * endpoint that moves money. With the exact path, the next job route fails closed
 * with a `401` in its first test, which is the right direction to be wrong in.
 *
 * Note the prefix match is segment-aware (`/d` or `/d/…`), so a future `/dashboard`
 * would not be swept in.
 */
const PUBLIC_PREFIXES = ['/d', '/api/public', '/api/jobs/cutoff'];

/** Reachable while `mustChangePassword` is set — everything else is not. */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = [
  '/change-password',
  '/set-password',
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
    if (
      PUBLIC_PATHS.includes(pathname) ||
      PUBLIC_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
    ) {
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

  // ---- 3a. a borrowed session may not reach the admin surface --------------
  //
  // FR-904's read-only guarantee is enforced where it belongs — `authorize.ts`
  // refuses every merchant write, and a test walks every mutating merchant handler
  // to prove it. This rule answers a different question: can a borrowed session
  // reach the *admin* surface at all?
  //
  // Today it cannot, because an impersonation session's role is `MERCHANT` and the
  // role gate below sends it to `/merchant/drops`. That is an accident of the role
  // being right, not a statement of intent — and a token carrying both `ADMIN` and
  // `imp` would pass the gate and let the impersonating admin act with full
  // privileges from inside the merchant's identity, which is precisely what
  // "read-only" exists to prevent. So the intent is written down here as well.
  //
  // `/api/auth/impersonation/end` is *not* affected: it lives under `/api/auth`,
  // which this does not cover, so the exit is always reachable. That is the whole
  // reason the exit is not an `/api/admin` route.
  if (session.impersonation && (matchesPrefix(pathname, '/admin') || matchesPrefix(pathname, '/api/admin'))) {
    if (isApi(pathname)) {
      return NextResponse.json(
        {
          error: 'IMPERSONATING',
          message: 'End the impersonation session before using the admin surface.',
        },
        { status: 403 },
      );
    }
    // Not `deny()`: its non-API 403 target is `/change-password`, which is where a
    // forced password change belongs and nowhere near what this is. A page request
    // inside a borrowed session is sent to the surface the session can actually use.
    return NextResponse.redirect(new URL('/merchant/drops', request.url), 307);
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
