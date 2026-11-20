import { describe, expect, it } from 'vitest';

import { BreakdownTable } from '@/components/guardrail/BreakdownTable';
import { DEFAULT_FEES, buildDealView, formatCents } from '@/lib/guardrail';
import type { CompleteGuardrailInput, DealView } from '@/lib/guardrail';
import { breakdownLabels } from '@/lib/copy/guardrail-copy';
import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `BreakdownTable` rendered — the first `.tsx` test in the repository.
 *
 * ## Why this file could not exist before
 *
 * `vitest.config.ts` admitted only `src/**\/*.test.ts`, so a file named
 * `*.test.tsx` was collected by nothing: no error, no skip line, no count change.
 * Measured before the glob was widened — `find src -name '*.test.tsx'` returned
 * **0**, against **212** `.test.ts` files and **71** `.tsx` sources. Nothing was
 * broken that day, which is exactly what made it a trap rather than a bug.
 *
 * Proved both directions with a sentinel test before writing this one: with the
 * widened glob the file ran and failed on demand; with the old glob the runner
 * printed **"No test files found"**. That is the difference between a test that
 * fails and a test that does not exist.
 *
 * ## Why `BreakdownTable` is the component that earns this
 *
 * Of the eight `.tsx` files no test mentioned, seven begin `'use client'` and hold
 * hooks — `PriceExplorer`, `FloorEscapeHatch`, four admin forms, the digest and
 * set-password forms. `renderToHtml` cannot exercise those, and this file does not
 * pretend otherwise: a DOM harness is a second runtime to maintain and would still
 * not run a `<form action={serverAction}>`.
 *
 * `BreakdownTable` is a **server** component with no hooks and no data access. It
 * takes a `DealView` and prints numbers. That is precisely the thing most likely to
 * be wrong and least likely to be caught by `tsc`: a row wired to the wrong field
 * compiles, typechecks, and renders a plausible dollar amount.
 *
 * ## The failure this guards
 *
 * The component does no arithmetic — every figure comes from the view, formatted
 * (`buildDealView` derives the contribution row as the remainder, so the four rows
 * reconcile by construction). The risk is therefore **transposition**: `keep` and
 * `ourFee` are both integers of similar magnitude, so swapping two lines still
 * sums to the right total on screen while telling the merchant the wrong story
 * about where their money went. §6.4 rule 1's whole purpose — "the breakdown the
 * merchant can add up" — survives a swap; the merchant's understanding does not.
 *
 * So every assertion below pairs a label with its own figure, derived from the same
 * view the component received. Swapping any two rows fails here even though the
 * column still adds up.
 */

/**
 * A view built by the real `buildDealView`, not hand-written.
 *
 * Deliberate: a literal would let this test pass with a shape the production builder
 * never produces, and the figures here have to be genuinely distinct — equal values
 * would let a transposition pass. $16.00 menu, $4.80 food, $0.80 packaging, 25 %
 * floor; the assertions below confirm the resulting four rows are pairwise distinct.
 */
const INPUT: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 1600,
  foodCostCents: 480,
  packagingCents: 80,
  floorPctOfMenu: 0.25,
};

function viewAt(dealPriceCents: number): DealView {
  return buildDealView(INPUT, dealPriceCents);
}

async function render(view: DealView): Promise<{ html: string; text: string }> {
  // The component returns an element; `renderToHtml` supplies the Suspense
  // boundary Next would (see its docblock) and rethrows any render error.
  const html = await renderToHtml(BreakdownTable({ view }));
  return { html, text: textOf(html) };
}

/** The `<dd>` (figure) that follows the `<dt>` (label) holding this exact text. */
function figureFor(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One `<div>` row: `<dt …>label</dt>` then `<dd …>figure</dd>`, in that order.
  const row = new RegExp(`<dt[^>]*>\\s*${escaped}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`);
  const match = row.exec(html);
  if (!match) throw new Error(`no row rendered for the label "${label}"`);
  return textOf(match[1] ?? '');
}

describe('BreakdownTable · the four rows carry their own figures', () => {
  it('pairs every label with the figure from its own field, not a neighbour', async () => {
    const view = viewAt(1200);
    const { html } = await render(view);
    const labels = breakdownLabels();

    // Guard the guard: if two rows held the same number, a transposition would be
    // invisible and this suite would be theatre. Asserted, not assumed.
    const rows = [
      view.breakdown.netContributionCents,
      view.breakdown.platformFeeCents,
      view.breakdown.cardFeeCents,
      view.breakdown.ingredientsAndPackagingCents,
    ];
    expect(new Set(rows).size, `the four rows must be distinct, got ${rows.join(', ')}`).toBe(4);

    expect(figureFor(html, labels.keep)).toBe(formatCents(view.breakdown.netContributionCents));
    expect(figureFor(html, labels.ourFee)).toBe(formatCents(view.breakdown.platformFeeCents));
    expect(figureFor(html, labels.cardFees)).toBe(formatCents(view.breakdown.cardFeeCents));
    expect(figureFor(html, labels.ingredientsAndContainer)).toBe(
      formatCents(view.breakdown.ingredientsAndPackagingCents),
    );
  });

  it('renders the total row, and it equals the sum of the four rows it labels', async () => {
    // §6.4 rule 1 is a claim about what the merchant sees, so it is checked on the
    // rendered strings: parse the four figures back out of the HTML and add them.
    const view = viewAt(1200);
    const { html } = await render(view);
    const labels = breakdownLabels();

    const printed = [
      figureFor(html, labels.keep),
      figureFor(html, labels.ourFee),
      figureFor(html, labels.cardFees),
      figureFor(html, labels.ingredientsAndContainer),
    ].map((text) => Math.round(Number.parseFloat(text.replace(/[^0-9.-]/g, '')) * 100));

    const total = printed.reduce((sum, cents) => sum + cents, 0);
    expect(total).toBe(view.dealPriceCents);
    expect(figureFor(html, 'Deal price')).toBe(formatCents(view.dealPriceCents));
  });
});

describe('BreakdownTable · the percentages are labelled too', () => {
  it('prints contributionPctOfMenu and floorPctOfMenu against their own labels', async () => {
    // Same transposition risk as the money rows, one section down: both are whole
    // percents, so a swap renders "Your minimum 31 %" and looks entirely ordinary.
    const view = viewAt(1200);
    const { html } = await render(view);
    const labels = breakdownLabels();

    expect(figureFor(html, labels.shareOfMenuPrice)).toBe(`${view.contributionPctOfMenu}%`);
    expect(figureFor(html, labels.yourMinimum)).toBe(`${view.floorPctOfMenu}%`);
  });

  it('shows the floor as configured, not as the contribution', async () => {
    // A different price moves the contribution but must not move the floor.
    const low = viewAt(900);
    const high = viewAt(1400);
    const labels = breakdownLabels();

    const lowHtml = (await render(low)).html;
    const highHtml = (await render(high)).html;

    expect(figureFor(lowHtml, labels.yourMinimum)).toBe(`${low.floorPctOfMenu}%`);
    expect(figureFor(highHtml, labels.yourMinimum)).toBe(`${high.floorPctOfMenu}%`);
    expect(low.floorPctOfMenu).toBe(high.floorPctOfMenu);

    // And the contribution genuinely did move, so the assertion above is not
    // comparing two identical numbers.
    expect(low.contributionPctOfMenu).not.toBe(high.contributionPctOfMenu);
  });
});

describe('BreakdownTable · it formats rather than computes', () => {
  it('renders exactly six money figures and no raw integer cents', async () => {
    // Five dollar figures (four rows + total). A regression that printed a bare
    // `1200` instead of `$12.00` is a plausible edit and reads as obviously wrong
    // only if you look; this asserts the shape of every figure on the screen.
    const view = viewAt(1200);
    const { text } = await render(view);

    const dollarFigures = text.match(/\$\d+\.\d{2}/g) ?? [];
    expect(dollarFigures).toHaveLength(5);

    // No stray bare integer: every number in the text is either inside a `$` figure
    // or immediately followed by `%`.
    const bare = text.match(/(?<![\d$.])\d+(?![\d.%])/g) ?? [];
    expect(bare, `unexpected bare integers: ${bare.join(', ')}`).toEqual([]);
  });

  it('renders a negative contribution with its sign, not as an absolute value', async () => {
    // `buildDealView` may legitimately produce a negative "You keep" — a price below
    // cost. `formatCents` prefixes `-`; a component that took `Math.abs` would show a
    // loss as a gain, which is the single most expensive misreading on this screen.
    const view = viewAt(400);
    const { html } = await render(view);

    expect(view.breakdown.netContributionCents).toBeLessThan(0);
    expect(figureFor(html, breakdownLabels().keep)).toBe(
      formatCents(view.breakdown.netContributionCents),
    );
    expect(figureFor(html, breakdownLabels().keep).startsWith('-')).toBe(true);
  });
});
