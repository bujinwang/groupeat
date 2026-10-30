import { describe, expect, it } from 'vitest';

import { PanelState, buildDealView, evaluateDeal, formatCents } from '@/lib/guardrail';
import { guidanceLine } from '@/lib/copy/guidance';
import { alcoholFlagConfirmationCopy, floorWarningCopy, ineligibleCopy, panelBlock, panelCopy } from '@/lib/copy/guardrail-copy';

import {
  FROZEN_ALCOHOL_CONFIRMATION,
  FROZEN_FLOOR_WARNING,
  FROZEN_GUIDANCE,
  FROZEN_INELIGIBLE,
  FROZEN_PANEL_COPY,
  FROZEN_VECTOR_A_BLOCK,
} from '../__fixtures__/frozen-copy';
import { VECTOR_A, VECTOR_C, VECTOR_D } from '../../guardrail/__tests__/fixtures';

/**
 * AC-10 (string half), against the test-only oracle (ARCHITECTURE-sprint1 §7.8).
 *
 * Every expectation below comes from `__fixtures__/frozen-copy.ts`, which is a
 * hand transcription of PRD-sprint1 with a § tag on each block. The code is never
 * the source of truth for a merchant-visible sentence: when the PRD changes, the
 * fixture is edited first and the code is made to match.
 *
 * View-dependent bodies (THIN, INFEASIBLE, INVALID, and the §5.3 block) are
 * templates in the PRD rather than literals, so they are asserted against the
 * concrete vector they belong to, inline, with the § reference beside them.
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

/** Resolves the one templated action label in the oracle. */
function frozenActionLabel(state: PanelState, minViablePriceCents: number | null): string {
  const template = FROZEN_PANEL_COPY[state].actionLabel;
  return template.replace(
    '{minViablePrice}',
    minViablePriceCents === null ? '' : formatCents(minViablePriceCents),
  );
}

describe('§7.8 oracle · completeness in both directions', () => {
  it('has exactly one frozen entry per PanelState, and no extras', () => {
    // PRD-sprint1 §5.4 lists exactly seven states. An eighth state with invented
    // copy must fail here, and a stale frozen entry no state can produce must
    // fail too.
    expect(Object.keys(FROZEN_PANEL_COPY).sort()).toEqual(Object.values(PanelState).sort());
  });

  it('has exactly one frozen guidance line per bucket', () => {
    // PRD-sprint1 §5.3, the four-row guidance table.
    expect(Object.keys(FROZEN_GUIDANCE).sort()).toEqual(
      ['CHEAP', 'MODERATE', 'TIGHT', 'SEVERE'].sort(),
    );
  });

  it('has exactly one frozen block per ineligibility reason', () => {
    expect(Object.keys(FROZEN_INELIGIBLE).sort()).toEqual(
      ['CONTAINS_ALCOHOL', 'NOT_BATCHABLE'].sort(),
    );
  });
});

describe('PRD-sprint1 §5.4 · every state renders its frozen headline, action and tone', () => {
  it('matches the oracle for all seven states', () => {
    const views: Record<PanelState, ReturnType<typeof buildDealView> | null> = {
      OK: VIEW_A_ABOVE_FLOOR,
      FLOOR: VIEW_A_AT_FLOOR,
      THIN: VIEW_C_THIN,
      BELOW_FLOOR: VIEW_A_BELOW_FLOOR,
      INFEASIBLE: VIEW_D_INFEASIBLE,
      INCOMPLETE_COST_DATA: null,
      INVALID_COST_DATA: VIEW_A_INVALID,
    };

    for (const state of Object.values(PanelState)) {
      const view = views[state];
      const copy = panelCopy(state, view, { foodCostCents: 480 });
      const frozen = FROZEN_PANEL_COPY[state];

      expect(copy.state, state).toBe(state);
      expect(copy.tone, state).toBe(frozen.tone);
      expect(copy.headline, state).toBe(frozen.headline);
      expect(copy.actionLabel, state).toBe(
        frozenActionLabel(state, view?.minViablePriceCents ?? null),
      );
    }
  });
});

describe('PRD-sprint1 §5.3 · the vector-A block is byte-identical', () => {
  it('produces the six frozen lines, in order', () => {
    expect(panelBlock(VIEW_A_AT_FLOOR)).toEqual([...FROZEN_VECTOR_A_BLOCK]);
  });

  it('is the body of the FLOOR state', () => {
    expect(panelCopy(PanelState.FLOOR, VIEW_A_AT_FLOOR).body).toEqual([...FROZEN_VECTOR_A_BLOCK]);
  });

  it('is also the body of the OK state', () => {
    expect(panelCopy(PanelState.OK, VIEW_A_ABOVE_FLOOR).body).toHaveLength(
      FROZEN_VECTOR_A_BLOCK.length,
    );
  });

  it('switches line 5 to "points above your minimum" above the floor', () => {
    // PRD-sprint1 §5.3, the three variants of the "that's N%…" clause.
    const body = panelBlock(VIEW_A_ABOVE_FLOOR);
    expect(body[3]).toBe("That's 27% of your menu price — 2 points above your minimum.");
    expect(body[1]).toBe('They save $4.50  (28% off)');
  });

  it('switches line 5 to "below your minimum" under the floor', () => {
    const body = panelBlock(VIEW_A_BELOW_FLOOR);
    expect(body[3]).toBe("That's 19% of your menu price — below your minimum.");
  });
});

describe('PRD-sprint1 §5.5 · the view-dependent bodies', () => {
  it('THIN — case C, do not soften this', () => {
    const copy = panelCopy(PanelState.THIN, VIEW_C_THIN);

    expect(copy.body).toEqual([
      "At $11.68 you'd keep $3.01 per plate — that part is fine.",
      "But it's only 3% off your $12.00 menu price. A 3% saving won't make anyone change their lunch plans.",
      "This dish has expensive ingredients, so there's very little room. It is a fine dish to sell normally; it is a poor dish to discount.",
    ]);
  });

  it('BELOW_FLOOR — names the submitted price and the price to use instead', () => {
    const copy = panelCopy(PanelState.BELOW_FLOOR, VIEW_A_BELOW_FLOOR);

    expect(copy.actionLabel).toBe('Use $11.12 instead');
    expect(copy.body).toEqual([
      '$10.00 is below the lowest price that still clears your minimum margin.',
      'The lowest price that works is $11.12.',
    ]);
  });

  it('INFEASIBLE — quotes the fee-inclusive full-price figure', () => {
    const copy = panelCopy(PanelState.INFEASIBLE, VIEW_D_INFEASIBLE, {
      contributionAtMenuPriceCents: evaluateDeal(VECTOR_D, VECTOR_D.menuPriceCents)
        .contributionCents,
    });

    expect(copy.body).toEqual([
      'At full price ($9.00) you keep -$1.08 per plate after ingredients, packaging, card fees and our fee. Your minimum is $2.25 per plate. There is no price that clears both, so we won\'t suggest one.',
      'At full price this dish already loses money.',
      'Two ways out:',
      "· Pick a dish with cheaper ingredients — that's usually the right answer.",
      "· Lower your minimum margin, if you're willing to earn less per plate.",
    ]);
  });

  it('INFEASIBLE — never quotes fullPriceContributionCents (that would print -$0.36)', () => {
    // PRD-sprint1 §5.5 footnote, corrected 2026-10-30: the field that excludes
    // the platform fee would print -$0.36 in a sentence that says "and our fee".
    expect(formatCents(VIEW_D_INFEASIBLE.fullPriceContributionCents)).toBe('-$0.36');
    expect(formatCents(VIEW_D_INFEASIBLE.contributionAtMenuPriceCents)).toBe('-$1.08');

    const copy = panelCopy(PanelState.INFEASIBLE, VIEW_D_INFEASIBLE);
    const text = copy.body.join(' ');
    expect(text).toContain('you keep -$1.08 per plate');
    expect(text).not.toContain('-$0.36');
  });

  it('INFEASIBLE — correct even when the view was built at a submitted price', () => {
    // A merchant submits $5.00 on vector D. INFEASIBLE outranks BELOW_FLOOR, so
    // the breakdown describes the $5.00 order; the sentence still says "at full
    // price ($9.00)" and must quote the menu-price figure.
    const submitted = buildDealView(VECTOR_D, 500);

    expect(submitted.state).toBe(PanelState.INFEASIBLE);
    expect(submitted.breakdown.contributionCents).toBe(-485);
    expect(formatCents(submitted.contributionAtMenuPriceCents)).toBe('-$1.08');

    expect(panelCopy(PanelState.INFEASIBLE, submitted).body[0]).toBe(
      'At full price ($9.00) you keep -$1.08 per plate after ingredients, packaging, card fees and our fee. Your minimum is $2.25 per plate. There is no price that clears both, so we won\'t suggest one.',
    );
  });

  it('INCOMPLETE_COST_DATA — one body line, no view needed', () => {
    const copy = panelCopy(PanelState.INCOMPLETE_COST_DATA, null);

    expect(copy.body).toEqual([
      "We can't tell you whether a deal makes money without knowing what the food costs you. A rough number is fine — you can correct it later.",
    ]);
  });

  it('INVALID_COST_DATA — names the two numbers', () => {
    const copy = panelCopy(PanelState.INVALID_COST_DATA, VIEW_A_INVALID, { foodCostCents: 850 });

    expect(copy.body).toEqual([
      'You charge $9.00 but the ingredients cost you $8.50.',
      "A discount can't fix a dish that barely makes money at full price — it would only make it worse.",
      'Fix the two numbers, or pick a different dish.',
    ]);
  });
});

describe('PRD-sprint1 §5.3 · the guidance lookup', () => {
  it('matches the oracle for every bucket', () => {
    for (const bucket of ['CHEAP', 'MODERATE', 'TIGHT', 'SEVERE'] as const) {
      expect(guidanceLine(bucket), bucket).toBe(FROZEN_GUIDANCE[bucket]);
    }
  });

  it('vector A at its floor lands in TIGHT', () => {
    expect(VIEW_A_AT_FLOOR.guidanceBucket).toBe('TIGHT');
    expect(panelBlock(VIEW_A_AT_FLOOR)[5]).toBe(FROZEN_GUIDANCE.TIGHT);
  });

  it('a 0% discount moves vector A down a bucket, as designed', () => {
    // full-price contribution 963.60, deal contribution 835.60 → 0.5356 → 54/100.
    expect(VIEW_A_AT_MENU.breakEvenCountOf100).toBe(54);
    expect(VIEW_A_AT_MENU.guidanceBucket).toBe('MODERATE');
  });
});

describe('PRD-sprint1 §5.5 · items that can never be part of a deal', () => {
  it('matches the oracle for both reasons', () => {
    for (const reason of ['NOT_BATCHABLE', 'CONTAINS_ALCOHOL'] as const) {
      const copy = ineligibleCopy(reason);
      const frozen = FROZEN_INELIGIBLE[reason];

      expect(copy.reason).toBe(reason);
      expect(copy.tone).toBe(frozen.tone);
      expect(copy.headline).toBe(frozen.headline);
      expect(copy.actionLabel).toBe(frozen.actionLabel);
      expect(copy.body).toEqual([...frozen.body]);
    }
  });

  it('the alcohol block names the regulator and carries no apology', () => {
    // PRD-sprint1 §5.5 requires three things: state the outcome, close the door,
    // and attribute the block to the AGLC rather than to platform policy. It
    // explicitly forbids an apology clause.
    const copy = ineligibleCopy('CONTAINS_ALCOHOL');
    const text = [copy.headline, ...copy.body].join(' ').toLowerCase();

    for (const banned of ['sorry', 'unfortunately', 'we apologise', 'we apologize', 'permanent']) {
      expect(text, `must not contain "${banned}"`).not.toContain(banned);
    }
    expect(text).toContain('aglc');
    expect(text).toContain('no exception');
  });
});

describe('PRD-sprint1 §5.5a · the alcohol flag confirmation', () => {
  it('matches the oracle', () => {
    expect(alcoholFlagConfirmationCopy()).toEqual({ ...FROZEN_ALCOHOL_CONFIRMATION });
  });

  it('asks about the fact, not the intention', () => {
    const copy = alcoholFlagConfirmationCopy();
    expect(copy.headline.toLowerCase()).toContain('contains no alcohol');
    expect(copy.headline.toLowerCase()).not.toContain('are you sure');
    expect(copy.confirmLabel.toLowerCase()).toContain('no alcohol');
  });
});

describe('PRD-sprint1 §5.1 · the minimum-margin warning (US-M5)', () => {
  it('matches the oracle at the merchant’s own menu price', () => {
    const copy = floorWarningCopy({ pct: 0.1, menuPriceCents: 1600 });

    expect(copy.headline).toBe(
      FROZEN_FLOOR_WARNING.headlineTemplate.replace('{pct}', '10'),
    );
    expect(copy.body).toEqual([
      FROZEN_FLOOR_WARNING.bodyTemplate
        .replace('{amount}', '$1.60')
        .replace('{menuPrice}', '$16.00'),
    ]);
  });

  it('falls back to $16.00 only when the merchant has no dishes', () => {
    // PRD-sprint1 §5.1, the `{menuPrice}` row.
    const copy = floorWarningCopy({ pct: 0.15 });
    expect(copy.headline).toBe(FROZEN_FLOOR_WARNING.headlineTemplate.replace('{pct}', '15'));
    expect(copy.body[0]).toContain(`on a ${formatCents(FROZEN_FLOOR_WARNING.fallbackMenuPriceCents)} dish`);
  });

  it('never invents a statistic about what restaurants need', () => {
    // PRD-sprint1 §5.1: "Do not put a number like 'most restaurants need 20%' in
    // this copy — it is not derivable from the model."
    const copy = floorWarningCopy({ pct: 0.1 });
    const text = [copy.headline, ...copy.body].join(' ').toLowerCase();
    expect(text).not.toContain('most restaurants');
    expect(text).not.toContain('20%');
  });
});
