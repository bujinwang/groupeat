import { prisma } from '@/lib/db/prisma';
import { readGuardrailSnapshot } from '@/lib/guardrail';
import {
  merchantReportFor,
  type DropReportSource,
  type MerchantReport,
  type ReportAttributionFact,
  type ReportCostBasis,
  type ReportCustomerFact,
  type ReportLedgerFact,
  type ReportOrderFact,
} from '@/lib/reports/drop-report';

/**
 * M9 — merchant reporting, as a query. FR-701…FR-703, FR-705.
 *
 * The arithmetic lives in `src/lib/reports/drop-report.ts` and is pure. This
 * module only fetches the facts it needs, and every decision below is about
 * fetching the *right* facts — because each wrong fetch produces a number that
 * is plausible, printable and wrong.
 *
 * ## Only drops that could have taken money are reported
 *
 * The selector admits `LOCKED, CAPTURED, PICKUP_OPEN, COMPLETED, FAILED,
 * CANCELLED` — every status at or past the cutoff. A `DRAFT` has no orders by
 * definition and a `PUBLISHED` drop is still taking joins, so reporting either
 * would print a row that changes under the merchant by the time they refresh.
 * `LOCKED` is included deliberately: it is the state during capture, and a
 * merchant looking at the screen while cards are being charged should see the
 * drop appear rather than see nothing and wonder.
 *
 * ## Start from `Order`, never from `DropParticipant`
 *
 * The same rule `lib/db/commission.ts` documents, for the same reason: a
 * participant row means "this person was authorised", not "money was taken". A
 * participant with no `Order` is a card that was never charged — the drop failed,
 * or their authorisation was voided — and counting it would report units the
 * merchant never sold. Every figure starts at `Order` and walks outward.
 *
 * ## Attribution goes through `participant.shareLink`, not `order.dropId = shareLink.dropId`
 *
 * A drop has one `ShareLink` per organiser (`@@unique([dropId, organiserId])`).
 * Joining orders to links on `dropId` matches every order in the drop against
 * every link on it — so two organisers who shared one drop are **each** credited
 * with the whole drop. It is a one-line change, it type-checks, and it is
 * invisible in every single-organiser test. FR-703 is precisely the feature that
 * would ship that bug, so it is called out here and asserted in the tests; the
 * pure module's `unattributedUnitsFor` is the second net.
 */

/**
 * The statuses a report may include. See the module docblock.
 *
 * Transcribed rather than imported from `@prisma/client` so this list is visible
 * next to the comment explaining it. `tsc` checks the assignment at the query
 * below, so the day the enum grows and this does not, the omission surfaces
 * there instead of as a silently missing drop.
 */
const REPORTABLE_STATUSES = [
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

/**
 * `Drop.guardrailSnapshot.input` → the cost basis contribution is recomputed from.
 *
 * `readGuardrailSnapshot` validates the stored blob and throws
 * `SNAPSHOT_UNREADABLE` for a version this build does not understand. That throw
 * is **caught** here and the drop is skipped, rather than propagated: a drop
 * published by an older build must not blank a merchant's whole report. Skipping
 * is reported through `withheldDropCount`'s sibling mechanism — the drop simply
 * has no `costBasis` and never becomes a `DropReportSource`, which the caller
 * counts.
 *
 * FR-207: these are the constants **in force at publish**, never today's
 * `DEFAULT_FEES` and never the `MenuItem`'s current costs.
 */
function costBasisFrom(stored: unknown): ReportCostBasis | null {
  try {
    const input = readGuardrailSnapshot(stored).input;
    return {
      menuPriceCents: input.menuPriceCents,
      foodCostCents: input.foodCostCents,
      packagingCents: input.packagingCents,
      platformFeePct: input.platformFeePct,
      platformFeeFloorCents: input.platformFeeFloorCents,
      platformFeeCapCents: input.platformFeeCapCents,
      stripePct: input.stripePct,
      stripeFixedCents: input.stripeFixedCents,
    };
  } catch {
    // An unreadable snapshot is a drop we cannot state a contribution for. Naming
    // it here rather than throwing keeps one old drop from blanking the page.
    return null;
  }
}

/**
 * Every reportable drop for a merchant, as report sources.
 *
 * Returns the sources **and** the count of drops dropped on the way — an
 * unreadable snapshot, or a merchant row that vanished mid-request. The caller
 * adds that count to the report's `withheldDropCount` so the page can say how many
 * drops it could not include, which is the difference between an honest report
 * and one that silently omits a drop the merchant remembers running.
 */
export async function reportSourcesFor(args: {
  merchantId: string;
  /** How many drops, newest pickup first. Bounded so the page cannot grow unbounded. */
  limit?: number;
}): Promise<{ sources: DropReportSource[]; skippedDropCount: number }> {
  const drops = await prisma.drop.findMany({
    where: {
      merchantId: args.merchantId,
      status: { in: [...REPORTABLE_STATUSES] },
    },
    orderBy: [{ windowStart: 'desc' }, { id: 'desc' }],
    take: args.limit ?? 50,
    select: {
      id: true,
      title: true,
      windowStart: true,
      minQty: true,
      maxQty: true,
      dealPriceCents: true,
      guardrailSnapshot: true,
      merchant: { select: { name: true, timezone: true } },
    },
  });

  if (drops.length === 0) {
    return { sources: [], skippedDropCount: 0 };
  }

  const dropIds = drops.map((drop) => drop.id);

  // Four reads, all keyed on the same drop id list, then assembled in memory.
  //
  // Not one query with four `include`s: a drop with 30 orders, 60 ledger rows and
  // 30 participants through a nested include is one row multiplied by every
  // relation, and Prisma's nested reads make the shape hard to reason about.
  // Four flat reads each bounded by the same id list are trivially checkable
  // against each other, which is what a reconciliation feature needs.
  const [orders, ledgerRows, participants, shareLinks] = await Promise.all([
    prisma.order.findMany({
      where: { dropId: { in: dropIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        dropId: true,
        qty: true,
        subtotalCents: true,
        platformFeeCents: true,
        refundedCents: true,
        platformFeeReversedCents: true,
        participantId: true,
      },
    }),
    prisma.ledgerEntry.findMany({
      where: { dropId: { in: dropIds } },
      select: { dropId: true, orderId: true, type: true, amountCents: true },
    }),
    prisma.dropParticipant.findMany({
      where: { dropId: { in: dropIds } },
      select: {
        id: true,
        dropId: true,
        qty: true,
        customerId: true,
        shareLinkId: true,
        /**
         * The instant this person joined. It is the cutoff for FR-702's count.
         *
         * Not decoration and not interchangeable with the drop's `windowStart`:
         * a "prior purchase" is one that happened before **this person walked in
         * the door**, which is the only reading of "returning customer" that stays
         * true when two drops on one evening are reported side by side.
         */
        createdAt: true,
        // The order is what makes a participant a *customer who bought*; a
        // participant without one was authorised and never charged.
        order: { select: { id: true } },
      },
    }),
    prisma.shareLink.findMany({
      where: { dropId: { in: dropIds } },
      select: {
        id: true,
        dropId: true,
        organiserId: true,
        organiser: { select: { displayName: true } },
      },
    }),
  ]);

  // `priorCapturedOrderCount` for every customer appearing in these drops — one
  // query, not one per participant.
  //
  // ## Why this is a time-bounded count and not "total captures minus one"
  //
  // The first version of this query counted **every** captured order each customer
  // had, then subtracted one for the order on the drop being reported. It is wrong,
  // and the wrongness is the kind that only appears once a customer buys twice:
  // reporting January's drop in March counted the February and March purchases as
  // "prior", so a customer whose *first ever* purchase was in January was reported
  // as returning on January's report. The report would have time-travelled — its
  // output for a past drop would change every time a customer bought again.
  //
  // The cutoff is `participant.createdAt` — the instant this person joined *this*
  // drop — and a prior capture is one that happened strictly before it. That makes
  // each row a function of the past alone, which is what a report has to be.
  //
  // Why not the drop's `windowStart`: it would be a defensible definition of "prior
  // to this drop", and it breaks on a tie. A customer who bought at noon on drop A
  // and joined drop B at 1pm is unambiguously a returning customer at 1pm, but if
  // both drops share an evening `windowStart` the comparison is `>=` against the
  // same instant and the ordering that actually happened is lost. `createdAt`
  // preserves it.
  //
  // "Captured" is the discriminator FR-702 needs, and the module docblock explains
  // why it is capture and not join: a join that was never charged is not a
  // purchase, and counting it would report a returning diner as new (or worse, the
  // reverse).
  const customerIds = [...new Set(participants.map((participant) => participant.customerId))];

  const capturedOrders =
    customerIds.length === 0
      ? []
      : await prisma.order.findMany({
          where: { participant: { is: { customerId: { in: customerIds } } } },
          select: {
            createdAt: true,
            participant: { select: { customerId: true } },
          },
        });

  // customerId → every instant they captured an order, sorted.
  const capturesByCustomer = new Map<string, number[]>();
  for (const order of capturedOrders) {
    const customerId = order.participant.customerId;
    const existing = capturesByCustomer.get(customerId);
    if (existing) {
      existing.push(order.createdAt.getTime());
    } else {
      capturesByCustomer.set(customerId, [order.createdAt.getTime()]);
    }
  }
  for (const instants of capturesByCustomer.values()) {
    instants.sort((left, right) => left - right);
  }

  const ordersByDrop = groupBy(orders, (order) => order.dropId);
  // `LedgerEntry.dropId` is nullable in the schema (a drop-level adjustment need
  // not name one), but the query filters `dropId: { in: dropIds }`, which cannot
  // match NULL. The guard is for the type, not a reachable state — and it is
  // written as a filter rather than a `!` so that if the column's meaning ever
  // changes, unattributed ledger rows fall out of every report instead of
  // silently accumulating against the first drop id.
  const ledgerByDrop = groupBy(
    ledgerRows.filter((row): row is typeof row & { dropId: string } => row.dropId !== null),
    (row) => row.dropId,
  );
  const participantsByDrop = groupBy(participants, (row) => row.dropId);
  const linksById = new Map(shareLinks.map((link) => [link.id, link]));

  const sources: DropReportSource[] = [];
  let skippedDropCount = 0;

  for (const drop of drops) {
    const costBasis = costBasisFrom(drop.guardrailSnapshot);
    if (!costBasis) {
      skippedDropCount += 1;
      continue;
    }

    const dropOrders = ordersByDrop.get(drop.id) ?? [];
    const dropLedger = ledgerByDrop.get(drop.id) ?? [];

    const orderFacts: ReportOrderFact[] = dropOrders.map((order) => ({
      orderId: order.id,
      qty: order.qty,
      subtotalCents: order.subtotalCents,
      platformFeeCents: order.platformFeeCents,
      refundedCents: order.refundedCents,
      platformFeeReversedCents: order.platformFeeReversedCents,
    }));

    const ledgerFacts: ReportLedgerFact[] = dropLedger.map((row) => ({
      orderId: row.orderId,
      type: row.type,
      amountCents: row.amountCents,
    }));

    // Only participants that produced an order. This is the "start from Order"
    // rule at the level it matters: a customer who joined and was never charged
    // is not a unit, is not GMV, and — per FR-702's classifier — is not a
    // customer this drop acquired.
    const dropParticipants = participantsByDrop.get(drop.id) ?? [];
    const payingParticipants = dropParticipants.filter(
      (participant) => participant.order !== null,
    );

    const customers: ReportCustomerFact[] = payingParticipants.map((participant) => {
      const instants = capturesByCustomer.get(participant.customerId) ?? [];
      const joinedAt = participant.createdAt.getTime();
      // Strictly before: a capture at the same millisecond as the join is this
      // join's own charge, not a prior one. `<` rather than `<=` is what keeps a
      // first-time buyer from being counted as their own previous customer.
      const priorCapturedOrderCount = instants.filter((instant) => instant < joinedAt).length;

      return {
        participantId: participant.id,
        qty: participant.qty,
        priorCapturedOrderCount,
      };
    });

    // Attribution: accumulated per `ShareLink.organiserId`, over paying
    // participants only, walking `participant.shareLink` — see the module
    // docblock for what joining on `dropId` would do instead.
    //
    // ## Two survivors of the sweep, and they are two different things
    //
    // **Equivalent mutant — the `?? fallback` that cannot fire.** Appending
    // `?? [...linksById.values()][0]` to the lookup below changes nothing, and the
    // suite correctly stayed green. It is dead code, not a gap: `shareLinks` is
    // loaded with `where: { dropId: { in: dropIds } }`, which spans every drop in
    // this report, so a non-null `shareLinkId` (guaranteed by the guard above)
    // always resolves. There is no state in which the fallback runs, so there is
    // no test that could distinguish it. Deleting the possibility is better than
    // defending it — hence no fallback in the source.
    //
    // **Not an equivalent mutant — the real `dropId`-join bug.** Replacing the
    // lookup with "the first link on this drop", ignoring `shareLinkId`, is the
    // bug FR-703 exists to prevent, and it *is* killed, twice:
    // `attributes units through the participant share link` and `does not credit
    // one organiser with another organiser's units`. The distinction matters — the
    // first is redundancy, the second is coverage, and reporting them as the same
    // word ("survivor") would be a claim the tests do not support.
    //
    // **Equivalent mutant — `payingParticipants` → `dropParticipants`.** Swapping
    // the loop header to iterate non-payers left all tests green, and that one is
    // also genuine: the `if (!order) continue` below excludes exactly the rows the
    // swap admits, so the two changes cancel. The guard is what makes the loop
    // correct; the header is belt-and-braces.
    const byOrganiser = new Map<string, ReportAttributionFact>();

    for (const participant of payingParticipants) {
      if (!participant.shareLinkId) {
        // A plain-link diner. Belongs to no organiser, so it is the
        // `unattributedUnits` remainder — not a zero row for a null organiser.
        continue;
      }

      const link = linksById.get(participant.shareLinkId);
      if (!link) {
        // Unreachable: the link ids came from this drop's own share links.
        continue;
      }

      const order = dropOrders.find((candidate) => candidate.participantId === participant.id);
      if (!order) {
        // A paying participant always has an order. Skipped rather than asserted
        // for the same reason as above: degrade to a smaller-but-correct
        // attribution instead of a 500.
        continue;
      }

      const existing = byOrganiser.get(link.organiserId);
      if (existing) {
        byOrganiser.set(link.organiserId, {
          ...existing,
          units: existing.units + participant.qty,
          gmvCents: existing.gmvCents + order.subtotalCents,
          refundedCents: existing.refundedCents + order.refundedCents,
        });
      } else {
        byOrganiser.set(link.organiserId, {
          organiserProfileId: link.organiserId,
          organiserName: link.organiser.displayName,
          units: participant.qty,
          gmvCents: order.subtotalCents,
          refundedCents: order.refundedCents,
        });
      }
    }

    sources.push({
      dropId: drop.id,
      dropTitle: drop.title,
      merchantName: drop.merchant.name,
      merchantTimezone: drop.merchant.timezone,
      windowStart: drop.windowStart,
      minQty: drop.minQty,
      maxQty: drop.maxQty,
      dealPriceCents: drop.dealPriceCents,
      costBasis,
      orders: orderFacts,
      ledger: ledgerFacts,
      customers,
      attribution: [...byOrganiser.values()],
    });
  }

  return { sources, skippedDropCount };
}

/**
 * The whole report for one merchant.
 *
 * `withheldDropCount` on the result is the sum of two different kinds of
 * withhold — a drop whose snapshot this build cannot read, and a drop whose
 * figures did not reconcile with its ledger. Both mean the same thing to the
 * merchant: this report does not include it. The page says so and does not
 * pretend otherwise.
 */
export async function merchantReportQuery(args: {
  merchantId: string;
  merchantName: string;
  timezone: string;
  limit?: number;
}): Promise<MerchantReport> {
  const { sources, skippedDropCount } = await reportSourcesFor({
    merchantId: args.merchantId,
    limit: args.limit,
  });

  const report = merchantReportFor({
    merchantId: args.merchantId,
    merchantName: args.merchantName,
    timezone: args.timezone,
    sources,
  });

  return {
    ...report,
    withheldDropCount: report.withheldDropCount + skippedDropCount,
  };
}

/** `Object.groupBy` is not in this TS lib target; three lines and no polyfill. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const group = map.get(key(row));
    if (group) {
      group.push(row);
    } else {
      map.set(key(row), [row]);
    }
  }
  return map;
}
