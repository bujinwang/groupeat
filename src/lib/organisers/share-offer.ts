import { shareMessageFor, shareUrlFor } from '@/lib/organisers/share-link';
import type { Ranked } from '@/lib/organisers/likely-fill';
import type { ShareableDropRow } from '@/lib/db/share-links';

/**
 * FR-802 — one share offer, composed from one row.
 *
 * ## Why this module exists, and what it prevents
 *
 * The share link is now reachable from **two** entry points: the server action that
 * `/organiser` posts to, and `POST /api/organiser/drops/:id/share` (PRD-v1.md:874).
 * They already share `ensureShareLink`, so they cannot mint different *tokens*. What
 * they did not share is everything downstream of the token — the URL and the
 * pre-written message — and that is where a second client would quietly get a
 * different product:
 *
 *   - a route returning `{ token }` alone forces the caller to compose `/d/:code?src=…&o=…`
 *     itself, and the plausible mistake is to omit `?src=organiser_link`. The link still
 *     works, the diner still joins, and the view classifies as `direct` — so the
 *     organiser's contribution disappears from PRD §10.2's only organiser metric with no
 *     error anywhere. `shareUrlFor` is the one place that knows the parameter, so the
 *     route returns its output rather than the raw token.
 *   - the message is the thing an organiser actually pastes. Composing it in the browser
 *     (where `ShareLinkControl` does it) and *also* in the API — for the share-sheet
 *     client this route is for — would be two implementations of the four-line format
 *     and of the Competition Act rule that every number in it is real. Those drift
 *     silently: the text still looks right, it just stops matching the page.
 *
 * So the wire payload is composed here, from the same pure formatters the page uses,
 * and the test asserts byte-identical text against `ShareLinkControl`'s inputs.
 *
 * ## Why it is not in `lib/organisers/share-link.ts`
 *
 * That module is deliberately free of the database and of `share-links.ts` — it is
 * imported by a client component, and dragging a `ShareableDropRow` type (and therefore
 * `@/lib/db/prisma`) into the browser bundle is the thing its docblock warns about. This
 * module is the composition layer, so it is the one that is allowed to know both.
 *
 * It is still pure: no clock, no random, no query. The token is an input.
 */

/**
 * What both entry points return for a successful share.
 *
 * Deliberately the same shape the page needs, so `ShareLinkControl` and an API client
 * read the same three values rather than each deciding what a share consists of.
 */
export type ShareOffer = {
  readonly token: string;
  /** Absolute when `APP_URL` is usable, relative otherwise — `shareUrlFor`'s rule. */
  readonly url: string;
  /** The four-line message, ready to paste. */
  readonly message: string;
};

/**
 * The offer for a drop this organiser may share.
 *
 * `drop` is a `ShareableDropRow` and not a narrower type on purpose: the message quotes
 * the title, both prices, the threshold, the joined count, the cutoff and the merchant's
 * zone, and every one of those has to come from the same row the page rendered. A
 * parameter list would let a caller pass a `joinedQty` it read a minute ago, and the
 * pasted message would then state a count the page disagrees with.
 *
 * `origin` is passed through, not derived: `publicOrigin()` is the only place that
 * decides whether this deployment has a usable public address, and a guess here would
 * put `http://localhost:3000` into someone's group chat.
 */
export function shareOfferFor(args: {
  readonly drop: ShareableDropRow;
  readonly token: string;
  readonly origin: string | undefined;
}): ShareOffer {
  const url = shareUrlFor({
    publicCode: args.drop.publicCode,
    token: args.token,
    origin: args.origin,
  });

  const message = shareMessageFor({
    title: args.drop.title,
    merchantName: args.drop.merchantName,
    dealPriceCents: args.drop.dealPriceCents,
    menuPriceCents: args.drop.menuPriceCents,
    minQty: args.drop.minQty,
    joinedQty: args.drop.joinedQty,
    cutoffAt: args.drop.cutoffAt,
    timeZone: args.drop.merchantTimezone,
    url,
  });

  return { token: args.token, url, message };
}

/**
 * The wire form of a shareable drop.
 *
 * One function, used by `GET /api/organiser/drops`, so the JSON and the page cannot
 * disagree about which fields exist or how a `Decimal` becomes a number. Dates become
 * ISO-8601 with offset via `toISOString()` — PRD §11's "all timestamps ISO-8601".
 *
 * ## Why `existingToken` is in the payload and the *message* is not
 *
 * `existingToken` is what turns "Get share link" into "Copy message": a client that
 * cannot see it would offer to mint a link the organiser already has. The message, by
 * contrast, is not derivable without the token — so it belongs to the POST response,
 * where the token exists, and not to a list where most rows have none. Returning a
 * message for a row with no link would mean returning one built on a token that does
 * not exist yet.
 *
 * ## What is absent, structurally
 *
 * FR-805. No participant name, no phone, no customer id — `ShareableDropRow` has no
 * field that could carry one, and this mapper only forwards fields it names. The route
 * test asserts the serialised payload contains neither the phone nor its last four.
 */
export function shareableDropJson(row: ShareableDropRow): {
  id: string;
  publicCode: string;
  title: string;
  merchantName: string;
  dealPriceCents: number;
  menuPriceCents: number;
  minQty: number;
  maxQty: number;
  joinedQty: number;
  thresholdMet: boolean;
  cutoffAt: string;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  pickupAddress: string | null;
  existingToken: string | null;
  existingClicks: number;
  category: string | null;
  likelyFill: Ranked;
} {
  return {
    id: row.id,
    publicCode: row.publicCode,
    title: row.title,
    merchantName: row.merchantName,
    dealPriceCents: row.dealPriceCents,
    menuPriceCents: row.menuPriceCents,
    minQty: row.minQty,
    maxQty: row.maxQty,
    joinedQty: row.joinedQty,
    // Computed here rather than left to the caller. The page renders a badge from the
    // same comparison, and two clients deciding "is this drop on?" from raw numbers is
    // how one of them ends up using `>` instead of `>=`.
    thresholdMet: row.joinedQty >= row.minQty,
    cutoffAt: row.cutoffAt.toISOString(),
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    timeZone: row.merchantTimezone,
    pickupAddress: row.pickupAddress,
    existingToken: row.existingToken,
    existingClicks: row.existingClicks,
    category: row.category,
    // Forwarded, never recomputed. The score is `likelyFill`'s; a mapper that ranked
    // would be a second implementation of §9.3, and the two would drift the first time
    // a weight changed — the drift gap 17 recorded, one layer up.
    likelyFill: row.likelyFill,
  };
}
