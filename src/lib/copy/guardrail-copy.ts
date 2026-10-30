import { DEFAULT_FEES, PanelState, floorCentsOf, formatCents, roundHalfUp } from '@/lib/guardrail';
import type { DealView, IneligibilityReason } from '@/lib/guardrail';

import { guidanceLine } from './guidance';

/**
 * Every merchant-visible string about the guardrail, in one pure module
 * (ARCHITECTURE-sprint1 §7.8). No frozen string may be typed inline in a `.tsx`;
 * that is what makes AC-10 testable without a browser.
 *
 * The functions here format strings and choose sentences. They never compute
 * money: every figure arrives already rounded, on a `DealView`.
 */

export type PanelTone = 'green' | 'amber' | 'red';

export type PanelCopy = {
  state: PanelState;
  tone: PanelTone;
  headline: string;
  actionLabel: string;
  body: string[];
};

export type IneligibleCopy = {
  reason: IneligibilityReason;
  tone: PanelTone;
  headline: string;
  actionLabel: string;
  body: string[];
};

/** A two-button confirmation dialog's frozen strings (PRD-sprint1 §5.5a). */
export type ConfirmationCopy = {
  headline: string;
  body: string[];
  confirmLabel: string;
  cancelLabel: string;
};

/** The minimum-margin warning (PRD-sprint1 §5.1, US-M5). */
export type FloorWarningCopy = {
  headline: string;
  body: string[];
};

/**
 * `{menuPrice}` fallback for the floor warning when the merchant has no dishes
 * yet — the only hard-coded price in the copy layer, and it is a product rule
 * from PRD-sprint1 §5.1 rather than a default I chose.
 */
export const FLOOR_WARNING_FALLBACK_MENU_PRICE_CENTS = 1600;

/**
 * Extra inputs the panel needs that are not on `DealView`.
 *
 * - `foodCostCents`: the INVALID_COST_DATA sentence quotes the ingredient cost
 *   itself, which the view does not carry (it only carries the sum).
 */
export type PanelCopyContext = {
  foodCostCents?: number | null;
};

/**
 * The §5.3 block for a viable deal, as logical lines (the box in the PRD wraps
 * them for width; the sentence boundaries are what is frozen).
 *
 * ⚠️ The line `You keep $X per plate after ingredients, packaging, card fees and
 * our fee ($Y).` is **a deal price**, and a deal price becomes a drop, so we do
 * charge our fee on it. That is why this sentence names the fee *and* quotes the
 * fee-inclusive figure — both are correct here.
 *
 * **Do not remove "and our fee" from this line.** The INFEASIBLE sentence omits
 * it because it describes a full-price sale; this one keeps it because it
 * describes a drop. Same phrase, opposite decisions, and a global find-and-replace
 * would silently falsify this line while turning every test green
 * (PRD-sprint1 §5.7.1).
 *
 * Vector A produces exactly:
 * ```
 * $11.12 per plate   ·   normally $16.00
 * They save $4.88  (31% off)
 * You keep $4.01 per plate after ingredients, packaging, card fees and our fee ($0.89).
 * That's 25% of your menu price — exactly your minimum.
 * To break even, 71 of every 100 plates must go to people who would not have eaten here otherwise.
 * → So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.
 * ```
 */
export function panelBlock(view: DealView): string[] {
  return [
    `${formatCents(view.dealPriceCents)} per plate   ·   normally ${formatCents(view.menuPriceCents)}`,
    `They save ${formatCents(view.savingCents)}  (${view.discountPct}% off)`,
    `You keep ${formatCents(view.breakdown.contributionCents)} per plate after ingredients, packaging, card fees and our fee (${formatCents(view.breakdown.platformFeeCents)}).`,
    contributionLine(view),
    `To break even, ${view.breakEvenCountOf100} of every 100 plates must go to people who would not have eaten here otherwise.`,
    guidanceLine(view.guidanceBucket),
  ];
}

/**
 * PRD-sprint1 §5.3, "line 5" — the three variants of the
 * "That's N% of your menu price …" clause.
 */
export function contributionLine(view: DealView): string {
  const share = `That's ${view.contributionPctOfMenu}% of your menu price`;
  if (view.isBelowFloor) {
    return `${share} — below your minimum.`;
  }
  const atMinimum =
    view.minViablePriceCents !== null && view.dealPriceCents === view.minViablePriceCents;
  if (atMinimum || view.pointsAboveFloor <= 0) {
    return `${share} — exactly your minimum.`;
  }
  return `${share} — ${view.pointsAboveFloor} points above your minimum.`;
}

/**
 * The copy for a panel state (PRD-sprint1 §5.3 and §5.5).
 *
 * `view` is `null` only for `INCOMPLETE_COST_DATA`, which by definition has no
 * numbers to show.
 */
export function panelCopy(
  state: PanelState,
  view: DealView | null,
  context: PanelCopyContext = {},
): PanelCopy {
  switch (state) {
    case PanelState.OK:
      return {
        state,
        tone: 'green',
        headline: 'This works.',
        actionLabel: 'Use this price',
        body: view ? panelBlock(view) : [],
      };

    case PanelState.FLOOR:
      return {
        state,
        tone: 'green',
        headline: 'This is the lowest price that still works.',
        actionLabel: 'Use this price',
        body: view ? panelBlock(view) : [],
      };

    case PanelState.THIN:
      return {
        state,
        tone: 'amber',
        headline: 'Profitable, but nobody will bite.',
        actionLabel: 'Pick another dish',
        body: view ? thinBody(view) : [],
      };

    case PanelState.BELOW_FLOOR:
      return {
        state,
        tone: 'red',
        headline: 'That price loses you money.',
        actionLabel:
          view && view.minViablePriceCents !== null
            ? `Use ${formatCents(view.minViablePriceCents)} instead`
            : 'Use the lowest price that works',
        body: view ? belowFloorBody(view) : [],
      };

    case PanelState.INFEASIBLE:
      return {
        state,
        tone: 'red',
        headline: "This dish can't be a deal at your minimum margin.",
        actionLabel: 'Try another dish',
        body: view ? infeasibleBody(view) : [],
      };

    case PanelState.INCOMPLETE_COST_DATA:
      return {
        state,
        tone: 'red',
        headline: 'We need your ingredient cost first.',
        actionLabel: 'Add ingredient cost',
        body: [
          "We can't tell you whether a deal makes money without knowing what the food costs you. A rough number is fine — you can correct it later.",
        ],
      };

    case PanelState.INVALID_COST_DATA:
      return {
        state,
        tone: 'red',
        headline: 'Check your numbers.',
        actionLabel: 'Fix the numbers',
        body: invalidBody(view, context),
      };

    default:
      // Exhaustive over PanelState; unreachable, but a total function is cheaper
      // to reason about than a thrown error in a render path.
      return {
        state,
        tone: 'red',
        headline: 'Check your numbers.',
        actionLabel: 'Fix the numbers',
        body: [],
      };
  }
}

/** PRD-sprint1 §5.5 `THIN`. Case C must render this, not a green state. */
function thinBody(view: DealView): string[] {
  const keep = formatCents(view.breakdown.contributionCents);
  const price = formatCents(view.dealPriceCents);
  const menu = formatCents(view.menuPriceCents);
  const discount = view.discountPct;
  return [
    `At ${price} you'd keep ${keep} per plate — that part is fine.`,
    `But it's only ${discount}% off your ${menu} menu price. A ${discount}% saving won't make anyone change their lunch plans.`,
    "This dish has expensive ingredients, so there's very little room. It is a fine dish to sell normally; it is a poor dish to discount.",
  ];
}

/** PRD-sprint1 §5.5 `BELOW_FLOOR`. */
function belowFloorBody(view: DealView): string[] {
  const submitted = formatCents(view.dealPriceCents);
  const body = [
    `${submitted} is below the lowest price that still clears your minimum margin.`,
  ];
  if (view.minViablePriceCents !== null) {
    body.push(`The lowest price that works is ${formatCents(view.minViablePriceCents)}.`);
  }
  return body;
}

/**
 * PRD-sprint1 §5.5 `INFEASIBLE`.
 *
 * ### The question this sentence answers: "what do I keep today, at full price?"
 *
 * A full-price sale is **not** a drop, so we charge nothing on it. The sentence
 * therefore names exactly three deductions — "after ingredients, packaging and
 * card fees" — and quotes the matching **fee-exclusive** figure,
 * `DealView.fullPriceContributionCents` (PRD-sprint1 §5.5, §5.7.1).
 *
 * Vector D: `900 − 850 − 30 − 56.10 = −$0.36`. Quoting the fee-inclusive
 * −$1.08 here would describe a transaction that never happens and understate what
 * the merchant keeps today by the whole fee.
 *
 * `fullPriceContributionCents` is computed at the **menu** price and is
 * independent of `dealPriceCents`, so it is correct even when the view was built
 * at a submitted price — a merchant who submits $5.00 on vector D still reaches
 * INFEASIBLE (that state outranks BELOW_FLOOR) and still reads the $9.00 figure.
 *
 * ⚠️ Do **not** "unify" this with `contributionCents`. The AC-7 predicate uses
 * the fee-inclusive figure because every candidate price in the scan would be a
 * drop; this sentence is not about a drop. This line has already been changed in
 * the wrong direction twice.
 *
 * This module does no arithmetic on money. It formats and chooses sentences.
 */
function infeasibleBody(view: DealView): string[] {
  // §7.2 rule 8: read the figure off the view, never re-derive it. It is produced
  // once inside buildDealView, at the menu price, so it does not depend on which
  // price this view was built at.
  const atFullPrice = view.fullPriceContributionCents;

  const body = [
    `At full price (${formatCents(view.menuPriceCents)}) you keep ${formatCents(atFullPrice)} per plate after ingredients, packaging and card fees. Your minimum is ${formatCents(view.floorCents)} per plate. There is no price that clears both, so we won't suggest one.`,
  ];
  if (atFullPrice < 0) {
    body.push('At full price this dish already loses money.');
  }
  body.push(
    'Two ways out:',
    "· Pick a dish with cheaper ingredients — that's usually the right answer.",
    "· Lower your minimum margin, if you're willing to earn less per plate.",
  );
  return body;
}

/** PRD-sprint1 §5.5 `INVALID_COST_DATA`. */
function invalidBody(view: DealView | null, context: PanelCopyContext): string[] {
  const body: string[] = [];
  const foodCost = context.foodCostCents;
  if (view && typeof foodCost === 'number' && Number.isFinite(foodCost)) {
    body.push(
      `You charge ${formatCents(view.menuPriceCents)} but the ingredients cost you ${formatCents(foodCost)}.`,
    );
  }
  body.push(
    "A discount can't fix a dish that barely makes money at full price — it would only make it worse.",
    'Fix the two numbers, or pick a different dish.',
  );
  return body;
}

/**
 * Copy for an item that can never be part of a deal.
 *
 * Both strings are frozen in PRD-sprint1 §5.5 (the alcohol one added
 * 2026-10-30, replacing a placeholder this module had authored while the
 * document had a gap). §5.5's copy lock applies: verbatim, no paraphrase, no
 * apology clause.
 */
export function ineligibleCopy(reason: IneligibilityReason): IneligibleCopy {
  if (reason === 'NOT_BATCHABLE') {
    return {
      reason,
      tone: 'red',
      headline: 'This dish is marked as not batchable.',
      actionLabel: 'Edit this dish',
      body: [
        "You've told us you can't make 20 of these at once, so there's no batch to price. Turn batching back on if that's changed.",
      ],
    };
  }
  return {
    reason,
    tone: 'red',
    headline: "This dish contains alcohol, so it can't be part of a deal.",
    actionLabel: 'Edit this dish',
    body: [
      "Alcohol can't be sold through a GroupEat drop under Alberta's AGLC liquor rules — that's regulation, not something we can switch off.",
      "There's no exception for this dish.",
    ],
  };
}

/**
 * PRD-sprint1 §5.5a — the confirmation shown when a merchant flips
 * `containsAlcohol` from `true` to `false` (S1-025).
 *
 * The dialog asks about the **fact** ("confirm this dish contains no alcohol"),
 * not about the intention ("are you sure?"), because the fact is what is true or
 * false and what the AGLC cares about. The caller is responsible for defaulting
 * focus to Cancel — the confirm button must not be what a double-tap hits.
 *
 * Flipping `false → true` needs no confirmation and must not get one.
 */
export function alcoholFlagConfirmationCopy(): ConfirmationCopy {
  return {
    headline: 'Confirm this dish contains no alcohol.',
    body: ["If it does, it can't be sold through a drop."],
    confirmLabel: 'Yes, this dish has no alcohol',
    cancelLabel: 'Cancel',
  };
}

/**
 * US-M5 — the minimum-margin warning, frozen in PRD-sprint1 §5.1.
 *
 * Placement is a requirement, not styling: it appears **only** on the settings
 * page, either as the merchant drags below `FLOOR_WARN_THRESHOLD` or because the
 * saved value is already below it. It must never appear on first login, on the
 * dish screen, in the guardrail panel, as a modal, a toast or an email — a
 * warning shown before the merchant has a reason to care teaches them to dismiss
 * warnings, which is the one thing this screen cannot afford.
 *
 * `pct` is a fraction (`0.1`, not `10`). `menuPriceCents` should be the
 * merchant's own highest-priced dish; the `$16.00` fallback applies only when
 * they have no dishes yet (PRD-sprint1 §5.1, `{menuPrice}` row).
 */
export function floorWarningCopy(args: {
  pct: number;
  menuPriceCents?: number;
}): FloorWarningCopy {
  const pctWhole = roundHalfUp(args.pct * 100);
  const menuPriceCents = args.menuPriceCents ?? FLOOR_WARNING_FALLBACK_MENU_PRICE_CENTS;
  const amountCents = floorCentsOf({
    ...DEFAULT_FEES,
    menuPriceCents,
    foodCostCents: null,
    packagingCents: 0,
    floorPctOfMenu: args.pct,
  });

  return {
    headline: `A ${pctWhole}% minimum is very thin.`,
    body: [
      `At that rate you'd keep ${formatCents(amountCents)} on a ${formatCents(menuPriceCents)} dish. That still has to cover labour and rent — the lower this goes, the more likely a batch ends up costing you money.`,
    ],
  };
}

/**
 * PRD-sprint1 §6.4 — the breakdown row labels.
 *
 * These are PRD words, so they live here rather than in a `.tsx` (§7.8), and the
 * test-only oracle carries a transcription of them for comparison.
 *
 * "Card fees" is deliberately one row: rule 5 of §6.4 says the percentage and the
 * fixed amount are not itemised, because two rows invite an argument about rates
 * instead of a decision about the drop.
 */
export type BreakdownLabels = {
  keep: string;
  ourFee: string;
  cardFees: string;
  ingredientsAndContainer: string;
  shareOfMenuPrice: string;
  yourMinimum: string;
};

export function breakdownLabels(): BreakdownLabels {
  return {
    keep: 'You keep',
    ourFee: 'Our fee',
    cardFees: 'Card fees',
    ingredientsAndContainer: 'Ingredients + container',
    shareOfMenuPrice: 'Share of your menu price',
    yourMinimum: 'Your minimum',
  };
}

/**
 * The INFEASIBLE escape hatch (PRD-sprint1 §5.5 "Change my minimum margin", Q-6).
 *
 * ⚠️ **Not PRD-frozen.** The PRD fixes the *requirement* — a confirmation that
 * names the consequence in money, not "are you sure?" — but not the sentence. It
 * is authored here, in one place, so it is reviewable, and it is reported to the
 * PM as a copy gap rather than being buried in a component. Every number in it is
 * computed; nothing is a template placeholder.
 */
export function floorEscapeHatchCopy(args: {
  candidatePct: number;
  minViablePriceCents: number;
  keepCents: number;
  currentFloorCents: number;
}): { headline: string; consequence: string; confirmLabel: string; cancelLabel: string } {
  const shortfall = args.currentFloorCents - args.keepCents;
  const consequence =
    shortfall > 0
      ? `Lowering your minimum to ${args.candidatePct}% would let this dish sell at ${formatCents(args.minViablePriceCents)}, and you'd keep ${formatCents(args.keepCents)} per plate. That's ${formatCents(shortfall)} less than your current minimum of ${formatCents(args.currentFloorCents)} per plate.`
      : `Lowering your minimum to ${args.candidatePct}% would let this dish sell at ${formatCents(args.minViablePriceCents)}, and you'd keep ${formatCents(args.keepCents)} per plate.`;

  return {
    headline: 'Lower your minimum margin?',
    consequence,
    confirmLabel: `Lower it to ${args.candidatePct}%`,
    cancelLabel: 'Keep my minimum',
  };
}
