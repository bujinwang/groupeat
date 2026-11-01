/**
 * Which party bears the Stripe processing fee, expressed as code.
 *
 * ## Why this file exists
 *
 * `src/lib/guardrail/fees.ts` subtracts `cardFeeAt()` from the **merchant's**
 * contribution. That is an assumption about our payment integration, not a law of
 * arithmetic, and until Sprint 2 nothing in the codebase asserted it. Every
 * guardrail test fed the constants back to the module that produced them, so the
 * suite was green whether or not the assumption matched reality.
 *
 * This module states the assumption once, in types, so ADR-001's claim can be
 * tested against a real Stripe charge instead of against a comment.
 *
 * ## The two models
 *
 * | Model | Charge lives on | Stripe fee paid by | Our revenue |
 * |---|---|---|---|
 * | `DIRECT` | connected account | **merchant** | `application_fee_amount`, gross |
 * | `DESTINATION` | platform | **platform** | application fee − Stripe fee |
 *
 * The guardrail implements `DIRECT`. See ADR-001 §2.
 *
 * ## The failure this prevents
 *
 * Under `DESTINATION`, vector A's merchant keeps $4.63 rather than the $4.01 the
 * panel prints, and GroupEat nets $0.27 rather than $0.89. Both are silent: the
 * panel looks right, the breakdown reconciles, and the only symptom is that the
 * merchant's bank account disagrees with the app.
 */

/** The charge model GroupEat uses. See ADR-001. */
export const CHARGE_MODEL = 'DIRECT' as const;

export type ChargeModel = 'DIRECT' | 'DESTINATION';

export type FeeSettlement = {
  /** What the diner is charged, in cents. */
  chargedCents: number;
  /** GroupEat's fee, in cents — `application_fee_amount` on a direct charge. */
  platformFeeCents: number;
  /** Stripe's processing fee, in cents. */
  cardFeeCents: number;
  /** What lands in the merchant's balance, before their own food/packaging costs. */
  merchantGrossCents: number;
  /** What lands in GroupEat's balance. */
  platformNetCents: number;
  /** Who actually pays Stripe. */
  cardFeeBearer: 'MERCHANT' | 'PLATFORM';
};

/**
 * Splits one charge between the merchant and the platform.
 *
 * Pure, and deliberately separate from the guardrail: the guardrail answers "what
 * should the merchant charge", this answers "who gets what once they do". Keeping
 * them apart is what lets ADR-001's test assert the second against Stripe without
 * touching the frozen arithmetic of the first.
 *
 * `merchantGrossCents + platformNetCents + cardFeeCents === chargedCents`, always.
 * That identity is the whole point — it is the sentence "the money goes somewhere"
 * made checkable.
 */
export function settleCharge(args: {
  chargedCents: number;
  platformFeeCents: number;
  cardFeeCents: number;
  model: ChargeModel;
}): FeeSettlement {
  const { chargedCents, platformFeeCents, cardFeeCents, model } = args;

  if (model === 'DIRECT') {
    // The card fee leaves the connected account before GroupEat's fee is
    // transferred out. Both come off the top of the charge.
    return {
      chargedCents,
      platformFeeCents,
      cardFeeCents,
      merchantGrossCents: chargedCents - cardFeeCents - platformFeeCents,
      platformNetCents: platformFeeCents,
      cardFeeBearer: 'MERCHANT',
    };
  }

  // Destination charge: the full amount is transferred to the connected account,
  // our application fee is pulled back, and Stripe debits ITS fee from the
  // platform's balance — so the platform nets the application fee minus Stripe's.
  return {
    chargedCents,
    platformFeeCents,
    cardFeeCents,
    merchantGrossCents: chargedCents - platformFeeCents,
    platformNetCents: platformFeeCents - cardFeeCents,
    cardFeeBearer: 'PLATFORM',
  };
}

/**
 * The merchant's contribution per plate under a given charge model.
 *
 * This is the function that proves ADR-001's claim in one line: feed it the
 * guardrail's own `cardFeeAt()` and it must reproduce `DealView`'s
 * `netContributionCents` — but **only** under `DIRECT`.
 */
export function merchantContributionUnder(args: {
  chargedCents: number;
  platformFeeCents: number;
  cardFeeCents: number;
  foodCostCents: number;
  packagingCents: number;
  model: ChargeModel;
}): number {
  const settled = settleCharge(args);
  return settled.merchantGrossCents - args.foodCostCents - args.packagingCents;
}
