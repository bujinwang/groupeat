import { prisma } from '@/lib/db/prisma';
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
 */

export const PUBLIC_VISIBLE_STATUSES = [
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
] as const;

export type PublicDrop = {
  id: string;
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
};

const PUBLIC_SELECT = {
  id: true,
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
} as const;

/** `null` when the code does not exist or the drop is not public. */
export async function getPublicDrop(publicCode: string): Promise<PublicDrop | null> {
  const row = await prisma.drop.findFirst({
    where: { publicCode, status: { in: [...PUBLIC_VISIBLE_STATUSES] } },
    select: PUBLIC_SELECT,
  });

  if (!row) {
    return null;
  }

  return {
    id: row.id,
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
