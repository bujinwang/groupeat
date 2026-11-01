import { NextResponse, type NextRequest } from 'next/server';

import { logger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import { isStripeConfigured, platform } from '@/lib/payments/stripe';
import { syncOnboarding } from '@/lib/payments/onboarding-service';

/**
 * `POST /api/webhooks/stripe` — keeps `Merchant.status` honest.
 *
 * ## Why a webhook is required, not optional
 *
 * Onboarding completes **on Stripe's site**, in a flow we do not control. The
 * `?state=return` redirect is the fast path, but it is only a hint: the merchant
 * may close the tab, lose signal, or finish on a phone while the laptop is open.
 * The webhook is the authority. Without it, a merchant can be fully enabled at
 * Stripe and still read `PENDING` here — and M3's publish check would refuse to
 * let them run a drop they are perfectly able to run.
 *
 * ## The two rules that matter
 *
 *   1. **Verify the signature against the raw body.** `request.json()` would
 *      re-serialise and break the HMAC. The raw text is read once and passed to
 *      `constructEvent`.
 *   2. **Always 2xx on an event we do not care about.** Stripe retries non-2xx,
 *      so answering 400 to an `invoice.paid` we ignore would produce a retry
 *      storm with no benefit. Only a bad signature is a 400.
 *
 * Deliberately not in the merchant auth scope: Stripe is the caller, not a user.
 * The signature *is* the authentication.
 */

const ROUTE = 'api/webhooks/stripe';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isStripeConfigured()) {
    // Nothing to verify against. 503 makes the misconfiguration visible in
    // Stripe's delivery log rather than silently swallowing events.
    logger.warn('stripe.webhook_rejected', { reason: 'not_configured' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('stripe.webhook_rejected', { reason: 'not_configured' });
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'NO_SIGNATURE' }, { status: 400 });
  }

  // The raw body, not the parsed JSON: the signature covers exact bytes.
  const payload = await request.text();

  let event;
  try {
    event = platform().webhooks.constructEvent(payload, signature, secret);
  } catch {
    logger.warn('stripe.webhook_rejected', { reason: 'bad_signature' });
    return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 400 });
  }

  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object;
      const merchant = await prisma.merchant.findUnique({
        where: { stripeAccountId: account.id },
        select: { id: true },
      });

      if (!merchant) {
        // An account we do not know about. Not an error: Stripe may send events
        // for accounts created by another integration on the same platform.
        logger.warn('stripe.webhook_rejected', { reason: 'unknown_account' });
        break;
      }

      // Re-reads from Stripe rather than trusting the event body: the event can
      // arrive out of order, and `assessOnboarding` is the single rule.
      const assessment = await syncOnboarding({ merchantId: merchant.id });
      logger.info('stripe.webhook_processed', {
        eventType: event.type,
        merchantId: merchant.id,
        state: assessment.state,
      });
      break;
    }

    default:
      // Ignored on purpose, and 200 for the reason in the header comment.
      break;
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

/** Stripe sometimes probes the endpoint. Answer without doing any work. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'POST_ONLY' }, { status: 405, headers: { Allow: 'POST' } });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
void ROUTE;
