import { NextResponse, type NextRequest } from 'next/server';

import { requireMerchant } from '@/lib/auth/authorize';
import { errorResponse } from '@/lib/http';
import { listCounterDrops } from '@/lib/redemption/manifest';

/**
 * `GET /api/merchant/pickup-queue` — the drops a pickup counter can open (FR-604).
 *
 * Returns plates **outstanding**, not plates sold. See `listCounterDrops`.
 *
 * No `dropId` comes from the caller and no merchant id comes from the query
 * string: the scope is the session's `MerchantUser` rows, as everywhere else. A
 * merchant with no rows gets an empty list rather than a 404 — there is no
 * resource here to be forbidden from.
 */

const ROUTE = 'api/merchant/pickup-queue';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const { merchantIds } = await requireMerchant();
    const drops = await listCounterDrops(merchantIds, new Date());

    return NextResponse.json(
      {
        drops: drops.map((drop) => ({
          id: drop.id,
          title: drop.title,
          status: drop.status,
          // ISO strings, not `Date`s: `JSON.stringify` would produce the same
          // thing, but making it explicit means the contract is visible at the
          // boundary and a client never has to guess at a locale.
          windowStart: drop.windowStart.toISOString(),
          windowEnd: drop.windowEnd.toISOString(),
          outstanding: drop.outstanding,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
