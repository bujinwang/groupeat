import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { emit } from '@/lib/analytics/events';
import { requireMerchant } from '@/lib/auth/authorize';
import { getMerchant, primaryMerchantFloor, updateFloor } from '@/lib/db/merchants';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';

/**
 * `PATCH /api/merchant/settings` — the minimum margin (S1-018, A-4).
 *
 * Three rules the guardrail depends on:
 *   1. the value is validated here (`0 < x <= 1`), never trusted from the body;
 *   2. **lowering** it requires `acknowledgedConsequence: true` — Q-6's decision
 *      is that the floor must be hard to move, not impossible to move, so the
 *      caller has to say it understands the consequence;
 *   3. every change writes `floor_changed` to the log and the analytics stream.
 */

const ROUTE = 'api/merchant/settings';

const bodySchema = z.object({
  floorPctOfMenu: z.number(),
  acknowledgedConsequence: z.boolean().optional(),
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const { session, merchantIds } = await requireMerchant();

    const raw: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'Send the new minimum margin as a fraction between 0 and 1.',
          fieldErrors: { floorPctOfMenu: 'Send a fraction, e.g. 0.25 for 25%.' },
        },
        { status: 422 },
      );
    }

    const requested = parsed.data.floorPctOfMenu;
    if (!Number.isFinite(requested) || requested <= 0 || requested > 1) {
      return NextResponse.json(
        {
          error: 'VALIDATION',
          message: 'The minimum margin must be greater than 0 and at most 100%.',
          fieldErrors: { floorPctOfMenu: 'Enter a value between 1% and 100%.' },
        },
        { status: 422 },
      );
    }

    const current = await primaryMerchantFloor(merchantIds);

    if (requested < current.floorPctOfMenu && parsed.data.acknowledgedConsequence !== true) {
      return NextResponse.json(
        {
          error: 'CONSEQUENCE_NOT_ACKNOWLEDGED',
          message:
            'Lowering this means you earn less per plate on every deal you run, not just this one.',
          fieldErrors: { acknowledgedConsequence: 'Confirm that you understand this.' },
        },
        { status: 422 },
      );
    }

    const updated = await updateFloor(current.merchantId, requested);

    if (updated !== current.floorPctOfMenu) {
      logger.info('floor.changed', {
        actorId: session.userId,
        merchantId: current.merchantId,
        fromPct: current.floorPctOfMenu,
        toPct: updated,
      });
      emit('floor_changed', {
        merchantId: current.merchantId,
        actorUserId: session.userId,
        fromPct: current.floorPctOfMenu,
        toPct: updated,
      });
    }

    const merchant = await getMerchant(current.merchantId);
    return NextResponse.json({ merchant }, { status: 200 });
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
