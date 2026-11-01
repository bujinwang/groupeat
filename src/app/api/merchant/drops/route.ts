import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { createDraft, listDrops } from '@/lib/db/drops';
import { collectDraftFieldErrors } from '@/lib/drops/draft-validation';
import { parseDraftInput } from '@/lib/drops/input';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';

/**
 * `GET  /api/merchant/drops` — the caller's drops, newest first.
 * `POST /api/merchant/drops` — create a `DRAFT` (FR-201's starting point).
 *
 * ## What the body may not decide
 *
 * The floor, the fee constants, and the guardrail result all come from the
 * database at publish time. This route stores the merchant's *intent* — dish,
 * price, quantities, window — with no evaluation attached. A draft is allowed to
 * be unprofitable; publishing it is not. That separation is what lets FR-203's
 * slider exist: the merchant drags, sees the panel, and only the publish path
 * refuses.
 *
 * Timing and quantities **are** checked here, though, because a draft with an
 * impossible window is not a draft worth saving — and a 422 at save is a better
 * teacher than a 422 at publish.
 */

const ROUTE = 'api/merchant/drops';

export async function GET(): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const drops = await listDrops(merchantIds);
    return NextResponse.json({ drops }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseDraftInput(raw);

    if (!parsed.ok) {
      logger.info('drop.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(parsed.fieldErrors).length,
      });
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Check the details for this drop.',
          fieldErrors: parsed.fieldErrors,
        },
        { status: 422 },
      );
    }

    const value = parsed.value;

    // `now` is the prospective publish time: a draft saved today is expected to
    // publish today, so the five-day cap is measured from here.
    const now = new Date();
    const fieldErrors = await collectDraftFieldErrors({ merchantIds, value, now });

    if (Object.keys(fieldErrors).length > 0) {
      logger.info('drop.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(fieldErrors).length,
      });
      return NextResponse.json(
        { error: 'VALIDATION', message: 'Check the details for this drop.', fieldErrors },
        { status: 422 },
      );
    }

    const drop = await createDraft(merchantIds, value);

    logger.info('drop.draft_created', {
      actorId: session.userId,
      dropId: drop.id,
      merchantId: drop.merchantId,
      itemId: drop.menuItemId,
    });

    return NextResponse.json({ drop }, { status: 201 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
