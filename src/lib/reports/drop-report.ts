import { roundHalfUp } from '@/lib/guardrail';
import { assertLedgerReconciles } from '@/lib/settlement/ledger';
import type { LedgerEntryShape, LedgerOrder } from '@/lib/settlement/ledger';

/**
 * M9 — merchant reporting, as arithmetic. FR-701, FR-702, FR-703, FR-705.
 *
 * > `FR-701 | Per-drop report: units sold, GMV, platform fee, contribution $,
 * > contribution % | Numbers reconcile with ledger` — PRD-v1.md:517
 * > `FR-702 | New vs returning customers | Based on Customer.firstSeenAt vs drop date`
 * > — PRD-v1.md:518
 * > `FR-703 | Organiser attribution: which organiser drove which units | From
 * > shareLinkId` — PRD-v1.md:519
 * | `FR-705 | Suggested next action | Rule-based in V1: "your Tuesday 3pm sold out
 * > — try 30 units"` — PRD-v1.md:521
 *
 * Pure: no Prisma, no `Date.now()`, no I/O. Every instant arrives as an argument.
 * `PROGRESS.md` records that this milestone previously had **zero** references
 * anywhere in the repo; that absence is why this module starts with the three
 * things that could have been quietly wrong.
 *
 * ## 1. FR-701's acceptance criterion is about the ledger, so the ledger is the check
 *
 * "Numbers reconcile with ledger" is not a description of the code, it is a test.
 * `charges` here are `Order` rows and `ledger` is the `LedgerEntry` rows for the
 * same drop, and `reconcile()` compares them with the identities already written
 * in `src/lib/settlement/ledger.ts` (L1 and L2), reusing those functions rather
 * than restating their arithmetic. That is deliberate: a report that reconciles
 * by its own definition reconciles always.
 *
 * The alternative — trust `Order` and skip the comparison — is the tempting one,
 * because `Order` is what the rest of the codebase reads. It is wrong here for
 * the reason the ledger module gives: the two records exist precisely so each can
 * be checked against the other. A report is the one screen a merchant will use to
 * argue about money, so it is the last place to accept a single source.
 *
 * ## 2. GMV is gross; contribution is net of refunds; they answer different questions
 *
 * `gmvCents` is `Σ order.subtotalCents` — what was rung up. `netCapturedCents` is
 * `gmvCents − refundedCents` — what actually stayed. A force-failed drop
 * (FR-502/FR-902) captures every card and refunds every card, so it has a large
 * GMV and a zero contribution. Printing only one of them would describe that drop
 * as either a triumph or a wash; a merchant who saw "GMV $480" on a drop they
 * know was cancelled would stop trusting every other number on the page.
 *
 * ## 3. Contribution % is a share of **GMV**, not of menu price
 *
 * This is the one place this module and the guardrail deliberately disagree, and
 * the disagreement is not an oversight. `DealEvaluation.contributionPctOfMenu` is
 * `netContribution ÷ menuPrice` — a *forward-looking* figure answering "is this
 * price worth running", computed before a single diner joins. A *reporting*
 * figure answers "what did this drop actually return", and the only denominator
 * a merchant can check against their own till is the money the drop took:
 * `contributionCents ÷ gmvCents`.
 *
 * Both are correct at what they do. Reusing `contributionPctOfMenu` here would
 * produce a percentage that does not multiply back to the dollars printed beside
 * it, which is the fastest way to lose an argument with a merchant holding a
 * calculator. So the denominator is GMV and `contributionPctOfGmv` is the name,
 * spelled out so nobody has to guess which percentage they are reading.
 *
 * ## 4. Contribution reuses the guardrail's `contributionAt`, per unit
 *
 * `contributionAt` is the codebase's only definition of "what the merchant keeps
 * per plate" and it is fee-inclusive by design. Re-deriving it here would be a
 * second definition of the product's central number, and the two would drift the
 * first time a fee constant moved.
 *
 * It is applied **per unit and multiplied**, matching `platformFeeCentsForOrder`'s
 * rounding rule and for the same measured reason: the fee floor (60¢) and cap
 * (200¢) are per plate, so rounding an order total instead of a unit hits each
 * bound once instead of `qty` times and understates the merchant's margin. The
 * table in `lib/settlement/platform-fee.ts` quantifies it — 67¢ on a $11.12 × 3
 * order.
 *
 * The inputs are the **frozen snapshot's**, never today's `MenuItem`. FR-207: a
 * merchant who raises their ingredient cost next month must not rewrite what a
 * deal last week actually earned.
 *
 * ## 5. FR-702's literal rule cannot distinguish a new customer from a returning one
 *
 * The PRD says "based on `Customer.firstSeenAt` vs drop date". Implemented
 * literally as `firstSeenAt >= drop.windowStart → NEW`, it classifies **nobody**
 * as new, ever, and the reason is a three-step argument that was measured rather
 * than assumed:
 *
 *   1. `rules.ts:91` enforces `cutoffAt < windowStart` — joining must close before
 *      pickup opens, so the merchant knows how much to cook.
 *   2. `Customer.firstSeenAt` defaults to `now()` and `joinDrop` upserts the
 *      customer row *at join time*, which is before the cutoff.
 *   3. Therefore `firstSeenAt < cutoffAt < windowStart` for every customer alive.
 *      Not usually — always, by construction.
 *
 * So `firstSeenAt >= windowStart` is `false` for every participant on every drop,
 * and the retention feature the PRD calls out as the reason merchants stay would
 * ship as a column of zeroes that looks like a working report. (Its sibling bug,
 * `firstSeenAt == participant.createdAt`, was also measured: the two defaults are
 * separate statements, 1–13 ms apart across five transactional samples, so an
 * equality test on those would be flaky in one direction and silently wrong in
 * the other.)
 *
 * `isNewCustomer` below is the definition that *is* distinguishable and matches
 * what the PRD means by "new": **this drop was the customer's first capture
 * anywhere.** Not "first join" — a card that was authorised and never charged
 * (the drop failed, or their authorisation was voided) is not a customer, and
 * counting it would report a returning diner as new because their failed attempt
 * came first. Not "first seen either way" — same problem, from the other side.
 *
 * It needs one number the customer row cannot supply: how many *other* captured
 * orders this customer has. The query layer supplies it as
 * `priorCapturedOrderCount`, and the classifier takes it as the only input. That
 * keeps the whole decision pure and testable, and it makes the `prior === 0`
 * reading a property of one `if` rather than an emergent property of two optional
 * dates.
 *
 * The consequence worth stating plainly: this is a **whole-history** definition.
 * A customer whose first-ever capture was in March is "returning" on every later
 * drop, including a drop in a different merchant's page, because the `Customer`
 * row is global (phone-keyed, not per-merchant). That is the honest reading of a
 * shared identity and it is what "does this drop bring me people who were not
 * already buying from me" can be answered with at V1. A per-merchant definition
 * would need a `Customer.merchantId`, which does not exist — noted in
 * `PROGRESS.md` as the limitation rather than papered over with a proxy.
 */

/**
 * The ledger's own identities, reused. See the module docblock §1.
 *
 * Imported from `lib/settlement` rather than restated so that a change to what
 * "reconciles" means lands in one place. If these two ever disagree, the report
 * is wrong because settlement is right.
 */
export type ReportOrderFact = {
  readonly orderId: string;
  readonly qty: number;
  readonly subtotalCents: number;
  readonly platformFeeCents: number;
  readonly refundedCents: number;
  readonly platformFeeReversedCents: number;
};

/** One `LedgerEntry` row, as the reconciliation reads it. Signed. §6.2. */
export type ReportLedgerFact = {
  readonly orderId: string | null;
  readonly type: 'CHARGE' | 'REFUND' | 'PLATFORM_FEE' | 'ORGANISER_COMMISSION' | 'ADJUSTMENT';
  readonly amountCents: number;
};

/** One participant's identity for FR-702, joined outward to the `Customer` row. */
export type ReportCustomerFact = {
  /** `DropParticipant.id`. Never rendered — see the note on `DropReportRow`. */
  readonly participantId: string;
  /** `DropParticipant.qty` — the units this person bought, not the units they were authorised for. */
  readonly qty: number;
  /**
   * Captured orders this `Customer` has **other than** the one on this drop.
   *
   * The whole of FR-702's classifier. `0` means this drop was their first
   * capture anywhere; anything above `0` means they had already bought before.
   * The query layer's job is to count it over all time and to exclude this drop's
   * own order, and both halves are asserted there.
   */
  readonly priorCapturedOrderCount: number;
};

/** One organiser's share of a drop, for FR-703. */
export type ReportAttributionFact = {
  /** `ShareLink.organiserId`. An id, never a name — the query layer resolves names. */
  readonly organiserProfileId: string;
  readonly organiserName: string;
  readonly units: number;
  /** What this organiser's brought-in diners actually paid, before refunds. */
  readonly gmvCents: number;
  readonly refundedCents: number;
};

/** The frozen guardrail inputs a drop's contribution is recomputed from. FR-207. */
export type ReportCostBasis = {
  readonly menuPriceCents: number;
  readonly foodCostCents: number;
  readonly packagingCents: number;
  /** The `feeConstants` the drop was published under, not today's. */
  readonly platformFeePct: number;
  readonly platformFeeFloorCents: number;
  readonly platformFeeCapCents: number;
  readonly stripePct: number;
  readonly stripeFixedCents: number;
};

/** Everything one drop's report needs, in one shape. */
export type DropReportSource = {
  readonly dropId: string;
  readonly dropTitle: string;
  readonly merchantName: string;
  /** The merchant's IANA zone. Contribution and dates are display, not money. */
  readonly merchantTimezone: string;
  readonly windowStart: Date;
  /** `minQty`, so FR-705 can say "sold out" against the number that mattered. */
  readonly minQty: number;
  readonly maxQty: number;
  /** Per unit, what the diner pays. From the drop, not the order — see `assertUnitPriceConsistent`. */
  readonly dealPriceCents: number;
  readonly costBasis: ReportCostBasis;
  readonly orders: readonly ReportOrderFact[];
  readonly ledger: readonly ReportLedgerFact[];
  readonly customers: readonly ReportCustomerFact[];
  readonly attribution: readonly ReportAttributionFact[];
};

/** FR-701's five figures, plus the two the reconciliation needs to be checkable. */
export type DropReportFigures = {
  /** Σ `order.qty`. Units actually charged for. */
  readonly unitsSold: number;
  /** Σ `order.subtotalCents`. What was rung up, before refunds. */
  readonly gmvCents: number;
  /** Σ `order.platformFeeCents` net of reversals. GroupEat's revenue on this drop. */
  readonly platformFeeCents: number;
  /** `gmvCents − refundedCents`. What stayed with the merchant's drop. */
  readonly netCapturedCents: number;
  readonly refundedCents: number;
  /**
   * What the merchant kept: `Σ (qty × contributionAt(per plate))` less refunds.
   *
   * **Net of refunds**, unlike the guardrail's forward-looking figure, and that
   * is the same gross-vs-net decision as §2: a cancelled drop returned the food
   * cost too, so it must not report a contribution.
   */
  readonly contributionCents: number;
  /** `contributionCents ÷ gmvCents`, 0 when GMV is 0. See §3. */
  readonly contributionPctOfGmv: number;
};

/** FR-702's answer, and the honest denominator beside it. */
export type CustomerMix = {
  /** Distinct customers whose first capture anywhere was this drop. */
  readonly newCustomers: number;
  /** Distinct customers who had already bought before this drop. */
  readonly returningCustomers: number;
  /** `new + returning`. Distinct people, so it can be below the order count. */
  readonly totalCustomers: number;
  /**
   * `newCustomers ÷ totalCustomers`, 0 when there are none.
   *
   * Rounded to whole percent at render, not here — the same "money and rates are
   * exact, rounding is display" rule the guardrail uses.
   */
  readonly newCustomerPct: number;
};

/** FR-705's suggestion, as a discriminated union so a caller cannot render half of one. */
export type SuggestedAction =
  | {
      readonly kind: 'SOLD_OUT';
      /** The `maxQty` that sold out — what to raise it above. */
      readonly soldOutAtQty: number;
      readonly suggestedQty: number;
    }
  | {
      readonly kind: 'MISSED_MINIMUM';
      readonly joinedQty: number;
      readonly minQty: number;
      readonly shortBy: number;
    }
  | {
      readonly kind: 'NO_CUSTOMERS';
    }
  | {
      readonly kind: 'PERFORMED_WELL';
      readonly newCustomerPct: number;
    };

/** One drop, reported. */
export type DropReportRow = {
  readonly dropId: string;
  readonly dropTitle: string;
  /** `YYYY-MM-DD` in the merchant's zone. Display only; never a period key. */
  readonly pickupDate: string;
  readonly figures: DropReportFigures;
  readonly customerMix: CustomerMix;
  /** Every organiser who brought anyone, largest first. Empty when none did. */
  readonly attribution: readonly ReportAttributionFact[];
  /**
   * Units no organiser is credited with — the plain-link diners.
   *
   * Carried explicitly rather than left as `unitsSold − Σ attribution.units`,
   * because a merchant reading the attribution table needs to know why it does
   * not sum to the total, and a missing remainder is indistinguishable from a bug.
   */
  readonly unattributedUnits: number;
  readonly suggestedAction: SuggestedAction;
};

/** The whole report for one merchant. */
export type MerchantReport = {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly timezone: string;
  readonly dropCount: number;
  /** Every drop's figures summed. Contribution is the sum of the rows, not recomputed. */
  readonly totals: DropReportFigures;
  readonly totalCustomerMix: CustomerMix;
  readonly rows: readonly DropReportRow[];
  /**
   * How many drops could not be reconciled and were therefore withheld.
   *
   * Not zero in practice, and not an error: `PROGRESS.md` records that settlement
   * writes ledger rows and `Order` columns in one transaction, so a mismatch means
   * something outside this report is wrong. The report refuses to print a figure
   * it cannot vouch for and says how many it withheld. See `reconcile`.
   */
  readonly withheldDropCount: number;
};

/**
 * A report that cannot be reconciled. Thrown, never clamped.
 *
 * The same argument as `assertLedgerReconciles` and `assertRefundWithinSubtotal`:
 * clamping a ledger defect into a plausible smaller number destroys the evidence
 * and understates a merchant's money in a direction nobody can reproduce. The
 * caller decides whether to withhold one drop or fail the page; this module's job
 * is to refuse.
 */
export class ReportIntegrityError extends Error {
  readonly dropId: string;
  readonly identity: string;
  readonly reportSide: number;
  readonly ledgerSide: number;

  constructor(args: {
    dropId: string;
    identity: string;
    reportSide: number;
    ledgerSide: number;
    what: string;
  }) {
    super(
      `REPORT_UNRECONCILED on drop ${args.dropId}: ${args.identity}: ${args.what} — ` +
        `report says ${args.reportSide}, ledger says ${args.ledgerSide} ` +
        `(difference ${args.reportSide - args.ledgerSide})`,
    );
    this.name = 'ReportIntegrityError';
    this.dropId = args.dropId;
    this.identity = args.identity;
    this.reportSide = args.reportSide;
    this.ledgerSide = args.ledgerSide;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isReportIntegrityError(error: unknown): error is ReportIntegrityError {
  return error instanceof ReportIntegrityError;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * FR-702's classifier — the whole of it.
 *
 * `priorCapturedOrderCount === 0` is the definition. See the module docblock §5
 * for why the PRD's literal `firstSeenAt vs drop date` cannot be used and why
 * "prior *capture*" rather than "prior join" is the right reading of "new".
 *
 * A negative count is a bug in the caller, not a rounding problem, so it throws:
 * a `-1` silently treated as "not new" would mark every customer returning and
 * reproduce exactly the failure this function exists to avoid.
 */
export function isNewCustomer(customer: ReportCustomerFact): boolean {
  if (!Number.isInteger(customer.priorCapturedOrderCount) || customer.priorCapturedOrderCount < 0) {
    throw new Error(
      `priorCapturedOrderCount for participant ${customer.participantId} is ` +
        `${customer.priorCapturedOrderCount}, which is not a non-negative integer. ` +
        `A caller that could not compute it must say so rather than pass -1.`,
    );
  }
  return customer.priorCapturedOrderCount === 0;
}

/**
 * FR-702 for one drop, over **distinct people**.
 *
 * Not over orders: `@@unique([dropId, customerId])` makes two orders on one drop
 * impossible for the same person today, but a person with two captures in one
 * drop would be two rows and one human, and "new vs returning" is a question
 * about humans. Distinctness is enforced on `participantId` because that is the
 * unique key this module is handed, and the query layer is asserted to select one
 * participant per customer.
 *
 * Summing the mix across drops **double-counts** a person who bought twice; that
 * is stated on `MerchantReport.totalCustomerMix` rather than hidden.
 */
export function customerMixOf(customers: readonly ReportCustomerFact[]): CustomerMix {
  let newCustomers = 0;
  let returningCustomers = 0;

  for (const customer of customers) {
    if (isNewCustomer(customer)) {
      newCustomers += 1;
    } else {
      returningCustomers += 1;
    }
  }

  const totalCustomers = newCustomers + returningCustomers;

  return {
    newCustomers,
    returningCustomers,
    totalCustomers,
    newCustomerPct: totalCustomers === 0 ? 0 : newCustomers / totalCustomers,
  };
}

/**
 * FR-701's contribution for one order, **net of that order's refund**.
 *
 * ## Why `grossContribution − refundedCents` is wrong, measured
 *
 * The first version of this module wrote `Σ contribution − refundedCents`, on the
 * reasoning that a refunded dollar is a dollar the merchant did not keep. It is
 * wrong by the food cost, and the direction is the alarming one. Three plates at
 * `$11.12`, fully refunded: gross contribution `3 × 401 = 1203`, refund `3336`, so
 * the report would print **−$21.33**. A force-failed drop (FR-502/FR-902) takes
 * every card and gives every cent back, and the merchant never cooked anything —
 * their actual contribution is exactly zero. Reporting a large negative would tell
 * a merchant they *lost* money on a drop that cost them nothing, on the one screen
 * they use to decide whether to run another.
 *
 * The error is that a refund returns the whole charge, which includes the food
 * cost and the fees; subtracting it from a figure that had already had those
 * deducted charges the merchant for the food twice.
 *
 * ## What is computed instead
 *
 * `roundHalfUp(gross × (subtotal − refunded) ÷ subtotal)` — the order's
 * contribution scaled by the fraction of the charge that was kept.
 *
 *  - **No refund** (`refunded = 0`): the fraction is `1`, so the result is the
 *    gross figure, and per-unit rounding is preserved exactly. This is the common
 *    case and the one the ADR-004 literals pin.
 *  - **Full refund** (`refunded = subtotal`): the fraction is `0`, so the result is
 *    exactly `0` — arithmetically, not by a special case.
 *  - **Partial refund** (FR-903): pro-rata. This is an approximation and it is
 *    stated rather than hidden: the food for a partially refunded plate was
 *    probably still cooked, so a strict accounting would keep `foodCost ×
 *    refundedQty` in the figure. `Order` records refunded *cents*, not refunded
 *    *units*, so the exact version is not computable from the data — and inventing
 *    a unit count from a cents ratio would be a guess wearing a number's clothes.
 *
 * Being pro-rata is the conservative direction: it credits the merchant with less
 * than they may have kept, never more. On a merchant's own money, understating is
 * the right way to be wrong.
 *
 * Exact at both endpoints is what matters, because both endpoints are real events
 * and the middle is rare.
 */
export function contributionCentsFor(args: {
  qty: number;
  priceCents: number;
  costBasis: ReportCostBasis;
}): number {
  const { qty, priceCents, costBasis } = args;

  const cardFee = costBasis.stripePct * priceCents + costBasis.stripeFixedCents;
  const proportional = costBasis.platformFeePct * priceCents;
  const platformFee =
    proportional < costBasis.platformFeeFloorCents
      ? costBasis.platformFeeFloorCents
      : proportional > costBasis.platformFeeCapCents
        ? costBasis.platformFeeCapCents
        : proportional;

  const perUnit =
    priceCents - costBasis.foodCostCents - costBasis.packagingCents - cardFee - platformFee;

  // Per unit first — see the module docblock §4 and `platformFeeCentsForOrder`.
  return qty * roundHalfUp(perUnit);
}

/**
 * The same, scaled by the fraction of the order that was not refunded. See
 * `contributionCentsFor` for why this is not `gross − refundedCents`.
 *
 * `subtotalCents` is the order's own charge and is required, rather than being
 * recomputed as `qty × priceCents`, because a mismatch between the two is exactly
 * the defect `assertReportInputsWellFormed` refuses — and this function must not
 * paper over it by picking one.
 */
export function netContributionCentsFor(args: {
  qty: number;
  priceCents: number;
  costBasis: ReportCostBasis;
  subtotalCents: number;
  refundedCents: number;
}): number {
  const gross = contributionCentsFor({
    qty: args.qty,
    priceCents: args.priceCents,
    costBasis: args.costBasis,
  });

  /**
   * There is no `refundedCents === 0 → return gross` fast path, deliberately.
   *
   * One was written and then deleted: the scaling path already returns `gross`
   * exactly when nothing was refunded, because `roundHalfUp(gross × subtotal ÷
   * subtotal)` is `gross` for every integer `gross` — multiplying and dividing by
   * the same integer cannot move a value that is already whole. A mutation sweep
   * reported the fast path as surviving every probe, which is the correct answer:
   * it was dead code that could only ever drift from the path it shadowed.
   */
  if (args.refundedCents >= args.subtotalCents) {
    // Fully (or over-) refunded. Returned rather than computed so the endpoint is a
    // statement in the code: "a cancelled drop contributes exactly zero". See the
    // note in the test file on why this is an equivalent mutant that stays.
    return 0;
  }
  if (args.subtotalCents <= 0) {
    throw new Error(
      `Order with subtotalCents ${args.subtotalCents} and refundedCents ${args.refundedCents} ` +
        `cannot be scaled: a charge of nothing cannot have a kept fraction.`,
    );
  }

  const keptCents = args.subtotalCents - args.refundedCents;
  return roundHalfUp((gross * keptCents) / args.subtotalCents);
}

/**
 * Refuses a report whose orders disagree with each other or with the drop.
 *
 * Two checks, both of which have produced a plausible-but-wrong number in this
 * codebase before:
 *
 *   - **Every order must carry the drop's `dealPriceCents`.** Contribution is
 *     computed from the drop's price, so an order written at a different price
 *     (a repricing bug, a snapshot from an older build) would be reported at a
 *     contribution it never earned. `unitPriceCents × qty === subtotalCents` is
 *     checked too, because a subtotal that does not multiply back makes GMV and
 *     units describe different drops.
 *   - **Refunds must fit inside their charge**, the same `0 ≤ refunded ≤ subtotal`
 *     assertion `assertRefundWithinSubtotal` makes for commission. A refund larger
 *     than its charge would make `netCapturedCents` negative and drag contribution
 *     down in a way no diner's money can explain.
 */
export function assertReportInputsWellFormed(source: DropReportSource): void {
  for (const order of source.orders) {
    if (!Number.isInteger(order.qty) || order.qty < 1) {
      throw new Error(
        `Order ${order.orderId} on drop ${source.dropId} has qty ${order.qty}; a captured order has at least one unit.`,
      );
    }
    if (order.qty * source.dealPriceCents !== order.subtotalCents) {
      throw new Error(
        `Order ${order.orderId} on drop ${source.dropId} does not carry the drop's price: ` +
          `${order.qty} × ${source.dealPriceCents} is ${order.qty * source.dealPriceCents}, ` +
          `but subtotalCents is ${order.subtotalCents}. The report computes contribution from ` +
          `the drop's price, so this order would be reported at a contribution it never earned.`,
      );
    }
    if (
      !Number.isInteger(order.refundedCents) ||
      order.refundedCents < 0 ||
      order.refundedCents > order.subtotalCents
    ) {
      throw new Error(
        `Order ${order.orderId} on drop ${source.dropId} has refundedCents ${order.refundedCents} ` +
          `outside 0..${order.subtotalCents}. Refusing to clamp — a refund larger than its charge ` +
          `is a ledger defect and a clamped report would hide it.`,
      );
    }
  }
}

/**
 * FR-701's acceptance criterion, made falsifiable.
 *
 * ## The ledger's own identities run first, because they check more than this module can
 *
 * `assertLedgerReconciles` is L1–L4, and **L4 is the reason to call it rather than
 * write the aggregate comparison by hand**. L1–L3 compare drop-level totals, so
 * two orders wrong in opposite directions cancel and pass. Only L4, which walks
 * each order against its own `CHARGE`, `PLATFORM_FEE`, `REFUND` and `ADJUSTMENT`
 * rows, notices — and it names the order id.
 *
 * This function used to restate L1–L3 inline. It agreed with the settlement module
 * by coincidence rather than construction, and it silently lost L4, which is the
 * only check that catches a refund posted to the wrong diner: the drop-level
 * totals are identical whether the money went back to the right person or not.
 * The first version was weaker than the code it claimed to reuse.
 *
 * ## What this adds on top
 *
 * The report's `DropReportFigures` are computed independently of both the orders
 * array and the ledger — `figuresFor` walks `Order` and sums. So comparing them
 * to the ledger is a **third** opinion, and the two comparisons are not
 * redundant:
 *
 *   - L1–L4 prove the ledger and the `Order` rows agree.
 *   - `reconcile` proves the *report's* arithmetic reads those same `Order` rows
 *     correctly, and that the ledger agrees with the figures the merchant will
 *     actually be shown.
 *
 * A report that summed `qty` instead of `subtotalCents` would pass L1–L4 and fail
 * the `gmvCents` comparison. A ledger missing a `PLATFORM_FEE` row would pass the
 * figures comparison and fail L2. Each catches what the other cannot.
 */
export function reconcile(args: {
  dropId: string;
  figures: DropReportFigures;
  ledger: readonly ReportLedgerFact[];
  orders: readonly ReportOrderFact[];
}): void {
  // L1–L4 over the same rows, reusing the settlement module's implementation.
  //
  // Wrapped so that this module has **one** failure type. `assertLedgerReconciles`
  // throws `SettlementIntegrityError`, and `merchantReportFor`'s withholding logic
  // matches on `ReportIntegrityError` — so without this conversion a genuinely
  // unreconciled drop would escape as an unhandled error and 500 the whole page
  // instead of being withheld from it. The bug was found by the test that asserts a
  // bad drop is withheld while a good one still renders.
  //
  // The message is carried across verbatim: it already names the identity, both
  // sides and the offending order id, and re-wording it would lose exactly the
  // detail that makes the failure actionable.
  try {
    assertLedgerReconciles({
      dropId: args.dropId,
      entries: args.ledger.map(toLedgerEntryShape(args.dropId)),
      orders: args.orders.map(toLedgerOrder),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReportIntegrityError({
      dropId: args.dropId,
      identity: 'L1-L4',
      // `0`/`0` because the numbers are already in `detail`; duplicating them in
      // numeric fields here would invite a caller to print them twice.
      reportSide: 0,
      ledgerSide: 0,
      what: detail,
    });
  }

  // The third opinion: the figures the merchant is shown, against the ledger.
  let chargedCents = 0;
  let refundedSignedCents = 0;
  let platformFeeCents = 0;

  for (const entry of args.ledger) {
    switch (entry.type) {
      case 'CHARGE':
        chargedCents += entry.amountCents;
        break;
      case 'REFUND':
        refundedSignedCents += entry.amountCents;
        break;
      case 'PLATFORM_FEE':
      case 'ADJUSTMENT':
        platformFeeCents += entry.amountCents;
        break;
      case 'ORGANISER_COMMISSION':
        // A payout, not revenue. Same exclusion as `dropLedgerTotals`.
        break;
    }
  }

  fail(args.dropId, 'L1', args.figures.gmvCents, chargedCents, 'gmvCents vs Σ CHARGE');
  fail(
    args.dropId,
    'L3',
    args.figures.refundedCents,
    Math.abs(refundedSignedCents),
    'refundedCents vs |Σ REFUND|',
  );
  fail(
    args.dropId,
    'L2',
    args.figures.platformFeeCents,
    platformFeeCents,
    'platformFeeCents vs Σ (PLATFORM_FEE + ADJUSTMENT)',
  );
}

/**
 * `ReportOrderFact` → the ledger module's `LedgerOrder`.
 *
 * Field-for-field identical today; written as a mapping rather than a cast so that
 * a column added to one type and not the other is a compile error here instead of
 * an `undefined` that becomes `NaN` money three functions later.
 */
function toLedgerOrder(order: ReportOrderFact): LedgerOrder {
  return {
    id: order.orderId,
    subtotalCents: order.subtotalCents,
    platformFeeCents: order.platformFeeCents,
    refundedCents: order.refundedCents,
    platformFeeReversedCents: order.platformFeeReversedCents,
  };
}

/**
 * `ReportLedgerFact` → `LedgerEntryShape`.
 *
 * `stripeRef` and `note` are not read by any identity, so `null` is exact rather
 * than a placeholder — the report never selects them. `dropId` is threaded from
 * the caller because the error message needs it and the row does not carry it.
 */
function toLedgerEntryShape(dropId: string) {
  return (entry: ReportLedgerFact): LedgerEntryShape => ({
    orderId: entry.orderId,
    dropId,
    type: entry.type,
    amountCents: entry.amountCents,
    stripeRef: null,
    note: null,
  });
}

function fail(
  dropId: string,
  identity: string,
  reportSide: number,
  ledgerSide: number,
  what: string,
): void {
  if (reportSide === ledgerSide) {
    return;
  }
  throw new ReportIntegrityError({ dropId, identity, reportSide, ledgerSide, what });
}

/**
 * FR-701's five figures from one drop's orders.
 *
 * Contribution is net of refunds, per order — see `netContributionCentsFor` for
 * the arithmetic and for why the obvious `Σ contribution − refundedCents` is
 * wrong by the food cost. `contributionCents` is therefore a **sum of already
 * reconciled per-order figures**, which is what keeps a cancelled drop at exactly
 * zero rather than at a large negative.
 */
export function figuresFor(source: DropReportSource): DropReportFigures {
  assertReportInputsWellFormed(source);

  let unitsSold = 0;
  let gmvCents = 0;
  let platformFeeCents = 0;
  let refundedCents = 0;
  let contributionCents = 0;

  for (const order of source.orders) {
    unitsSold += order.qty;
    gmvCents += order.subtotalCents;
    // Net of reversals: a refunded application fee is not our revenue. Same
    // reading as L2 and as `dropLedgerTotals`.
    platformFeeCents += order.platformFeeCents - order.platformFeeReversedCents;
    refundedCents += order.refundedCents;
    contributionCents += netContributionCentsFor({
      qty: order.qty,
      priceCents: source.dealPriceCents,
      costBasis: source.costBasis,
      subtotalCents: order.subtotalCents,
      refundedCents: order.refundedCents,
    });
  }

  const netCapturedCents = gmvCents - refundedCents;

  return {
    unitsSold,
    gmvCents,
    platformFeeCents,
    netCapturedCents,
    refundedCents,
    contributionCents,
    // Guarded division, the way `evaluateDeal` guards `menuPriceCents > 0`: a drop
    // nobody joined must report 0, never NaN or Infinity.
    contributionPctOfGmv: gmvCents === 0 ? 0 : contributionCents / gmvCents,
  };
}

/**
 * FR-703 through the attribution path the PRD names, and the units that fall
 * outside it.
 *
 * `unattributedUnits` is `unitsSold − Σ attribution.units`. It is **not** asserted
 * to be zero: a diner who arrives through a plain link has no `shareLinkId` and
 * belongs to no organiser (`DropParticipant.shareLinkId IS NULL`). That is a
 * normal, common case — it is the whole point of a public link — so a report that
 * refused it would refuse most drops.
 *
 * What *is* asserted is that it cannot be negative, because a negative remainder
 * means an organiser was credited with units the drop never sold, which is the
 * `Order.dropId = ShareLink.dropId` attribution bug the commission module's AC8
 * exists for. That failure is caught here even if it somehow got past commission.
 */
export function unattributedUnitsFor(args: {
  dropId: string;
  unitsSold: number;
  attribution: readonly ReportAttributionFact[];
}): number {
  const attributed = sum(args.attribution.map((row) => row.units));
  const unattributed = args.unitsSold - attributed;

  if (unattributed < 0) {
    throw new ReportIntegrityError({
      dropId: args.dropId,
      identity: 'FR-703',
      reportSide: args.unitsSold,
      ledgerSide: attributed,
      what:
        'attribution credits more units than the drop sold — an organiser was credited with ' +
        'another organiser\'s (or nobody\'s) units, which is the `dropId`-join bug',
    });
  }

  return unattributed;
}

/**
 * FR-705 — a rule, in the PRD's own words.
 *
 * > "Rule-based in V1: *your Tuesday 3pm sold out — try 30 units*"
 *
 * Four arms, in priority order, and the order is the design:
 *
 *   1. **Sold out.** The drop hit `maxQty` — the strongest signal available, and
 *      the one the PRD quotes. Suggesting more is safe because demand is proven.
 *   2. **Missed the minimum.** Joined fewer than `minQty`. Worth trying again,
 *      with a smaller ask — so the suggestion is the cheapest change that would
 *      have cleared it, not a guess at a better number.
 *   3. **Nobody new.** The drop ran and brought no first-time customer. That is
 *      the retention signal §6.7 says merchants stay for, and the honest action
 *      is to say so rather than invent advice about quantity.
 *   4. **Performed.** Ran, cleared the minimum, brought new people. No change
 *      recommended; the rule says so instead of manufacturing a suggestion,
 *      because a report that always suggests something is a report nobody reads.
 *
 * Deliberately no fifth arm and no scoring: the PRD says "rule-based in V1" and
 * the moment this starts weighting signals it becomes a model with no acceptance
 * criterion, which is a different feature.
 */
export function suggestedActionFor(args: {
  joinedQty: number;
  minQty: number;
  maxQty: number;
  customerMix: CustomerMix;
}): SuggestedAction {
  const { joinedQty, minQty, maxQty, customerMix } = args;

  if (joinedQty >= maxQty && maxQty > 0) {
    return {
      kind: 'SOLD_OUT',
      soldOutAtQty: maxQty,
      // The PRD's own example: a drop that sold out at 20 suggests trying 30.
      suggestedQty: maxQty + Math.max(10, Math.ceil(maxQty / 2)),
    };
  }

  if (joinedQty < minQty) {
    return {
      kind: 'MISSED_MINIMUM',
      joinedQty,
      minQty,
      shortBy: minQty - joinedQty,
    };
  }

  if (customerMix.newCustomers === 0) {
    return { kind: 'NO_CUSTOMERS' };
  }

  return { kind: 'PERFORMED_WELL', newCustomerPct: customerMix.newCustomerPct };
}

/**
 * One drop, reported in full — figures, mix, attribution and suggestion, with the
 * reconciliation run before any of it is returned.
 *
 * The reconciliation comes **first**. A report that computed a suggestion from
 * figures it had not yet checked would be advising a merchant on the strength of
 * a number it is about to refuse.
 */
export function dropReportFor(source: DropReportSource): DropReportRow {
  const figures = figuresFor(source);
  reconcile({
    dropId: source.dropId,
    figures,
    ledger: source.ledger,
    orders: source.orders,
  });

  const customerMix = customerMixOf(source.customers);
  const unattributedUnits = unattributedUnitsFor({
    dropId: source.dropId,
    unitsSold: figures.unitsSold,
    attribution: source.attribution,
  });

  // Largest first, then by name, then by id — a total order, so two renders of the
  // same drop cannot reorder. The same reasoning as `commissionStatementFor`'s sort.
  const attribution = [...source.attribution].sort((left, right) => {
    if (left.units !== right.units) {
      return right.units - left.units;
    }
    if (left.organiserName !== right.organiserName) {
      return left.organiserName < right.organiserName ? -1 : 1;
    }
    return left.organiserProfileId < right.organiserProfileId ? -1 : 1;
  });

  return {
    dropId: source.dropId,
    dropTitle: source.dropTitle,
    pickupDate: isoDateInZone(source.windowStart, source.merchantTimezone),
    figures,
    customerMix,
    attribution,
    unattributedUnits,
    suggestedAction: suggestedActionFor({
      joinedQty: figures.unitsSold,
      minQty: source.minQty,
      maxQty: source.maxQty,
      customerMix,
    }),
  };
}

/**
 * `YYYY-MM-DD` for an instant, read in a zone.
 *
 * A local helper rather than an import from `lib/organisers/commission`, and the
 * duplication is the lesser evil for a specific reason: importing it would make
 * the reporting module depend on the commission module's public surface, and
 * `commission.ts` is documented as the *organiser's* statement — the two features
 * are separate milestones that happen to need the same six lines of `Intl`
 * plumbing. `monthKeyOf` there is the period key; this is a display date.
 *
 * Built from `formatToParts`, not from `toISOString().slice(0, 10)`: the latter
 * reads the instant in UTC, so a drop at 6pm Tuesday in Edmonton would print as
 * Wednesday, and every drop in a merchant's evening service would be filed under
 * the wrong day.
 */
export function isoDateInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    if (!found) {
      throw new Error(`Time zone "${timeZone}" produced no "${type}" part.`);
    }
    return found.value;
  };

  return `${read('year')}-${read('month')}-${read('day')}`;
}

/**
 * The whole merchant report from already-fetched sources.
 *
 * ## Why the totals are sums of the rows rather than recomputed from all orders
 *
 * The merchant's screen shows a table and a total. If the total were computed
 * from a second pass over the raw orders, it could disagree with the column a
 * merchant adds up on screen — the same failure `totalsFor` in the commission
 * module exists to prevent, and the same reason it sums already-rounded figures.
 * Here the figures are integers, so summing rows is exact, and the only way the
 * total can be wrong is if the rows are.
 *
 * ## Contribution % on the total is over total GMV, not the mean of the row rates
 *
 * Averaging per-drop percentages would let a $40 drop weigh the same as a $400
 * one. The total's percentage is `Σ contribution ÷ Σ gmv`, which is the figure a
 * merchant can reproduce by dividing the two numbers printed above it.
 *
 * ## A drop that fails to reconcile is withheld, not silently zeroed
 *
 * `withheldDropCount` is the count of drops whose reconciliation threw. The rest
 * of the report still renders: one broken drop must not blank a merchant's whole
 * month, and a zero row for that drop would be a false statement about money —
 * strictly worse than an absence the page can name.
 */
export function merchantReportFor(args: {
  merchantId: string;
  merchantName: string;
  timezone: string;
  sources: readonly DropReportSource[];
}): MerchantReport {
  const rows: DropReportRow[] = [];
  let withheldDropCount = 0;

  for (const source of args.sources) {
    try {
      rows.push(dropReportFor(source));
    } catch (error) {
      if (isReportIntegrityError(error)) {
        withheldDropCount += 1;
        continue;
      }
      throw error;
    }
  }

  // Newest pickup first: a merchant opening the page is asking "how did last
  // night go". Ties broken by title then id so the order is total.
  rows.sort((left, right) => {
    if (left.pickupDate !== right.pickupDate) {
      return left.pickupDate < right.pickupDate ? 1 : -1;
    }
    if (left.dropTitle !== right.dropTitle) {
      return left.dropTitle < right.dropTitle ? -1 : 1;
    }
    return left.dropId < right.dropId ? -1 : 1;
  });

  const totals = rows.reduce<DropReportFigures>(
    (running, row) => {
      const gmvCents = running.gmvCents + row.figures.gmvCents;
      const contributionCents = running.contributionCents + row.figures.contributionCents;
      return {
        unitsSold: running.unitsSold + row.figures.unitsSold,
        gmvCents,
        platformFeeCents: running.platformFeeCents + row.figures.platformFeeCents,
        netCapturedCents: running.netCapturedCents + row.figures.netCapturedCents,
        refundedCents: running.refundedCents + row.figures.refundedCents,
        contributionCents,
        contributionPctOfGmv: gmvCents === 0 ? 0 : contributionCents / gmvCents,
      };
    },
    {
      unitsSold: 0,
      gmvCents: 0,
      platformFeeCents: 0,
      netCapturedCents: 0,
      refundedCents: 0,
      contributionCents: 0,
      contributionPctOfGmv: 0,
    },
  );

  const totalCustomerMix = rows.reduce<CustomerMix>(
    (running, row) => {
      const newCustomers = running.newCustomers + row.customerMix.newCustomers;
      const returningCustomers = running.returningCustomers + row.customerMix.returningCustomers;
      const totalCustomers = newCustomers + returningCustomers;
      return {
        newCustomers,
        returningCustomers,
        totalCustomers,
        newCustomerPct: totalCustomers === 0 ? 0 : newCustomers / totalCustomers,
      };
    },
    { newCustomers: 0, returningCustomers: 0, totalCustomers: 0, newCustomerPct: 0 },
  );

  return {
    merchantId: args.merchantId,
    merchantName: args.merchantName,
    timezone: args.timezone,
    dropCount: rows.length,
    totals,
    totalCustomerMix,
    rows,
    withheldDropCount,
  };
}
