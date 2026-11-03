import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse } from '@/lib/http';
import { parseJoinInput } from '@/lib/join/input';
import { JOIN_REFUSAL_COPY, type JoinRefusalReason } from '@/lib/join/rules';
import { joinDrop, type JoinResult } from '@/lib/join/service';
import type { JoinSuccessBody } from '@/lib/join/wire';
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

    /**
     * The notification seam, resolved lazily for the same reason as the payment port:
     * a static import of the Twilio module would put it in this route's graph on a
     * deployment with no credentials, and would make the route untestable without it.
     *
     * `resolveSender()` answers `loggingSender()` when nothing is configured, which
     * logs `{ kind, count }` and delivers nothing. That is a deliberate, visible
     * no-op rather than a silent one — a diner's message is composed either way, and
     * the log says whether a provider carried it.
     */
    const { resolveSender } = await import('@/lib/notify/twilio-sender');
    const sender = resolveSender();

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
        /**
         * FR-802. The organiser's token, when the diner came through their link.
         *
         * This line is the whole reason the wire field exists, and it is the line most
         * likely to go missing: `organiserToken` is optional on `JoinRequest`, so
         * omitting it type-checks, the schema still validates it, and every join is
         * simply unattributed — silently, forever. It is the same omission that
         * `paymentMethodId` suffered in slice 2b (see the note above), which is why
         * `join/__tests__/attribution.test.ts` asserts on the participant row rather
         * than on the parsed body.
         */
        ...(parsed.value.organiserToken ? { organiserToken: parsed.value.organiserToken } : {}),
        // Behind a proxy this must be a trusted header; the same caveat as
        // `auth/rate-limit.ts`. Recorded on the consent row only, never logged.
        ...(request.headers.get('x-forwarded-for')
          ? { ipAddress: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
          : {}),
      },
      {
        paymentPort,
        // FR-408. One message, one recipient: the diner who just joined.
        confirm: async (message) => {
          await sender.send([message]);
        },
      },
    );

    if (!result.ok) {
      return NextResponse.json(refusalBody(result), { status: result.status });
    }

    // Typed, not just constructed. `satisfies` is what makes this field list
    // exhaustive: add a field to `JoinSuccessBody` and this object stops compiling
    // until it is emitted, and a typo here is an excess-property error rather than a
    // silently renamed key. Without it the route and the component were two
    // independent declarations of one wire shape, and the gap between them rendered
    // as "people join by undefined".
    const body = {
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
      // The words for `cutoffAt`, in the merchant's zone. The confirmation prints
      // this one; `cutoffAt` is here for any caller that needs the instant.
      cutoffLabel: result.cutoffLabel,
      windowStart: result.windowStart.toISOString(),
      windowEnd: result.windowEnd.toISOString(),
      isConfirmedAlready: result.isConfirmedAlready,
      // The diner's route back to their own order. A path, not an absolute URL:
      // the browser is already on this origin, so a relative link cannot be wrong
      // about the host or the scheme. The absolute form exists for the SMS and is
      // built by the same `orderPath`/`orderUrl` pair.
      orderPath: result.orderPath,
    } satisfies JoinSuccessBody;

    return NextResponse.json(body, {
      status: 200,
      // A hold is not cacheable, and neither is a quantity that just changed.
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
