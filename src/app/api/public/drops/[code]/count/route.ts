import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse } from '@/lib/http';
import { headlineFor, resolveDropView } from '@/lib/public/drop-view';
import { getPublicDrop } from '@/lib/public/public-drops';

/**
 * `GET /api/public/drops/:code/count` — FR-303's poll target.
 *
 * ## What it deliberately does not return
 *
 * No participant ids, no names, no phone numbers, no organiser attribution. The
 * response is five numbers and one sentence. A public endpoint that leaked a
 * participant list would be a privacy incident caused by a convenience, and the
 * page has no use for anything else.
 *
 * ## Why the sentence is built here, not in the browser
 *
 * `headlineFor` is the same function the server-rendered page uses. If the poll
 * response carried only raw numbers and the client formatted its own sentence,
 * there would be two definitions of "Confirmed — 22 orders", and they would drift
 * the first time somebody edited one.
 *
 * ## Errors are uniform
 *
 * A missing code and a server fault both answer with the same shape, and a missing
 * code is 404 while a fault is 500 — but neither names a reason a caller could use
 * to tell "this drop does not exist" from "this drop is a draft". That distinction
 * is the merchant's, not the public's.
 */

const ROUTE = 'api/public/drops/count';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  try {
    const drop = await getPublicDrop(code);

    if (!drop) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'That drop could not be found.' },
        { status: 404 },
      );
    }

    const view = resolveDropView({
      status: drop.status,
      minQty: drop.minQty,
      maxQty: drop.maxQty,
      cutoffAt: drop.cutoffAt,
      windowStart: drop.windowStart,
      windowEnd: drop.windowEnd,
      joinedQty: drop.joinedQty,
      now: new Date(),
      hadCaptures: drop.hadCaptures,
    });

    return NextResponse.json(
      {
        view: {
          headline: headlineFor(view, drop.minQty),
          joinedQty: view.joinedQty,
          minQty: view.minQty,
          maxQty: view.maxQty,
          remainingQty: view.remainingQty,
          progress: view.progress,
          showScarcity: view.showScarcity,
          offerPhase: view.offerPhase,
          canJoin: view.canJoin,
        },
      },
      {
        status: 200,
        // A count that is cached is a count that is wrong.
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    // The app's single exception-to-response path: it logs an
    // `api.unhandled_error` event and returns a generic 500. Nothing about the
    // failure reaches the caller.
    return errorResponse(error, ROUTE);
  }
}
