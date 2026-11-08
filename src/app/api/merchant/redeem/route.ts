import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant, requireMerchantWrite } from '@/lib/auth/authorize';
import { errorResponse } from '@/lib/http';

import { parseRedeemInput } from '@/lib/redemption/input';
import { REFUSAL_COPY, type RefusalReason } from '@/lib/redemption/rules';
import { type RedeemOutcome, redeemCode } from '@/lib/redemption/redeem';

/**
 * `POST /api/merchant/redeem` — FR-601…FR-605.
 *
 * ## Why this is a POST and not a GET on a code
 *
 * A scan **takes food off an order**. It is not safe to retry by a browser
 * prefetch, a link preview, or a shoulder-surfed URL, and a GET would make all
 * three of those possible. The code travels in the body, so it also stays out of
 * access logs and referrers — which matters because the code is a bearer token.
 *
 * ## HTTP status per outcome
 *
 * | Outcome | Status | Why |
 * |---|---|---|
 * | `REDEEMED` | 200 | It worked. |
 * | `PARTIAL` | 200 | It worked, less than asked. Not an error. |
 * | `ALREADY_REDEEMED` | 200 | FR-605: a double scan is a normal event. |
 * | `REFUSED` | 200 | The scan was **processed**; food was not handed over. |
 * | unauthenticated | 401 | No session. |
 * | no merchant scope | 404 | US-M1. |
 * | malformed body | 422 | The one thing that is a client error. |
 *
 * The refusals being 200 rather than 4xx is the decision in this file. A staff
 * member at a counter is not debugging HTTP; every 4xx that reaches a fetch call
 * becomes either a thrown exception or a branch somebody forgets, and the outcome
 * union already carries the distinction. More importantly, a refusal is not a
 * failure of the request — it is the name of the reason food was not handed over,
 * and that is the payload. The screen renders `reason` and `copy`; it does not
 * inspect `response.ok`.
 *
 * The counter-argument, that an unfetchable refusal is indistinguishable from a
 * network failure, is real and is why the body is exhaustive: `ok: false` plus a
 * `reason` and finished copy, so a screen that renders the body can always say
 * something true.
 *
 * ## Why the copy is resolved here and not in the component
 *
 * `REFUSAL_COPY` is exhaustive over `RefusalReason` by construction. Sending the
 * sentence with the reason means the screen has one thing to render and cannot
 * drift from the server's vocabulary — and the copy for `NOT_YOUR_DROP` and
 * `UNKNOWN_PARTICIPANT` is deliberately identical, which is a security property
 * that would be lost the moment a component was free to write its own.
 */

const ROUTE = 'api/merchant/redeem';

/**
 * `FULLY_REDEEMED` is a refusal in the domain and a double scan on the screen.
 *
 * FR-605 says a second scan is idempotent and shows "already redeemed at {time}".
 * `redeemCode` reports that as `ALREADY_REDEEMED` whenever it can read the row, and
 * only falls back to a refusal when the row cannot be read at all. Mapping the
 * fallback refusal onto the same neutral shape keeps the screen honest without
 * inventing a fifth outcome: the diner is told the plates are gone, not that
 * something went wrong.
 */
function bodyFor(outcome: RedeemOutcome): { status: number; body: Record<string, unknown> } {
  if (outcome.kind === 'REDEEMED' || outcome.kind === 'PARTIAL') {
    return {
      status: 200,
      body: {
        ok: true,
        outcome: outcome.kind,
        participantId: outcome.participantId,
        dropId: outcome.dropId,
        name: outcome.name,
        qty: outcome.qty,
        taken: outcome.taken,
        redeemedQty: outcome.redeemedQty,
        remaining: outcome.remaining,
        ...(outcome.kind === 'PARTIAL' ? { reason: outcome.reason } : {}),
      },
    };
  }

  if (outcome.kind === 'ALREADY_REDEEMED') {
    return {
      status: 200,
      body: {
        ok: true,
        outcome: 'ALREADY_REDEEMED',
        participantId: outcome.participantId,
        dropId: outcome.dropId,
        name: outcome.name,
        qty: outcome.qty,
        redeemedQty: outcome.redeemedQty,
        redeemedAt: outcome.redeemedAt?.toISOString() ?? null,
      },
    };
  }

  return refusedBody(outcome.reason);
}

function refusedBody(reason: RefusalReason): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      ok: false,
      outcome: 'REFUSED',
      reason,
      copy: REFUSAL_COPY[reason],
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // The one mutating merchant handler a STAFF account may reach. The write gate
    // refuses staff by default; redemption is the explicit exception.
    const { session, merchantIds } = await requireMerchantWrite({ allowStaff: true });

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseRedeemInput(raw);

    if (!parsed.ok) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Scan or type a code.',
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    // `session.userId` is the audit trail on the row (`redeemedByUserId`). A
    // merchant id is never read from the body: scope comes from the session only.
    //
    // `scanId` is passed through when the client sent one. A queued client retries
    // with the same value and gets the original answer instead of a second claim
    // (FR-606); a client that does not send it keeps the pre-existing behaviour.
    const outcome = await redeemCode({
      code: parsed.value.code,
      merchantIds,
      userId: session.userId,
      ...(parsed.value.requested === undefined ? {} : { requested: parsed.value.requested }),
      ...(parsed.value.scanId === undefined ? {} : { scanId: parsed.value.scanId }),
    });

    const { status, body } = bodyFor(outcome);

    // The refusal and the double scan are already logged inside `redeemCode`, with
    // the reason and the ids and never the code. Logged here as well would double
    // every refusal in the metric, so only the response shape is decided here.
    return NextResponse.json(body, { status });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

/**
 * `GET /api/merchant/redeem` — a health check for the scanner screen, not a
 * redemption.
 *
 * Deliberately not "redeem by query string": see the note on POST above. This
 * exists so the screen can tell a signed-in staff member from a session that has
 * expired *before* they scan nine codes, and so an expired session produces a
 * redirect rather than a red box that looks like a bad code.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();
    // No log event. This is called on every visit to the scanner screen and on
    // every session re-check, so an event here would be the loudest thing in the
    // redemption metrics and would say nothing.
    return NextResponse.json(
      {
        // `role` matters to the screen: a `STAFF` member and an `OWNER` both get in,
        // and the screen shows the same thing to both. It is returned so a future
        // manager-only action has somewhere to branch from.
        role: session.role,
        merchantIds,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
