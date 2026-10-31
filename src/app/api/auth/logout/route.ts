import { NextResponse } from 'next/server';

import { clearSessionCookie } from '@/lib/auth/session';

/**
 * `POST /api/auth/logout` — clears the cookie and returns 204.
 *
 * Idempotent on purpose: signing out twice, or with no cookie, is not an error.
 *
 * ⚠️ **This does not revoke anything server-side.** The JWT is stateless, so a
 * copy of the token stays valid until its own `exp` (at most 60 minutes) or the
 * 7-day absolute cap, whichever comes first — clearing the cookie only stops
 * *this* browser from sending it. Accepted for Sprint 1 (there is no session
 * store), and it is the same trade-off as the in-memory rate limiter: both need
 * a durable, shared store before M9. Do not describe logout as revocation.
 */
export async function POST(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  clearSessionCookie(response);
  return response;
}
