import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse } from '@/lib/http';
import { quoteJoin, type QuoteRefusalReason } from '@/lib/join/quote';
import { logger } from '@/lib/logging/logger';
import { JOIN_CAPTURE_METHOD } from '@/lib/join/payment-port';

/**
 * `POST /api/public/drops/[code]/intent` — the Payment Element's client secret.
 *
 * ## Why this is a second endpoint rather than part of `join`
 *
 * The Element needs a `clientSecret` bound to an amount *before* the diner submits
 * the form, and the amount depends on the quantity they have chosen. So there has to
 * be a call that quotes a quantity and returns a secret without creating anything.
 * `join` remains the call that commits.
 *
 * The sequence the page performs is:
 *
 *   1. diner picks a quantity → this endpoint → `{ clientSecret, amountLabel }`;
 *   2. the Element mounts against that secret and tokenises the card into a `pm_…`;
 *   3. the diner submits → `POST …/join` with the `pm_…` and the quantity;
 *   4. `join` writes the participant and confirms the intent server-side.
 *
 * ## No participant row is created here, deliberately
 *
 * `PENDING` rows count toward capacity, so creating one at quote time would let
 * abandoned page views consume a drop's plates and close it out from under real
 * diners. It would also mean an intent exists for somebody who never pressed a
 * button. `quoteJoin` is therefore read-only.
 *
 * ## What this endpoint must never return
 *
 * No phone number, no customer id, no full participant record — it is called before
 * any of those exist. It returns the secret, the amount the diner is about to
 * authorise, and enough of the drop to render the quantity limits. The secret itself
 * is short-lived and scoped to one intent.
 *
 * ## The two secrets, and why only one crosses the wire
 *
 * `STRIPE_SECRET_KEY` never leaves the server. The Element needs
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, which is public by design and is returned
 * here so the page does not need it at build time — meaning a deployment can add
 * keys without a rebuild.
 *
 * ## Status codes
 *
 * | Outcome | Status |
 * |---|---|
 * | quoted | 200 |
 * | bad or missing quantity | 422 |
 * | unknown code, or not published | 404 |
 * | closed / sold out / not enough left | 409 |
 * | pricing data unusable | 500 |
 * | Stripe or the merchant's Connect account not ready | 503 |
 */

const ROUTE = 'api/public/drops/intent';

/**
 * A diner-facing sentence per refusal.
 *
 * Kept here rather than in `JOIN_REFUSAL_COPY` because these are the refusals that
 * happen *before* a join is attempted, and two of them (`SOLD_OUT`,
 * `NOT_ENOUGH_LEFT`) need wording that mentions the quantity the diner asked for.
 * The join route already carries the committed-attempt vocabulary; duplicating that
 * map would be two places to fix a sentence.
 */
const QUOTE_COPY: Record<QuoteRefusalReason, { title: string; detail: string }> = {
  NOT_FOUND: {
    title: 'This offer is not available',
    detail: 'Check the link — it may have expired or been mistyped.',
  },
  CLOSED: {
    title: 'Ordering has closed',
    detail: 'This drop is no longer taking orders.',
  },
  CANCELLED: {
    title: 'This drop was cancelled',
    detail: 'The restaurant called it off. Nobody was charged, and anyone who paid has been refunded.',
  },
  SOLD_OUT: {
    title: 'Sold out',
    detail: 'Every plate on this drop has been taken.',
  },
  NOT_ENOUGH_LEFT: {
    title: 'Not enough left',
    detail: 'There are fewer plates left than you asked for. Try a smaller quantity.',
  },
  BAD_QTY: {
    title: 'Check the quantity',
    detail: 'Choose between one and the number allowed per person.',
  },
  PRICE_UNAVAILABLE: {
    title: 'This offer cannot be priced right now',
    detail: 'The restaurant has been notified. Please try again shortly.',
  },
  PAYMENTS_NOT_CONFIGURED: {
    title: 'Card payments are not available',
    detail: 'This restaurant cannot take payment yet. Please try again later.',
  },
};

function refusal(reason: QuoteRefusalReason, status: 404 | 409 | 422 | 500 | 503): NextResponse {
  return NextResponse.json(
    { error: 'QUOTE_REFUSED', reason, copy: QUOTE_COPY[reason] },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return refusal('BAD_QTY', 422);
    }

    // Only the quantity travels: this endpoint has no business receiving a phone
    // number, and requiring one here would collect personal data before the diner has
    // decided to order.
    const qty =
      typeof raw === 'object' && raw !== null && 'qty' in raw
        ? (raw as { qty: unknown }).qty
        : undefined;

    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
      return refusal('BAD_QTY', 422);
    }

    const { isStripeConfigured } = await import('@/lib/payments/stripe');
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!isStripeConfigured() || !publishableKey) {
      logger.info('join.refused', { reason: 'PAYMENTS_NOT_CONFIGURED' });
      return refusal('PAYMENTS_NOT_CONFIGURED', 503);
    }

    const quoted = await quoteJoin({ publicCode: code, qty });
    if (!quoted.ok) {
      // `quoteJoin` already logged `join.pricing_unavailable` with the drop id for a
      // data error; re-logging it here would produce two lines for one problem and
      // make a rate metric double-count. The route only maps the refusal.
      return refusal(quoted.reason, quoted.status);
    }

    const { quote } = quoted;

    /**
     * The intent, created on the **merchant's** account (ADR-001).
     *
     * `capture_method: 'manual'` is the constant, not a parameter, for the same
     * reason it is in the port: a quote that could capture would be one argument away
     * from charging a diner at the moment they opened the page (FR-404).
     *
     * The intent is created **unconfirmed** here — there is no card yet. It stays at
     * `requires_payment_method` until `join` confirms it server-side with the `pm_…`
     * from the Element, which is what makes `requires_capture` a synchronous fact for
     * `joinDrop`. An intent abandoned at `requires_payment_method` holds nothing and
     * expires on its own, so an abandoned quote costs a diner nothing.
     *
     * Server-side only: this reaches `forMerchant()` through a dynamic import because
     * `stripe.ts` must not enter the route's module graph when no key is configured.
     */
    const { forMerchant } = await import('@/lib/payments/stripe');
    const intent = await forMerchant(quote.stripeAccountId).paymentIntents.create({
      amount: quote.amountCents,
      currency: 'cad',
      capture_method: JOIN_CAPTURE_METHOD,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      // Ids only. Metadata is visible in the dashboard and is treated like a log line.
      metadata: { dropId: quote.dropId },
      // A quote that is never submitted should not linger. Stripe expires an
      // unconfirmed intent anyway; setting it explicitly makes the window legible.
      description: `GroupEat drop ${quote.dropId} × ${quote.qty}`,
    });

    if (!intent.client_secret) {
      // Should be impossible for a PaymentIntent, and refused rather than guessed at:
      // returning `null` to the Element produces a blank card form with no message.
      logger.error('join.payment_unavailable', { reason: 'no_client_secret', operation: ROUTE });
      return refusal('PRICE_UNAVAILABLE', 500);
    }

    return NextResponse.json(
      {
        clientSecret: intent.client_secret,
        publishableKey,
        amountCents: quote.amountCents,
        amountLabel: quote.amountLabel,
        qty: quote.qty,
        unitPriceCents: quote.unitPriceCents,
        minQty: quote.minQty,
        maxQty: quote.maxQty,
        maxPerCustomer: quote.maxPerCustomer,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
