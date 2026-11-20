import { NextResponse, type NextRequest } from 'next/server';

import { dropPublished } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { requireMerchantWrite } from '@/lib/auth/authorize';
import { publishDrop } from '@/lib/drops/publish';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';
import { canPublishDrop } from '@/lib/payments/onboarding';
import { readOnboarding } from '@/lib/payments/onboarding-service';

/**
 * `POST /api/merchant/drops/:id/publish` — FR-207.
 *
 * The route's whole job is gathering two facts the publish service must not
 * look up itself: the session's scope, and whether Stripe payouts are ready.
 * Every refusal that involves money is decided in `lib/drops/publish.ts`, so
 * there is one implementation and it is testable.
 *
 * ## Why readiness is read here, then passed in
 *
 * Readiness is *read* here and handed to `publishDrop` as a boolean, so the
 * publish service decides when it is the blocking reason. Throwing a 409 here
 * would mask a more specific problem the merchant should fix first — a price
 * below the floor — because it would fire before `reviewForPublish` runs. A
 * merchant with a bad price and no Stripe account hears about the price.
 *
 * The boolean comes from the canonical `canPublishDrop()` rule, which asks for
 * `state === 'READY' && canAcceptPayments`. Reading `state` alone would publish
 * a drop the merchant cannot actually be paid for if the two fields ever drift;
 * 2026-11-20 Gate 32 wired the rule in to close that gap.
 *
 * If Stripe is not configured at all, `readOnboarding` returns `NOT_STARTED`
 * for a merchant with no account; with an account it would throw, which is
 * correct — refusing to publish when we cannot verify payout readiness is the
 * safe direction.
 */

const ROUTE = 'api/merchant/drops/[id]/publish';

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchantWrite();
    const { id } = await context.params;

    const onboarding = await readOnboarding({ merchantId: merchantIds[0] ?? '' });
    // 2026-11-20 Gate 32: was `onboarding.state === 'READY'`, which ignored
    // `canAcceptPayments`. The canonical write-boundary rule decides now.
    const payoutsReady = canPublishDrop(onboarding);

    const { drop, snapshot } = await publishDrop({
      merchantIds,
      dropId: id,
      actorId: session.userId,
      now: new Date(),
      payoutsReady,
    });

    logger.info('drop.published', {
      actorId: session.userId,
      dropId: drop.id,
      merchantId: drop.merchantId,
      dealPriceCents: drop.dealPriceCents,
    });

    // The denominator of PRD §10.2's threshold-hit-rate target. Emitted after the
    // publish service has returned, so a refused publish is not counted as a drop
    // that failed to hit its threshold — it is a drop that never existed.
    record(
      dropPublished({
        dropId: drop.id,
        merchantId: drop.merchantId,
        dealPriceCents: drop.dealPriceCents,
        minQty: drop.minQty,
        maxQty: drop.maxQty,
      }),
    );

    // The snapshot is returned so the caller can confirm what was frozen without
    // a second read — and so a test can assert the frozen shape over the wire.
    return NextResponse.json({ drop, snapshot }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
