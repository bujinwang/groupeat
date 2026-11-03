import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth/authorize';
import { isStripeConfigured } from '@/lib/payments/stripe';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';
import { issueParticipantRefund } from '@/lib/refunds/participant-refund';

/**
 * `POST /api/admin/participants/:id/refund` — FR-903.
 *
 * > `FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe refund created`
 * > — PRD-v1.md:550
 *
 * ## What this route does not decide
 *
 * Every refusal that involves money is in `lib/refunds/participant-refund.ts`, so
 * there is one implementation and it is testable without HTTP. This file reads the
 * body, checks the session, resolves the port, and translates.
 *
 * ## Why `requireAdmin` and not a role check on the body
 *
 * A route handler is a public endpoint; middleware's matcher is not an
 * authorisation gate (`authorize.ts` states this, and the admin server actions
 * re-check for the same reason). The actor id is taken from the session, never from
 * the request, so the `actorId` in the log line is the person who actually asked.
 *
 * ## The port is resolved dynamically
 *
 * Same reason as `run-tick.ts`: `real-charge-port` is `server-only`, and a static
 * import would make every DB-backed refund test fail at module load. The dynamic
 * import is also where "Stripe is not configured" becomes a sentence the operator
 * can act on rather than a 500.
 */

const ROUTE = 'api/admin/participants/[id]/refund';

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /**
   * The amount to return, in integer cents. Omitted means the full order — which
   * is what an operator almost always means, and typing the exact number to do it
   * would be an opportunity to typo.
   */
  amountCents: z.number().int().positive().optional(),
  /**
   * The operator's own words. Logged, not audited — see the note in
   * `lib/refunds/participant-refund.ts`: this route predates `AuditLog` and still
   * writes no row, which is an open gap rather than a design choice.
   */
  reason: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const session = await requireAdmin();
    const { id } = await context.params;

    const raw: unknown = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Send an amount in whole cents, greater than zero.',
          fieldErrors: { amountCents: 'Enter a whole number of cents, greater than zero.' },
        },
        { status: 422 },
      );
    }

    if (!isStripeConfigured()) {
      // Not a 500: nothing is broken, the environment is incomplete. The operator
      // gets a sentence that says which knob is missing.
      logger.warn('admin.refund_refused', { actorId: session.userId, participantId: id, reason: 'stripe_not_configured' });
      return NextResponse.json(
        {
          error: 'REQUEST_FAILED',
          message: 'Stripe is not configured on this environment, so no refund can be created.',
          fieldErrors: {},
        },
        { status: 503 },
      );
    }

    // `server-only` throws outside a React server graph for a STATIC import, so the
    // real port is reached only this way. `run-tick.ts` carries the full note.
    const { realChargePort } = await import('@/lib/settlement/real-charge-port');
    const port = realChargePort();

    const result = await issueParticipantRefund({
      participantId: id,
      ...(parsed.data.amountCents === undefined ? {} : { amountCents: parsed.data.amountCents }),
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      port,
      actorId: session.userId,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
