import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/prisma';

import { type ManifestRow, type ManifestSummary, phoneLast4, summariseManifest } from './rules';

/**
 * The batch face of FR-604 — "the pickup table, not a text input".
 *
 * ## What this query is for
 *
 * A staff member with a phone can scan one order at a time. That is the wrong tool
 * at 6pm with nine orders on a warmer: the question is not "is this code good", it
 * is "which of these bags is still unclaimed". This reads the whole drop so the
 * answer is on one screen, and `summariseManifest` counts it.
 *
 * ## The status filter, and why it is not `isRedeemableStatus`
 *
 * A manifest is shown for a drop whose window has opened, but it is also the thing
 * a merchant opens when a diner calls to say "I'm five minutes away". Refusing to
 * show the list because the status is `CAPTURED` would be exactly wrong — the list
 * exists to tell you who is coming. Redemption still refuses on its own; this is a
 * read, and a read that over-restricts is a read that gets worked around with a
 * spreadsheet.
 *
 * So: any status, but the drop must be **yours**. That is the only rule that
 * protects anything here.
 *
 * ## PII
 *
 * `phoneLast4` and a name, never the number. FR-805's minimisation applies to the
 * staff screen too: a name plus four digits matches a face at a counter, and a
 * full number identifies someone afterwards. The full phone is not selected from
 * the database at all, so it cannot leak into a response by accident — the redaction
 * happens in the `select`, not in a formatter a future refactor might drop.
 */

export type Manifest = {
  readonly dropId: string;
  readonly title: string;
  readonly status: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly timeZone: string;
  readonly rows: readonly ManifestRow[];
  readonly summary: ManifestSummary;
};

/**
 * The load. Throws 404 when the drop is outside the caller's scope — a foreign id
 * is a 404, never a 403 (US-M1), same as everywhere else in this codebase.
 */
export async function loadManifest(merchantIds: readonly string[], dropId: string): Promise<Manifest> {
  if (merchantIds.length === 0) {
    throw AppError.notFound('That drop could not be found.');
  }

  const drop = await prisma.drop.findFirst({
    where: { id: dropId, merchantId: { in: [...merchantIds] } },
    select: {
      id: true,
      title: true,
      status: true,
      windowStart: true,
      windowEnd: true,
      merchant: { select: { timezone: true } },
      participants: {
        select: {
          id: true,
          qty: true,
          redeemedQty: true,
          redeemedAt: true,
          // Only the last four digits are needed, and Prisma cannot slice a column.
          // The full value is fetched here and narrowed immediately, which is the
          // one place it exists in memory — see the note above on why this is not a
          // formatting decision made later.
          customer: { select: { name: true, phone: true } },
        },
        /**
         * Who is still owed food, first.
         *
         * The list is worked top-down at a counter, so the ordering has to be the
         * order of work: outstanding orders, then collected ones as a receipt. The
         * secondary key is `createdAt` so the list does not reshuffle between two
         * loads of the same screen — a list that reorders under a finger is how a
         * staff member hands over the wrong bag.
         */
        orderBy: [{ redeemedQty: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });

  if (!drop) {
    throw AppError.notFound('That drop could not be found.');
  }

  const rows: ManifestRow[] = drop.participants.map((row) => ({
    participantId: row.id,
    name: row.customer.name,
    phoneLast4: phoneLast4(row.customer.phone),
    qty: row.qty,
    redeemedQty: row.redeemedQty,
    redeemedAt: row.redeemedAt,
  }));

  return {
    dropId: drop.id,
    title: drop.title,
    status: drop.status,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    timeZone: drop.merchant.timezone,
    rows,
    summary: summariseManifest(rows),
  };
}

/**
 * The drops that are plausibly at a counter right now, for the screen's drop
 * picker: window open, or about to open, or recently closed.
 *
 * `PICKUP_OPEN` and `COMPLETED` only, because those are the two statuses a
 * manifest is actually worked from, and anything wider would put every drop a
 * merchant has ever run in front of a staff member at 6pm. `CAPTURED` is included
 * deliberately: the window is defined by `windowStart`, and a merchant who opens
 * the screen early should see the drop waiting rather than an empty list.
 */
export async function listCounterDrops(merchantIds: readonly string[], now: Date): Promise<
  { id: string; title: string; status: string; windowStart: Date; windowEnd: Date; outstanding: number }[]
> {
  if (merchantIds.length === 0) {
    return [];
  }

  const drops = await prisma.drop.findMany({
    where: {
      merchantId: { in: [...merchantIds] },
      status: { in: ['CAPTURED', 'PICKUP_OPEN', 'COMPLETED'] },
      windowEnd: { gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
    },
    orderBy: { windowStart: 'asc' },
    take: 20,
    select: {
      id: true,
      title: true,
      status: true,
      windowStart: true,
      windowEnd: true,
      participants: { select: { qty: true, redeemedQty: true } },
    },
  });

  return drops.map((drop) => ({
    id: drop.id,
    title: drop.title,
    status: drop.status,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    // Plates still owed, not plates sold: a screen that opens on "9 orders" when
    // eight are collected is a screen a staff member stops trusting.
    outstanding: drop.participants.reduce(
      (sum, row) => sum + Math.max(row.qty - row.redeemedQty, 0),
      0,
    ),
  }));
}
