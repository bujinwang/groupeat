import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, buildDealView, cardFeeAt, platformFeeAt } from '@/lib/guardrail';
import type { CompleteGuardrailInput } from '@/lib/guardrail';

import { CHARGE_MODEL, merchantContributionUnder, settleCharge } from '../fee-bearer';

/**
 * ADR-001 — the guardrail's fee assumption, asserted against the charge model.
 *
 * ## The gap this closes
 *
 * Before this file, the guardrail's tests fed `DEFAULT_FEES` into
 * `minViablePrice()` and then asserted that `minViablePrice()` had subtracted
 * `DEFAULT_FEES`. That is a tautology: it holds whether or not the merchant
 * actually pays the card fee. The suite could not have caught the destination-
 * charge bug described in ADR-001 §2, because the bug is about who pays, and no
 * test had an opinion about who pays.
 *
 * This file has an opinion. It reconciles the **display** figure (what the panel
 * shows the merchant) against the **settlement** figure (what the merchant's
 * Stripe balance actually gains) and requires them to be the same number under
 * the model we ship.
 *
 * ## Vector A, from PRD-v1 §7.4
 *
 * menu $16.00, food $4.80, packaging $0.80, deal price $11.12, floor 25%.
 * Published figures: platform fee $0.89, card fee $0.62, contribution **$4.01**,
 * walk-in contribution $9.64, break-even 70.6%.
 */

const VECTOR_A: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 1600,
  foodCostCents: 480,
  packagingCents: 80,
  floorPctOfMenu: 0.25,
};

const DEAL_PRICE = 1112;

function feefor(priceCents: number, input: CompleteGuardrailInput): {
  cardFeeCents: number;
  platformFeeCents: number;
} {
  return {
    cardFeeCents: cardFeeAt(priceCents, input),
    platformFeeCents: platformFeeAt(priceCents, input),
  };
}

describe('ADR-001 · the shipped charge model is the one the guardrail assumes', () => {
  it('is DIRECT', () => {
    // If this ever changes, every frozen figure in the copy fixture is wrong.
    expect(CHARGE_MODEL).toBe('DIRECT');
  });

  it('under DIRECT, settlement reproduces the panel figure for vector A exactly', () => {
    const view = buildDealView(VECTOR_A, DEAL_PRICE);
    const { cardFeeCents, platformFeeCents } = feefor(DEAL_PRICE, VECTOR_A);

    const settled = merchantContributionUnder({
      chargedCents: DEAL_PRICE,
      platformFeeCents,
      cardFeeCents,
      foodCostCents: VECTOR_A.foodCostCents,
      packagingCents: VECTOR_A.packagingCents,
      model: 'DIRECT',
    });

    // The panel says $4.01. Settlement must agree to the cent.
    expect(view.breakdown.netContributionCents).toBe(401);
    expect(Math.round(settled)).toBe(401);
  });

  it('under DESTINATION, settlement disagrees with the panel by exactly the card fee', () => {
    // This is the regression test that matters: it pins the SIZE of the error, so
    // a future reader can see it is not a rounding artefact.
    const view = buildDealView(VECTOR_A, DEAL_PRICE);
    const { cardFeeCents, platformFeeCents } = feefor(DEAL_PRICE, VECTOR_A);

    const settled = merchantContributionUnder({
      chargedCents: DEAL_PRICE,
      platformFeeCents,
      cardFeeCents,
      foodCostCents: VECTOR_A.foodCostCents,
      packagingCents: VECTOR_A.packagingCents,
      model: 'DESTINATION',
    });

    expect(view.breakdown.netContributionCents).toBe(401);
    expect(Math.round(settled)).toBe(463);
    expect(Math.round(settled) - view.breakdown.netContributionCents).toBe(
      Math.round(cardFeeCents),
    );
  });

  it('under DESTINATION, GroupEat nets what is left of our fee after Stripe', () => {
    const { cardFeeCents, platformFeeCents } = feefor(DEAL_PRICE, VECTOR_A);

    const direct = settleCharge({
      chargedCents: DEAL_PRICE,
      platformFeeCents,
      cardFeeCents,
      model: 'DIRECT',
    });
    const destination = settleCharge({
      chargedCents: DEAL_PRICE,
      platformFeeCents,
      cardFeeCents,
      model: 'DESTINATION',
    });

    expect(Math.round(direct.platformNetCents)).toBe(89);
    expect(Math.round(destination.platformNetCents)).toBe(27);
  });

  it('every model is zero-sum: the charge is fully accounted for', () => {
    // "The money goes somewhere" — the identity that catches a settlement bug
    // before it becomes a reconciliation bug in M5.
    for (const model of ['DIRECT', 'DESTINATION'] as const) {
      for (const charged of [410, 650, 1112, 1600, 5000]) {
        const { cardFeeCents, platformFeeCents } = feefor(charged, VECTOR_A);
        const settled = settleCharge({
          chargedCents: charged,
          platformFeeCents,
          cardFeeCents,
          model,
        });
        const total =
          settled.merchantGrossCents + settled.platformNetCents + settled.cardFeeCents;
        expect(total).toBeCloseTo(charged, 6);
      }
    }
  });

  it('under DIRECT the card-fee bearer is the merchant', () => {
    const { cardFeeCents, platformFeeCents } = feefor(DEAL_PRICE, VECTOR_A);
    const settled = settleCharge({
      chargedCents: DEAL_PRICE,
      platformFeeCents,
      cardFeeCents,
      model: 'DIRECT',
    });
    expect(settled.cardFeeBearer).toBe('MERCHANT');
  });
});

describe('ADR-001 · the low-ticket case where the model decides the business', () => {
  /**
   * The fee floor is $0.60. On a $4.10 item the card fee is 2.9% + 30c = $0.42,
   * which is 70% of our fee. Under DESTINATION the platform nets $0.18 on a deal
   * it spent sales effort to run. This is the case that makes the choice
   * existential rather than cosmetic.
   */
  it('vector B: destination charging leaves the platform under 20 cents a unit', () => {
    const vectorB: CompleteGuardrailInput = {
      ...DEFAULT_FEES,
      menuPriceCents: 650,
      foodCostCents: 110,
      packagingCents: 35,
      floorPctOfMenu: 0.25,
    };
    const price = 410;
    const { cardFeeCents, platformFeeCents } = feefor(price, vectorB);

    const direct = settleCharge({
      chargedCents: price,
      platformFeeCents,
      cardFeeCents,
      model: 'DIRECT',
    });
    const destination = settleCharge({
      chargedCents: price,
      platformFeeCents,
      cardFeeCents,
      model: 'DESTINATION',
    });

    expect(Math.round(direct.platformNetCents)).toBe(60);
    expect(destination.platformNetCents).toBeLessThan(20);
  });
});
