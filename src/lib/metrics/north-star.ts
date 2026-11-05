/**
 * PRD-v1 §10.2's north-star metrics, as arithmetic.
 *
 * Pure: every fact arrives as an argument. The dashboard is a read of eight
 * questions the product is judged by, and the tempting implementation is a set of
 * Prisma aggregates on the page — which makes each definition invisible and
 * untestable. Here the definitions are named, the denominators are carried beside
 * every rate, and a zero denominator is `null` rather than `0`, because "no deals
 * decided yet" and "0% hit rate" are different answers.
 *
 * ## The definitions, stated once
 *
 * | Metric | Numerator / denominator |
 * |---|---|
 * | Threshold hit rate | decided drops that reached `minQty` / decided drops |
 * | Median fill rate | per drop, ever-authorised qty ÷ `minQty`; median over decided drops |
 * | Time to first publish | `first publishedAt − merchant.createdAt` in hours; median |
 * | Join conversion | `join_authorised` / `deal_page_viewed` from the analytics sink |
 * | Organiser share rate | drops with a share link / drops ever published |
 * | Redemption rate | redeemed qty / captured qty |
 * | Repeat participant rate | customers with ≥2 captured orders / customers with ≥1 |
 * | New-customer share | orders that are the customer's first capture / all captured orders |
 *
 * ## Why "decided" excludes `PUBLISHED` and `CANCELLED`
 *
 * A live drop has not had its cutoff, so counting it as a miss would punish a drop
 * that is still filling. A cancelled drop is a merchant decision, not a demand
 * outcome; ADR-004's own outcome classifier excludes it for the same reason.
 *
 * ## Why the fill denominator includes voided authorisations
 *
 * The question is "how full was the drop at cutoff", not "how much money moved".
 * A participant whose authorisation was voided after a failed drop did join; a
 * participant whose card was declined (`FAILED`) never did. Including `VOIDED` and
 * `EXPIRED` and excluding `FAILED` is the only reading that makes the two failed
 * drops in the dev database report the demand they actually had.
 */

export type MetricRatio = {
  /** `numerator / denominator`, or `null` when the denominator is zero. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
};

export type NorthStarFacts = {
  readonly decidedDrops: readonly {
    readonly status: string;
    readonly minQty: number;
    readonly participants: readonly { readonly qty: number; readonly authStatus: string }[];
  }[];
  readonly merchants: readonly {
    readonly createdAt: Date;
    readonly firstPublishedAt: Date | null;
  }[];
  readonly sharedDropIds: readonly string[];
  readonly publishedDropIds: readonly string[];
  readonly orders: readonly { readonly customerId: string; readonly createdAt: Date }[];
  readonly redemption: readonly { readonly qty: number; readonly redeemedQty: number }[];
  readonly analytics: {
    readonly dealPageViewed: number;
    readonly joinAuthorised: number;
  };
};

export type NorthStarMetrics = {
  readonly thresholdHitRate: MetricRatio;
  readonly medianFillRate: number | null;
  readonly medianHoursToFirstPublish: number | null;
  readonly joinConversion: MetricRatio;
  readonly organiserShareRate: MetricRatio;
  readonly redemptionRate: MetricRatio;
  readonly repeatParticipantRate: MetricRatio;
  readonly newCustomerShare: MetricRatio;
};

const HIT_STATUSES = new Set(['LOCKED', 'CAPTURED', 'PICKUP_OPEN', 'COMPLETED']);
const EVER_AUTHORISED = new Set(['AUTHORIZED', 'VOIDED', 'EXPIRED']);

function ratio(numerator: number, denominator: number): MetricRatio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function computeNorthStar(facts: NorthStarFacts): NorthStarMetrics {
  const hits = facts.decidedDrops.filter((drop) => HIT_STATUSES.has(drop.status)).length;

  const fillRates = facts.decidedDrops
    .filter((drop) => drop.minQty > 0)
    .map((drop) => {
      const joined = drop.participants
        .filter((participant) => EVER_AUTHORISED.has(participant.authStatus))
        .reduce((total, participant) => total + participant.qty, 0);
      return joined / drop.minQty;
    });

  const hoursToPublish = facts.merchants
    .filter((merchant): merchant is { createdAt: Date; firstPublishedAt: Date } =>
      merchant.firstPublishedAt !== null,
    )
    .map(
      (merchant) =>
        (merchant.firstPublishedAt.getTime() - merchant.createdAt.getTime()) / (60 * 60 * 1000),
    );

  const ordersByCustomer = new Map<string, number>();
  let firstCaptures = 0;
  for (const order of [...facts.orders].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  )) {
    const count = ordersByCustomer.get(order.customerId) ?? 0;
    if (count === 0) firstCaptures += 1;
    ordersByCustomer.set(order.customerId, count + 1);
  }
  const repeatCustomers = [...ordersByCustomer.values()].filter((count) => count >= 2).length;

  const capturedQty = facts.redemption.reduce((total, row) => total + row.qty, 0);
  const redeemedQty = facts.redemption.reduce((total, row) => total + row.redeemedQty, 0);

  return {
    thresholdHitRate: ratio(hits, facts.decidedDrops.length),
    medianFillRate: median(fillRates),
    medianHoursToFirstPublish: median(hoursToPublish),
    joinConversion: ratio(facts.analytics.joinAuthorised, facts.analytics.dealPageViewed),
    organiserShareRate: ratio(
      new Set(facts.sharedDropIds).size,
      new Set(facts.publishedDropIds).size,
    ),
    redemptionRate: ratio(redeemedQty, capturedQty),
    repeatParticipantRate: ratio(repeatCustomers, ordersByCustomer.size),
    newCustomerShare: ratio(firstCaptures, facts.orders.length),
  };
}
