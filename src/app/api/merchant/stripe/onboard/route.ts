import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { primaryMerchantId } from '@/lib/db/items';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import { isStripeNotConfigured } from '@/lib/payments/connect-port';
import { beginOnboarding } from '@/lib/payments/onboarding-service';

/**
 * `POST /api/merchant/stripe/onboard` — FR-102.
 *
 * Starts or resumes Connect onboarding and returns a **fresh** hosted link. The
 * client redirects to it; nothing about the flow lives in the browser.
 *
 * The return/refresh URLs are built from the request origin rather than a
 * configured base URL. Two reasons: the app runs on a different port per
 * environment here, and a hardcoded origin is the classic way a Stripe return
 * lands on `localhost` in production. `x-forwarded-proto` is honoured because a
 * proxied deployment terminates TLS before us.
 *
 * A missing key is a **503 with a clear message**, not a 500: "payments are not
 * configured" is an operational fact, not a bug in the merchant's request.
 */

const ROUTE = 'api/merchant/stripe/onboard';

function originOf(request: NextRequest): string {
  const host = request.headers.get('host');
  if (!host) {
    throw AppError.badRequest('Missing host header; cannot build the Stripe return URL.');
  }
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();
    const merchantId = await primaryMerchantId(merchantIds);
    const origin = originOf(request);

    const result = await beginOnboarding({
      merchantId,
      actorId: session.userId,
      returnUrl: `${origin}/merchant/payouts?state=return`,
      refreshUrl: `${origin}/merchant/payouts?state=refresh`,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (isStripeNotConfigured(error)) {
      return NextResponse.json(
        {
          error: 'STRIPE_NOT_CONFIGURED',
          message: error.message,
          fieldErrors: {},
        },
        { status: 503 },
      );
    }
    return errorResponse(error, ROUTE);
  }
}
