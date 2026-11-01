import { GuardrailError, GuardrailErrorCode } from './errors';
import { evaluateDeal } from './evaluateDeal';
import { cardFeeAt, platformFeeAt } from './fees';
import { roundHalfUp } from './money';
import type {
  Breakdown,
  CompleteGuardrailInput,
  GuardrailSnapshot,
  SnapshotInput,
  SnapshotResult,
} from './types';

/**
 * The frozen `guardrailSnapshot` — PRD-sprint1 §7.7.
 *
 * ## Why this module is small and strict
 *
 * The snapshot is written **once**, at publish, and never recomputed. So there
 * are no update functions here, no merge helper, and no "recompute for display"
 * path — the absence of those functions is the design. A helper that
 * recalculates a stored snapshot would be the one way to break FR-207, so it
 * does not exist.
 *
 * ## The two reads
 *
 *   1. `buildGuardrailSnapshot()` — at publish. Produces the object to store.
 *   2. `readGuardrailSnapshot()` — everywhere after. Validates a stored JSON
 *      blob and returns it, or throws `SNAPSHOT_UNREADABLE`.
 *
 * Nothing in the app should read `Drop.guardrailSnapshot` as `any` or cast it to
 * the type: a row written by an older build has a `version` this build may not
 * understand, and casting turns that into silently wrong money on a report.
 *
 * ## What is deliberately not stored
 *
 * `DealView` figures (rounded cents, whole percentages, guidance bucket, panel
 * state) are **not** in the snapshot. They are display derived from the
 * unrounded result by `buildDealView`, and storing them would create two
 * sources of truth that agree only until someone changes a rounding rule.
 * Money that is a percentage is stored exact; rounding happens at render.
 */

/** The only `version` this build can produce or read. */
export const SNAPSHOT_VERSION = 1 as const;

/**
 * What "the same money" means for a stored snapshot, in cents.
 *
 * ## The Postgres `jsonb` normalisation (read this before comparing snapshots)
 *
 * `Drop.guardrailSnapshot` is a Prisma `Json` column, which is `jsonb` in
 * PostgreSQL. **`jsonb` stores numbers as `numeric`, not as float8.** So a
 * JavaScript double written to the column is parsed into Postgres's decimal
 * representation and re-serialised when read back:
 *
 * ```
 * written:  400.79200000000003
 * read back: 400.792
 * ```
 *
 * The difference is ~3 × 10⁻¹⁴ cents — physically meaningless — and the stored
 * value is arguably the nicer of the two. But it has one sharp consequence:
 *
 * **A stored snapshot is never `===` the object that produced it.**
 *
 * A reconciliation job that recomputes `netContributionCents` and compares it to
 * the stored value with strict equality will alert on *every* drop, forever,
 * about a difference no accountant would recognise. That is the failure this
 * constant exists to prevent, and `sameSnapshotMoney()` is the comparison to use.
 *
 * Note this is specific to `jsonb`. `JSON.parse(JSON.stringify(x))` in a unit
 * test round-trips doubles exactly, so the in-memory tests would never have
 * caught it — only a real database does.
 */
export const SNAPSHOT_MONEY_TOLERANCE = 1e-6;

/**
 * Builds the object to write to `Drop.guardrailSnapshot`.
 *
 * `computedAt` is a parameter rather than read from the clock, because this
 * module must stay clock-free (AC-8) and because a publish path needs to record
 * the moment *it* decided the drop went live, not the moment this function ran.
 *
 * Throws `INCOMPLETE_COST_DATA` for missing ingredient cost — the same guard
 * every other entry point has, so a drop can never be published with a snapshot
 * built on a hole.
 *
 * @param input  Complete cost data plus the fee constants in force.
 * @param dealPriceCents The price at publish. Must clear the floor; that check
 *   belongs to the publish route (price *policy*), not here (price *recording*).
 * @param computedAt ISO-8601 with offset, from the caller.
 */
export function buildGuardrailSnapshot(
  input: CompleteGuardrailInput,
  dealPriceCents: number,
  computedAt: string,
): GuardrailSnapshot {
  const evaluation = evaluateDeal(input, dealPriceCents);

  const snapshotInput: SnapshotInput = {
    menuPriceCents: input.menuPriceCents,
    foodCostCents: input.foodCostCents,
    packagingCents: input.packagingCents,
    floorPctOfMenu: input.floorPctOfMenu,
    platformFeePct: input.platformFeePct,
    platformFeeFloorCents: input.platformFeeFloorCents,
    platformFeeCapCents: input.platformFeeCapCents,
    stripePct: input.stripePct,
    stripeFixedCents: input.stripeFixedCents,
  };

  const result: SnapshotResult = {
    dealPriceCents,
    netContributionCents: evaluation.netContributionCents,
    contributionPctOfMenu: evaluation.contributionPctOfMenu,
    walkInContributionCents: evaluation.walkInContributionCents,
    breakEvenIncrementality: evaluation.breakEvenIncrementality,
    platformFeeCents: evaluation.platformFeeCents,
    isBelowFloor: evaluation.isBelowFloor,
    minViablePriceCents: evaluation.minViablePriceCents,
  };

  return {
    version: SNAPSHOT_VERSION,
    computedAt,
    input: snapshotInput,
    result,
  };
}

/**
 * Validates a value read from the database and narrows it to
 * `GuardrailSnapshot`.
 *
 * Hand-written rather than zod, because this folder may not import anything
 * (AC-8) and a schema library is a dependency. The cost is ~40 lines; the
 * benefit is that the guardrail stays liftable.
 *
 * Checks shape, not policy: it confirms the keys exist and are numbers, and that
 * `version` is one this build understands. It does **not** re-run the arithmetic
 * to confirm `netContributionCents` is consistent with `input` — that is the
 * nightly reconciliation's job, and doing it here would make every page render
 * pay for a scan.
 */
export function readGuardrailSnapshot(stored: unknown): GuardrailSnapshot {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      'guardrailSnapshot is not an object.',
    );
  }

  const record = stored as Record<string, unknown>;

  if (record.version !== SNAPSHOT_VERSION) {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      // Named, not generic: the fix for a version mismatch is "teach this build
      // the old shape", and that requires knowing which version it was.
      `guardrailSnapshot version ${String(record.version)} is not supported by this build ` +
        `(expected ${SNAPSHOT_VERSION}).`,
    );
  }

  if (typeof record.computedAt !== 'string' || record.computedAt.length === 0) {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      'guardrailSnapshot.computedAt is missing.',
    );
  }

  const input = requireObject(record.input, 'input');
  const result = requireObject(record.result, 'result');

  const snapshotInput: SnapshotInput = {
    menuPriceCents: requireNumber(input, 'menuPriceCents', 'input'),
    foodCostCents: requireNumber(input, 'foodCostCents', 'input'),
    packagingCents: requireNumber(input, 'packagingCents', 'input'),
    floorPctOfMenu: requireNumber(input, 'floorPctOfMenu', 'input'),
    platformFeePct: requireNumber(input, 'platformFeePct', 'input'),
    platformFeeFloorCents: requireNumber(input, 'platformFeeFloorCents', 'input'),
    platformFeeCapCents: requireNumber(input, 'platformFeeCapCents', 'input'),
    stripePct: requireNumber(input, 'stripePct', 'input'),
    stripeFixedCents: requireNumber(input, 'stripeFixedCents', 'input'),
  };

  // `minViablePriceCents` is the one nullable member: `null` is a real answer
  // ("no price clears this floor"), not a missing value. Every other field is a
  // number or boolean and must be present.
  const minViableRaw = result.minViablePriceCents;
  if (minViableRaw !== null && typeof minViableRaw !== 'number') {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      'guardrailSnapshot.result.minViablePriceCents must be a number or null.',
    );
  }

  if (typeof result.isBelowFloor !== 'boolean') {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      'guardrailSnapshot.result.isBelowFloor must be a boolean.',
    );
  }

  const snapshotResult: SnapshotResult = {
    dealPriceCents: requireNumber(result, 'dealPriceCents', 'result'),
    netContributionCents: requireNumber(result, 'netContributionCents', 'result'),
    contributionPctOfMenu: requireNumber(result, 'contributionPctOfMenu', 'result'),
    walkInContributionCents: requireNumber(result, 'walkInContributionCents', 'result'),
    breakEvenIncrementality: requireNumber(result, 'breakEvenIncrementality', 'result'),
    platformFeeCents: requireNumber(result, 'platformFeeCents', 'result'),
    isBelowFloor: result.isBelowFloor,
    minViablePriceCents: minViableRaw,
  };

  return {
    version: SNAPSHOT_VERSION,
    computedAt: record.computedAt,
    input: snapshotInput,
    result: snapshotResult,
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      `guardrailSnapshot.${path} is not an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = source[key];
  // `Number.isFinite` rather than `typeof === 'number'`: JSON has no NaN or
  // Infinity literal, but a hand-edited row or a bad decimal cast can produce
  // one, and `NaN` would propagate into every report silently.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GuardrailError(
      GuardrailErrorCode.SNAPSHOT_UNREADABLE,
      `guardrailSnapshot.${path}.${key} is missing or not a finite number.`,
    );
  }
  return value;
}

/**
 * True when two snapshots represent the same money, within
 * `SNAPSHOT_MONEY_TOLERANCE`.
 *
 * Use this — never `toEqual`, never `===` — whenever one side has been through
 * the database. See `SNAPSHOT_MONEY_TOLERANCE` for why a `jsonb` round trip
 * changes the last bits of a double.
 *
 * Structural fields (`version`) and the input block must match exactly: an input
 * that differs is a different calculation, not a rounding artefact. Only the
 * *derived* result figures get the tolerance.
 */
export function sameSnapshotMoney(
  a: GuardrailSnapshot,
  b: GuardrailSnapshot,
  tolerance: number = SNAPSHOT_MONEY_TOLERANCE,
): boolean {
  if (a.version !== b.version || a.computedAt !== b.computedAt) {
    return false;
  }

  const inputsMatch = (Object.keys(a.input) as (keyof SnapshotInput)[]).every(
    (key) => a.input[key] === b.input[key],
  );
  if (!inputsMatch) {
    return false;
  }

  if (a.result.minViablePriceCents !== b.result.minViablePriceCents) {
    return false;
  }
  if (a.result.isBelowFloor !== b.result.isBelowFloor) {
    return false;
  }
  if (a.result.dealPriceCents !== b.result.dealPriceCents) {
    return false;
  }

  const derived: readonly (keyof SnapshotResult)[] = [
    'netContributionCents',
    'contributionPctOfMenu',
    'walkInContributionCents',
    'breakEvenIncrementality',
    'platformFeeCents',
  ];

  return derived.every((key) => {
    const left = a.result[key];
    const right = b.result[key];
    return typeof left === 'number' && typeof right === 'number'
      ? Math.abs(left - right) <= tolerance
      : left === right;
  });
}

/**
 * The four panel rows for a **stored** snapshot, computed from its own inputs.
 *
 * ## Why this exists
 *
 * There are two slightly different figures in the system and they can differ by
 * almost one cent:
 *
 *   - `snapshot.result.netContributionCents` is *exact* — `price − food −
 *     packaging − exactCardFee − exactPlatformFee`.
 *   - `DealView.breakdown.netContributionCents` is a *remainder* after the card
 *     and platform fees are each rounded to whole cents.
 *
 * Two independent roundings are involved (card `0.029·P + 30`, platform `0.08·P`
 * clamped), so the divergence can approach — but never reach — a full cent. At
 * `P = 1500` the card fee is `73.5`, the panel shows `74`, and the panel's
 * contribution is `746` where the exact figure is `746.5`.
 *
 * **Neither is wrong.** The panel is internally consistent (its four rows sum to
 * the price), and the snapshot is arithmetically correct. But a report that
 * renders `formatCents(snapshot.result.netContributionCents)` will disagree with
 * the panel the merchant remembers by a cent on some prices, and the merchant
 * will believe the report.
 *
 * So: a report must build its breakdown with **this** function, from the stored
 * snapshot, and never mix the two sources. `snapshotBreakdown()` reproduces the
 * panel exactly, using the fee constants that were in force when the drop was
 * published rather than today's.
 *
 * `ingredientsAndPackagingCents` is stored implicitly (both inputs are), so it is
 * recomputed here from `snapshot.input` — it is a sum of two stored integers, so
 * it cannot drift.
 */
export function snapshotBreakdown(snapshot: GuardrailSnapshot): Breakdown {
  const { input, result } = snapshot;
  const feeConstants = input;
  const priceCents = result.dealPriceCents;

  const cardFeeCents = roundHalfUp(cardFeeAt(priceCents, feeConstants));
  const platformFeeCents = roundHalfUp(platformFeeAt(priceCents, feeConstants));
  const ingredientsAndPackagingCents = input.foodCostCents + input.packagingCents;

  return {
    // Remainder last, so the four rows sum to the price by construction —
    // identical to `buildDealView`'s rule, which is the point.
    netContributionCents:
      priceCents - ingredientsAndPackagingCents - cardFeeCents - platformFeeCents,
    platformFeeCents,
    cardFeeCents,
    ingredientsAndPackagingCents,
  };
}
