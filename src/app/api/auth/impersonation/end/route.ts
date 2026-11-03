import { NextResponse, type NextRequest } from 'next/server';

import { endImpersonation } from '@/lib/auth/impersonation';
import { clearSessionCookie, getSession, setSessionCookie } from '@/lib/auth/session';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';

/**
 * `POST /api/auth/impersonation/end` — FR-904's way out.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why this is not under `/api/admin`
 *
 * Because of whose session is live. An impersonation replaces the admin's cookie with
 * a `MERCHANT` one, and `middleware.ts` gates `/api/admin` on the **role** — so an
 * admin trying to leave through an admin route would be redirected to
 * `/merchant/drops` by their own borrowed session, unable to end it. The exit has to
 * live somewhere a `MERCHANT` session can reach.
 *
 * `/api/auth/*` is that place, and it is the honest one: ending an impersonation is a
 * session operation, not an admin operation. The authorisation is the **signed
 * claim**, not a role — `endImpersonation` refuses outright when the claim is absent,
 * so this route cannot be used by an ordinary merchant to acquire anything. All it
 * does is hand back a session for the `actorUserId` inside a token we signed.
 *
 * ## Why it re-checks the admin row rather than trusting the claim
 *
 * A signed claim cannot be forged but it can be stale: the admin may have been
 * demoted or deleted in the last half hour. `endImpersonation` looks the id up and
 * builds the restored session from the **current** row, so a demotion is honoured on
 * the way out instead of being carried back in from the token. A deleted admin gets a
 * 401 that clears the cookie, which is the correct end state: nobody is signed in.
 */

const ROUTE = 'api/auth/impersonation/end';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Read through the cookie directly rather than `requireSession`: this route must
    // work for a session that is merely present, and `requireSession`'s throw would
    // be indistinguishable from the admin-row-missing case below — which clears the
    // cookie. A missing session should not clear anything; there is nothing to clear.
    const session = await getSession();
    if (!session) {
      throw AppError.unauthorized('Please sign in again.');
    }

    const result = await endImpersonation({
      session,
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    });

    const response = NextResponse.json(
      { redirectTo: '/admin/users', auditId: result.auditId },
      { status: 200 },
    );
    await setSessionCookie(response, result.session);
    return response;
  } catch (error) {
    // A 401 here means the admin account is gone. Clearing the cookie is the only
    // useful thing left to do — an impersonation session whose owner no longer exists
    // must not stay in the browser, and a bare 401 would leave the admin staring at a
    // merchant page they cannot leave.
    const response = errorResponse(error, ROUTE);
    if (response.status === 401) {
      clearSessionCookie(response);
    }
    return response;
  }
}
