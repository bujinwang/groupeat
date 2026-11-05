import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/prisma';
import { normalisePublicCode } from '@/lib/drops/public-code';
import { isGuardrailError, readGuardrailSnapshot } from '@/lib/guardrail';

/**
 * The diner's read path — the only database access in the app that is **not**
 * merchant-scoped.
 *
 * ## Why this lives outside `lib/db/drops.ts`
 *
 * Every function in that module takes `merchantIds` and filters by it, which is
 * the property that makes a foreign id a 404 rather than a 403. A public lookup
 * by definition has no merchant scope, so putting it there would weaken the one
 * rule that module enforces. Here the "scope" is the `publicCode` — a bearer
 * token, generated from `node:crypto` — and the status filter below.
 *
 * ## The status filter includes `FAILED`, and that is a fix
 *
 * A failed drop must stay reachable. A diner who joined taps the same link they
 * used to join; if that link 404s, the only reasonable inference is "I have been
 * charged and nobody will tell me". PRD-v1 FR-306 requires the page to say
 * "nobody was charged", which is impossible if the page does not exist.
 *
 * `DRAFT` is still invisible: an unpublished drop has no price commitment behind
 * it, so a guessed code must not reveal one.
 *
 * ## `CANCELLED` was missing, and that was a bug found by rendering the page
 *
 * This list did not contain `CANCELLED`, so `getPublicDrop` returned `null` for a drop
 * that had been called off and `/d/:publicCode` answered **404** — to a diner whose
 * order may already have been captured and refunded. The reasoning that put `FAILED`
 * here applies to it word for word: the diner taps the same link they joined with, and a
 * 404 reads as "I have been charged and nobody will tell me".
 *
 * What made it invisible to review is that the *page* is full of cancellation copy —
 * `headlineFor`'s `CANCELLED` branch, a whole paragraph keyed on `hadCaptures`, and two
 * more arms in the blocked-join wording — every one of them unreachable through the only
 * function that feeds the page. The copy was written, tested at the `resolveDropView`
 * level, and connected to nothing. A render test is what surfaced it: the fixture was
 * created, the assertion on the refunded sentence was written, and the page 404'd.
 *
 * `cancelDrop` cannot capture (`it requires PUBLISHED`), and `forceFailDrop` refunds
 * before writing the status — so on every reachable path a cancelled drop has no live
 * holds by the time it is read. Nothing is disclosed by listing it that the diner does
 * not already know about their own order.
 */
export const PUBLIC_VISIBLE_STATUSES = [
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type PublicDrop = {
  id: string;
  /**
   * Who is running the drop.
   *
   * Exposed for analytics only (`deal_page_viewed`, `join_*`). It is an opaque id
   * and is already in the URL's page, so it discloses nothing a viewer could not
   * infer — but it is deliberately **not** rendered, because a diner deciding
   * whether to tap cares about the restaurant's name, not its row id.
   */
  merchantId: string;
  publicCode: string;
  title: string;
  description: string | null;
  heroImageUrl: string | null;
  dealPriceCents: number;
  /**
   * The "was" price.
   *
   * Read from the frozen snapshot, not from the dish. PRD-v1 §15.2 requires a
   * discount to reference the real recorded menu price, and the recorded price is
   * the one that was true when the deal was struck. A merchant who re-priced the
   * dish this morning must not silently change the discount on a drop that was
   * announced last week — that is FR-207's rule, applied to the public page.
   */
  menuPriceCents: number;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
  windowStart: Date;
  windowEnd: Date;
  cutoffAt: Date;
  status: string;
  merchantName: string;
  merchantAddress: string | null;
  merchantInstructions: string | null;
  timeZone: string;
  itemName: string;
  itemPhotoUrl: string | null;
  /** Units from participants whose card authorisation is still live. */
  joinedQty: number;
  /**
   * True when at least one `Order` row exists — money actually moved.
   *
   * This is what lets the page distinguish the two ways a drop can fail: below the
   * threshold (nobody charged) and below the 90 % capture tolerance after cards
   * were charged and refunded (design §7). One `take: 1` read answers it; no count
   * is needed because the question is boolean.
   */
  hadCaptures: boolean;
};

const PUBLIC_SELECT = {
  id: true,
  merchantId: true,
  publicCode: true,
  title: true,
  description: true,
  heroImageUrl: true,
  dealPriceCents: true,
  minQty: true,
  maxQty: true,
  maxPerCustomer: true,
  windowStart: true,
  windowEnd: true,
  cutoffAt: true,
  status: true,
  guardrailSnapshot: true,
  merchant: {
    select: { name: true, pickupAddress: true, pickupInstructions: true, timezone: true },
  },
  menuItem: { select: { name: true, photoUrl: true, menuPriceCents: true } },
  // Only live authorisations count toward the threshold. A `VOIDED` or `EXPIRED`
  // participant is not a claimed plate, and counting them would show a drop as
  // fuller than it is — the exact dishonesty FR-304 is written against.
  participants: { where: { authStatus: 'AUTHORIZED' }, select: { qty: true } },
  // One row, if any. The public page only needs to know *whether* money moved
  // (design §7), so this is a `take: 1` rather than a count: the difference
  // between one order and forty does not change the sentence.
  orders: { select: { id: true }, take: 1 },
} as const;

/**
 * `null` when the code does not exist or the drop is not public.
 *
 * ## Why the code is normalised here, and why the shape check is *not* here
 *
 * Every diner-facing surface reads a code through this function — the deal page, the
 * join page, the order page, the OpenGraph card and the count API — so this is the one
 * place a code can be normalised once instead of five times. `normalisePublicCode` strips
 * what pasting and typing actually produce: surrounding whitespace, a `?o=` query string,
 * a `#fragment`, a whole pasted URL, and the hyphens people add when transcribing. So
 * `/d/aumw15yfow1/` now resolves the same drop as `/d/AUMW15YFOW1` and
 * `https://groupeat.ca/d/AUMW15YFOW1?o=abc` pasted into the bar does too.
 *
 * `isWellFormedPublicCode` is deliberately **not** used as a gate, and the reason is
 * measured rather than stylistic: **55 of the 57 drops in the dev database have codes
 * that fail the shape check** (`SL17937383601698`, `AUMW15RE9H1` — fixture codes, longer
 * and shorter than eight characters), and every one of them is a `FAILED` drop. Those are
 * exactly the drops the section above says must stay reachable, because the diner who
 * joined taps the same link and needs to read "nobody was charged". A shape gate here
 * would have converted 55 working explanations into 404s.
 *
 * That asymmetry is worth stating plainly, because it is the reason a "validate your
 * input" reflex is wrong here: **normalisation is idempotent on every stored code** (0 of
 * 57 changed, 0 normalised to empty), so it cannot break a reachable drop. A gate can, and
 * does. The gate stays a generator-side invariant — `createDraft` mints codes from the
 * 30-symbol alphabet — rather than a lookup-side rejection.
 *
 * Normalising also means the lookup is no longer a raw path segment. It is still not
 * *validated*, so the 404 for a wrong-shaped code remains indistinguishable from the 404
 * for a nonexistent one, which is the property the module header claims.
 */
export async function getPublicDrop(publicCode: string): Promise<PublicDrop | null> {
  const row = await prisma.drop.findFirst({
    where: {
      publicCode: normalisePublicCode(publicCode),
      status: { in: [...PUBLIC_VISIBLE_STATUSES] },
    },
    select: PUBLIC_SELECT,
  });

  return row ? toPublicDrop(row) : null;
}

/**
 * FR-206 — the one read that may return a `DRAFT`, and the scope that makes it safe.
 *
 * > `FR-206 | Merchant previews the real deal page | Preview renders the actual public
 * > page with ?preview=1` — PRD-v1.md:459
 *
 * `getPublicDrop` deliberately excludes `DRAFT`, and that exclusion is asserted because
 * it is the privacy boundary: a guessed code must not reveal an unpublished price. A
 * preview cannot relax that boundary, so it does not live in `getPublicDrop` at all —
 * it is a second function with a second, narrower `where`: the code **and** the
 * merchant scope from the signed-in user's `MerchantUser` rows, **and** `DRAFT`.
 *
 * The merchant scope is the only thing standing between a public URL and someone else's
 * unpublished drop, so it is a query predicate rather than a check applied to the result.
 * A caller that passes an empty scope gets `null` without touching the database, and a
 * caller with one merchant cannot see a draft belonging to another even when the code is
 * correct.
 *
 * Only `DRAFT` is previewable. A published drop is already visible through
 * `getPublicDrop`; a failed or cancelled one is visible too, and previewing it would
 * give a merchant a page with no additional information. The narrow status is also a
 * second lock: a bug in the page's preview condition cannot turn a settled drop into a
 * preview.
 */
export async function getPreviewDrop(
  publicCode: string,
  merchantIds: readonly string[],
): Promise<PublicDrop | null> {
  if (merchantIds.length === 0) {
    return null;
  }

  const row = await prisma.drop.findFirst({
    where: {
      publicCode: normalisePublicCode(publicCode),
      merchantId: { in: [...merchantIds] },
      status: 'DRAFT',
    },
    select: PUBLIC_SELECT,
  });

  return row ? toPublicDrop(row) : null;
}

type PublicDropRow = Prisma.DropGetPayload<{ select: typeof PUBLIC_SELECT }>;

/**
 * One row → the wire shape, in one place.
 *
 * Extracted when preview was added, because the two reads must produce **byte-identical**
 * values for every shared field; a merchant previewing a draft and then viewing the
 * published drop should see the same page, not two mappings that drifted on `joinedQty`
 * or the frozen menu price.
 */
function toPublicDrop(row: PublicDropRow): PublicDrop {
  return {
    id: row.id,
    merchantId: row.merchantId,
    publicCode: row.publicCode,
    title: row.title,
    description: row.description,
    heroImageUrl: row.heroImageUrl,
    dealPriceCents: row.dealPriceCents,
    menuPriceCents: frozenMenuPrice(row.guardrailSnapshot, row.menuItem.menuPriceCents),
    minQty: row.minQty,
    maxQty: row.maxQty,
    maxPerCustomer: row.maxPerCustomer,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    cutoffAt: row.cutoffAt,
    status: row.status,
    merchantName: row.merchant.name,
    merchantAddress: row.merchant.pickupAddress,
    merchantInstructions: row.merchant.pickupInstructions,
    timeZone: row.merchant.timezone,
    itemName: row.menuItem.name,
    itemPhotoUrl: row.menuItem.photoUrl,
    joinedQty: row.participants.reduce((total, participant) => total + participant.qty, 0),
    hadCaptures: row.orders.length > 0,
  };
}

/**
 * The menu price as it was when the drop was published.
 *
 * `readGuardrailSnapshot` throws on a shape it does not understand — deliberately,
 * because casting a stale blob turns into silently wrong money on a report. On a
 * *public page* the right response to an unreadable snapshot is not a 500 for a
 * diner holding a link; it is to fall back to the dish's current price and let the
 * page render. The fallback is imperfect (it may show a discount that differs from
 * the one announced) and it is the lesser evil of the two available.
 */
function frozenMenuPrice(snapshot: unknown, currentMenuPriceCents: number): number {
  try {
    return readGuardrailSnapshot(snapshot).input.menuPriceCents;
  } catch (error) {
    if (!isGuardrailError(error)) {
      throw error;
    }
    return currentMenuPriceCents;
  }
}
