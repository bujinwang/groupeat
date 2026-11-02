import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES, minViablePrice, type CompleteGuardrailInput } from '@/lib/guardrail';
import { lintCopy } from '../copy-lint';
import { planProposals, proposalFacts, type PlanArgs } from '../plan';

/**
 * The planner's invariants.
 *
 * These are not "does it return three things" tests. Each assertion below is a
 * promise the rest of the system relies on:
 *
 *   - **No price below the floor.** A proposal becomes a draft in one click, and
 *     a draft that cannot publish is a dead end the merchant discovers later.
 *   - **No price at or above the menu.** A zero-discount "deal" is a
 *     misrepresentation (Competition Act, PRD-v1 §15.2).
 *   - **Every quantity inside the batch.** You cannot promise 40 of a dish the
 *     kitchen makes 30 of.
 *   - **The window is publishable.** `validateDropTiming` already ran inside the
 *     planner; these tests assert the *result* rather than trusting the call.
 *   - **The planner's own copy passes the planner's own linter.** If it did not,
 *     the fallback path would ship copy that the model path is forbidden to
 *     write — a two-tier rule nobody could explain.
 */

const NOW = new Date('2026-11-01T18:00:00.000Z');
/**
 * 21:00Z on 3 November. Under Alberta's permanent-DST rule (in force from
 * 2026-11-01) this is 3pm MDT; under the old rule it was 2pm MST. Nothing below
 * depends on which, which is the point — see the `proposalFacts` tests.
 */
const QUIET_START = new Date('2026-11-03T21:00:00.000Z');

/**
 * Turns `"Tuesday 2pm–4pm"` into the width of the window in hours.
 *
 * This parses the label rather than calling back into `plan.ts`, so it is an
 * independent oracle: a bug in `hourLabel` cannot satisfy both sides of the
 * assertion. It exists because the window's *width* is the one property of the
 * slot label that no time zone can change, which makes it safe to assert on any
 * date — see the `proposalFacts` tests for why that matters.
 */
function windowHours(label: string): number {
  const match = /(\d{1,2})(am|pm)–(\d{1,2})(am|pm)/.exec(label);
  if (!match) throw new Error(`not a slot label: ${label}`);
  const to24 = (hour: string, period: string): number => {
    const asTwelve = Number(hour) % 12;
    return period === 'pm' ? asTwelve + 12 : asTwelve;
  };
  return to24(match[3]!, match[4]!) - to24(match[1]!, match[2]!);
}

function guardrail(overrides: Partial<CompleteGuardrailInput> & { floorPctOfMenu: number }): CompleteGuardrailInput {
  return {
    ...DEFAULT_FEES,
    menuPriceCents: 1600,
    foodCostCents: 480,
    packagingCents: 80,
    ...overrides,
  };
}

/** PRD-v1 §7.4 vector A: floor price $11.12, break-even 70.6%. */
const VECTOR_A = {
  dish: { id: 'dish-a', name: 'Beef Bowl', menuPriceCents: 1600, batchYield: 30 },
  guardrail: guardrail({ floorPctOfMenu: 0.25 }),
};

function planArgs(overrides: Partial<PlanArgs> = {}): PlanArgs {
  return {
    dish: VECTOR_A.dish,
    guardrail: VECTOR_A.guardrail,
    quietStart: QUIET_START,
    maxQtyAsked: 30,
    intent: 'EITHER',
    merchantName: 'Golden Dragon',
    now: NOW,
    ...overrides,
  };
}

describe('planProposals — the money invariants', () => {
  it('prices every proposal at or above the floor and below the menu price', () => {
    const floor = minViablePrice(VECTOR_A.guardrail);
    expect(floor).toBe(1112);

    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposals).toHaveLength(3);
    for (const proposal of result.proposals) {
      expect(proposal.dealPriceCents).toBeGreaterThanOrEqual(floor!);
      expect(proposal.dealPriceCents).toBeLessThan(VECTOR_A.dish.menuPriceCents);
      expect(proposal.minViablePriceCents).toBe(floor);
      expect(proposal.discountPct).toBeGreaterThan(0);
      expect(proposal.discountPct).toBeCloseTo(
        (VECTOR_A.dish.menuPriceCents - proposal.dealPriceCents) / VECTOR_A.dish.menuPriceCents,
        10,
      );
    }
  });

  it('charges more for the quiet hour than for the other two', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byArchetype = Object.fromEntries(
      result.proposals.map((proposal) => [proposal.archetype, proposal.dealPriceCents]),
    );

    // The whole point of the archetypes: the plan that asks the least of the
    // merchant gives the smallest discount.
    expect(byArchetype.QUIET_HOUR).toBeGreaterThan(byArchetype.TRIAL!);
    expect(byArchetype.TRIAL).toBe(byArchetype.SURPLUS);
  });

  it('never asks for more units than one batch, and never more than the merchant offered', () => {
    const result = planProposals(planArgs({ maxQtyAsked: 40 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const proposal of result.proposals) {
      expect(proposal.maxQty).toBe(VECTOR_A.dish.batchYield);
      expect(proposal.minQty).toBeGreaterThanOrEqual(1);
      expect(proposal.minQty).toBeLessThanOrEqual(proposal.maxQty);
    }
  });

  it('says out loud that it capped the quantity', () => {
    const result = planProposals(planArgs({ maxQtyAsked: 40 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.join(' ')).toContain('makes 30 in one batch');
  });
});

describe('planProposals — the window invariants', () => {
  it('closes joining before pickup starts and inside the five-day authorisation window', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fiveDays = NOW.getTime() + 5 * 24 * 60 * 60 * 1000;

    for (const proposal of result.proposals) {
      const start = new Date(proposal.windowStart).getTime();
      const end = new Date(proposal.windowEnd).getTime();
      const cutoff = new Date(proposal.cutoffAt).getTime();

      expect(end).toBeGreaterThan(start);
      expect(cutoff).toBeLessThan(start);
      expect(cutoff).toBeLessThanOrEqual(fiveDays);
    }
  });

  it('never sets a join deadline in the middle of the night', () => {
    // 12 hours of notice before a 2pm pickup is 2am. Correct arithmetic, useless
    // deadline: the page would say "Joining closes Tuesday 2am".
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const proposal of result.proposals) {
      const localHour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Edmonton',
          hour: 'numeric',
          hour12: false,
        }).format(new Date(proposal.cutoffAt)),
      );
      expect(localHour).toBeGreaterThanOrEqual(9);
      expect(localHour).toBeLessThan(21);
    }
  });

  it('keeps an early deadline when snapping it would leave no lead time', () => {
    // A 10am pickup with 3 hours of notice closes at 7am. Snapping that to 9am
    // would leave one hour, so the snap is refused and 7am stands.
    const result = planProposals(
      planArgs({ quietStart: new Date('2026-11-03T17:00:00.000Z') }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const quiet = result.proposals.find((proposal) => proposal.archetype === 'QUIET_HOUR');
    const cutoff = new Date(quiet!.cutoffAt);
    const start = new Date(quiet!.windowStart);
    expect(start.getTime() - cutoff.getTime()).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('refuses a quiet day past the authorisation window', () => {
    const result = planProposals(
      planArgs({ quietStart: new Date('2026-11-09T21:00:00.000Z') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('WINDOW_TOO_FAR');
    expect(result.message).toContain('five');
  });
});

describe('planProposals — refusals', () => {
  it('refuses a dish where no price clears the floor', () => {
    // PRD-v1 §7.4 vector D.
    const result = planProposals(
      planArgs({
        dish: { id: 'dish-d', name: 'Loss Leader', menuPriceCents: 900, batchYield: 20 },
        guardrail: guardrail({
          menuPriceCents: 900,
          foodCostCents: 850,
          packagingCents: 30,
          floorPctOfMenu: 0.25,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('NO_VIABLE_PRICE');
  });

  it('refuses a dish whose floor price is its menu price', () => {
    // Constructed so the ascending scan lands exactly on the menu price:
    // contribution(2500) = 2197.5 = floor, contribution(2499) < floor.
    const result = planProposals(
      planArgs({
        dish: { id: 'dish-e', name: 'Thin Margin', menuPriceCents: 2500, batchYield: 20 },
        guardrail: guardrail({
          menuPriceCents: 2500,
          foodCostCents: 0,
          packagingCents: 0,
          floorPctOfMenu: 0.879,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe('NO_DISCOUNT_POSSIBLE');
  });
});

describe('planProposals — copy', () => {
  it('writes copy that its own linter accepts', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const proposal of result.proposals) {
      const violations = lintCopy(
        {
          title: proposal.title,
          description: proposal.description,
          shareMessage: proposal.shareMessage,
          rationale: proposal.rationale,
        },
        {
          dealPriceCents: proposal.dealPriceCents,
          menuPriceCents: proposal.menuPriceCents,
        },
      );
      expect(violations, `${proposal.archetype}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it('quotes the deal price, and only the deal price, in the group message', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const proposal of result.proposals) {
      const price = `$${(proposal.dealPriceCents / 100).toFixed(2)}`;
      expect(proposal.shareMessage).toContain(price);
      expect(proposal.shareMessage.length).toBeLessThanOrEqual(140);
      expect(proposal.title.length).toBeLessThanOrEqual(60);
    }
  });

  it('names the restaurant and the minimum in the group message', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const surplus = result.proposals.find((proposal) => proposal.archetype === 'SURPLUS');
    expect(surplus).toBeDefined();
    expect(surplus!.shareMessage).toContain('Golden Dragon');
    expect(surplus!.shareMessage).toContain(`Need ${surplus!.minQty} by`);
  });
});

describe('planProposals — ordering and small batches', () => {
  it('leads with the archetype matching the answer', () => {
    const forQuiet = planProposals(planArgs({ intent: 'FILL_QUIET_HOUR' }));
    const forNew = planProposals(planArgs({ intent: 'NEW_CUSTOMERS' }));

    expect(forQuiet.ok && forQuiet.proposals[0]?.archetype).toBe('QUIET_HOUR');
    expect(forNew.ok && forNew.proposals[0]?.archetype).toBe('TRIAL');
  });

  it('scales the minimum down when the batch cannot support the usual floor', () => {
    // A 12-plate batch cannot be asked for 20 trial orders, and must not be
    // silently held to it either.
    const result = planProposals(
      planArgs({
        dish: { id: 'dish-f', name: 'Small Batch', menuPriceCents: 1200, batchYield: 12 },
        guardrail: guardrail({
          menuPriceCents: 1200,
          foodCostCents: 300,
          packagingCents: 50,
          floorPctOfMenu: 0.25,
        }),
        maxQtyAsked: 12,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const proposal of result.proposals) {
      expect(proposal.maxQty).toBe(12);
      expect(proposal.minQty).toBeLessThanOrEqual(12);
    }

    const trial = result.proposals.find((proposal) => proposal.archetype === 'TRIAL');
    expect(trial?.minQty).toBe(8); // ceil(12 × 0.6)
  });
});

describe('proposalFacts', () => {
  it('formats the price once, so nothing downstream formats it again', () => {
    const result = planProposals(planArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const facts = proposalFacts(result.proposals[0]!);
    expect(facts.priceLabel).toBe(`$${(result.proposals[0]!.dealPriceCents / 100).toFixed(2)}`);
    expect(facts.menuPriceLabel).toBe('$16.00');
    expect(facts.discountLabel).toMatch(/^\d+%$/);

    // The window is two hours wide, and that is true of every tzdata revision:
    // 3 November 2026 is 3pm–5pm under `tzdata 2026c` and 2pm–4pm under
    // `2025c`, but the *span* is offset-invariant. Asserting the span rather
    // than the hour keeps this test about formatting instead of about which
    // tzdata the Node binary happens to ship. The exact hour is asserted below,
    // on an instant no tzdata release can disagree about.
    expect(facts.slotLabel).toMatch(/^Tuesday \d{1,2}(am|pm)–\d{1,2}(am|pm)$/);
    expect(windowHours(facts.slotLabel)).toBe(2);
  });

  it("renders the window in the merchant's zone, not the server's", () => {
    // A July instant on purpose. Edmonton has been UTC−6 every July for decades,
    // and from 2026-11-01 it is UTC−6 year-round (Alberta adopted permanent DST;
    // see the note on `DEFAULT_PLAN_TIME_ZONE`). So this literal survives any
    // tzdata release, old or new — unlike a November instant, which is exactly
    // what made the previous version of this test fail on tzdata 2026c.
    const proposal = {
      dealPriceCents: 1310,
      menuPriceCents: 1600,
      discountPct: 0.18125,
      windowStart: '2027-07-06T20:00:00.000Z', // 2pm MDT
      windowEnd: '2027-07-06T22:00:00.000Z', //  4pm MDT
      cutoffAt: '2027-07-06T15:00:00.000Z', //    9am MDT
    };

    expect(proposalFacts(proposal).slotLabel).toBe('Tuesday 2pm–4pm');

    // The same instant in another zone. This is the half that proves the zone is
    // actually applied: if `plan.ts` silently fell back to UTC (a container's
    // local time), the assertion above would read 'Tuesday 8pm–10pm' and this one
    // would pass by accident. Asserting both directions makes that swap visible.
    expect(proposalFacts(proposal, 'UTC').slotLabel).toBe('Tuesday 8pm–10pm');
    expect(proposalFacts(proposal).closesLabel).toBe('Tuesday 9am');
  });
});
