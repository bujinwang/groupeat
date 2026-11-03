import { NextResponse, type NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/authorize';
import { listAdminDrops, parseAdminDropStatus } from '@/lib/db/admin-drops';
import { errorResponse } from '@/lib/http';

/**
 * `GET /api/admin/drops` — FR-901.
 *
 * > `GET    /api/admin/drops` — PRD-v1.md:889
 * > `FR-901 | List/filter all drops by status |` — PRD-v1.md:548
 *
 * ## Why this is a route when the page reads the same data directly
 *
 * The admin screen is a server component and calls `listAdminDrops` itself; this
 * endpoint exists because the PRD names it, and because the one thing a server
 * component cannot serve is a second client — an operator's script, a support tool, a
 * mobile view. It resolves through the same function, so the two cannot disagree about
 * what "all drops" means or how `capturedCents` is computed.
 *
 * ## The `status` parameter is filtered through a parser, not cast
 *
 * `?status=WHATEVER` returns an unfiltered list with `appliedStatus: null` rather than a
 * 422. The reasoning is in `parseAdminDropStatus`: an operator who mistypes a filter
 * should see everything and a note, because a filter that silently matches nothing
 * looks identical to a filter that found nothing. The response says which filter was
 * actually applied so a caller can tell.
 */

const ROUTE = 'api/admin/drops';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin();

    const requested = request.nextUrl.searchParams.get('status') ?? undefined;
    const status = parseAdminDropStatus(requested);
    const list = await listAdminDrops({ status });

    return NextResponse.json(
      {
        drops: list.rows.map((row) => ({
          ...row,
          // ISO strings on the wire; the PRD's §11 rule. `Date` would serialise the
          // same way, but naming it here keeps the contract visible in the route.
          cutoffAt: row.cutoffAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        })),
        countsByStatus: list.countsByStatus,
        // The whole table, not `drops.length` — the same distinction the page's "All"
        // chip needs, exposed here so a second client cannot get it wrong either.
        totalDrops: list.totalDrops,
        totalCents: list.totalCents,
        // What the caller actually got, so an unparseable filter is visible rather
        // than looking like an empty result.
        requestedStatus: requested ?? null,
        appliedStatus: status,
        filterIgnored: requested !== undefined && status === null,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
