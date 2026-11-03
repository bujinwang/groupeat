import { prisma } from '@/lib/db/prisma';

import {
  COMMISSION_PERIOD_TZ,
  buildCommissionLine,
  commissionBasisPoints,
  commissionPeriodFor,
  monthKeyOf,
  organiserSlug,
  parseCommissionPeriod,
  totalsFor,
} from '@/lib/organisers/commission';
import type {
  CommissionLineRow,
  CommissionOrderFact,
  CommissionPeriod,
  CommissionTotals,
} from '@/lib/organisers/commission';

/**
 * FR-804 — the commission statement, as a query.
 *
 * > `FR-804 | Commission statement: units × 5% of captured GMV | Monthly,
 * > exportable` — PRD-v1.md:539
 *
 * The arithmetic lives in `src/lib/organisers/commission.ts` and is pure. This module
 * only fetches the facts that arithmetic needs, and every decision below is about
 * fetching the *right* facts — because each wrong fetch produces a number that is
 * plausible, printable, and wrong.
 *
 * ## The statement is a live query. There is no `CommissionPayout` table.
 *
 * `Order` stores cumulative `refundedCents`, not a refund timestamp, so a refund that
 * lands in April cannot be attributed to its own month without a column that does not
 * exist. Two options followed from that: freeze a month when it is paid (a payout row
 * per organiser per month), or leave the statement live and say so out loud.
 *
 * Live, deliberately. A `CommissionPayout` table is a schema consequence of a
 * *process* decision — "a month is closed when we transfer" — that no one has made;
 * adding it now would encode a workflow (provisional vs paid, who closes a month, what
 * happens to a correction) into a migration before the beta has run once. So the
 * statement recomputes, **a refund landing after a month was paid restates that
 * month**, and the page says so in words. `refunded_cents` is a column on every line
 * precisely so a changed figure is explainable instead of mysterious: the operator
 * compares the export they paid from against today's figure and sees the refund.
 *
 * The record of what was transferred is the export taken at payment time. That is a
 * weaker guarantee than a payout row, and it is the honest one for a product where a
 * human moves the money by e-transfer.
 *
 * ## Start from `Order`, never from `DropParticipant`
 *
 * A participant row means "this person was authorised". It does not mean "money was
 * taken": a join authorises the card, and capture happens at cutoff. A participant
 * with no `Order` is a card that was authorised and never charged — it contributes
 * `0` units and `0` cents, and any aggregate that starts from `DropParticipant` counts
 * money that was never taken. So every figure here starts at `Order` and walks
 * outward.
 *
 * `DropParticipant.shareLinkId IS NULL` belongs to nobody: that diner arrived through
 * a plain link, so no organiser is credited and the row is excluded by the filter
 * rather than summed as zero.
 *
 * ## Attribute through `participant.shareLinkId`, never `Order.dropId = ShareLink.dropId`
 *
 * A drop has **one `ShareLink` per organiser** (`@@unique([dropId, organiserId])`).
 * Joining orders to links on `dropId` therefore matches every order in the drop
 * against every link on the drop — so each organiser is credited with the whole drop,
 * and two organisers who shared one drop are each paid the full amount. It is a
 * single-character change, it passes type checking, and it is invisible in every
 * single-organiser test. AC8 exists for it.
 *
 * ## A line's presence is decided by activity, not by money
 *
 * A link nobody joined is noise and is absent — which falls out for free here, because
 * lines are grouped from orders and a link with no orders has nothing to group. A link
 * whose orders netted `$0.00` (a force-failed drop) **must** appear: the organiser
 * worked that drop, and "why did this pay nothing" is a support ticket unless the row
 * is there with `drop_status = FAILED` beside it. AC9 asserts both halves.
 *
 * ## The commission rate has no history column, and this is where that bites
 *
 * `OrganiserProfile.commissionPct` is a single mutable `Decimal(5,2)`. **Policy: a rate
 * change takes effect for the whole month in which it is set; ops do not change rates
 * mid-month.** Stated here because this is the module that reads the rate, and the
 * consequence is not hypothetical:
 *
 *   - a rate changed on the 20th restates the whole month, including the nineteen days
 *     already worked at the old rate, and there is nothing to compare against to notice;
 *   - the figure for a closed month is therefore only reproducible while the rate is
 *     unchanged, and **the export taken at payment time is the record** — the same
 *     consequence as a late refund, from a different cause.
 *
 * The alternative — snapshotting the rate per line — needs a column on `Order` or a new
 * table, and that is a migration. The policy is cheaper than the column and is the one
 * ops can actually follow at 5–15 organisers.
 *
 * ## Why the profile is re-read here instead of accepted as an argument
 *
 * The caller has already resolved the profile to decide whether to render a statement
 * at all. Passing its `commissionPct` in would let a statement be computed at a rate
 * from an object assembled at some other moment — and the one number that must be the
 * rate *now* is the multiplier on every line. One extra `findUnique` is the price of
 * not being able to get that wrong.
 */

/** Everything the page and the CSV route need, in one shape, computed once. */
export type CommissionStatement = {
  readonly organiserProfileId: string;
  readonly organiserName: string;
  /** Filename-safe, derived from the display name. See `organiserSlug`. */
  readonly organiserSlug: string;
  readonly monthKey: string;
  readonly periodFrom: Date;
  readonly periodTo: Date;
  readonly commissionBasisPoints: number;
  readonly lines: readonly CommissionLineRow[];
  readonly totals: CommissionTotals;
};

/** One `ShareLink`'s orders, accumulated before they become a line. */
type LineGroup = {
  dropId: string;
  merchantName: string;
  dropTitle: string;
  dropStatus: CommissionLineRow['dropStatus'];
  windowStart: Date;
  merchantTimezone: string;
  orders: CommissionOrderFact[];
};

/**
 * The organiser's statement for one month, or `null` if they have no profile.
 *
 * `null` rather than a throw for a profile-less ORGANISER: that account exists
 * (FR-906), it signs in, and the page turns it into a sentence. A throw here would be
 * a 500 on a state that is known and fixable.
 *
 * `monthKey` must already be validated, and the two callers validate it differently on
 * purpose. The page resolves `?month=` through `resolveCommissionMonth`, which falls
 * back to the current month **and reports that it did**, so a hand-edited URL renders
 * something and says so. The CSV route refuses a malformed month with a 400 instead,
 * because a file named `2026-03` whose figures are another month's corrupts the record
 * of what was paid. An invalid key reaching *this* function throws from
 * `commissionPeriodFor` rather than quietly selecting the current month, so neither
 * caller can fall back here by accident.
 */
export async function commissionStatementFor(args: {
  organiserProfileId: string;
  monthKey: string;
}): Promise<CommissionStatement | null> {
  const period: CommissionPeriod = commissionPeriodFor(args.monthKey);

  const profile = await prisma.organiserProfile.findUnique({
    where: { id: args.organiserProfileId },
    select: { id: true, displayName: true, commissionPct: true },
  });

  if (!profile) {
    return null;
  }

  // `Decimal` → `number` at the boundary, the way `organiserProfileForUser` does it.
  const basisPoints = commissionBasisPoints(Number(profile.commissionPct));

  const orders = await prisma.order.findMany({
    where: {
      // Half-open on the instant the money came into existence. `gte from, lt to` —
      // never `lte to`, or an order captured at exactly local midnight on the 1st
      // would be counted in two months.
      createdAt: { gte: period.from, lt: period.to },
      // The attribution path, spelled out: Order → DropParticipant.shareLinkId →
      // ShareLink.organiserId. Not `dropId`. See the module docblock.
      participant: { is: { shareLink: { is: { organiserId: args.organiserProfileId } } } },
    },
    // Deterministic order, so two renders of the same month cannot differ by row
    // order (AC11). The statement is re-sorted by pickup date below; this keeps the
    // grouping itself stable.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      qty: true,
      subtotalCents: true,
      refundedCents: true,
      participant: {
        select: {
          shareLink: {
            select: {
              id: true,
              drop: {
                select: {
                  id: true,
                  title: true,
                  status: true,
                  windowStart: true,
                  merchant: { select: { name: true, timezone: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const groups = new Map<string, LineGroup>();

  // Grouped by `ShareLink.id` — the attribution grain the spec names ("one `ShareLink`
  // row = one (drop, organiser) pair", enforced by `@@unique([dropId, organiserId])`).
  // Grouping by `dropId` would be the same defect as joining on it.
  for (const order of orders) {
    const shareLink = order.participant.shareLink;
    if (!shareLink) {
      // Unreachable: the `where` clause requires a share link with this organiser.
      // Skipped rather than asserted because the alternative is a `!` assertion, and
      // an assertion here would turn a Prisma filter regression into a 500 instead of
      // a smaller-but-correct statement.
      continue;
    }

    let group = groups.get(shareLink.id);
    if (!group) {
      group = {
        dropId: shareLink.drop.id,
        merchantName: shareLink.drop.merchant.name,
        dropTitle: shareLink.drop.title,
        // Prisma's `DropStatus` and the pure module's `CommissionDropStatus` are the
        // same union. If the enum grows and the pure module's list does not, this
        // assignment stops compiling — which is the point of not importing the
        // generated enum into a module that must stay Prisma-free.
        dropStatus: shareLink.drop.status,
        windowStart: shareLink.drop.windowStart,
        merchantTimezone: shareLink.drop.merchant.timezone,
        orders: [],
      };
      groups.set(shareLink.id, group);
    }

    group.orders.push({
      orderId: order.id,
      qty: order.qty,
      subtotalCents: order.subtotalCents,
      refundedCents: order.refundedCents,
    });
  }

  const lines: CommissionLineRow[] = [];

  for (const group of groups.values()) {
    // The `0 ≤ refundedCents ≤ subtotalCents` assertion runs inside this call and
    // throws naming the order. Not clamped here, and not clamped there: a clamp would
    // underpay the organiser silently and destroy the evidence of the ledger defect.
    lines.push(
      buildCommissionLine(
        {
          dropId: group.dropId,
          merchantName: group.merchantName,
          dropTitle: group.dropTitle,
          dropStatus: group.dropStatus,
          windowStart: group.windowStart,
          merchantTimezone: group.merchantTimezone,
          orders: group.orders,
        },
        basisPoints,
      ),
    );
  }

  // Sort by pickup, then drop title, then drop id. Pickup order is the order an
  // organiser reads the month in ("what did I work, in the order I worked it"), and
  // the two tie-breakers make the order total so AC11's byte-identical render holds
  // even when two drops share a pickup slot.
  lines.sort((left, right) => {
    if (left.pickupDate !== right.pickupDate) {
      return left.pickupDate < right.pickupDate ? -1 : 1;
    }
    if (left.drop !== right.drop) {
      return left.drop < right.drop ? -1 : 1;
    }
    return left.dropId < right.dropId ? -1 : left.dropId > right.dropId ? 1 : 0;
  });

  return {
    organiserProfileId: profile.id,
    organiserName: profile.displayName,
    organiserSlug: organiserSlug(profile.displayName),
    monthKey: period.monthKey,
    periodFrom: period.from,
    periodTo: period.to,
    commissionBasisPoints: basisPoints,
    lines,
    totals: totalsFor(lines),
  };
}

/**
 * The months this organiser has any captured activity in, newest first.
 *
 * For the month selector. Only months with an attributed order appear: a month with
 * nothing in it is a statement of zeros, and offering twelve of those per organiser
 * makes the one month that matters harder to find. The page adds the month currently
 * being viewed if it is not in the list, so a link to an empty month still renders.
 *
 * Selects `createdAt` only — no money columns — because the question is "which months
 * exist", and the period is resolved in code from the instants. It does join, through
 * `participant.shareLink` to the organiser, because there is no other way to ask whose
 * orders these are; what it does not do is aggregate money. Deliberately not a
 * `GROUP BY date_trunc(...)`: that would resolve the month in the *database's* zone,
 * which is the same seven-hour defect the pure module exists to avoid, one layer down.
 */
export async function commissionMonthsFor(organiserProfileId: string): Promise<string[]> {
  const orders = await prisma.order.findMany({
    where: { participant: { is: { shareLink: { is: { organiserId: organiserProfileId } } } } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const keys = new Set<string>();
  for (const order of orders) {
    keys.add(monthKeyOf(order.createdAt, COMMISSION_PERIOD_TZ));
  }

  return [...keys].sort().reverse();
}

/**
 * The current commission month, in Edmonton.
 *
 * Exists so the page and the route default to the same month without either of them
 * calling `new Date()` and formatting it themselves. `now` is a parameter for the
 * tests; production omits it.
 */
export function currentCommissionMonthKey(now: Date = new Date()): string {
  return monthKeyOf(now, COMMISSION_PERIOD_TZ);
}

/**
 * `?month=` resolved to a month key, falling back to the current month.
 *
 * The page's rule, in one place: a hand-edited or truncated URL must render the
 * current month rather than a 500. Returns what was asked for alongside what was
 * applied so a caller can say so instead of silently answering a different question.
 */
export function resolveCommissionMonth(raw: string | null | undefined): {
  readonly monthKey: string;
  readonly requested: string | null;
  readonly ignored: boolean;
} {
  const requested = typeof raw === 'string' ? raw : null;
  const parsed = parseCommissionPeriod(raw);
  return {
    monthKey: parsed ? parsed.monthKey : currentCommissionMonthKey(),
    requested,
    ignored: requested !== null && parsed === null,
  };
}
