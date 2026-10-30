import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth/session';

/**
 * `GET /api/auth/me` — who the caller is, according to the signed cookie.
 *
 * Allowed while `mustChangePassword` is set: the client needs to know why it is
 * being held on the change-password screen.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: 'UNAUTHENTICATED', message: 'Please sign in to continue.' },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      userId: session.userId,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
      absoluteExpiresAt: new Date(session.absoluteExpiresAt * 1000).toISOString(),
    },
    { status: 200 },
  );
}
