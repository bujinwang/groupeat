import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';
import { loadManifest } from '@/lib/redemption/manifest';

/**
 * `GET /api/merchant/pickup-queue/:id` — the batch manifest for one drop (FR-604).
 *
 * This is the "which bags are still on the warmer" screen. Redemption still
 * decides whether any given plate may be handed over; this only reports.
 *
 * A drop outside the caller's scope is a **404** from `loadManifest`, matching
 * every other merchant-scoped read (US-M1).
 */

const ROUTE = 'api/merchant/pickup-queue/[id]';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const { id } = await context.params;

    const manifest = await loadManifest(merchantIds, id);

    logger.info('redemption.manifest_viewed', {
      dropId: manifest.dropId,
      merchantId: merchantIds[0] ?? 'none',
      orders: manifest.summary.orders,
      plates: manifest.summary.plates,
    });

    return NextResponse.json(
      {
        dropId: manifest.dropId,
        title: manifest.title,
        status: manifest.status,
        windowStart: manifest.windowStart.toISOString(),
        windowEnd: manifest.windowEnd.toISOString(),
        timeZone: manifest.timeZone,
        summary: manifest.summary,
        rows: manifest.rows.map((row) => ({
          participantId: row.participantId,
          name: row.name,
          // Four digits, because that is all the database handed out. A full number
          // would let a staff member ring a diner after the shift, which is not
          // something this screen should enable.
          phoneLast4: row.phoneLast4,
          qty: row.qty,
          redeemedQty: row.redeemedQty,
          redeemedAt: row.redeemedAt?.toISOString() ?? null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
