import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { getItem, updateItem } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { errorResponse } from '@/lib/http';
import { evaluateItem } from '@/lib/items/evaluate';
import { parseItemInput } from '@/lib/items/input';
import { recordAlcoholFlagChange, recordEvaluation } from '@/lib/items/record';
import { logger } from '@/lib/logging/logger';

/**
 * `GET   /api/merchant/items/:id` — one dish plus its evaluation.
 * `PATCH /api/merchant/items/:id` — update it.
 *
 * A foreign id is a **404**, never a 403 (US-M1): the response must not confirm
 * that another merchant's dish exists.
 */

const ROUTE = 'api/merchant/items/[id]';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const { id } = await context.params;

    const item = await getItem(merchantIds, id);
    const floorPctOfMenu = await getFloor(item.merchantId);
    const evaluation = evaluateItem({ item, floorPctOfMenu });

    return NextResponse.json({ item, evaluation }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();
    const { id } = await context.params;

    // Ownership first: a foreign id must 404 before any body parsing work.
    const previous = await getItem(merchantIds, id);

    const raw: unknown = await request.json().catch(() => null);
    const parsed = parseItemInput(raw);

    if (!parsed.ok) {
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

    const item = await updateItem(merchantIds, id, parsed.value);
    logger.info('item.saved', {
      actorId: session.userId,
      itemId: item.id,
      merchantId: item.merchantId,
    });

    // S1-025: an alcohol-flag transition is auditable in both directions, whether
    // it came from the confirmation dialog or from a direct API call. The dialog
    // is a UI affordance; the record does not depend on the client having shown it.
    recordAlcoholFlagChange({
      itemId: item.id,
      merchantId: item.merchantId,
      actorUserId: session.userId,
      from: previous.containsAlcohol,
      to: item.containsAlcohol,
    });

    const floorPctOfMenu = await getFloor(item.merchantId);
    const evaluation = evaluateItem({ item, floorPctOfMenu });
    recordEvaluation(evaluation, item, session.userId);

    return NextResponse.json({ item, evaluation }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
