import { countAnalyticsEvents } from '@/lib/analytics/read-counts';
import {
  computeNorthStar,
  type NorthStarFacts,
  type NorthStarMetrics,
} from '@/lib/metrics/north-star';

import { prisma } from './prisma';

/**
 * The north-star dashboard's reads.
 *
 * Four flat queries rather than one graph: drops with their ever-authorised
 * participants, merchants' first publish, share-link coverage, and captured
 * participants for redemption/repeat/new-customer. The arithmetic is pure
 * (`lib/metrics/north-star.ts`); this module only supplies the facts.
 *
 * ## Why captured participants are the root for three metrics
 *
 * An `Order` means money was taken. A participant row without one is an authorisation
 * that was voided or declined — a real join attempt, but not a customer. Redemption,
 * repeat participation and new-customer share all ask questions about customers who
 * bought, so all three start from the order relation, the same rule `lib/db/reports.ts`
 * documents.
 *
 * ## Why the analytics read is separate
 *
 * `deal_page_viewed` and `join_authorised` live in the append-only JSONL sink, not in
 * Postgres. The reader returns zeros for a missing file; the page renders "not
 * measured" rather than a 0% conversion.
 */
export async function loadNorthStarMetrics(): Promise<NorthStarMetrics> {
  const [decidedDrops, merchants, sharedDrops, publishedDrops, capturedParticipants, analytics] =
    await Promise.all([
      prisma.drop.findMany({
        where: {
          status: { in: ['LOCKED', 'CAPTURED', 'PICKUP_OPEN', 'COMPLETED', 'FAILED'] },
        },
        select: {
          status: true,
          minQty: true,
          participants: { select: { qty: true, authStatus: true } },
        },
      }),
      prisma.merchant.findMany({
        select: {
          createdAt: true,
          drops: {
            where: { publishedAt: { not: null } },
            orderBy: { publishedAt: 'asc' },
            take: 1,
            select: { publishedAt: true },
          },
        },
      }),
      prisma.drop.findMany({
        where: { shareLinks: { some: {} } },
        select: { id: true },
      }),
      prisma.drop.findMany({
        where: { publishedAt: { not: null } },
        select: { id: true },
      }),
      prisma.dropParticipant.findMany({
        where: { order: { isNot: null } },
        select: {
          customerId: true,
          qty: true,
          redeemedQty: true,
          order: { select: { createdAt: true } },
        },
      }),
      countAnalyticsEvents(['deal_page_viewed', 'join_authorised']),
    ]);

  const facts: NorthStarFacts = {
    decidedDrops,
    merchants: merchants.map((merchant) => ({
      createdAt: merchant.createdAt,
      firstPublishedAt: merchant.drops[0]?.publishedAt ?? null,
    })),
    sharedDropIds: sharedDrops.map((drop) => drop.id),
    publishedDropIds: publishedDrops.map((drop) => drop.id),
    orders: capturedParticipants.flatMap((participant) =>
      participant.order
        ? [{ customerId: participant.customerId, createdAt: participant.order.createdAt }]
        : [],
    ),
    redemption: capturedParticipants.map((participant) => ({
      qty: participant.qty,
      redeemedQty: participant.redeemedQty,
    })),
    analytics: {
      dealPageViewed: analytics.deal_page_viewed ?? 0,
      joinAuthorised: analytics.join_authorised ?? 0,
    },
  };

  return computeNorthStar(facts);
}
