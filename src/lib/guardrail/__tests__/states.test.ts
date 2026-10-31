import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEES,
  PanelState,
  THIN_DISCOUNT_THRESHOLD,
  buildDealView,
  minViablePrice,
  resolvePanelState,
} from '@/lib/guardrail';

import { VECTOR_A, VECTOR_C, VECTOR_D } from './fixtures';

/**
 * PRD-sprint1 §5.4 — the seven states and their precedence.
 *
 * `INVALID_COST_DATA → INCOMPLETE_COST_DATA → INFEASIBLE → BELOW_FLOOR → THIN
 * → FLOOR → OK`.
 */
describe('resolvePanelState · precedence, first match wins', () => {
  const base = {
    validationFailed: false,
    costDataIncomplete: false,
    minViablePriceCents: 1112 as number | null,
    isBelowFloor: false,
    discountPctExact: 0.305,
    dealPriceCents: 1112,
    thinThreshold: THIN_DISCOUNT_THRESHOLD,
  };

  it('1 · validation failure wins over everything', () => {
    expect(
      resolvePanelState({
        ...base,
        validationFailed: true,
        costDataIncomplete: true,
        minViablePriceCents: null,
        isBelowFloor: true,
        discountPctExact: 0.01,
      }),
    ).toBe(PanelState.INVALID_COST_DATA);
  });

  it('2 · incomplete cost data beats infeasibility', () => {
    expect(
      resolvePanelState({
        ...base,
        costDataIncomplete: true,
        minViablePriceCents: null,
        isBelowFloor: true,
      }),
    ).toBe(PanelState.INCOMPLETE_COST_DATA);
  });

  it('3 · a null minViablePrice is INFEASIBLE even when the price is also below the floor', () => {
    expect(
      resolvePanelState({ ...base, minViablePriceCents: null, isBelowFloor: true }),
    ).toBe(PanelState.INFEASIBLE);
  });

  it('4 · below the floor beats a thin discount', () => {
    expect(
      resolvePanelState({ ...base, isBelowFloor: true, discountPctExact: 0.02 }),
    ).toBe(PanelState.BELOW_FLOOR);
  });

  it('5 · a thin discount beats landing exactly on the floor', () => {
    expect(
      resolvePanelState({ ...base, discountPctExact: 0.0267, dealPriceCents: 1112 }),
    ).toBe(PanelState.THIN);
  });

  it('6 · landing exactly on the floor is FLOOR', () => {
    expect(resolvePanelState({ ...base, dealPriceCents: 1112 })).toBe(PanelState.FLOOR);
  });

  it('7 · otherwise OK', () => {
    expect(resolvePanelState({ ...base, dealPriceCents: 1150 })).toBe(PanelState.OK);
  });
});

describe('buildDealView · the states the four vectors must produce', () => {
  it('case C (at the floor and 2.7% off) is THIN, not FLOOR', () => {
    const view = buildDealView(VECTOR_C, 1168);

    expect(view.dealPriceCents).toBe(view.minViablePriceCents);
    expect(view.discountPct).toBe(3);
    expect(view.state).toBe(PanelState.THIN);
  });

  it('vector A at its lowest viable price is FLOOR', () => {
    expect(buildDealView(VECTOR_A, 1112).state).toBe(PanelState.FLOOR);
  });

  it('vector A above its lowest viable price is OK', () => {
    expect(buildDealView(VECTOR_A, 1150).state).toBe(PanelState.OK);
  });

  it('vector A below its lowest viable price is BELOW_FLOOR', () => {
    expect(buildDealView(VECTOR_A, 1000).state).toBe(PanelState.BELOW_FLOOR);
  });

  it('vector D is INFEASIBLE', () => {
    expect(buildDealView(VECTOR_D, VECTOR_D.menuPriceCents).state).toBe(PanelState.INFEASIBLE);
  });

  it('an item whose ingredients exceed its menu price is INVALID_COST_DATA', () => {
    const view = buildDealView(
      { ...DEFAULT_FEES, menuPriceCents: 900, foodCostCents: 850, packagingCents: 60, floorPctOfMenu: 0.25 },
      900,
    );
    expect(view.state).toBe(PanelState.INVALID_COST_DATA);
  });
});

describe('boundaries', () => {
  it('dealPrice === menuPrice is viable but THIN (a 0% discount moves nobody)', () => {
    const view = buildDealView(VECTOR_A, VECTOR_A.menuPriceCents);

    expect(view.savingCents).toBe(0);
    expect(view.discountPct).toBe(0);
    expect(view.isBelowFloor).toBe(false);
    expect(view.state).toBe(PanelState.THIN);
  });

  it('floorPct = 0 puts the floor at zero and the search at the window start', () => {
    const input = { ...VECTOR_A, floorPctOfMenu: 0 };
    const minViable = minViablePrice(input);

    expect(minViable).toBe(Math.ceil(input.menuPriceCents * 0.5));
    expect(buildDealView(input, minViable as number).state).toBe(PanelState.FLOOR);
  });

  it('floorPct = 1 is never achievable, so the item is INFEASIBLE', () => {
    const input = { ...VECTOR_A, floorPctOfMenu: 1 };

    expect(minViablePrice(input)).toBeNull();
    expect(buildDealView(input, input.menuPriceCents).state).toBe(PanelState.INFEASIBLE);
    expect(buildDealView(input, input.menuPriceCents).floorPctOfMenu).toBe(100);
  });

  it('a 100-cent menu price is handled without crashing and cannot clear the fee floor', () => {
    const input = {
      ...DEFAULT_FEES,
      menuPriceCents: 100,
      foodCostCents: 30,
      packagingCents: 5,
      floorPctOfMenu: 0.25,
    };

    expect(minViablePrice(input)).toBeNull();

    const view = buildDealView(input, input.menuPriceCents);
    expect(view.state).toBe(PanelState.INFEASIBLE);
    expect(view.floorCents).toBe(25);
    const sum =
      view.breakdown.netContributionCents +
      view.breakdown.platformFeeCents +
      view.breakdown.cardFeeCents +
      view.breakdown.ingredientsAndPackagingCents;
    expect(sum).toBe(100);
  });

  it('a small but viable menu price is priced correctly', () => {
    const input = {
      ...DEFAULT_FEES,
      menuPriceCents: 1000,
      foodCostCents: 100,
      packagingCents: 0,
      floorPctOfMenu: 0.25,
    };

    // 500 − 100 − 0 − 44.5 (card) − 60 (fee floor) = 295.5 ≥ 250.
    expect(minViablePrice(input)).toBe(500);
  });
});
