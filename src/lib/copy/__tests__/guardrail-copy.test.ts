import { describe, expect, it } from 'vitest';

import { PanelState, buildDealView, evaluateDeal } from '@/lib/guardrail';
import { guidanceLine } from '@/lib/copy/guidance';
import { ineligibleCopy, panelBlock, panelCopy } from '@/lib/copy/guardrail-copy';

import { VECTOR_A, VECTOR_C, VECTOR_D } from '../../guardrail/__tests__/fixtures';

/**
 * AC-10 (string half) — every frozen string, asserted exactly.
 *
 * These are explicit expectations rather than `.snap` files on purpose: a change
 * to a merchant-facing sentence must fail here with the sentence in the diff,
 * not require `--update`.
 */

const VIEW_A_AT_FLOOR = buildDealView(VECTOR_A, 1112);
const VIEW_A_ABOVE_FLOOR = buildDealView(VECTOR_A, 1150);
const VIEW_A_BELOW_FLOOR = buildDealView(VECTOR_A, 1000);
const VIEW_A_AT_MENU = buildDealView(VECTOR_A, VECTOR_A.menuPriceCents);
const VIEW_C_THIN = buildDealView(VECTOR_C, 1168);
const VIEW_D_INFEASIBLE = buildDealView(VECTOR_D, VECTOR_D.menuPriceCents);
const VIEW_A_INVALID = buildDealView(
  { ...VECTOR_A, menuPriceCents: 900, foodCostCents: 850, packagingCents: 60 },
  900,
);

describe('PRD-sprint1 §5.3 · the vector-A block is byte-identical', () => {
  it('produces the six frozen lines, in order', () => {
    expect(panelBlock(VIEW_A_AT_FLOOR)).toEqual([
      '$11.12 per plate   ·   normally $16.00',
      'They save $4.88  (31% off)',
      'You keep $4.01 per plate after ingredients, packaging, card fees and our fee ($0.89).',
      "That's 25% of your menu price — exactly your minimum.",
      'To break even, 71 of every 100 plates must go to people who would not have eaten here otherwise.',
      "→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.",
    ]);
  });

  it('is the body of the FLOOR state', () => {
    const copy = panelCopy(PanelState.FLOOR, VIEW_A_AT_FLOOR);
    expect(copy.tone).toBe('green');
    expect(copy.headline).toBe('This is the lowest price that still works.');
    expect(copy.actionLabel).toBe('Use this price');
    expect(copy.body).toEqual(panelBlock(VIEW_A_AT_FLOOR));
  });

  it('switches line 5 to "points above your minimum" above the floor', () => {
    const body = panelBlock(VIEW_A_ABOVE_FLOOR);
    expect(body[3]).toBe("That's 27% of your menu price — 2 points above your minimum.");
    expect(body[1]).toBe('They save $4.50  (28% off)');
  });

  it('switches line 5 to "below your minimum" under the floor', () => {
    const body = panelBlock(VIEW_A_BELOW_FLOOR);
    expect(body[3]).toBe("That's 19% of your menu price — below your minimum.");
  });
});

describe('PRD-sprint1 §5.5 · the seven states', () => {
  it('OK', () => {
    const copy = panelCopy(PanelState.OK, VIEW_A_ABOVE_FLOOR);
    expect(copy.tone).toBe('green');
    expect(copy.headline).toBe('This works.');
    expect(copy.actionLabel).toBe('Use this price');
    expect(copy.body.length).toBe(6);
  });

  it('FLOOR', () => {
    const copy = panelCopy(PanelState.FLOOR, VIEW_A_AT_FLOOR);
    expect(copy.headline).toBe('This is the lowest price that still works.');
    expect(copy.actionLabel).toBe('Use this price');
  });

  it('THIN (case C — do not soften this)', () => {
    const copy = panelCopy(PanelState.THIN, VIEW_C_THIN);

    expect(copy.tone).toBe('amber');
    expect(copy.headline).toBe('Profitable, but nobody will bite.');
    expect(copy.actionLabel).toBe('Pick another dish');
    expect(copy.body).toEqual([
      "At $11.68 you'd keep $3.01 per plate — that part is fine.",
      "But it's only 3% off your $12.00 menu price. A 3% saving won't make anyone change their lunch plans.",
      "This dish has expensive ingredients, so there's very little room. It is a fine dish to sell normally; it is a poor dish to discount.",
    ]);
  });

  it('BELOW_FLOOR', () => {
    const copy = panelCopy(PanelState.BELOW_FLOOR, VIEW_A_BELOW_FLOOR);

    expect(copy.tone).toBe('red');
    expect(copy.headline).toBe('That price loses you money.');
    expect(copy.actionLabel).toBe('Use $11.12 instead');
    expect(copy.body).toEqual([
      '$10.00 is below the lowest price that still clears your minimum margin.',
      'The lowest price that works is $11.12.',
    ]);
  });

  it('INFEASIBLE quotes the fee-inclusive full-price figure', () => {
    const copy = panelCopy(PanelState.INFEASIBLE, VIEW_D_INFEASIBLE, {
      contributionAtMenuPriceCents: evaluateDeal(VECTOR_D, VECTOR_D.menuPriceCents)
        .contributionCents,
    });

    expect(copy.tone).toBe('red');
    expect(copy.headline).toBe("This dish can't be a deal at your minimum margin.");
    expect(copy.actionLabel).toBe('Try another dish');
    expect(copy.body).toEqual([
      'At full price ($9.00) you keep -$1.08 per plate after ingredients, packaging, card fees and our fee. Your minimum is $2.25 per plate. There is no price that clears both, so we won\'t suggest one.',
      'At full price this dish already loses money.',
      'Two ways out:',
      "· Pick a dish with cheaper ingredients — that's usually the right answer.",
      "· Lower your minimum margin, if you're willing to earn less per plate.",
    ]);
  });

  it('INCOMPLETE_COST_DATA has no view and still reads correctly', () => {
    const copy = panelCopy(PanelState.INCOMPLETE_COST_DATA, null);

    expect(copy.tone).toBe('red');
    expect(copy.headline).toBe('We need your ingredient cost first.');
    expect(copy.actionLabel).toBe('Add ingredient cost');
    expect(copy.body).toEqual([
      "We can't tell you whether a deal makes money without knowing what the food costs you. A rough number is fine — you can correct it later.",
    ]);
  });

  it('INVALID_COST_DATA names the two numbers', () => {
    const copy = panelCopy(PanelState.INVALID_COST_DATA, VIEW_A_INVALID, { foodCostCents: 850 });

    expect(copy.tone).toBe('red');
    expect(copy.headline).toBe('Check your numbers.');
    expect(copy.actionLabel).toBe('Fix the numbers');
    expect(copy.body).toEqual([
      'You charge $9.00 but the ingredients cost you $8.50.',
      "A discount can't fix a dish that barely makes money at full price — it would only make it worse.",
      'Fix the two numbers, or pick a different dish.',
    ]);
  });

  it('every state returns a headline, an action and a tone', () => {
    for (const state of Object.values(PanelState)) {
      const copy = panelCopy(state, VIEW_A_AT_FLOOR, { foodCostCents: 480 });
      expect(copy.state).toBe(state);
      expect(copy.headline.length).toBeGreaterThan(0);
      expect(copy.actionLabel.length).toBeGreaterThan(0);
      expect(['green', 'amber', 'red']).toContain(copy.tone);
    }
  });
});

describe('PRD-sprint1 §5.3 · the guidance lookup', () => {
  it('vector A lands in the TIGHT bucket and gets the bolded sentence', () => {
    expect(VIEW_A_AT_FLOOR.guidanceBucket).toBe('TIGHT');
    expect(guidanceLine('TIGHT')).toBe(
      "→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.",
    );
  });

  it('has a frozen sentence for every bucket', () => {
    expect(guidanceLine('CHEAP')).toBe(
      "→ So run this drop in a slot you're normally empty in. This one is cheap to run — you have some room.",
    );
    expect(guidanceLine('MODERATE')).toBe(
      "→ So run this drop in a slot you're normally empty in, and start with 20 units.",
    );
    expect(guidanceLine('SEVERE')).toBe(
      "→ Most of these plates must be people who would not have come. Only run this at a time you're normally empty — and consider a cheaper dish instead.",
    );
  });

  it('at a 0% discount the break-even figure drops a bucket, as designed', () => {
    // full price contribution 963.60, deal contribution 835.60 → 0.5356 → 54 of 100.
    expect(VIEW_A_AT_MENU.breakEvenCountOf100).toBe(54);
    expect(VIEW_A_AT_MENU.guidanceBucket).toBe('MODERATE');
  });
});

describe('ineligible items', () => {
  it('non-batchable copy', () => {
    const copy = ineligibleCopy('NOT_BATCHABLE');
    expect(copy.headline).toBe('This dish is marked as not batchable.');
    expect(copy.actionLabel).toBe('Edit this dish');
    expect(copy.body).toEqual([
      "You've told us you can't make 20 of these at once, so there's no batch to price. Turn batching back on if that's changed.",
    ]);
  });

  it('alcohol copy is a hard, permanent block', () => {
    const copy = ineligibleCopy('CONTAINS_ALCOHOL');
    expect(copy.tone).toBe('red');
    expect(copy.headline).toBe("This dish contains alcohol, so it can't be part of a deal.");
    expect(copy.actionLabel).toBe('Edit this dish');
    expect(copy.body).toEqual([
      'Alcohol may not be sold through a GroupEat drop. This block is permanent and cannot be overridden.',
    ]);
  });
});
