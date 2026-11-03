import { prisma } from '@/lib/db/prisma';

/**
 * FR-901 — every drop, filterable by status, with the figures an operator needs to act.
 *
 * > `FR-901 | List/filter all drops by status |` — PRD-v1.md:548
 *
 * ## Why this is not `db/drops.ts`
 *
 * `db/drops.ts` is **merchant-scoped by construction**: every function takes
 * `merchantIds` and filters by it, which is what makes a foreign drop id a 404. An
 * admin list is the opposite question — it spans tenants on purpose — so it cannot
 * reuse that module without either passing every merchant id (a query that grows with
 * the customer base) or adding an "all" escape hatch to the one module whose whole job
 * is to be scoped. The escape hatch is how a scoped query eventually gets called
 * unscoped from a merchant page.
 *
 * So there are two modules with two shapes, and this one is only ever reachable from
 * `requireAdmin`.
 *
 * ## What the row carries, and why each field earned its place
 *
 * The list exists so an operator can decide, on the phone, what to do about a drop.
 * That means it needs the thing being decided about (`status`), who it belongs to
 * (`merchantName`, so they can say it out loud), how big it is (`joinedQty`/`minQty`,
 * the demand question), and **how much money is exposed** (`capturedCents`) — which is
 * the number that makes a force-fail feel like the right or wrong idea, and the number
 * the confirmation dialog must show back.
 *
 * `capturedCents` is summed from `Order.subtotalCents` minus `Order.refundedCents`, so
 * it is what is *still out there* rather than what was ever charged. A drop that was
 * already partly refunded by hand (FR-903) must not present its original total as the
 * amount at risk.
 */

/** Every `DropStatus`, for the filter chips and for validating a `?status=` query. */
export const ADMIN_DROP_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type AdminDropStatus = (typeof ADMIN_DROP_STATUSES)[number];

/**
 * Narrows a query-string value to a status.
 *
 * Takes `string | undefined` and returns `null` for anything else — an unknown
 * `?status=WHATEVER` must not throw a 500 at an operator, and it must not silently
 * show every drop either, because a filter that quietly does nothing looks like the
 * filter found no matches. The page and the route both treat `null` as "no filter" and
 * the page says so in words.
 */
export function parseAdminDropStatus(value: string | undefined): AdminDropStatus | null {
  if (!value) {
    return null;
  }
  return (ADMIN_DROP_STATUSES as readonly string[]).includes(value)
    ? (value as AdminDropStatus)
    : null;
}

export type AdminDropRow = {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantTimezone: string;
  readonly dealPriceCents: number;
  readonly minQty: number;
  readonly maxQty: number;
  /** Sum of `DropParticipant.qty`. The demand figure, not a row count. */
  readonly joinedQty: number;
  readonly participantCount: number;
  /** Money that moved and has **not** been returned: `subtotal − refunded`, per order. */
  readonly capturedCents: number;
  readonly refundedCents: number;
  readonly cutoffAt: Date;
  readonly createdAt: Date;
};

export type AdminDropList = {
  readonly rows: readonly AdminDropRow[];
  /** Counts across **all** drops, ignoring the current filter, so the chips can show them. */
  readonly countsByStatus: Readonly<Record<AdminDropStatus, number>>;
  /**
   * Every drop in the table, filtered or not.
   *
   * Separate from `rows.length` on purpose, and this is the field a chip bar gets
   * wrong: an "All" chip that renders `rows.length` shows the *filtered* count, so
   * under `?status=FAILED` it reads "All 3" next to "FAILED 3" — plausible-looking
   * and useless, exactly the bug the unfiltered `groupBy` above exists to avoid.
   * Derived from that same read so the two cannot drift.
   */
  readonly totalDrops: number;
  /** Money still exposed across the **listed** rows, which under a filter is a subset. */
  readonly totalCents: number;
};

/**
 * The list. `status` is the only filter V1 needs — FR-901 says "filter by status" and
 * nothing else, and a merchant picker on this screen would be a second navigation
 * problem to solve.
 */
export async function listAdminDrops(args: {
  status?: AdminDropStatus | null;
  /** Cap. The PRD gives no number; 100 is a screenful-and-a-half and keeps the query bounded. */
  limit?: number;
} = {}): Promise<AdminDropList> {
  const limit = args.limit ?? 100;

  // One read for the page, and one for the counts. The counts cannot be derived from
  // an already-filtered list (that is the bug a chip counter usually has: it shows how
  // many of the *shown* rows have each status, which is always the filter itself).
  const [drops, grouped] = await Promise.all([
    prisma.drop.findMany({
      where: args.status ? { status: args.status } : {},
      orderBy: [{ status: 'asc' }, { cutoffAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        publicCode: true,
        title: true,
        status: true,
        dealPriceCents: true,
        minQty: true,
        maxQty: true,
        cutoffAt: true,
        createdAt: true,
        merchantId: true,
        merchant: { select: { name: true, timezone: true } },
        participants: { select: { qty: true } },
        orders: { select: { subtotalCents: true, refundedCents: true } },
      },
    }),
    prisma.drop.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);

  const countsByStatus = Object.fromEntries(
    ADMIN_DROP_STATUSES.map((status) => [status, 0]),
  ) as Record<AdminDropStatus, number>;
  for (const group of grouped) {
    if ((ADMIN_DROP_STATUSES as readonly string[]).includes(group.status)) {
      countsByStatus[group.status as AdminDropStatus] = group._count._all;
    }
  }

  let totalCents = 0;
  const rows: AdminDropRow[] = drops.map((drop) => {
    // Still out there, not ever-charged: the subtraction is what keeps a partly
    // refunded drop from reporting its original total as exposed money.
    const capturedCents = drop.orders.reduce(
      (total, order) => total + order.subtotalCents - order.refundedCents,
      0,
    );
    const refundedCents = drop.orders.reduce((total, order) => total + order.refundedCents, 0);
    totalCents += capturedCents;

    return {
      id: drop.id,
      publicCode: drop.publicCode,
      title: drop.title,
      status: drop.status,
      merchantId: drop.merchantId,
      merchantName: drop.merchant.name,
      merchantTimezone: drop.merchant.timezone,
      dealPriceCents: drop.dealPriceCents,
      minQty: drop.minQty,
      maxQty: drop.maxQty,
      joinedQty: drop.participants.reduce((total, participant) => total + participant.qty, 0),
      participantCount: drop.participants.length,
      capturedCents,
      refundedCents,
      cutoffAt: drop.cutoffAt,
      createdAt: drop.createdAt,
    };
  });

  return { rows, countsByStatus, totalDrops: Object.values(countsByStatus).reduce((a, b) => a + b, 0), totalCents };
}
