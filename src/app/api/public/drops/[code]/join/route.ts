import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse } from '@/lib/http';
import { parseJoinInput } from '@/lib/join/input';
import { JOIN_REFUSAL_COPY, type JoinRefusalReason } from '@/lib/join/rules';
import { joinDrop, type JoinResult } from '@/lib/join/service';
import { logger } from '@/lib/logging/logger';

/**
 * `POST /api/public/drops/[code]/join` — FR-401…FR-407.
 *
 * ## Why this endpoint is public, and what guards it
 *
 * A diner has no account (PRD-v1 §6.4): the drop's `publicCode` is the credential,
 * and requiring a login to order food from a group chat would kill the product. So
 * the guards are not authentication, they are:
 *
 *   - the `publicCode`, a bearer token generated from `node:crypto`;
 *   - `DRAFT` invisibility, so a guessed code reveals nothing;
 *   - the drop's own state machine (`drop-view.ts`), which refuses a closed,
 *     failed or full drop for everyone equally;
 *   - the server-side quantity cap (`MAX_JOIN_QTY`), so a tampered body cannot
 *     authorise an unbounded amount;
 *   - and the payment provider, which is the real gate on a card.
 *
 * ## Why a refusal carries finished copy
 *
 * Same reasoning as `/api/merchant/redeem`: `JOIN_REFUSAL_COPY` is exhaustive over
 * `JoinRefusalReason` by construction, so sending the sentence with the reason means
 * the component renders one thing and cannot drift from the server's vocabulary.
 * Two of the reasons (`NOT_FOUND`, and the identical treatment of a draft) are
 * security properties that a component writing its own copy would lose.
 *
 * ## Status codes
 *
 * | Outcome | Status |
 * |---|---|
 * | joined, or already joined | 200 |
 * | malformed body / bad phone / over the per-person cap | 422 |
 * | card declined | 402 |
 * | sold out / closed / failed / not enough left | 409 |
 * | unknown code, or a draft | 404 |
 * | pricing data unusable, or the row could not be recorded | 500 |
 * | payments not configured, or the provider unreachable | 503 |
 *
 * 402 for a decline is the one unusual choice and it is the correct one: `402
 * Payment Required` means the request was well formed and the payment failed, which
 * is exactly what happened. It also gives the join page a status it can branch on
 * without parsing the body.
 *
 * ## The flag
 *
 * `JOIN_FLOW_PROVEN_LIVE` in `src/app/d/[publicCode]/page.tsx` is still `false`, so
 * the deal page does not offer the button. The page it would link to
 * (`/d/[publicCode]/join`) now exists and is tested as of slice 2b, so what remains
 * is not code: it is one live run against Stripe. Until a card has actually been
 * held, the button stays disabled — "the page exists" and "a card can be held" are
 * different claims, and only the first is true here.
 */

const ROUTE = 'api/public/drops/join';

/** A refusal's status is chosen by the service; this maps it to the body. */
function refusalBody(result: Extract<JoinResult, { ok: false }>): {
  error: 'JOIN_REFUSED';
  reason: JoinRefusalReason;
  copy: { title: string; detail: string };
  /** Present so a form can highlight the field without parsing prose. */
  fieldErrors?: Record<string, string>;
} {
  const copy = JOIN_REFUSAL_COPY[result.reason];
  const fieldErrors: Record<string, string> | undefined =
    result.reason === 'BAD_QTY'
      ? { qty: copy.detail }
      : result.reason === 'BAD_PHONE'
        ? { phone: copy.detail }
        : undefined;

  return {
    error: 'JOIN_REFUSED',
    reason: result.reason,
    copy,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  try {
    // A body that will not parse is the only thing here that is unambiguously a
    // client error, and it is refused before any database work.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'JOIN_REFUSED', reason: 'BAD_QTY', copy: JOIN_REFUSAL_COPY.BAD_QTY },
        { status: 422 },
      );
    }

    const parsed = parseJoinInput(raw);
    if (!parsed.ok) {
      // The schema's own message is better than the domain copy for a shape error,
      // because it names the field the diner mistyped.
      const firstField = Object.keys(parsed.fieldErrors)[0];
      const reason: JoinRefusalReason = firstField === 'phone' ? 'BAD_PHONE' : 'BAD_QTY';
      return NextResponse.json(
        {
          error: 'JOIN_REFUSED',
          reason,
          copy: JOIN_REFUSAL_COPY[reason],
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    /**
     * The real port, resolved lazily.
     *
     * A static import of the Stripe-backed port would put the SDK in this route's
     * module graph even when no key is configured, and would make the route
     * untestable without it. The dynamic import is the seam: absent a key, the
     * route answers 503 with a sentence instead of throwing inside the SDK.
     *
     * Slice 2a ships the fake-backed path only. `real-payment-port.ts` lands with
     * the keys (slice 2b), and this branch is where it gets wired — which is why the
     * refusal is explicit rather than a silent fallthrough to a fake. A fake in
     * production would take a join and hold nothing.
     */
    const { isStripeConfigured } = await import('@/lib/payments/stripe');
    if (!isStripeConfigured()) {
      logger.info('join.refused', { reason: 'PAYMENTS_NOT_CONFIGURED' });
      return NextResponse.json(
        {
          error: 'JOIN_REFUSED',
          reason: 'PAYMENTS_NOT_CONFIGURED' satisfies JoinRefusalReason,
          copy: JOIN_REFUSAL_COPY.PAYMENTS_NOT_CONFIGURED,
        },
        { status: 503 },
      );
    }

    const { createJoinPaymentPort } = await import('@/lib/join/real-payment-port');
    const paymentPort = await createJoinPaymentPort();

    const result = await joinDrop(
      {
        publicCode: code,
        phone: parsed.value.phone,
        qty: parsed.value.qty,
        ...(parsed.value.name ? { name: parsed.value.name } : {}),
        ...(parsed.value.consented === undefined ? {} : { consented: parsed.value.consented }),
        // The card, as an id. Passing this through is what makes a real join
        // possible at all: the port refuses an authorisation with no
        // `paymentMethodId`, and until slice 2b nothing on the wire carried one.
        ...(parsed.value.paymentMethodId ? { paymentMethodId: parsed.value.paymentMethodId } : {}),
        // Behind a proxy this must be a trusted header; the same caveat as
        // `auth/rate-limit.ts`. Recorded on the consent row only, never logged.
        ...(request.headers.get('x-forwarded-for')
          ? { ipAddress: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
          : {}),
      },
      { paymentPort },
    );

    if (!result.ok) {
      return NextResponse.json(refusalBody(result), { status: result.status });
    }

    return NextResponse.json(
      {
        ok: true,
        participantId: result.participantId,
        qty: result.qty,
        amountCents: result.amountCents,
        amountLabel: result.amountLabel,
        phoneLast4: result.phoneLast4,
        status: result.status,
        alreadyJoined: result.alreadyJoined,
        minQty: result.minQty,
        maxQty: result.maxQty,
        cutoffAt: result.cutoffAt.toISOString(),
        windowStart: result.windowStart.toISOString(),
        windowEnd: result.windowEnd.toISOString(),
        isConfirmedAlready: result.isConfirmedAlready,
      },
      {
        status: 200,
        // A hold is not cacheable, and neither is a quantity that just changed.
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
