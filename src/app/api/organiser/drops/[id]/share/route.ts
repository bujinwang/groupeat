import { NextResponse, type NextRequest } from 'next/server';

import { requireOrganiserWrite } from '@/lib/auth/authorize';
import {
  ensureShareLink,
  listShareableDrops,
  organiserProfileForUser,
} from '@/lib/db/share-links';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import { logger } from '@/lib/logging/logger';
import { publicOrigin } from '@/lib/notify/public-origin';
import { shareOfferFor } from '@/lib/organisers/share-offer';

/**
 * `POST /api/organiser/drops/:id/share` — FR-802 across the wire.
 *
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 * > `POST   /api/organiser/drops/:id/share` — PRD-v1.md:874
 *
 * ## The relationship to the server action, stated precisely
 *
 * `getShareLinkAction` is the *page's* entry point and this is the *interface*. They
 * are not two implementations:
 *
 *   - both resolve the profile from the session's `userId`, never from the request;
 *   - both mint through `ensureShareLink`, so the token, its `@@unique([dropId,
 *     organiserId])` guarantee, and its live-drop re-check are one implementation;
 *   - both compose the URL and message through `shareOfferFor`.
 *
 * What differs is only what *should* differ: the refusal vocabulary. The action returns
 * `{ error, token: null }` because a React form can only render a sentence; a JSON
 * client needs the status, and conflating "your account is unfinished" with "that drop
 * closed" wastes a caller's retry. So `null` from `ensureShareLink` — a drop that is not
 * published, past cutoff, or nonexistent — becomes a **409**, not a 404 and not a 400.
 *
 * ## Why `null` is a 409 and not a 404
 *
 * The distinction the route can actually make is *not* "which of the three was it", and
 * that is on purpose: `ensureShareLink` collapses them because the organiser's next
 * action is identical in all three cases, and a 404/409 split would tell an
 * unauthenticated guesser which drop ids exist. What the route *can* say is that the
 * request was well formed and no different body would help — the drop is in a state that
 * forbids the action — which is exactly `AppError.conflict`'s definition.
 *
 * A malformed `:id` needs no special case: Prisma answers `findUnique` with `null` for a
 * non-uuid string rather than throwing (probed, not assumed), so a hand-edited URL
 * reaches the same 409 as a real drop that has closed. It does not leak existence
 * either, which a 400 "not a uuid" would.
 *
 * ## Idempotent, and why no idempotency key
 *
 * PRD §11 says "all mutating endpoints require idempotency keys". This one is exempt by
 * construction rather than by neglect: the unique index makes a repeat return the
 * **same** token, so a retried POST cannot mint a second link, split `clicks`, or orphan
 * a link already pasted into a group chat. `/api/admin/drops/:id/force-fail` records the
 * same reasoning for its own no-op second call. A key table would add a write to a route
 * whose only intended write is one row, and buy nothing.
 *
 * ## The log line, and the one thing the action does that this does not
 *
 * `organiser.share_link_created` is emitted by both, so a minted link is equally visible
 * whichever entry point made it. `revalidatePath('/organiser')` is *not* called: this
 * route is not rendering that page, and purging a cache from an API call is a side
 * effect the caller did not ask for. The page re-reads on the next request.
 */

const ROUTE = 'api/organiser/drops/[id]/share';

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, context: Context): Promise<NextResponse> {
  try {
    const session = await requireOrganiserWrite();
    const { id } = await context.params;

    const profile = await organiserProfileForUser(session.userId);
    if (!profile) {
      throw AppError.forbidden(
        'Your account has no organiser profile yet, so there is nothing to attribute a link to. Ask the team to complete it.',
      );
    }

    // The SAME row the page renders, through the same filter and projection, so the
    // message quotes the numbers `/organiser` shows rather than a second query's.
    //
    // **Read before minting**, and that order is deliberate. Mint-then-read forces a
    // decision for the case where the row has vanished by the time it is read — a drop
    // that crossed its cutoff *inside* this handler. That branch is unreachable in any
    // test that is not a race, and an unreachable branch is the defect this milestone
    // keeps finding: code that looks like it handles something because nothing ever
    // proved it did. Reading first removes the case instead of handling it.
    //
    // The `undefined` destructure below is why `if (!row)` is not optional: it narrows the
    // type for `shareOfferFor`, which needs a whole row. Probed — deleting the guard
    // fails `tsc` with `ShareableDropRow | undefined` is not assignable, so it is not dead
    // code kept for symmetry.
    const [row] = await listShareableDrops({
      organiserProfileId: profile.id,
      dropId: id,
    });

    // The one 409, used by both refusals below. One wording for one situation: an
    // organiser reading it does not care which of our two reads noticed.
    const notShareable = (): AppError =>
      AppError.conflict(
        'That drop is not taking shares right now. Refresh to see what is still open.',
      );

    // The reachable guard, and the one that does the work in practice: the filter here
    // and the filter in `ensureShareLink` are the same predicate applied at two instants,
    // so this one answers first. Split into two sentences it would tell an unauthenticated
    // guesser which drop ids are real; one sentence tells them nothing.
    if (!row) {
      throw notShareable();
    }

    const link = await ensureShareLink({ organiserProfileId: profile.id, dropId: id });
    if (!link) {
      // The drop closed in the microseconds between the read above and this mint. Kept
      // because it is what makes the route correct rather than what makes it pass: the
      // only test that can reach it would be a race, and none does. `ensureShareLink` is
      // still the authority on "can this be shared" — the action calls it with no read in
      // front — so the check earns its place even where this route rarely needs it.
      throw notShareable();
    }

    logger.info(link.created ? 'organiser.share_link_created' : 'organiser.share_link_reused', {
      organiserProfileId: profile.id,
      dropId: id,
      source: 'api',
    });

    const offer = shareOfferFor({ drop: row, token: link.token, origin: publicOrigin() });

    return NextResponse.json(
      {
        ...offer,
        composed: true,
        drop: {
          id: row.id,
          publicCode: row.publicCode,
          title: row.title,
          cutoffAt: row.cutoffAt.toISOString(),
          timeZone: row.merchantTimezone,
        },
      },
      {
        status: 200,
        headers: {
          // A token is a credential for attribution (FR-804 is paid off it). A cached
          // response would hand a proxy a link that outlives the organiser's intent.
          'cache-control': 'no-store',
        },
      },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
