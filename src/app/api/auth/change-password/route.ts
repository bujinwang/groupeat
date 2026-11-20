import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { refuseIfImpersonating } from '@/lib/auth/authorize';
import { changePassword } from '@/lib/auth/credentials';
import { getSession, setSessionCookie } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http';

/**
 * `POST /api/auth/change-password` (S1-019).
 *
 *   200 `{ redirectTo }` + refreshed `Set-Cookie` — changed, `mv` now false
 *   401 — no session
 *   403 — borrowed (impersonating) session: a merchant's credentials cannot be
 *        changed while an admin is viewing that account (FR-904).
 *   422 `{ error: 'VALIDATION', fieldErrors }` — wrong current password, too short, …
 *
 * Re-signs the session so the middleware gate opens immediately; the caller does
 * not have to log in again with the new password.
 */

const ROUTE = 'api/auth/change-password';

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: 'UNAUTHENTICATED', message: 'Please sign in again.' },
        { status: 401 },
      );
    }

    // FR-904: a borrowed (impersonating) session must not be able to change a
    // merchant's password. `session.userId` for an impersonation session is the
    // *borrowed* user's id, so without this guard an admin holding a borrowed
    // token would silently reset that merchant's credentials, and the audit row
    // would attribute the change to the merchant rather than the admin. Called
    // before the body is parsed, so an impersonating caller gets 403 (not 400)
    // and learns nothing about the request shape.
    refuseIfImpersonating(session);

    const raw: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Both the current and the new password are required.',
        },
        { status: 400 },
      );
    }

    const result = await changePassword(
      session.userId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );

    if (!result.ok) {
      const fieldErrors = result.field ? { [result.field]: result.message } : {};
      return NextResponse.json(
        { error: 'VALIDATION', message: result.message, fieldErrors },
        { status: result.status },
      );
    }

    const response = NextResponse.json({ redirectTo: result.redirectTo }, { status: 200 });
    await setSessionCookie(response, result.session);
    return response;
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
