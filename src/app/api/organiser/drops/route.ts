import { NextResponse, type NextRequest } from 'next/server';

import { requireOrganiser } from '@/lib/auth/authorize';
import { organiserProfileForUser, listShareableDrops } from '@/lib/db/share-links';
import { AppError } from '@/lib/errors';
import { errorResponse } from '@/lib/http';
import { shareableDropJson } from '@/lib/organisers/share-offer';

/**
 * `GET /api/organiser/drops` — FR-801 across the wire.
 *
 * > `FR-801 | Organiser sees available drops from their merchants | Ranked by
 * > likelyFill (§9.4)` — PRD-v1.md:536
 * > `GET    /api/organiser/drops` — PRD-v1.md:873
 *
 * ## What this route is, and what it is not
 *
 * It is a **second reader of the same query** the page uses — `listShareableDrops`,
 * mapped through `shareableDropJson`. It is not a new implementation. That distinction
 * is the whole point of the file: gap 17 taught that a "second view" written as a
 * second query is a second place for the same silent defects, and the condition that
 * makes `likelyFill` rankable (a few months of `ShareLink` history) is also the
 * condition that makes a second ordering rule drift from the page's.
 *
 * ## Why it exists at all when the page renders the list
 *
 * Gap 18: PRD §11 declares three organiser endpoints and only the commission one was
 * built, because FR-802's share link shipped as a server action (following the pattern
 * `admin/actions.ts` established). A server action is a Next-runtime endpoint reachable
 * only from a React form — it cannot be called by a share sheet, an organiser assistant,
 * or `curl`. The capability was delivered; the *interface* was not.
 *
 * ## The 403 with no profile, and why it is not a 404
 *
 * An ORGANISER whose account has no `OrganiserProfile` (FR-906) is the right role with
 * nothing behind it. A 404 would say the endpoint does not exist when in fact the
 * account is unfinished, and the useful sentence is the one that says so. Same answer,
 * same reasoning, as `/api/organiser/commission`.
 *
 * ## Nothing here writes
 *
 * A `GET`, and `listShareableDrops` is a single `findMany`. The route test asserts the
 * `ShareLink` row count is unchanged after a call — this endpoint is the one an
 * organiser's client polls, so a write hidden behind it would fire on every poll.
 */

const ROUTE = 'api/organiser/drops';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireOrganiser();

    const profile = await organiserProfileForUser(session.userId);
    if (!profile) {
      throw AppError.forbidden(
        'Your account has no organiser profile yet, so there are no drops attributed to you. Ask the team to complete it.',
      );
    }

    const rows = await listShareableDrops({ organiserProfileId: profile.id });

    return NextResponse.json(
      {
        organiser: {
          displayName: profile.displayName,
          commissionPct: profile.commissionPct,
        },
        drops: rows.map(shareableDropJson),
        // FR-801's ranking, now implemented — see `lib/organisers/likely-fill.ts`.
        //
        // Two fields rather than one, because they answer different questions and a
        // client needs both: `ordering` is what the array *is*, and the boolean is the
        // yes/no a client would otherwise have to infer from a string. The pair exists
        // because gap 16 spent several slices where the honest answer was
        // `orderingIsLikelyFill: false`, and a client that paginated or cached on the
        // old value can detect the change rather than silently inheriting a new order.
        ordering: 'likely_fill',
        orderingIsLikelyFill: true,
      },
      {
        status: 200,
        headers: {
          // The list changes when a drop publishes, locks, or takes a join. A cached
          // copy would offer a link to a drop that has since closed — the exact stale
          // state `ensureShareLink` re-checks because this header cannot be trusted.
          'cache-control': 'no-store',
        },
      },
    );
  } catch (error) {
    return errorResponse(error, ROUTE);
  }
}
