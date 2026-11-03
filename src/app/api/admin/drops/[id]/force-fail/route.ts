import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth/authorize';
import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { isStripeConfigured } from '@/lib/payments/stripe';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';
import { forceFailDrop } from '@/lib/admin/force-fail';

/**
 * `POST /api/admin/drops/:id/force-fail` — FR-902.
 *
 * > `FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry`
 * > — PRD-v1.md:549
 * > `POST   /api/admin/drops/:id/force-fail` — PRD-v1.md:883
 *
 * ## Where the double confirmation lives, and where it cannot
 *
 * The PRD asks for two confirmations. The **first** is the client's: a dialog that
 * names the drop and the total about to be refunded, dismissed by default. The
 * **second** is this route's: the body must carry the drop's `publicCode` back, and
 * `forceFailDrop` refuses a mismatch. That is the strongest form the server can
 * enforce — an HTTP client can always POST twice — but it is not decoration. It is
 * the difference between a request that names its target and one that acts on
 * whatever id a stale tab happened to hold.
 *
 * What is deliberately **not** here: an idempotency key. The PRD says all mutating
 * endpoints require one, and the second call is already a no-op — a drop in
 * `CANCELLED` returns `alreadyCancelled: true` without touching Stripe — so a key
 * would add a table this slice does not have in exchange for no behaviour. That gap
 * is real and is recorded rather than papered over.
 *
 * ## Why the actor's email is fetched, not assumed
 *
 * `forceFailDrop` writes it onto the audit row, denormalised, so the row survives the
 * user being renamed or deleted. It comes from the session, so it is the person who
 * actually pressed the button.
 *
 * ## Why the port and the notify port are resolved here
 *
 * `real-charge-port` is `server-only`, so a static import would break every
 * DB-backed test that loads this module. Same reason as the refund route.
 */

const ROUTE = 'api/admin/drops/[id]/force-fail';

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /**
   * The drop's public code, echoed from the confirmation dialog.
   *
   * Not a checksum and not a secret — it is the operator restating *which* drop, in
   * the one vocabulary both the admin list and the diner-facing link use.
   */
  confirmPublicCode: z.string().trim().min(1).max(64),
  /** Required, because a cancellation with no stated reason is not auditable. */
  reason: z.string().trim().min(1).max(500),
});

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const session = await requireAdmin();
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
          message: 'Confirm the drop and say why it is being cancelled.',
          fieldErrors,
        },
        { status: 422 },
      );
    }

    if (!isStripeConfigured()) {
      // Not a 500: the environment is incomplete, and the operator gets a sentence
      // naming the missing knob. A force-fail is mostly provider calls, so this
      // cannot proceed at all.
      logger.warn('admin.force_fail_refused', {
        actorId: session.userId,
        dropId: id,
        reason: 'stripe_not_configured',
      });
      return NextResponse.json(
        {
          error: 'REQUEST_FAILED',
          message: 'Stripe is not configured on this environment, so refunds cannot be created.',
          fieldErrors: {},
        },
        { status: 503 },
      );
    }

    // A static import of any of these would drag `server-only` into every test that
    // touches this route. `run-tick.ts` carries the full note.
    const { realChargePort } = await import('@/lib/settlement/real-charge-port');
    const { composingNotifyPort } = await import('@/lib/notify/compose-port');
    const { resolveSender } = await import('@/lib/notify/twilio-sender');

    // The email is read from the `User` row, not carried in the session.
    //
    // `SessionClaims` deliberately holds only `userId`/`role`/expiry — a session
    // token that carried an email would carry a value that can go stale the moment
    // somebody changes it, and the audit row is supposed to record the address *as it
    // was when the action happened*. Reading the row now is that moment.
    const actor = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    if (!actor) {
      // A valid token for a deleted user. `requireAdmin` cannot see this, because it
      // validates the claim and not the row.
      throw AppError.unauthorized('Your account no longer exists. Sign in again.');
    }

    const result = await forceFailDrop({
      dropId: id,
      confirmPublicCode: parsed.data.confirmPublicCode,
      reason: parsed.data.reason,
      // Behind a proxy the forwarded header is the diner's real address; the direct
      // one is the proxy's. Recorded for the audit row, never trusted for anything.
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      port: realChargePort(),
      notify: composingNotifyPort({ sender: resolveSender() }),
      actor: { userId: session.userId, email: actor.email },
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
