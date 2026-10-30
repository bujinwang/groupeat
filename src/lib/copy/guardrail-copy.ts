import { PanelState, formatCents } from '@/lib/guardrail';
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

/**
 * Extra inputs the panel needs that are not on `DealView`.
 *
 * - `foodCostCents`: the INVALID_COST_DATA sentence quotes the ingredient cost
 *   itself, which the view does not carry (it only carries the sum).
 * - `contributionAtMenuPriceCents`: the INFEASIBLE sentence quotes
 *   `evaluateDeal(input, menuPriceCents).contributionCents` — the fee-inclusive
 *   full-price figure (PRD-sprint1 §5.5), **not**
 *   `DealView.fullPriceContributionCents`, which excludes the platform fee.
 *   When omitted, the view's own breakdown contribution is used, which is the
 *   same number whenever the view was built at the menu price (what the route
 *   handler does for an INFEASIBLE item).
 */
export type PanelCopyContext = {
  foodCostCents?: number | null;
  contributionAtMenuPriceCents?: number;
};

/**
 * The §5.3 block for a viable deal, as logical lines (the box in the PRD wraps
 * them for width; the sentence boundaries are what is frozen).
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
        body: view ? infeasibleBody(view, context) : [],
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
 * The quoted figure is the **fee-inclusive** contribution at full price, because
 * the sentence says "and our fee". Quoting `fullPriceContributionCents` here
 * would understate the deduction by exactly the platform fee.
 */
function infeasibleBody(view: DealView, context: PanelCopyContext): string[] {
  const atFullPrice =
    context.contributionAtMenuPriceCents !== undefined
      ? context.contributionAtMenuPriceCents
      : view.breakdown.contributionCents;

  const body = [
    `At full price (${formatCents(view.menuPriceCents)}) you keep ${formatCents(atFullPrice)} per plate after ingredients, packaging, card fees and our fee. Your minimum is ${formatCents(view.floorCents)} per plate. There is no price that clears both, so we won't suggest one.`,
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
 * Copy for an item that can never be part of a deal (PRD-sprint1 §5.5
 * "Non-batchable item", §7.4 AGLC hard block).
 *
 * The alcohol sentence is not specified verbatim in PRD-sprint1 §5.5 — it is
 * written here in the same voice and flagged in the sprint report as the one
 * frozen-string gap.
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
      'Alcohol may not be sold through a GroupEat drop. This block is permanent and cannot be overridden.',
    ],
  };
}
