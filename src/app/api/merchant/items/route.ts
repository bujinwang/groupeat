import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { createItem, listItems } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { errorResponse } from '@/lib/http';
import { evaluateItem } from '@/lib/items/evaluate';
import { parseItemInput } from '@/lib/items/input';
import { recordEvaluation } from '@/lib/items/record';
import { logger } from '@/lib/logging/logger';

/**
 * `GET  /api/merchant/items` — the caller's dishes.
 * `POST /api/merchant/items` — create one (flow 1).
 *
 * The POST body carries costs; the **floor does not**. It is read from the
 * merchant record through `toPct()`, so a tampered body cannot move the floor
 * (S1-018).
 */

const ROUTE = 'api/merchant/items';

export async function GET(): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const items = await listItems(merchantIds);
    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseItemInput(raw);

    if (!parsed.ok) {
      // AC-9 server half: the same predicate the form ran, re-run here.
      logger.info('item.validation_failed', {
        actorId: session.userId,
        merchantId: merchantIds[0] ?? 'none',
        issueCount: Object.keys(parsed.fieldErrors).length,
      });
      return NextResponse.json(
        { error: 'VALIDATION', message: 'Check the values you entered.', fieldErrors: parsed.fieldErrors },
        { status: 422 },
      );
    }

    const item = await createItem(merchantIds, parsed.value);
    logger.info('item.saved', {
      actorId: session.userId,
      itemId: item.id,
      merchantId: item.merchantId,
    });

    const floorPctOfMenu = await getFloor(item.merchantId);
    const evaluation = evaluateItem({ item, floorPctOfMenu });
    recordEvaluation(evaluation, item, session.userId);

    // The item id is needed to navigate to the dish; the evaluation is returned
    // with it so the panel can render without a second round trip.
    return NextResponse.json({ item, evaluation }, { status: 201 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
