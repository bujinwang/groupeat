import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEES,
  GuardrailError,
  GuardrailErrorCode,
  SNAPSHOT_VERSION,
  buildDealView,
  buildGuardrailSnapshot,
  formatCents,
  readGuardrailSnapshot,
  snapshotBreakdown,
} from '@/lib/guardrail';
import type { CompleteGuardrailInput, GuardrailSnapshot } from '@/lib/guardrail';

import { VECTOR_A, VECTOR_B, VECTOR_C, VECTOR_D } from './fixtures';

/**
 * FR-207 / PRD-sprint1 §7.7 — the frozen snapshot contract.
 *
 * The tests here are shaped around the failure the contract exists to prevent:
 * a published drop's money changing after the fact. So the immutability tests
 * mutate the *input* and assert the *output* does not move, rather than testing
 * that a pure function is pure.
 */

const COMPUTED_AT = '2026-10-28T18:22:04.311-06:00';

function snapshotOf(input: CompleteGuardrailInput, price: number): GuardrailSnapshot {
  return buildGuardrailSnapshot(input, price, COMPUTED_AT);
}

describe('buildGuardrailSnapshot · §7.7 worked example', () => {
  it('matches the documented shape for vector A exactly', () => {
    const snapshot = snapshotOf(VECTOR_A, 1112);

    // The whole object, because the point of the contract is the exact key set.
    // A new key here is a version bump, and this assertion is what forces that
    // conversation instead of letting it happen quietly.
    expect(snapshot).toEqual({
      version: 1,
      computedAt: COMPUTED_AT,
      input: {
        menuPriceCents: 1600,
        foodCostCents: 480,
        packagingCents: 80,
        floorPctOfMenu: 0.25,
        platformFeePct: 0.08,
        platformFeeFloorCents: 60,
        platformFeeCapCents: 200,
        stripePct: 0.029,
        stripeFixedCents: 30,
      },
      result: {
        dealPriceCents: 1112,
        // 400.792 — unrounded. §7.7 writes this as `400.79`, which is the same
        // number displayed to two places, not a different stored value.
        netContributionCents: 400.79200000000003,
        contributionPctOfMenu: 0.250495,
        walkInContributionCents: 963.6,
        breakEvenIncrementality: 0.7062486440846912,
        platformFeeCents: 88.96000000000001,
        isBelowFloor: false,
        minViablePriceCents: 1112,
      },
    });
  });

  it('stores the exact key set — no more, no less', () => {
    const snapshot = snapshotOf(VECTOR_A, 1112);

    expect(Object.keys(snapshot).sort()).toEqual(['computedAt', 'input', 'result', 'version']);
    expect(Object.keys(snapshot.input).sort()).toEqual([
      'floorPctOfMenu',
      'foodCostCents',
      'menuPriceCents',
      'packagingCents',
      'platformFeeCapCents',
      'platformFeeFloorCents',
      'platformFeePct',
      'stripeFixedCents',
      'stripePct',
    ]);
    expect(Object.keys(snapshot.result).sort()).toEqual([
      'breakEvenIncrementality',
      'contributionPctOfMenu',
      'dealPriceCents',
      'isBelowFloor',
      'minViablePriceCents',
      'netContributionCents',
      'platformFeeCents',
      'walkInContributionCents',
    ]);
  });

  it('stores every fee constant, so the number is re-derivable later', () => {
    const snapshot = snapshotOf(VECTOR_A, 1112);

    // Without these, a merchant complaint in six months is unanswerable when
    // Stripe has changed its rate.
    expect(snapshot.input).toMatchObject(DEFAULT_FEES);
  });
});

describe('buildGuardrailSnapshot · rounding boundary', () => {
  /**
   * The trap this test exists for: §7.7's prose says derived money is stored
   * unrounded, while its own example shows `400.79` and `88.96`. A reader who
   * trusts the prose and stores exact values, then compares against a snapshot
   * built from the doc's example, sees a mismatch and "fixes" it by rounding —
   * after which the snapshot no longer reproduces `netContributionCents` from
   * `input`, and the reconciliation job alerts forever.
   */
  it('keeps derived money unrounded while the panel rounds it', () => {
    const snapshot = snapshotOf(VECTOR_A, 1112);
    const view = buildDealView(VECTOR_A, 1112);

    // Exact, for storage.
    expect(snapshot.result.netContributionCents).not.toBe(400.79);
    expect(snapshot.result.netContributionCents).toBeCloseTo(400.792, 10);
    expect(snapshot.result.platformFeeCents).toBeCloseTo(88.96, 10);

    // Rounded, for display.
    expect(view.breakdown.platformFeeCents).toBe(89);
    expect(view.breakdown.netContributionCents).toBe(401);

    // And they are the same money — the difference is presentation only.
    expect(Math.abs(view.breakdown.netContributionCents - snapshot.result.netContributionCents)).toBeLessThan(0.5);
    expect(view.breakdown.netContributionCents).toBe(Math.floor(snapshot.result.netContributionCents + 0.5));
  });

  it('reconciles the panel breakdown to the deal price, which the snapshot never claims to', () => {
    const view = buildDealView(VECTOR_A, 1112);
    const { breakdown, dealPriceCents } = view;

    // The snapshot stores four independent figures; only the *view* guarantees
    // they sum. This is why a report must read the view for a breakdown and the
    // snapshot for a historical record, never swap them.
    expect(
      breakdown.netContributionCents +
        breakdown.platformFeeCents +
        breakdown.cardFeeCents +
        breakdown.ingredientsAndPackagingCents,
    ).toBe(dealPriceCents);
  });
});

describe('buildGuardrailSnapshot · immutability (FR-207)', () => {
  it('does not change when the item is edited after freezing', () => {
    const item = { ...VECTOR_A };
    const frozen = snapshotOf(item, 1112);

    // Next month: ingredients go up, the menu price rises, the merchant raises
    // their floor. None of it may touch what the published drop earned.
    item.foodCostCents = 900;
    item.menuPriceCents = 2000;
    item.floorPctOfMenu = 0.4;

    expect(frozen.result).toEqual(snapshotOf({ ...VECTOR_A }, 1112).result);
    expect(frozen.input.foodCostCents).toBe(480);
    expect(frozen.result.netContributionCents).toBeCloseTo(400.792, 10);
  });

  it('is not affected by a later change to the live fee constants', () => {
    const frozen = snapshotOf(VECTOR_A, 1112);

    // A pricing experiment, or a Stripe rate change, must not rewrite history.
    const experiment: CompleteGuardrailInput = {
      ...VECTOR_A,
      platformFeePct: 0.12,
      stripePct: 0.035,
    };
    const recalculated = snapshotOf(experiment, 1112);

    expect(frozen.input.platformFeePct).toBe(0.08);
    expect(frozen.input.stripePct).toBe(0.029);
    expect(recalculated.result.netContributionCents).not.toBeCloseTo(
      frozen.result.netContributionCents,
      2,
    );
  });

  it('returns a fresh object each call, so a mutation cannot leak into the next snapshot', () => {
    const first = snapshotOf(VECTOR_A, 1112);
    first.result.netContributionCents = -999;

    const second = snapshotOf(VECTOR_A, 1112);
    expect(second.result.netContributionCents).toBeCloseTo(400.792, 10);
  });
});

describe('buildGuardrailSnapshot · all four vectors', () => {
  const cases = [
    { name: 'A', input: VECTOR_A, price: 1112 },
    { name: 'B', input: VECTOR_B, price: 488 },
    { name: 'C', input: VECTOR_C, price: 1168 },
    { name: 'D', input: VECTOR_D, price: 900 },
  ] as const;

  it.each(cases)('vector $name round-trips through readGuardrailSnapshot unchanged', ({ input, price }) => {
    const frozen = snapshotOf(input, price);

    // Simulate the database: JSON in, JSON out. Prisma's `Json` column does this
    // for real, and it is where a `Date` or a `Map` would silently become a
    // string or `{}` if the snapshot ever held one.
    const roundTripped = readGuardrailSnapshot(JSON.parse(JSON.stringify(frozen)));

    expect(roundTripped).toEqual(frozen);
  });

  it('records vector D as below the floor rather than throwing', () => {
    const frozen = snapshotOf(VECTOR_D, 900);

    // D is the absurd-ingredient-cost vector. It is a legitimate record of a
    // merchant's numbers, not an error — the publish route decides policy.
    expect(frozen.result.isBelowFloor).toBe(true);
    expect(frozen.result.minViablePriceCents).toBeNull();
    expect(Number.isFinite(frozen.result.netContributionCents)).toBe(true);
  });

  it('never stores NaN or Infinity for any vector', () => {
    for (const { input, price } of cases) {
      const { result } = snapshotOf(input, price);
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${key} is not finite`).toBe(true);
        }
      }
    }
  });
});

describe('buildGuardrailSnapshot · refusals', () => {
  it('throws INCOMPLETE_COST_DATA rather than storing a null ingredient cost', () => {
    const broken = { ...VECTOR_A, foodCostCents: null } as unknown as CompleteGuardrailInput;

    expect(() => snapshotOf(broken, 1112)).toThrow(GuardrailError);

    try {
      snapshotOf(broken, 1112);
    } catch (error) {
      expect((error as GuardrailError).code).toBe(GuardrailErrorCode.INCOMPLETE_COST_DATA);
    }
  });

  it('uses the caller-computed timestamp, never a clock of its own', () => {
    const first = buildGuardrailSnapshot(VECTOR_A, 1112, '2026-01-01T00:00:00-07:00');
    const second = buildGuardrailSnapshot(VECTOR_A, 1112, '2027-12-31T23:59:59-07:00');

    expect(first.computedAt).toBe('2026-01-01T00:00:00-07:00');
    expect(second.computedAt).toBe('2027-12-31T23:59:59-07:00');
    expect(first.result).toEqual(second.result);
  });
});

describe('readGuardrailSnapshot · rejects what it cannot understand', () => {
  const valid = snapshotOf(VECTOR_A, 1112);

  const cases: readonly { name: string; bad: unknown; fragment: string }[] = [
    { name: 'null', bad: null, fragment: 'not an object' },
    { name: 'an array', bad: [], fragment: 'not an object' },
    { name: 'a string', bad: '{"version":1}', fragment: 'not an object' },
    { name: 'an empty object', bad: {}, fragment: 'version undefined' },
    { name: 'version 2 from a future build', bad: { ...valid, version: 2 }, fragment: 'version 2' },
  ];

  it.each(cases)('rejects $name', ({ bad, fragment }) => {
    expect(() => readGuardrailSnapshot(bad)).toThrow(GuardrailError);

    try {
      readGuardrailSnapshot(bad);
    } catch (error) {
      expect((error as GuardrailError).code).toBe(GuardrailErrorCode.SNAPSHOT_UNREADABLE);
      // The message must name what was wrong: an unreadable row on one drop is
      // diagnosable, and "invalid snapshot" is not.
      expect((error as GuardrailError).message.toLowerCase()).toContain(fragment.toLowerCase());
    }
  });

  it('rejects a snapshot with a missing input field', () => {
    const { stripePct: _removed, ...inputWithoutStripe } = valid.input;
    const bad = { ...valid, input: inputWithoutStripe };

    expect(() => readGuardrailSnapshot(bad)).toThrow(/stripePct/);
  });

  it('rejects a NaN smuggled past JSON', () => {
    const bad = {
      ...valid,
      result: { ...valid.result, netContributionCents: Number.NaN },
    };

    // JSON has no NaN literal, but a hand-edited row or a bad decimal cast can
    // still produce one, and NaN propagates into every total silently.
    expect(() => readGuardrailSnapshot(bad)).toThrow(/netContributionCents/);
  });

  it('accepts a null minViablePriceCents, because null is a real answer', () => {
    const infeasible = snapshotOf(VECTOR_D, 900);
    expect(infeasible.result.minViablePriceCents).toBeNull();

    const read = readGuardrailSnapshot(JSON.parse(JSON.stringify(infeasible)));
    expect(read.result.minViablePriceCents).toBeNull();
  });

  it('rejects a string where a price belongs, rather than coercing it', () => {
    const bad = { ...valid, result: { ...valid.result, dealPriceCents: '1112' } };

    // Coercion here is the quiet failure: '1112' would arithmetic as 1112 in
    // most places and as '1112' in a template literal, so it would show up as a
    // formatting bug rather than as the data-integrity bug it is.
    expect(() => readGuardrailSnapshot(bad)).toThrow(/dealPriceCents/);
  });
});

describe('SNAPSHOT_VERSION', () => {
  it('is 1 and is what buildGuardrailSnapshot stamps', () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(snapshotOf(VECTOR_A, 1112).version).toBe(SNAPSHOT_VERSION);
  });

  it('survives a JSON round trip as a number, not a string', () => {
    const stored = JSON.parse(JSON.stringify(snapshotOf(VECTOR_A, 1112)));
    expect(stored.version).toBe(1);
    expect(typeof stored.version).toBe('number');
  });
});

describe('the snapshot and the panel agree about the money', () => {
  /**
   * The honest version of "agreement". There are two figures — the exact one in
   * the snapshot and the rounded-remainder one on the panel — and they are
   * allowed to differ when the card and platform fees do not land on whole
   * cents.
   *
   * The bound is **strictly less than one cent**, not half a cent, because two
   * roundings are involved and each contributes up to half: the card fee
   * (`0.029·P + 30`) and the platform fee (`0.08·P`, clamped). Their rounding
   * errors are independent, so their sum can approach a full cent.
   *
   * The assertion is a bound rather than equality because equality is false; it
   * is a tight bound rather than a loose one so a real regression cannot hide
   * inside the tolerance.
   */
  it('never diverges by a cent or more across the whole face-value price range', () => {
    const worst: { price: number; snapshot: number; view: number; delta: number }[] = [];
    let maxDelta = 0;

    for (let price = 500; price <= 5000; price += 1) {
      const view = buildDealView(VECTOR_A, price);
      const snapshot = snapshotOf(VECTOR_A, price);
      const delta = Math.abs(view.breakdown.netContributionCents - snapshot.result.netContributionCents);

      maxDelta = Math.max(maxDelta, delta);
      if (delta >= 1) {
        worst.push({
          price,
          snapshot: snapshot.result.netContributionCents,
          view: view.breakdown.netContributionCents,
          delta,
        });
      }
    }

    expect(worst).toEqual([]);
    // Sanity: the two roundings really do interact, or this test proves nothing.
    expect(maxDelta).toBeGreaterThan(0.5);
  });

  it('never makes the rendered strings differ by more than one cent', () => {
    for (let price = 500; price <= 5000; price += 1) {
      const view = buildDealView(VECTOR_A, price);
      const snapshot = snapshotOf(VECTOR_A, price);

      // Display is the only thing a merchant or accountant sees, so this is the
      // bound that actually matters.
      const viewRounded = Math.round(view.breakdown.netContributionCents);
      const snapshotRounded = Math.round(snapshot.result.netContributionCents);
      expect(Math.abs(viewRounded - snapshotRounded)).toBeLessThanOrEqual(1);
    }
  });

  it('is exactly equal whenever the card fee is a whole number of cents', () => {
    // P = 1400 → card fee 70.6, neither component rounds up past the exact sum.
    const price = 1400;
    const view = buildDealView(VECTOR_A, price);
    const snapshot = snapshotOf(VECTOR_A, price);

    expect(view.breakdown.netContributionCents).toBe(
      Math.round(snapshot.result.netContributionCents),
    );
  });

  it('diverges by exactly one cent at a half-cent card fee — the known, bounded case', () => {
    // P = 1500 → card fee 73.5. Rounding to 74 moves the panel's remainder to
    // 746 while the exact figure is 746.5. 746.5 formats to "$7.47" (half-up),
    // 746 to "$7.46".
    const price = 1500;
    const view = buildDealView(VECTOR_A, price);
    const snapshot = snapshotOf(VECTOR_A, price);

    expect(snapshot.result.netContributionCents).toBeCloseTo(746.5, 10);
    expect(view.breakdown.netContributionCents).toBe(746);
    expect(formatCents(snapshot.result.netContributionCents)).toBe('$7.47');
    expect(formatCents(view.breakdown.netContributionCents)).toBe('$7.46');
  });

  it('reproduces the panel exactly when a report uses snapshotBreakdown', () => {
    // This is the guard against a report disagreeing with what the merchant saw.
    // Checked across the range, not at one price, because the mismatch is only
    // visible at some of them.
    for (let price = 500; price <= 5000; price += 1) {
      const view = buildDealView(VECTOR_A, price);
      const snapshot = snapshotOf(VECTOR_A, price);

      expect(snapshotBreakdown(snapshot)).toEqual(view.breakdown);
    }
  });

  it('keeps the stored input consistent with a re-derivation, so a report can trust it', () => {
    const snapshot = snapshotOf(VECTOR_A, 1112);

    // A report must be able to recompute from `input` alone. If this ever drifts,
    // the snapshot is self-contradictory and no figure in it is trustworthy.
    const recomputed = buildGuardrailSnapshot(
      {
        ...snapshot.input,
        // `SnapshotInput` and `CompleteGuardrailInput` are structurally identical
        // here — same nine fields — so no cast is needed and a future divergence
        // becomes a compile error rather than a silent numeric mismatch.
      },
      snapshot.result.dealPriceCents,
      snapshot.computedAt,
    );

    expect(recomputed).toEqual(snapshot);
  });
});
