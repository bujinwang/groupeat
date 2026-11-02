import { platformFeeAt, roundHalfUp, type FeeConstants } from '@/lib/guardrail';

/**
 * The platform fee for one order — **rounded per unit, then multiplied**.
 *
 * ## Why this function exists
 *
 * The rule is recorded in ADR-004 as a decision, and it was written down in
 * `settle.ts` as prose, and there was no function anywhere that implemented it —
 * because the path that must implement it (join) did not exist yet. That is the
 * gap this module closes: the obligation is now callable, so the join path can
 * call it instead of deciding a rounding rule for itself.
 *
 * Settlement reads `DropParticipant.platformFeeCents` verbatim and never recomputes
 * it (design §11.1), because the fee was agreed at join time and `DEFAULT_FEES` may
 * have changed since. So **nothing in this slice can catch a join path that rounds
 * the order total instead of the unit** — the value is stored once and trusted
 * afterwards, and the fixtures set it directly. This function is the contract that
 * path must call.
 *
 * ## Why the test files keep their own copy of the expression
 *
 * Several settlement tests write `qty * roundHalfUp(platformFeeAt(DEAL_PRICE,
 * DEFAULT_FEES))` out by hand rather than calling this function, and that is
 * deliberate, not leftover duplication: in a test that expression is an **oracle**.
 * A test whose expected value is computed by the same code it is testing cannot
 * fail when that code is wrong. `platform-fee.test.ts` pins this function against
 * the ADR-004 vectors as literal integers (267, 180, 89) for the same reason.
 *
 * The duplication that *was* a defect is the kind the structural test
 * `__tests__/no-inline-fee-rounding.test.ts` now forbids: a second implementation
 * in **production** code. There, two copies are two chances to disagree.
 *
 * ## Why per unit and not per order
 *
 * The merchant's promise is per plate — the guardrail panel says "you keep $4.01
 * per plate … and our fee ($0.89)" — and the fee's floor and cap are per plate too
 * (`platformFeeAt` clamps to 60c…200c *for a price*). Rounding the order total
 * instead produces a different number, and the divergence is not a rounding error:
 *
 * | Deal price | Qty | Per unit, then × qty | Order total, rounded once | Divergence |
 * |---|---|---|---|---|
 * | $5.00 | 3 | `3 × roundHalfUp(60)` = **180** | `roundHalfUp(platformFeeAt(1500))` = **120** | 60c |
 * | $11.12 | 3 | `3 × roundHalfUp(88.96)` = **267** | `roundHalfUp(platformFeeAt(3336))` = **200** | 67c |
 *
 * The first diverges because the 60c **floor** is cleared three times instead of
 * once; the second because the 200c **cap** is hit three times instead of once. In
 * both cases the per-order reading undercharges us, and — worse — makes the
 * merchant's per-plate figure disagree with what they actually keep on a multi-unit
 * order.
 *
 * ## What this does *not* decide
 *
 * Which fees to pass. The caller must pass the constants **in force when the drop
 * was published**, which are frozen in `Drop.guardrailSnapshot.input` — not
 * `DEFAULT_FEES`, which is what they are today. Two participants on one drop must
 * never pay different fees, and a fee change between publish and join must not
 * retroactively re-price a published drop. `fees` is required, with no default, so
 * that choice has to be made at every call site rather than inherited by accident.
 */
export function platformFeeCentsForOrder(args: {
  /** Units on the order. Integer, at least 1. */
  qty: number;
  /** The drop's per-unit price, in cents. */
  dealPriceCents: number;
  /** The fee constants in force at publish — from the frozen snapshot. */
  fees: FeeConstants;
}): number {
  const { qty, dealPriceCents, fees } = args;

  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError(`platformFeeCentsForOrder: qty must be a positive integer, got ${qty}.`);
  }
  if (!Number.isInteger(dealPriceCents) || dealPriceCents < 1) {
    throw new RangeError(
      `platformFeeCentsForOrder: dealPriceCents must be a positive integer, got ${dealPriceCents}.`,
    );
  }

  // Per unit first. The multiplication happens on integers, so no float survives
  // this line — which is the point of rounding before multiplying rather than after.
  return qty * roundHalfUp(platformFeeAt(dealPriceCents, fees));
}

/**
 * The per-unit fee on its own, for the guardrail panel and for tests that want the
 * figure rather than an order total.
 *
 * Exported separately so a caller cannot accidentally get "the fee for one plate"
 * by passing `qty: 1` and then multiply it by a float somewhere else.
 */
export function platformFeeCentsPerUnit(args: {
  dealPriceCents: number;
  fees: FeeConstants;
}): number {
  return roundHalfUp(platformFeeAt(args.dealPriceCents, args.fees));
}
