import { DEFAULT_FEES } from '@/lib/guardrail';
import type { CompleteGuardrailInput, GuardrailInput } from '@/lib/guardrail';

/**
 * Shared test fixtures. Not a test file (no `.test.ts` suffix) so Vitest never
 * runs it directly.
 *
 * The four priced vectors are PRD-v1 §7.4 verbatim. Vector E (missing food cost)
 * cannot be a database row — `MenuItem.foodCostCents` is non-nullable — so it
 * exists only as a fixture (ARCHITECTURE-sprint1 A-2).
 */

export const VECTOR_A: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 1600,
  foodCostCents: 480,
  packagingCents: 80,
  floorPctOfMenu: 0.25,
};

export const VECTOR_B: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 650,
  foodCostCents: 110,
  packagingCents: 35,
  floorPctOfMenu: 0.25,
};

export const VECTOR_C: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 1200,
  foodCostCents: 660,
  packagingCents: 50,
  floorPctOfMenu: 0.25,
};

export const VECTOR_D: CompleteGuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 900,
  foodCostCents: 850,
  packagingCents: 30,
  floorPctOfMenu: 0.25,
};

/** PRD-v1 §7.4 vector E: `foodCostCents` is missing. */
export const VECTOR_E_MISSING: GuardrailInput = {
  ...DEFAULT_FEES,
  menuPriceCents: 1600,
  foodCostCents: null,
  packagingCents: 80,
  floorPctOfMenu: 0.25,
};

export const PRICED_VECTORS: readonly { name: string; input: CompleteGuardrailInput }[] = [
  { name: 'A', input: VECTOR_A },
  { name: 'B', input: VECTOR_B },
  { name: 'C', input: VECTOR_C },
  { name: 'D', input: VECTOR_D },
];

/**
 * Deterministic PRNG (mulberry32) so a property-test failure is reproducible
 * from the seed alone (ARCHITECTURE-sprint1 §7.7).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXED_SEED = 0x9e3779b9;
export const FUZZ_CASE_COUNT = 1000;

/**
 * A random input that satisfies the cost invariant
 * (`foodCost + packaging < menuPrice`) and the field bounds, so it is a row the
 * application could actually persist.
 */
export function randomValidInput(rng: () => number): GuardrailInput {
  const menuPriceCents = 100 + Math.floor(rng() * 49901); // 100 … 50000
  const foodCostCents = Math.floor(rng() * (menuPriceCents - 1)); // 0 … menu-2
  const maxPackaging = menuPriceCents - 1 - foodCostCents;
  const packagingCents = Math.floor(rng() * (maxPackaging + 1)); // 0 … menu-1-food
  const floorPctOfMenu = 0.05 + rng() * 0.85; // 0.05 … 0.90

  return {
    ...DEFAULT_FEES,
    menuPriceCents,
    foodCostCents,
    packagingCents,
    floorPctOfMenu,
  };
}

/** 1,000 reproducible valid inputs. */
export function randomValidInputs(count = FUZZ_CASE_COUNT, seed = FIXED_SEED): GuardrailInput[] {
  const rng = mulberry32(seed);
  const inputs: GuardrailInput[] = [];
  for (let i = 0; i < count; i += 1) {
    inputs.push(randomValidInput(rng));
  }
  return inputs;
}
