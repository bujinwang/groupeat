/**
 * The one Prisma `P2002` predicate in this codebase.
 *
 * Two call sites needed it — the `publicCode` generator in `db/drops.ts` and the
 * scan-idempotency insert in `redemption/redeem.ts` — and they used to carry two
 * definitions that disagreed: this one checked `meta.target`, the other checked
 * only `code`. That is how an unrelated unique collision in a redemption was
 * reported as "already recorded". There is now a single implementation; both
 * call sites import it, and `drops.ts` re-exports it so its pinned contract test
 * keeps exercising the same public surface.
 *
 * The check narrows by `code`, not by `instanceof`: Prisma surfaces these errors
 * as plain objects across module boundaries, so an `instanceof` test would fail
 * silently and let a known violation escape as a 500.
 *
 * ## Shape of the contract
 *
 * A `P2002` counts as *ours* only when the reported target names every field we
 * ask about. Prisma reports a string on some connectors and a string array on
 * others, so both shapes are handled by the same field list:
 *
 *   - string target  → substring match, exactly as before (the `publicCode`
 *     retry's test pins this direction: target `Code` must not match field
 *     `publicCode`, while target `publicCode` must match field `Code`);
 *   - array target   → exact element match, which is what a compound index
 *     reports;
 *   - several fields → *all* must be reported. A half-reported compound key is
 *     not evidence that this was the key we care about.
 *
 * Matching is case-sensitive. Prisma reports the schema's field names verbatim,
 * and a case-insensitive convenience would widen a positive claim (`REPLAYED`,
 * "retry this code") to constraints we did not identify.
 *
 * ## The one policy decision a caller has to make
 *
 * When Prisma reports a `P2002` with no usable target, the caller must decide what
 * that means. `missingTarget: "ours"` is the default because that is the
 * documented behaviour of the `publicCode` retry: retrying the generator is cheap
 * and safe even when attribution is uncertain. `missingTarget: "not-ours"` is for
 * callers whose positive answer asserts a fact about committed data — a replay —
 * and who must therefore propagate the error instead of guessing.
 */

export type UniqueViolationOptions = {
  /**
   * Answer for a `P2002` whose target is absent or not a string/array.
   * Defaults to `"ours"`; see the module docblock before overriding it.
   */
  readonly missingTarget?: "ours" | "not-ours";
};

export function isUniqueViolation(
  error: unknown,
  fields: string | readonly string[],
  options: UniqueViolationOptions = {},
): boolean {
  const required = typeof fields === "string" ? [fields] : fields;
  if (required.length === 0) {
    return false;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") {
    return false;
  }

  const target = candidate.meta?.target;
  if (typeof target !== "string" && !Array.isArray(target)) {
    return (options.missingTarget ?? "ours") === "ours";
  }

  // A string target keeps its historical substring semantics; an array target
  // keeps exact membership. Both answers are derived from the same `required`
  // list, so a compound key needs all of its fields reported.
  if (typeof target === "string") {
    return required.every((field) => target.includes(field));
  }
  return required.every((field) => target.includes(field));
}
