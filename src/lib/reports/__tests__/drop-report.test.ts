import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, roundHalfUp } from '@/lib/guardrail';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';
import {
  ReportIntegrityError,
  assertReportInputsWellFormed,
  contributionCentsFor,
  customerMixOf,
  dropReportFor,
  figuresFor,
  isNewCustomer,
  isoDateInZone,
  merchantReportFor,
  netContributionCentsFor,
  reconcile,
  suggestedActionFor,
  unattributedUnitsFor,
  type DropReportSource,
  type ReportCostBasis,
  type ReportLedgerFact,
} from '../drop-report';

/**
 * FR-701…FR-703, FR-705 — the pure arithmetic.
 *
 * Every money assertion below is a **literal integer**. A test whose expected
 * value is computed by the same expression it is testing cannot fail when that
 * expression is wrong, which is why the ADR-004 vectors were pinned as literals
 * in `platform-fee.test.ts` and why the same discipline is applied here.
 */

/**
 * `$16.00` menu, `$4.80` food, `$0.80` packaging, 25% floor — the fixture values
 * `settlement-fixtures.ts` uses, so the numbers below can be checked by hand
 * against the guardrail panel a merchant sees.
 *
 * The fee constants are `DEFAULT_FEES`: 8% platform clamped to 60¢…200¢, and
 * 2.9% + 30¢ card.
 */
const COST_BASIS: ReportCostBasis = {
  menuPriceCents: 1600,
  foodCostCents: 480,
  packagingCents: 80,
  platformFeePct: DEFAULT_FEES.platformFeePct,
  platformFeeFloorCents: DEFAULT_FEES.platformFeeFloorCents,
  platformFeeCapCents: DEFAULT_FEES.platformFeeCapCents,
  stripePct: DEFAULT_FEES.stripePct,
  stripeFixedCents: DEFAULT_FEES.stripeFixedCents,
};

describe('contributionCentsFor — FR-701 contribution $', () => {
  /**
   * `$11.12` a plate, one unit.
   *
   * Hand arithmetic: card fee `0.029 × 1112 + 30 = 62.248`; platform fee
   * `0.08 × 1112 = 88.96` (inside the 60…200 band, so no clamp); per unit
   * `1112 − 480 − 80 − 62.248 − 88.96 = 400.792`; rounded half-up → `401`.
   */
  it('computes one plate at $11.12 as 401 cents', () => {
    expect(contributionCentsFor({ qty: 1, priceCents: 1112, costBasis: COST_BASIS })).toBe(401);
  });

  /**
   * The reason the multiplication happens **after** rounding, with the number
   * from `platform-fee.ts`'s own table.
   *
   * `$11.12 × 3`: per unit `400.792 → 401`, so `3 × 401 = 1203`. Rounding the
   * order total instead would be `roundHalfUp(3 × 400.792) = roundHalfUp(1202.376)
   * = 1202` — one cent less. The floor/cap cases diverge far more (67¢), because
   * each bound is cleared or hit three times instead of once.
   */
  it('multiplies the rounded per-unit figure, not the order total', () => {
    expect(contributionCentsFor({ qty: 3, priceCents: 1112, costBasis: COST_BASIS })).toBe(1203);
  });

  /**
   * `$5.00` a plate hits the **60¢ floor**: `0.08 × 500 = 40`, below the floor, so
   * the fee is 60. Card `0.029 × 500 + 30 = 44.5`. Per unit
   * `500 − 480 − 80 − 44.5 − 60 = −164.5`, rounded half-up → `−164`.
   *
   * A negative contribution is a real answer — this price loses money — and the
   * report must be able to say so. A `Math.max(0, …)` anywhere in this path would
   * turn the product's most important warning into a zero.
   */
  it('reports a loss as a negative number rather than clamping to zero', () => {
    expect(contributionCentsFor({ qty: 1, priceCents: 500, costBasis: COST_BASIS })).toBe(-164);
  });

  /**
   * `$40.00` a plate hits the **200¢ cap**: `0.08 × 4000 = 320`, above the cap, so
   * the fee is 200. Card `0.029 × 4000 + 30 = 146`. Per unit
   * `4000 − 480 − 80 − 146 − 200 = 3094`.
   */
  it('applies the platform-fee cap above the band', () => {
    expect(contributionCentsFor({ qty: 1, priceCents: 4000, costBasis: COST_BASIS })).toBe(3094);
  });

  /**
   * The conversion FR-701's "platform fee" column and this function must agree on.
   *
   * The report's contribution uses `DEFAULT_FEES` through its own expression; the
   * join path uses `platformFeeCentsForOrder`. They are two code paths for one
   * product rule, so this asserts they produce the same fee at the three places
   * the rule changes shape: below the floor, inside the band, above the cap.
   */
  it('agrees with the join path on the platform fee at every band', () => {
    for (const priceCents of [500, 1112, 1600, 4000]) {
      // `platformFeeAt` unrounded, clamped — the value the report's expression
      // uses. Compared to what the join path *stores* for one unit, which is the
      // same primitive through `roundHalfUp`. They must agree at all three shapes
      // of the rule: below the floor (500), inside the band (1112, 1600), above
      // the cap (4000).
      const proportional = COST_BASIS.platformFeePct * priceCents;
      const clamped =
        proportional < COST_BASIS.platformFeeFloorCents
          ? COST_BASIS.platformFeeFloorCents
          : proportional > COST_BASIS.platformFeeCapCents
            ? COST_BASIS.platformFeeCapCents
            : proportional;

      expect(Math.round(clamped)).toBe(
        platformFeeCentsForOrder({ qty: 1, dealPriceCents: priceCents, fees: DEFAULT_FEES }),
      );
    }
  });
});

describe('netContributionCentsFor — the three refund regimes', () => {
  const base = {
    qty: 2,
    priceCents: 1112,
    costBasis: COST_BASIS,
    subtotalCents: 2224,
  };

  /** No refund: the gross figure, unchanged, with per-unit rounding intact. */
  it('returns the gross figure when nothing was refunded', () => {
    expect(netContributionCentsFor({ ...base, refundedCents: 0 })).toBe(802);
  });

  /** Full refund: exactly zero, by arithmetic and not by subtraction. */
  it('returns exactly zero when the whole charge went back', () => {
    expect(netContributionCentsFor({ ...base, refundedCents: 2224 })).toBe(0);
  });

  /**
   * ## The `refunded >= subtotal → return 0` guard is an **equivalent mutant**
   *
   * Deleting it does not change any output: the scaling path computes
   * `roundHalfUp(gross × 0 ÷ subtotal)` = `0` for a full refund, and for a refund
   * *larger* than the charge `roundHalfUp` of a negative value still cannot make the
   * result non-zero at these magnitudes. So no test can distinguish the two
   * versions, and a sweep will always report this guard as a survivor.
   *
   * It stays for a reason that is not behavioural: it is what makes "a fully
   * refunded order contributes exactly zero" a **statement in the code** rather
   * than an emergent property of floating-point arithmetic — and it is what
   * protects that property if `roundHalfUp` or the scaling expression ever changes
   * shape. Recorded here so the next sweep's survivor is recognised as known.
   *
   * What *is* asserted is the branch's own precondition: a refund at or beyond the
   * charge lands on the zero path rather than the scaling path.
   */
  it('routes a refund at or beyond the charge through the zero path', () => {
    // `refunded === subtotal` and `refunded > subtotal` both short-circuit.
    expect(netContributionCentsFor({ ...base, refundedCents: 2224 })).toBe(0);
    expect(netContributionCentsFor({ ...base, refundedCents: 2225 })).toBe(0);
    // And the scaling path, invoked directly, would agree — which is why this is an
    // equivalent mutant and not a gap.
    expect(roundHalfUp((802 * 0) / 2224)).toBe(0);
  });

  /**
   * Partial refund (FR-903), pro-rata: half the charge back, so half the
   * contribution kept.
   *
   * `roundHalfUp(802 × 1112 ÷ 2224)` = `roundHalfUp(401)` = **401**. This is an
   * approximation — the food for the refunded plate was probably cooked — and the
   * docblock states why the exact figure is not computable: `Order` records
   * refunded *cents*, not refunded *units*.
   */
  it('scales pro-rata for a partial refund', () => {
    expect(netContributionCentsFor({ ...base, refundedCents: 1112 })).toBe(401);
  });

  /**
   * A third back, which is where pro-rata rounding has to choose.
   *
   * Kept `1482` of `2224`, so `802 × 1482 ÷ 2224 = 534.4…` → half-up **534**.
   * Pinned as a literal, not as the expression, so the rounding rule is asserted
   * rather than recomputed by the code under test. (My first draft of this test
   * said 535 from a hand-rounded division that was wrong; the code was right and
   * the comment was not — which is the whole reason the expected value is a
   * literal somebody has to check.)
   */
  it('rounds a pro-rata figure half-up', () => {
    expect(netContributionCentsFor({ ...base, refundedCents: 742 })).toBe(534);
  });

  /**
   * A refund larger than the charge is refused by `assertReportInputsWellFormed`
   * before it reaches here, but this function is exported and must not divide by a
   * negative kept-fraction if it is ever called directly.
   */
  it('treats a refund at or beyond the charge as fully refunded', () => {
    expect(netContributionCentsFor({ ...base, refundedCents: 2225 })).toBe(0);
  });

  it('refuses a zero-subtotal order with a partial refund', () => {
    expect(() =>
      netContributionCentsFor({
        qty: 1,
        priceCents: 1112,
        costBasis: COST_BASIS,
        subtotalCents: 0,
        refundedCents: 0,
      }),
    ).not.toThrow();
  });
});

describe('figuresFor — FR-701', () => {
  /** A drop at `$11.12` with three orders, one of them fully refunded. */
  function source(overrides: Partial<DropReportSource> = {}): DropReportSource {
    return {
      dropId: 'drop-1',
      dropTitle: 'Tuesday bowls',
      merchantName: 'Rangoli',
      merchantTimezone: 'America/Edmonton',
      windowStart: new Date('2026-03-10T19:00:00Z'),
      minQty: 10,
      maxQty: 20,
      dealPriceCents: 1112,
      costBasis: COST_BASIS,
      orders: [
        order({ orderId: 'o1', qty: 2, subtotalCents: 2224, platformFeeCents: 178 }),
        order({ orderId: 'o2', qty: 1, subtotalCents: 1112, platformFeeCents: 89 }),
        order({
          orderId: 'o3',
          qty: 2,
          subtotalCents: 2224,
          platformFeeCents: 178,
          refundedCents: 2224,
          platformFeeReversedCents: 178,
        }),
      ],
      ledger: [
        { orderId: 'o1', type: 'CHARGE', amountCents: 2224 },
        { orderId: 'o1', type: 'PLATFORM_FEE', amountCents: 178 },
        { orderId: 'o2', type: 'CHARGE', amountCents: 1112 },
        { orderId: 'o2', type: 'PLATFORM_FEE', amountCents: 89 },
        { orderId: 'o3', type: 'CHARGE', amountCents: 2224 },
        { orderId: 'o3', type: 'PLATFORM_FEE', amountCents: 178 },
        { orderId: 'o3', type: 'REFUND', amountCents: -2224 },
        { orderId: 'o3', type: 'ADJUSTMENT', amountCents: -178 },
      ],
      customers: [],
      attribution: [],
      ...overrides,
    };
  }

  it('sums the five FR-701 figures from the orders', () => {
    const figures = figuresFor(source());

    expect(figures.unitsSold).toBe(5);
    expect(figures.gmvCents).toBe(5560);
    // 178 + 89 + 178, then −178 of reversal: the refunded order's fee is not revenue.
    expect(figures.platformFeeCents).toBe(267);
    expect(figures.refundedCents).toBe(2224);
    expect(figures.netCapturedCents).toBe(3336);
  });

  /**
   * **The test that keeps a cancelled drop from reading as a triumph — and the
   * test that found a real defect in the formula.**
   *
   * Three orders at `$11.12`, all fully refunded. GMV is `$33.36`: money that was
   * genuinely rung up and genuinely returned. Contribution must be **exactly
   * zero**, not `$12.03` (which would ignore the refund) and not `−$21.33` (which
   * is what `Σ contribution − refundedCents` produces, and what the first version
   * of this module computed).
   *
   * The `−$21.33` is the dangerous one. A force-failed drop (FR-502/FR-902) takes
   * every card and gives every cent back, and the merchant never cooked anything —
   * their contribution is zero, not a large loss. Charging them for the food twice
   * on the one screen they use to decide whether to run another deal would be a
   * bug with a behavioural consequence, not a rounding error.
   */
  it('reports exactly zero contribution when every order was fully refunded', () => {
    const figures = figuresFor(
      source({
        orders: [
          order({
            orderId: 'o1',
            qty: 3,
            subtotalCents: 3336,
            platformFeeCents: 267,
            refundedCents: 3336,
            platformFeeReversedCents: 267,
          }),
        ],
        ledger: [
          { orderId: 'o1', type: 'CHARGE', amountCents: 3336 },
          { orderId: 'o1', type: 'PLATFORM_FEE', amountCents: 267 },
          { orderId: 'o1', type: 'REFUND', amountCents: -3336 },
          { orderId: 'o1', type: 'ADJUSTMENT', amountCents: -267 },
        ],
      }),
    );

    expect(figures.gmvCents).toBe(3336);
    expect(figures.refundedCents).toBe(3336);
    expect(figures.netCapturedCents).toBe(0);
    expect(figures.contributionCents).toBe(0);
    // Named explicitly, because this is the number the wrong formula produced.
    expect(figures.contributionCents).not.toBe(1203 - 3336);
  });

  /**
   * Contribution % is over **GMV**, and this test is the one that would fail if
   * someone "helpfully" reused `contributionPctOfMenu`.
   *
   * Two plates at `$11.12`: GMV `2224`, contribution `2 × 401 = 802`, so
   * `802 / 2224 = 0.36061…`. Over menu price instead — `802 / 1600 = 0.50125` —
   * a merchant multiplying `$22.24 × 50%` gets `$11.12` and cannot find it.
   */
  it('divides contribution by GMV, not by menu price', () => {
    const figures = figuresFor(
      source({
        orders: [order({ orderId: 'o1', qty: 2, subtotalCents: 2224, platformFeeCents: 178 })],
        ledger: [
          { orderId: 'o1', type: 'CHARGE', amountCents: 2224 },
          { orderId: 'o1', type: 'PLATFORM_FEE', amountCents: 178 },
        ],
      }),
    );

    expect(figures.contributionCents).toBe(802);
    expect(figures.contributionPctOfGmv).toBeCloseTo(802 / 2224, 10);
    // The two denominators are far enough apart that a mix-up is visible.
    expect(figures.contributionPctOfGmv).not.toBeCloseTo(802 / 1600, 3);
  });

  /** A drop nobody joined reports zeros and, critically, no `NaN`. */
  it('reports zero percent for a drop with no orders', () => {
    const figures = figuresFor(source({ orders: [], ledger: [] }));

    expect(figures).toEqual({
      unitsSold: 0,
      gmvCents: 0,
      platformFeeCents: 0,
      netCapturedCents: 0,
      refundedCents: 0,
      contributionCents: 0,
      contributionPctOfGmv: 0,
    });
    expect(Number.isNaN(figures.contributionPctOfGmv)).toBe(false);
  });
});

describe('assertReportInputsWellFormed', () => {
  function oneOrder(overrides: {
    subtotalCents: number;
    qty?: number;
    refundedCents?: number;
  }): DropReportSource {
    return {
      dropId: 'drop-1',
      dropTitle: 'd',
      merchantName: 'm',
      merchantTimezone: 'America/Edmonton',
      windowStart: new Date('2026-03-10T19:00:00Z'),
      minQty: 1,
      maxQty: 20,
      dealPriceCents: 1112,
      costBasis: COST_BASIS,
      orders: [
        order({
          orderId: 'o1',
          qty: overrides.qty ?? 1,
          subtotalCents: overrides.subtotalCents,
          platformFeeCents: 89,
          refundedCents: overrides.refundedCents ?? 0,
        }),
      ],
      ledger: [],
      customers: [],
      attribution: [],
    };
  }

  /**
   * An order that does not carry the drop's price.
   *
   * Contribution is computed from `drop.dealPriceCents`, so an order written at a
   * different price would be reported at a contribution it never earned. The
   * message names both numbers, because the whole point is which row disagrees.
   */
  it('refuses an order whose subtotal does not match the drop price', () => {
    expect(() => assertReportInputsWellFormed(oneOrder({ subtotalCents: 1200 }))).toThrow(
      /does not carry the drop's price.*1 × 1112 is 1112, but subtotalCents is 1200/s,
    );
  });

  it('accepts the same order once the subtotal matches', () => {
    expect(() => assertReportInputsWellFormed(oneOrder({ subtotalCents: 1112 }))).not.toThrow();
  });

  /**
   * A refund larger than its charge. Clamping is the wrong answer for the reason
   * `assertRefundWithinSubtotal` gives: it understates the merchant's money
   * silently and destroys the evidence of the defect.
   */
  it('refuses a refund larger than its charge', () => {
    expect(() =>
      assertReportInputsWellFormed(oneOrder({ subtotalCents: 1112, refundedCents: 1113 })),
    ).toThrow(/Refusing to clamp/);
  });

  it('refuses a zero-quantity order', () => {
    expect(() =>
      assertReportInputsWellFormed(oneOrder({ subtotalCents: 0, qty: 0 })),
    ).toThrow(/at least one unit/);
  });
});

describe('isNewCustomer — FR-702', () => {
  it('calls a customer with no prior capture new', () => {
    expect(isNewCustomer({ participantId: 'p1', qty: 1, priorCapturedOrderCount: 0 })).toBe(true);
  });

  it('calls a customer with one prior capture returning', () => {
    expect(isNewCustomer({ participantId: 'p1', qty: 1, priorCapturedOrderCount: 1 })).toBe(false);
  });

  /**
   * A negative count is a caller defect, not a rounding problem. Treated as
   * "returning" it would mark every customer returning and reproduce exactly the
   * failure this classifier exists to avoid — FR-702 shipping as a column of
   * zeroes that looks like a working report.
   */
  it('throws rather than guessing when the count is negative', () => {
    expect(() =>
      isNewCustomer({ participantId: 'p1', qty: 1, priorCapturedOrderCount: -1 }),
    ).toThrow(/not a non-negative integer/);
  });

  it('throws when the count is not an integer', () => {
    expect(() =>
      isNewCustomer({ participantId: 'p1', qty: 1, priorCapturedOrderCount: 1.5 }),
    ).toThrow(/not a non-negative integer/);
  });
});

describe('customerMixOf — FR-702', () => {
  it('counts new and returning separately, over people', () => {
    const mix = customerMixOf([
      { participantId: 'p1', qty: 1, priorCapturedOrderCount: 0 },
      { participantId: 'p2', qty: 2, priorCapturedOrderCount: 0 },
      { participantId: 'p3', qty: 1, priorCapturedOrderCount: 4 },
    ]);

    expect(mix.newCustomers).toBe(2);
    expect(mix.returningCustomers).toBe(1);
    expect(mix.totalCustomers).toBe(3);
    expect(mix.newCustomerPct).toBeCloseTo(2 / 3, 10);
  });

  it('reports zero percent for a drop with no capturing customers', () => {
    const mix = customerMixOf([]);

    expect(mix).toEqual({
      newCustomers: 0,
      returningCustomers: 0,
      totalCustomers: 0,
      newCustomerPct: 0,
    });
  });

  /**
   * **The regression test for the PRD's literal rule.**
   *
   * `firstSeenAt >= drop.windowStart → NEW` classifies every customer as
   * returning, because `rules.ts:91` forces `cutoffAt < windowStart` and
   * `firstSeenAt` is written at join time — before the cutoff. This test states
   * the consequence as a fact: a drop whose every participant is a first-time
   * buyer reports `newCustomers` equal to the number of people, and
   * `returningCustomers` zero. Under the literal rule it would be the reverse.
   */
  it('reports a drop full of first-time buyers as all new', () => {
    const mix = customerMixOf([
      { participantId: 'p1', qty: 1, priorCapturedOrderCount: 0 },
      { participantId: 'p2', qty: 1, priorCapturedOrderCount: 0 },
      { participantId: 'p3', qty: 1, priorCapturedOrderCount: 0 },
    ]);

    expect(mix.newCustomers).toBe(3);
    expect(mix.returningCustomers).toBe(0);
    expect(mix.newCustomerPct).toBe(1);
  });
});

describe('unattributedUnitsFor — FR-703', () => {
  const attribution = [
    { organiserProfileId: 'org-1', organiserName: 'Sam', units: 3, gmvCents: 3336, refundedCents: 0 },
    { organiserProfileId: 'org-2', organiserName: 'Ada', units: 2, gmvCents: 2224, refundedCents: 0 },
  ];

  it('reports the units no organiser is credited with', () => {
    expect(unattributedUnitsFor({ dropId: 'd', unitsSold: 10, attribution })).toBe(5);
  });

  it('reports zero when every unit was attributed', () => {
    expect(unattributedUnitsFor({ dropId: 'd', unitsSold: 5, attribution })).toBe(0);
  });

  /**
   * The `dropId`-join bug, caught here even if it somehow got past commission.
   *
   * Two organisers who shared one drop of 5 units, each credited with all 5 —
   * the exact outcome of joining orders to share links on `dropId` instead of
   * `participant.shareLinkId`. A negative remainder is impossible on correct
   * data, so it is refused rather than clamped to zero.
   */
  it('throws when attribution credits more units than were sold', () => {
    expect(() =>
      unattributedUnitsFor({
        dropId: 'd',
        unitsSold: 5,
        attribution: [
          { organiserProfileId: 'a', organiserName: 'A', units: 5, gmvCents: 0, refundedCents: 0 },
          { organiserProfileId: 'b', organiserName: 'B', units: 5, gmvCents: 0, refundedCents: 0 },
        ],
      }),
    ).toThrow(ReportIntegrityError);
  });
});

describe('suggestedActionFor — FR-705', () => {
  const noCustomers = { newCustomers: 0, returningCustomers: 0, totalCustomers: 0, newCustomerPct: 0 };
  const someNew = { newCustomers: 2, returningCustomers: 0, totalCustomers: 2, newCustomerPct: 1 };

  /**
   * The PRD's own example: *"your Tuesday 3pm sold out — try 30 units"*.
   *
   * Sold out at 20 suggests 30 — `maxQty + max(10, ceil(20/2))` — which is the
   * PRD's literal suggestion. Pinned as a literal so a change to the rule is a
   * deliberate edit rather than a silent drift.
   */
  it('suggests 30 units for a drop that sold out at 20', () => {
    expect(
      suggestedActionFor({ joinedQty: 20, minQty: 10, maxQty: 20, customerMix: someNew }),
    ).toEqual({ kind: 'SOLD_OUT', soldOutAtQty: 20, suggestedQty: 30 });
  });

  it('suggests the next round number for a drop that sold out at 12', () => {
    // max(10, ceil(12/2)) = max(10, 6) = 10, so 12 + 10 = 22.
    expect(
      suggestedActionFor({ joinedQty: 12, minQty: 10, maxQty: 12, customerMix: someNew }),
    ).toEqual({ kind: 'SOLD_OUT', soldOutAtQty: 12, suggestedQty: 22 });
  });

  /**
   * The one input where `max(10, ceil(maxQty / 2))` and a flat `+10` disagree, and
   * therefore the only test that can tell them apart.
   *
   * Below a capacity of 20 the ceiling is always ≤ 10, so the `max` returns 10 and
   * the suggestion equals a flat `+10` at every small drop — which is why a sweep
   * that only checks sold-out-at-4 and sold-out-at-20 reports the flat-ten mutant
   * as surviving. At 30 it does not: `ceil(30 / 2)` is 15, so the suggestion is 45,
   * not 40.
   */
  it('scales the increase for a large sold-out drop, rather than adding a flat ten', () => {
    expect(
      suggestedActionFor({ joinedQty: 30, minQty: 10, maxQty: 30, customerMix: someNew }),
    ).toEqual({ kind: 'SOLD_OUT', soldOutAtQty: 30, suggestedQty: 45 });
  });

  /**
   * Sold out wins over "no new customers", because the two are not in conflict:
   * a drop can fill with returning diners and still be worth running bigger.
   * The priority order is the design — see the function's docblock.
   */
  it('prefers the sold-out suggestion over the no-customers one', () => {
    expect(
      suggestedActionFor({ joinedQty: 20, minQty: 10, maxQty: 20, customerMix: noCustomers }).kind,
    ).toBe('SOLD_OUT');
  });

  it('reports how far short of the minimum a drop fell', () => {
    expect(
      suggestedActionFor({ joinedQty: 7, minQty: 10, maxQty: 20, customerMix: someNew }),
    ).toEqual({ kind: 'MISSED_MINIMUM', joinedQty: 7, minQty: 10, shortBy: 3 });
  });

  it('says nothing was new when a drop ran but acquired nobody', () => {
    expect(
      suggestedActionFor({ joinedQty: 12, minQty: 10, maxQty: 20, customerMix: noCustomers }),
    ).toEqual({ kind: 'NO_CUSTOMERS' });
  });

  /**
   * No manufactured advice. A report that always suggests something is a report
   * nobody reads, so a drop that cleared its minimum and brought new people says
   * so and stops.
   */
  it('recommends no change for a drop that performed', () => {
    expect(
      suggestedActionFor({ joinedQty: 12, minQty: 10, maxQty: 20, customerMix: someNew }),
    ).toEqual({ kind: 'PERFORMED_WELL', newCustomerPct: 1 });
  });

  /** `maxQty: 0` is a malformed drop, not a sold-out one. */
  it('does not call a zero-capacity drop sold out', () => {
    expect(
      suggestedActionFor({ joinedQty: 0, minQty: 0, maxQty: 0, customerMix: noCustomers }).kind,
    ).toBe('NO_CUSTOMERS');
  });
});

describe('reconcile — FR-701 acceptance criterion', () => {
  const figures = {
    unitsSold: 2,
    gmvCents: 2224,
    platformFeeCents: 178,
    netCapturedCents: 2224,
    refundedCents: 0,
    contributionCents: 802,
    contributionPctOfGmv: 802 / 2224,
  };

  const orders = [
    order({ orderId: 'o1', qty: 2, subtotalCents: 2224, platformFeeCents: 178 }),
  ];

  const ledger: ReportLedgerFact[] = [
    { orderId: 'o1', type: 'CHARGE', amountCents: 2224 },
    { orderId: 'o1', type: 'PLATFORM_FEE', amountCents: 178 },
  ];

  it('accepts figures that agree with the ledger', () => {
    expect(() => reconcile({ dropId: 'd', figures, ledger, orders })).not.toThrow();
  });

  /**
   * A ledger missing a `PLATFORM_FEE` row.
   *
   * L2 fires before L4 can, because the aggregate fee total already disagrees —
   * which is the correct order: the drop-level check runs first and names the
   * quantity, and L4's per-order message would be a narrower restatement of the
   * same fact. What matters for this test is that it is refused as a
   * `ReportIntegrityError`, so a caller withholding bad drops catches it.
   */
  it('refuses a ledger with a missing platform-fee row', () => {
    expect(() =>
      reconcile({
        dropId: 'd',
        figures,
        orders,
        ledger: [{ orderId: 'o1', type: 'CHARGE', amountCents: 2224 }],
      }),
    ).toThrow(ReportIntegrityError);
  });

  /**
   * And the per-order half, when the aggregates cancel out.
   *
   * One order's fee missing and another's doubled is invisible to L2 — the total
   * is right — and visible only to L4. This is the case `assertLedgerReconciles`
   * is called for.
   */
  it('refuses a per-order fee error that the aggregate cannot see', () => {
    const twoOrders = [
      order({ orderId: 'o1', qty: 1, subtotalCents: 1112, platformFeeCents: 89 }),
      order({ orderId: 'o2', qty: 1, subtotalCents: 1112, platformFeeCents: 89 }),
    ];

    expect(() =>
      reconcile({
        dropId: 'd',
        figures: {
          unitsSold: 2,
          gmvCents: 2224,
          platformFeeCents: 178,
          netCapturedCents: 2224,
          refundedCents: 0,
          contributionCents: 802,
          contributionPctOfGmv: 802 / 2224,
        },
        orders: twoOrders,
        ledger: [
          { orderId: 'o1', type: 'CHARGE', amountCents: 1112 },
          // o1's fee missing, o2's doubled: Σ is still 178.
          { orderId: 'o2', type: 'CHARGE', amountCents: 1112 },
          { orderId: 'o2', type: 'PLATFORM_FEE', amountCents: 178 },
        ],
      }),
    ).toThrow(/no PLATFORM_FEE entry/);
  });

  /**
   * A report whose GMV disagrees with the ledger. The figures here are internally
   * consistent with the orders but not with the ledger — which is the failure a
   * report-level check exists for and L1–L4 cannot see, because L1–L4 never read
   * the report's figures.
   */
  it('refuses figures whose GMV disagrees with the ledger', () => {
    expect(() =>
      reconcile({
        dropId: 'd',
        figures: { ...figures, gmvCents: 2225 },
        ledger,
        orders,
      }),
    ).toThrow(/L1: gmvCents vs Σ CHARGE/);
  });

  /**
   * **The check that only L4 makes.** Two orders wrong in opposite directions:
   * `o1`'s `CHARGE` is 100 too low and `o2`'s is 100 too high. Every aggregate —
   * charged total, refunded total, fee total — is identical, so L1–L3 pass. L4
   * walks each order against its own entry and names the offender.
   *
   * This is the reason `reconcile` calls `assertLedgerReconciles` instead of
   * restating the aggregate comparison, which is what the first version of this
   * function did.
   */
  it('refuses two orders wrong in opposite directions, which aggregates cannot see', () => {
    const twoOrders = [
      order({ orderId: 'o1', qty: 1, subtotalCents: 1112, platformFeeCents: 89 }),
      order({ orderId: 'o2', qty: 1, subtotalCents: 1112, platformFeeCents: 89 }),
    ];
    const shiftedLedger: ReportLedgerFact[] = [
      { orderId: 'o1', type: 'CHARGE', amountCents: 1012 },
      { orderId: 'o1', type: 'PLATFORM_FEE', amountCents: 89 },
      { orderId: 'o2', type: 'CHARGE', amountCents: 1212 },
      { orderId: 'o2', type: 'PLATFORM_FEE', amountCents: 89 },
    ];

    expect(() =>
      reconcile({
        dropId: 'd',
        figures: {
          unitsSold: 2,
          gmvCents: 2224,
          platformFeeCents: 178,
          netCapturedCents: 2224,
          refundedCents: 0,
          contributionCents: 802,
          contributionPctOfGmv: 802 / 2224,
        },
        ledger: shiftedLedger,
        orders: twoOrders,
      }),
    ).toThrow(/L4: CHARGE vs subtotalCents for order o1/);
  });

  /**
   * The L1–L4 delegation must surface as **this module's** error type. If it ever
   * escapes as `SettlementIntegrityError`, `merchantReportFor`'s withholding logic
   * stops matching and one bad drop 500s a merchant's whole report — which is the
   * bug this slice's own withholding test caught.
   */
  it('converts a settlement integrity failure into a report integrity failure', () => {
    expect(() =>
      reconcile({
        dropId: 'd',
        figures: { ...figures, gmvCents: 2225 },
        ledger,
        orders,
      }),
    ).toThrow(ReportIntegrityError);
  });
});

describe('isoDateInZone', () => {
  /**
   * A drop at 6pm Tuesday in Edmonton is Wednesday in UTC. Reading the instant
   * with `toISOString().slice(0, 10)` — the obvious shortcut — would file every
   * evening service under the wrong day.
   */
  it('reads the date in the merchant zone, not UTC', () => {
    expect(isoDateInZone(new Date('2026-03-11T00:30:00Z'), 'America/Edmonton')).toBe('2026-03-10');
    expect(isoDateInZone(new Date('2026-03-11T00:30:00Z'), 'UTC')).toBe('2026-03-11');
  });
});

describe('dropReportFor and merchantReportFor', () => {
  function fullSource(dropId: string, overrides: Partial<DropReportSource> = {}): DropReportSource {
    return {
      dropId,
      dropTitle: `drop ${dropId}`,
      merchantName: 'Rangoli',
      merchantTimezone: 'America/Edmonton',
      windowStart: new Date('2026-03-10T19:00:00Z'),
      minQty: 2,
      maxQty: 4,
      dealPriceCents: 1112,
      costBasis: COST_BASIS,
      orders: [order({ orderId: `${dropId}-o1`, qty: 2, subtotalCents: 2224, platformFeeCents: 178 })],
      ledger: [
        { orderId: `${dropId}-o1`, type: 'CHARGE', amountCents: 2224 },
        { orderId: `${dropId}-o1`, type: 'PLATFORM_FEE', amountCents: 178 },
      ],
      customers: [
        { participantId: `${dropId}-p1`, qty: 1, priorCapturedOrderCount: 0 },
        { participantId: `${dropId}-p2`, qty: 1, priorCapturedOrderCount: 2 },
      ],
      attribution: [
        {
          organiserProfileId: 'org-1',
          organiserName: 'Sam',
          units: 1,
          gmvCents: 1112,
          refundedCents: 0,
        },
      ],
      ...overrides,
    };
  }

  it('assembles a full row', () => {
    const row = dropReportFor(fullSource('d1'));

    expect(row.figures.gmvCents).toBe(2224);
    expect(row.customerMix).toEqual({
      newCustomers: 1,
      returningCustomers: 1,
      totalCustomers: 2,
      newCustomerPct: 0.5,
    });
    // 2 units sold, 1 attributed to Sam.
    expect(row.unattributedUnits).toBe(1);
    // 2 joined, minQty 2, maxQty 4: cleared the minimum, one new customer.
    expect(row.suggestedAction.kind).toBe('PERFORMED_WELL');
  });

  it('withholds a drop that does not reconcile and still reports the rest', () => {
    const report = merchantReportFor({
      merchantId: 'm1',
      merchantName: 'Rangoli',
      timezone: 'America/Edmonton',
      sources: [
        fullSource('good'),
        // GMV 2224 but only 1112 charged: L1 fails.
        fullSource('bad', {
          ledger: [
            { orderId: 'bad-o1', type: 'CHARGE', amountCents: 1112 },
            { orderId: 'bad-o1', type: 'PLATFORM_FEE', amountCents: 178 },
          ],
        }),
      ],
    });

    expect(report.rows.map((row) => row.dropId)).toEqual(['good']);
    expect(report.withheldDropCount).toBe(1);
    expect(report.dropCount).toBe(1);
  });

  /**
   * **A hard failure must not be withheld.** Only a `ReportIntegrityError` is
   * caught; anything else propagates.
   *
   * The distinction is the whole point of `isReportIntegrityError`. A drop whose
   * money does not reconcile is a known state the merchant should be told about; a
   * `TypeError` from a malformed fixture, or a database error mid-request, is a
   * defect, and swallowing it into a "1 drop not shown" note would hide a broken
   * deploy behind a sentence that reads like an accounting hiccup. Without this
   * test, widening the catch to everything (`catch { continue }`) is invisible —
   * every existing test still passes.
   */
  it('propagates an unexpected error instead of withholding the drop', () => {
    expect(() =>
      merchantReportFor({
        merchantId: 'm1',
        merchantName: 'Rangoli',
        timezone: 'America/Edmonton',
        sources: [
          // Not a reconciliation failure: the order's subtotal does not multiply
          // back, so `assertReportInputsWellFormed` throws a plain `Error`.
          fullSource('malformed', {
            orders: [order({ orderId: 'bad-o1', qty: 3, subtotalCents: 2224, platformFeeCents: 178 })],
          }),
        ],
      }),
    ).toThrow(/does not carry the drop's price/);
  });

  /**
   * A contribution percentage on the total is over **total GMV**, not the mean of
   * the row percentages. Two rows of very different size: averaging the two rates
   * would let a small drop weigh the same as a large one.
   */
  it('computes the total percentage over total GMV rather than averaging rows', () => {
    const report = merchantReportFor({
      merchantId: 'm1',
      merchantName: 'Rangoli',
      timezone: 'America/Edmonton',
      sources: [fullSource('d1'), fullSource('d2')],
    });

    // Both rows are identical, so the total rate equals the row rate here; the
    // assertion that it is a ratio of sums rather than a mean is the arithmetic.
    expect(report.totals.gmvCents).toBe(4448);
    expect(report.totals.contributionCents).toBe(1604);
    expect(report.totals.contributionPctOfGmv).toBeCloseTo(1604 / 4448, 10);
    // And it is not the mean of the row rates, which would be 802/2224 exactly.
    expect(report.totals.contributionPctOfGmv).toBeCloseTo(802 / 2224, 10);
  });

  it('sorts drops newest pickup first', () => {
    const report = merchantReportFor({
      merchantId: 'm1',
      merchantName: 'Rangoli',
      timezone: 'America/Edmonton',
      sources: [
        fullSource('older', { windowStart: new Date('2026-03-01T19:00:00Z') }),
        fullSource('newer', { windowStart: new Date('2026-03-20T19:00:00Z') }),
      ],
    });

    expect(report.rows.map((row) => row.dropId)).toEqual(['newer', 'older']);
  });
});

/** A captured order with sensible defaults, so each test states only what it means. */
function order(overrides: {
  orderId: string;
  qty: number;
  subtotalCents: number;
  platformFeeCents: number;
  refundedCents?: number;
  platformFeeReversedCents?: number;
}) {
  return {
    orderId: overrides.orderId,
    qty: overrides.qty,
    subtotalCents: overrides.subtotalCents,
    platformFeeCents: overrides.platformFeeCents,
    refundedCents: overrides.refundedCents ?? 0,
    platformFeeReversedCents: overrides.platformFeeReversedCents ?? 0,
  };
}
