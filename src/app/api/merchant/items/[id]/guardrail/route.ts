import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireMerchant } from '@/lib/auth/authorize';
import { getItem } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { errorResponse } from '@/lib/http';
import { evaluateItem } from '@/lib/items/evaluate';
import { recordEvaluation } from '@/lib/items/record';
import { logger } from '@/lib/logging/logger';

/**
 * `POST /api/merchant/items/:id/guardrail` — read-only evaluation (S1-013).
 *
 * **Accepts only `{ dealPriceCents? }`.** Every cost and the floor are read from
 * the database; anything else in the body is ignored, not merged. Flow 3 in the
 * architecture is explicit: a tampered client that submits
 * `{ foodCostCents: 100, floorPctOfMenu: 0.01 }` must be evaluated against the
 * real costs, and a submitted price below the floor comes back as `BELOW_FLOOR`
 * with the real `minViablePriceCents` — never echoed as accepted.
 *
 * Never persists anything.
 */

const ROUTE = 'api/merchant/items/[id]/guardrail';

const bodySchema = z.object({
  dealPriceCents: z.number().int().positive().max(50000).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();
    const { id } = await context.params;

    const item = await getItem(merchantIds, id);

    // An empty body is valid: the caller is asking for the default evaluation.
    const raw: unknown = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw ?? {});

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Send either no body or a dealPriceCents in whole cents.',
          fieldErrors: { dealPriceCents: 'Use a whole number of cents between 1 and 50000.' },
        },
        { status: 422 },
      );
    }

    // The floor comes from the merchant row, converted once, here.
    const floorPctOfMenu = await getFloor(item.merchantId);

    const evaluation = evaluateItem({
      item,
      floorPctOfMenu,
      dealPriceCents: parsed.data.dealPriceCents ?? null,
    });

    recordEvaluation(evaluation, item, session.userId);

    logger.info('guardrail.evaluated', {
      itemId: item.id,
      state: evaluation.state,
      minViablePriceCents: evaluation.view?.minViablePriceCents ?? null,
    });

    // Always 200: an infeasible dish and a missing cost are answers, not errors
    // (ARCHITECTURE-sprint1 §7.3).
    return NextResponse.json(evaluation, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
