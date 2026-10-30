import { NextResponse } from 'next/server';

import { clearSessionCookie } from '@/lib/auth/session';

/**
 * `POST /api/auth/logout` — clears the cookie and returns 204.
 *
 * Idempotent on purpose: signing out twice, or with no cookie, is not an error.
 * The token itself is not revoked (there is no server-side session store in
 * Sprint 1); the absolute cap and the 60-minute window bound a stolen token.
 */
export async function POST(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  clearSessionCookie(response);
  return response;
}
