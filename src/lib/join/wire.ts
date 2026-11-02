/**
 * The `/join` success body — declared once, so the server and the browser cannot
 * disagree about it.
 *
 * ## The bug this exists to make impossible
 *
 * The confirmation screen rendered "people join by **undefined**". The cause was
 * not a typo; it was two declarations of the same shape, one on each side of a
 * JSON boundary:
 *
 *   - `JoinForm.tsx` declared `cutoffLabel: string`,
 *   - `route.ts` sent `cutoffAt: '2026-11-06T01:00:00.000Z'`,
 *   - and `body as JoinSuccess` told the compiler to stop caring.
 *
 * `cutoffLabel` was read in exactly one place and produced by nobody. `tsc` could
 * not see it: a cast is a promise, and the promise was false. The field had been
 * declared in 2b (commit `de9c7d6`) and never sent — so this was already broken
 * when I found it, and every test was green because no test read the sentence.
 *
 * A shared type does not merely document the shape; when the route body is typed
 * with it, an absent field is a compile error and an extra one is an excess-property
 * error. That is the whole reason this module exists and imports nothing — it has to
 * be importable from a client component without dragging Prisma or zod across.
 *
 * ## Why the labels are here and not computed in the browser
 *
 * Every human-readable string in this body is authored on the server, and
 * `amountLabel`/`cutoffLabel` are strings rather than numbers for a reason: the
 * merchant's `timezone` decides what "Thursday 1:00 PM" means, and a browser would
 * format in the diner's zone. A diner travelling, or on a phone set to another
 * country, would read a cutoff that is not the one the kitchen keeps. Same rule as
 * ADR-002 for money — the server owns the number *and* the words for it.
 */

/**
 * What `POST /api/public/drops/[code]/join` returns with a 200.
 *
 * Deliberately narrow: no full phone number, no customer id, no token. `phoneLast4`
 * is an identification fact and nothing more.
 */
export type JoinSuccessBody = {
  readonly ok: true;
  readonly participantId: string;
  readonly qty: number;
  readonly amountCents: number;
  /** `"$25.00"` — `formatCents`, server-side. Never re-formatted in the browser. */
  readonly amountLabel: string;
  readonly phoneLast4: string;
  readonly status: 'AUTHORIZED' | 'PENDING';
  readonly alreadyJoined: boolean;
  readonly minQty: number;
  readonly maxQty: number;
  /** ISO-8601. The instant, for any caller that needs to compute rather than print. */
  readonly cutoffAt: string;
  /** `"Thursday 1:00 PM"` in the merchant's zone — what the confirmation prints. */
  readonly cutoffLabel: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly isConfirmedAlready: boolean;
  /** `/d/CODE/mine?t=…` — a path, so it cannot be wrong about the origin. */
  readonly orderPath: string;
};
