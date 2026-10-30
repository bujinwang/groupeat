/**
 * Money formatting and rounding.
 *
 * Hand-rolled on purpose: `Intl.NumberFormat` output depends on the host ICU
 * data, which would make snapshots locale-dependent. These two functions are the
 * only place rounding happens, and rounding is a **display** concern only
 * (ARCHITECTURE-sprint1 §7.2).
 */

/**
 * Rounds half away from negative infinity ("half up" in the everyday sense):
 * `roundHalfUp(30.5) === 31`, `roundHalfUp(70.62) === 71`,
 * `roundHalfUp(-0.5) === 0`, `roundHalfUp(-1.5) === -1`.
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * Formats integer cents as `$11.12` / `-$1.08`.
 *
 * Non-integer input is rounded to the nearest cent first, so the function is
 * total over the module's own unrounded intermediates. Callers inside the
 * guardrail always pass integers; the rounding is a belt-and-braces guarantee
 * that no `$4.007920000000001` can ever reach a screen.
 *
 * Non-finite input is unreachable for validated data (the fuzz suite asserts
 * every produced figure is finite); it formats as `$0.00` rather than `$NaN`.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) {
    return '$0.00';
  }
  const rounded = roundHalfUp(cents);
  const isNegative = rounded < 0;
  const absolute = Math.abs(rounded);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const centsPart = remainder < 10 ? `0${remainder}` : `${remainder}`;
  return `${isNegative ? '-' : ''}$${dollars}.${centsPart}`;
}
