import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireMerchantWrite } from '@/lib/auth/authorize';
import { prisma } from '@/lib/db/prisma';
import { cancelDrop } from '@/lib/drops/cancel';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';

/**
 * `POST /api/merchant/drops/:id/cancel` — FR-208.
 *
 * > `FR-208 | Merchant can cancel a PUBLISHED drop | All auths voided; participants
 * >  notified. Reason required` — PRD-v1.md:461
 * > `POST   /api/merchant/drops/:id/cancel` — PRD-v1.md:863
 *
 * ## `requireMerchantWrite`, not `requireMerchant`
 *
 * This route mutates, so FR-904's gate applies: an admin viewing the account
 * read-only must not be able to call off a merchant's drop. That is not a formality —
 * cancellation is irreversible and it messages every diner, so it is the single worst
 * thing a borrowed session could do. Using the read gate here would have made the
 * impersonation banner a suggestion.
 *
 * ## Why the body carries the public code as well as the id
 *
 * Same reasoning as FR-902's `confirmPublicCode`, and the reason is worth restating
 * because it is the only server-side confirmation available: an HTTP client can
 * always POST twice, so the server cannot count presses. What it *can* do is require
 * the caller to restate which drop it means, in the vocabulary the merchant actually
 * reads on the page. A stale tab holding a different drop's id then fails instead of
 * cancelling the wrong one.
 *
 * The `id` in the path is already scoped to the caller's merchants by `cancelDrop`, so
 * this is not an authorisation check — it is a target-confirmation check, and both
 * have to pass.
 *
 * ## Why there is no `isStripeConfigured` pre-check, unlike FR-902
 *
 * A force-fail cannot proceed at all without Stripe: it exists to create refunds. A
 * cancellation mostly *releases* holds, and there are legitimate drops to cancel with
 * no Stripe account attached (a merchant who published before completing onboarding —
 * the publish gate refuses that, but a data fix can produce it). If the account is
 * missing there is nothing to void and the sweep reports zero; if Stripe is simply
 * unconfigured, `realChargePort()` throws `StripeNotConfiguredError` from inside the
 * service and the merchant gets a 503 naming the knob. Letting it surface from there
 * keeps one refusal path instead of two that can disagree.
 */

const ROUTE = 'api/merchant/drops/[id]/cancel';

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /**
   * The drop's public code, echoed from the confirmation field on the page.
   *
   * Not a secret and not a checksum — it is the merchant restating *which* drop, in
   * the same vocabulary as the `/d/:code` link they have been sharing.
   */
  confirmPublicCode: z.string().trim().min(1).max(64),
  /**
   * FR-208's "reason required".
   *
   * Required, and required again in `cancelDropRefusal`. This one produces a clean 422
   * with a field error; that one is the authority and protects other callers. Capped at
   * 500 like every other free-text operator note in the build, because the audit row's
   * `detail` is not a place to paste a thread.
   */
  reason: z.string().trim().min(1).max(500),
});

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchantWrite();
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
          message: 'Type the drop code and say why it is being called off.',
          fieldErrors,
        },
        { status: 422 },
      );
    }

    // A static import of either would drag `server-only` into every test that touches
    // this route; `run-tick.ts` carries the full note.
    const { realChargePort } = await import('@/lib/settlement/real-charge-port');
    const { composingNotifyPort } = await import('@/lib/notify/compose-port');
    const { resolveSender } = await import('@/lib/notify/twilio-sender');

    // The audit row records the actor's email *as it was when they acted*, so it is
    // read from the row now rather than carried in the session — `SessionClaims` holds
    // no email for exactly this reason (see the force-fail route).
    const actor = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    if (!actor) {
      // A valid token for a deleted user. `requireMerchantWrite` validates the claim,
      // not the row, so it cannot see this.
      throw AppError.unauthorized('Your account no longer exists. Sign in again.');
    }

    const result = await cancelDrop({
      merchantIds,
      dropId: id,
      confirmPublicCode: parsed.data.confirmPublicCode,
      reason: parsed.data.reason,
      // Behind a proxy the forwarded header is the diner's real address; the direct one
      // is the proxy's. Recorded on the audit row, never trusted for anything.
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      port: realChargePort(),
      notify: composingNotifyPort({ sender: resolveSender() }),
      actor: { userId: session.userId, email: actor.email },
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // `StripeNotConfiguredError` is not an `AppError`, so `errorResponse` maps it to a
    // 500. That is the honest status for a misconfigured environment, and the refusal
    // is logged here so the operator can see which drop was affected.
    logger.warn('drops.cancel_failed', {
      route: ROUTE,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return errorResponse(error, ROUTE);
  }
}
