import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth/authorize';
import { startImpersonation } from '@/lib/auth/impersonation';
import { setSessionCookie } from '@/lib/auth/session';
import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';

/**
 * `POST /api/admin/merchants/:id/impersonate` — FR-904.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why a route and not a server action
 *
 * The admin surface otherwise uses server actions (`(admin)/admin/actions.ts`), and
 * this is the one thing there that does not. The reason is the response: starting an
 * impersonation **replaces the session cookie**, and the client must then follow a
 * full navigation to the merchant surface so no cached server component survives with
 * the admin's identity. A route handler can set the cookie on the response and give
 * the browser a `redirectTo`; a server action would have to write the cookie through
 * `cookies()` and then rely on a client-side redirect that may race the revalidation.
 * `setSessionCookie` already exists for exactly this shape.
 *
 * ## Why the body names the merchant-user, not the merchant
 *
 * FR-904 covers **owners**, and a merchant can have several people attached to it. The
 * page lists them and the admin picks one; the route takes the `MerchantUser.id` it
 * picked and the `:id` in the path confirms which merchant that pick was made on. A
 * pick from a different merchant is refused (`NOT_IN_MERCHANT`) rather than honoured,
 * because a stale tab would otherwise mint a session for an account the admin was not
 * looking at.
 *
 * ## Why the reason is required
 *
 * The audit row is the record of *why* an admin was inside somebody's account, and a
 * row that says only "impersonated, Tuesday" cannot answer the question anyone asks
 * later. The same rule as force-fail's, for the same reason.
 */

const ROUTE = 'api/admin/merchants/[id]/impersonate';

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** `MerchantUser.id` — the link row, not the user id. */
  merchantUserId: z.string().uuid(),
  /** Required: a session with no stated reason is not auditable. */
  reason: z.string().trim().min(1).max(500),
});

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const session = await requireAdmin();

    // Already borrowing somebody's session, on a token that also carries ADMIN.
    //
    // This is not reachable through the UI — `middleware.ts` sends a `MERCHANT`
    // session to `/merchant/drops` before `/admin` — but a hand-rolled request with a
    // token minted before an admin was demoted could get here, and starting a second
    // impersonation would replace the claim of the first, orphaning its audit row: the
    // `STARTED` row would exist with no `ENDED` partner and no way to find it. Refused
    // with a sentence instead.
    if (session.impersonation) {
      throw AppError.conflict(
        'You are already viewing a merchant account. End that session before starting another.',
      );
    }

    const { id } = await context.params;

    const raw: unknown = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string' && !fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Choose an owner and say why you are viewing their account.',
          fieldErrors,
        },
        { status: 422 },
      );
    }

    // The email goes on the audit row, denormalised, so the row survives a rename.
    // Read from the row rather than carried in the token, for the reason the force-fail
    // route gives: the row is what the address *was* at the moment of the action.
    const actor = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    if (!actor) {
      throw AppError.unauthorized('Your account no longer exists. Sign in again.');
    }

    const result = await startImpersonation({
      merchantUserId: parsed.data.merchantUserId,
      expectMerchantId: id,
      reason: parsed.data.reason,
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      actor: { userId: session.userId, email: actor.email },
    });

    const response = NextResponse.json(
      {
        // The merchant landing page, not the impersonated user's `roleHome`: both are
        // `/merchant/drops` today, and pinning the literal here means the destination
        // cannot silently change if `roleHome` is ever retargeted for real merchants.
        redirectTo: '/merchant/drops',
        expiresAt: result.expiresAt.toISOString(),
        target: result.target,
        auditId: result.auditId,
      },
      { status: 200 },
    );

    // The admin's own token is replaced, not stacked. See `startImpersonation`'s
    // docblock: two cookies under one name is not a thing a browser does, and leaving
    // the admin's privileges reachable from the same browser would defeat "read-only".
    await setSessionCookie(response, result.session);

    return response;
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
