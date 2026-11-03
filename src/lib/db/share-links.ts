import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db/prisma';
import {
  SHARE_TOKEN_BYTES,
  SHARE_TOKEN_LENGTH,
  isShareToken,
} from '@/lib/organisers/share-link';

/**
 * FR-801/FR-802 — the organiser's drops, and the link that attributes them.
 *
 * > `FR-801 | Organiser sees available drops from their merchants | Ranked by
 * > likelyFill (§9.4)` — PRD-v1.md:536
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 * > `FR-805 | Organiser cannot see participant phone numbers | P0 privacy
 * > requirement` — PRD-v1.md:540
 *
 * ## "From their merchants" has no schema to read
 *
 * The PRD's phrase assumes an organiser-to-merchant relationship. There is none: no
 * join table, no `Merchant.organiserId`, nothing. `ShareLink` records the merchant only
 * *after* a link is created, so before the first share an organiser is attached to no
 * merchant at all.
 *
 * Rather than invent an assignment table (a product decision nobody has made, and one
 * that would need an admin screen to maintain), this module reads the V1 reality: 5–15
 * organisers, one corridor, one live drop per merchant at a time. **Every live drop is
 * offered to every organiser.** That is what the corridor size actually means, and it
 * fails safe — an organiser seeing a drop they cannot place is a wasted row, while an
 * organiser not seeing a drop that needs filling is a lost drop.
 *
 * `likelyFill` ranking (FR-801's acceptance, §9.4) is not implemented. It is defined as
 * a function of the organiser's *history* — fill rate per merchant+item, group size
 * inferred from the last drop, past success with a cuisine — and an organiser with no
 * share links has no history to rank with. So the order here is the honest one: drops
 * closest to their cutoff first, because that is the drop that needs somebody today.
 * When history exists, ranking belongs in a pure module beside `likelyFill`, not folded
 * into this query.
 *
 * ## FR-805 is enforced by the shape of the row
 *
 * The organiser gets aggregate counts. `ShareableDropRow` has no field that could carry
 * a phone number, a customer id, or a name, so there is no projection to get wrong —
 * the query below does not select them and the type could not hold them if it did. The
 * test asserts it anyway, because "the type has no field" stops being true the first
 * time somebody adds one for a good reason.
 *
 * ## Why `ensureShareLink` relies on a unique index
 *
 * Two taps on "Get share link" is not a hypothetical: it is the second tap of the
 * "2 taps max" flow, on a phone, on a slow connection. A `findFirst` followed by a
 * `create` has a window exactly as wide as that double-tap, and the consequence is two
 * rows for one organiser on one drop — after which `clicks` splits and a link already
 * pasted into a group chat counts on a row nobody reads.
 *
 * So the uniqueness is a constraint (`@@unique([dropId, organiserId])`) and the write
 * is an `upsert`. The second tap cannot create a second row; it returns the first one.
 */

export type ShareableDropRow = {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly merchantName: string;
  readonly merchantTimezone: string;
  readonly dealPriceCents: number;
  readonly menuPriceCents: number;
  readonly minQty: number;
  readonly maxQty: number;
  readonly joinedQty: number;
  readonly cutoffAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly pickupAddress: string | null;
  /** The token this organiser already has for this drop, or `null` if none yet. */
  readonly existingToken: string | null;
  /** Clicks on that link. Meaningless when `existingToken` is `null`. */
  readonly existingClicks: number;
};

/**
 * The organiser's own profile, or `null`.
 *
 * Returns `null` rather than throwing for an ORGANISER user with no profile — which is
 * exactly the account FR-906 found: it signs in, reaches `/organiser`, and has nothing
 * behind it. The page turns that into a sentence rather than a 500.
 */
export async function organiserProfileForUser(userId: string): Promise<{
  id: string;
  displayName: string;
  commissionPct: number;
} | null> {
  const profile = await prisma.organiserProfile.findUnique({
    where: { userId },
    select: { id: true, displayName: true, commissionPct: true },
  });

  if (!profile) {
    return null;
  }
  return {
    id: profile.id,
    displayName: profile.displayName,
    // `Decimal` → `number` at the boundary, as `MerchantRepo.toPct` does for the floor.
    commissionPct: Number(profile.commissionPct),
  };
}

/**
 * Drops an organiser can share right now.
 *
 * **Live only**: `PUBLISHED` and not past its cutoff. A drop that has locked or failed
 * cannot take a join, so offering it would produce a link that leads to a page saying
 * no — and the organiser would have burned their group's attention to find that out.
 *
 * The joined count is summed from participants rather than read from a counter,
 * because there is no counter: `Drop` has no `joinedQty` column, and the public page
 * computes it the same way.
 */
export async function listShareableDrops(args: {
  organiserProfileId: string;
  now?: Date;
  /**
   * Restricts the result to one drop, through the *same* filter and projection.
   *
   * Exists for `POST /api/organiser/drops/:id/share`, which needs the row's title,
   * prices and cutoff to compose the share message after minting a token. The
   * alternative was a second query with its own `select`, and that is precisely the
   * shape this module's docblock argues against: two projections of the same drop drift
   * the first time a field is added to one of them, and the symptom would be a message
   * quoting a price the page no longer shows.
   *
   * Note the filter still applies. A `dropId` naming a locked or past-cutoff drop yields
   * an empty list rather than a row — the same answer the unfiltered list gives, so a
   * caller cannot use this to read a drop the organiser page would not offer.
   */
  dropId?: string;
}): Promise<ShareableDropRow[]> {
  const now = args.now ?? new Date();

  const drops = await prisma.drop.findMany({
    where: {
      status: 'PUBLISHED',
      cutoffAt: { gt: now },
      ...(args.dropId === undefined ? {} : { id: args.dropId }),
    },
    orderBy: { cutoffAt: 'asc' },
    select: {
      id: true,
      publicCode: true,
      title: true,
      dealPriceCents: true,
      minQty: true,
      maxQty: true,
      cutoffAt: true,
      windowStart: true,
      windowEnd: true,
      merchant: {
        select: {
          name: true,
          timezone: true,
          pickupAddress: true,
          // Deliberately nothing else: no `users`, no contact column. FR-805 gives an
          // organiser aggregates, and a merchant's contact details are not theirs to
          // hold either.
        },
      },
      menuItem: { select: { menuPriceCents: true } },
      participants: { select: { qty: true } },
      shareLinks: {
        where: { organiserId: args.organiserProfileId },
        select: { token: true, clicks: true },
        take: 1,
      },
    },
  });

  return drops.map((drop) => ({
    id: drop.id,
    publicCode: drop.publicCode,
    title: drop.title,
    merchantName: drop.merchant.name,
    merchantTimezone: drop.merchant.timezone,
    dealPriceCents: drop.dealPriceCents,
    menuPriceCents: drop.menuItem.menuPriceCents,
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    joinedQty: drop.participants.reduce((sum, participant) => sum + participant.qty, 0),
    cutoffAt: drop.cutoffAt,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    pickupAddress: drop.merchant.pickupAddress,
    existingToken: drop.shareLinks[0]?.token ?? null,
    existingClicks: drop.shareLinks[0]?.clicks ?? 0,
  }));
}

/** A freshly minted token. 16 random bytes, base64url. */
function newShareToken(): string {
  const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
  if (token.length !== SHARE_TOKEN_LENGTH || !isShareToken(token)) {
    // Not a defensive nicety: if the encoding ever stops producing what `isShareToken`
    // accepts, every link generated would be rejected by the page that reads it, and
    // the symptom would be "sharing does nothing" with no error anywhere.
    throw new Error('Generated share token does not match the accepted shape.');
  }
  return token;
}

/**
 * The organiser's link for a drop, created on first request and stable afterwards.
 *
 * `upsert` on the `[dropId, organiserId]` unique index: the second tap finds the row
 * the first tap made, and a genuinely concurrent pair cannot produce two rows.
 *
 * Returns `null` when the drop is not shareable *for this organiser* — not published,
 * past cutoff, or nonexistent. The page's own list already filters for that, so this is
 * the check that a stale tab cannot bypass: a page open since before the cutoff must not
 * mint a link for a drop that has since locked.
 *
 * ## Why `created` is returned, and what it is *not* good for
 *
 * `upsert` cannot report whether it inserted or matched, so the classification comes
 * from a `findUnique` before it. That read is **advisory**: a concurrent second tap can
 * see no row, then find one after its own upsert, and report `created: true` for a link
 * this call did not create. Nothing depends on it being exact — the row count is
 * guaranteed by the unique index, not by this flag — because its only consumer is a log
 * line. `organiser.share_link_created` was emitted on every tap, including taps that
 * found an existing link, so the event named a creation that had not happened; with a
 * second entry point emitting it (gap 18) that would have been wrong twice as often.
 *
 * The alternative — inferring from `createdAt` — was rejected: it would be exact only if
 * the clock and the database agreed to the millisecond, and reading a floor from a column
 * that cannot store it is the mistake this codebase already recorded once.
 */
export async function ensureShareLink(args: {
  organiserProfileId: string;
  dropId: string;
  now?: Date;
}): Promise<{ token: string; created: boolean } | null> {
  const now = args.now ?? new Date();

  const drop = await prisma.drop.findUnique({
    where: { id: args.dropId },
    select: { id: true, merchantId: true, status: true, cutoffAt: true },
  });

  if (!drop || drop.status !== 'PUBLISHED' || drop.cutoffAt <= now) {
    return null;
  }

  // Advisory — see the docblock. Ordered before the upsert so the common case (a second
  // tap on an existing link) reads what is already there.
  const existing = await prisma.shareLink.findUnique({
    where: {
      dropId_organiserId: { dropId: drop.id, organiserId: args.organiserProfileId },
    },
    select: { token: true },
  });

  const link = await prisma.shareLink.upsert({
    where: {
      dropId_organiserId: { dropId: drop.id, organiserId: args.organiserProfileId },
    },
    update: {},
    create: {
      token: newShareToken(),
      dropId: drop.id,
      merchantId: drop.merchantId,
      organiserId: args.organiserProfileId,
    },
    select: { token: true },
  });

  return { token: link.token, created: existing === null };
}

/**
 * The share link a token names, **only if it belongs to that drop**.
 *
 * Returns `null` for a token that is malformed, unknown, or real but attached to a
 * different drop. All three are the same answer on purpose: the caller is a public
 * page, and distinguishing "unknown token" from "someone else's token" tells a stranger
 * which of their guesses was close.
 *
 * The drop check is the part that matters. Without it, a token from drop A placed on
 * drop B's URL would credit the organiser for a drop they never shared — attribution is
 * a payment input (FR-804), so a token that works anywhere is a token that can be
 * farmed.
 */
export async function resolveShareToken(args: {
  token: string;
  dropId: string;
}): Promise<{ shareLinkId: string; organiserId: string } | null> {
  if (!isShareToken(args.token)) {
    return null;
  }

  const link = await prisma.shareLink.findUnique({
    where: { token: args.token },
    select: { id: true, organiserId: true, dropId: true },
  });

  if (!link || link.dropId !== args.dropId) {
    return null;
  }
  return { shareLinkId: link.id, organiserId: link.organiserId };
}

/**
 * One click on an organiser's link.
 *
 * Called only for a request that looks like a person reading the page — the same
 * `isHumanView` gate `deal_page_viewed` uses, because the reason is identical: every
 * share is fetched by WhatsApp's or WeChat's unfurler to build the link card, so an
 * unfiltered counter measures sharing *effort* rather than reach. The caller decides;
 * this function only increments.
 *
 * A failure is swallowed. A click counter is not worth failing a diner's page load for.
 */
export async function countShareLinkClick(shareLinkId: string): Promise<void> {
  await prisma.shareLink
    .update({ where: { id: shareLinkId }, data: { clicks: { increment: 1 } } })
    .catch(() => undefined);
}
