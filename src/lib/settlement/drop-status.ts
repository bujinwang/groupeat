/**
 * The statuses a drop can be in while still holding an authorisation that must be
 * released.
 *
 * ## Why this is one list and not two
 *
 * `findDropsAwaitingVoid` selects drops to sweep; `voidRemainingAuthorisations`
 * refuses any drop not in this list. They are one rule, and before this module
 * existed they were two literals in two files — which is exactly how the defect
 * that shipped and then had to be fixed got in: the queue said `FAILED`, the guard
 * said `FAILED | CAPTURED`, and a declined diner's hold on a *successful* drop was
 * never retried. The engineer's own docblock at the time said the two "must list
 * the same statuses"; a comment cannot enforce that. A shared constant can.
 *
 * So there is one list. Adding a status here widens both halves at once, and there
 * is no way to widen one without the other.
 *
 * ## What belongs in it
 *
 * A status belongs here if a participant's authorisation can still be live while
 * the drop is in that state — i.e. every terminal status **after** the capture
 * decision has been made:
 *
 * | Status | Why it can hold a live authorisation |
 * |---|---|
 * | `FAILED` | the threshold was missed, or capture fell below tolerance. Authorisations are voided, and a void can fail transiently. |
 * | `CAPTURED` | the drop ran, but a *declined* diner's cancellation can fail in `finaliseCaptured`. |
 * | `PICKUP_OPEN` | post-capture. Same residual as `CAPTURED`, carried forward. |
 * | `COMPLETED` | post-capture. Same residual again. |
 * | `CANCELLED` | merchant or admin cancelled the drop (FR-902). Nobody will ever capture those holds, so they must be released. |
 *
 * ## Why the last three were listed before anything wrote them
 *
 * When this module was written, **nothing** in the build moved a drop to
 * `PICKUP_OPEN`, `COMPLETED` or `CANCELLED` — `grep` found them only in a
 * status-label map. Listing them anyway was not speculative generality; it was the
 * same defect this module exists to fix, one status further along. The bet paid
 * twice: `settlement/pickup-window.ts` now writes the first two, and FR-902's
 * `forceFailDrop` plus FR-208's `cancelDrop` write `CANCELLED`. The prediction about
 * what would have gone wrong was exact — `redeem.ts` reads no clock, so before that
 * transition no diner could collect food on any drop, and the symptom was a scanner
 * saying "not yet" to a paid, valid code.
 *
 * ## `CANCELLED` is now load-bearing for a second reason
 *
 * `cancelDrop` (FR-208) writes `CANCELLED` **before** it calls the void sweep, and
 * that ordering only works because this list is what the sweep's guard reads. Written
 * the other way round — sweep, then status — the sweep would see `PUBLISHED`, refuse
 * it, and return `{voided: 0}`: a cancelled drop whose every diner's money was still
 * held, with no error and no log line. Mutation-probing that ordering fails three
 * tests in `drops/__tests__/cancel.test.ts`, all on the released count.
 *
 * So this list is not only "which statuses may hold a live authorisation". It is also
 * the reason the cancel path can release them at all.
 *
 * The transition author would have had no reason to look at a settlement constant,
 * which is why the exhaustive cross-product test below is the real guard.
 *
 * The test `void-queue.cross-product.test.ts` walks all eight `DropStatus` values
 * against both halves (the queue and the guard) and requires them to agree on
 * every one, so a status list that drifts — in either direction — fails there
 * rather than in a diner's bank account.
 *
 * ## What must never be in it
 *
 * `LOCKED`. A locked drop still needs its authorisations to be **captured**, so
 * voiding one would release the hold on money we are about to take. That is the one
 * mistake in this list that loses money rather than failing to release it, which is
 * why the guard in `voidRemainingAuthorisations` exists as well as the queue filter:
 * the queue is a filter, the guard is a refusal, and a drop reached by any other
 * path still cannot be voided.
 *
 * `PUBLISHED` and `DRAFT` are absent for the obvious reason: they are before the
 * cutoff, and nothing may be voided before the decision.
 */
export const VOID_SWEEP_STATUSES = [
  'FAILED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'CANCELLED',
] as const;

export type VoidSweepStatus = (typeof VOID_SWEEP_STATUSES)[number];

/**
 * Narrows a `DropStatus` string to the sweepable subset.
 *
 * Takes a `string` rather than the Prisma enum because `settlement/` compares
 * against string literals throughout, deliberately: importing `@prisma/client` for
 * an enum would pull a runtime dependency into a module the tests load in
 * isolation (design §11.6).
 */
export function isVoidSweepStatus(status: string): status is VoidSweepStatus {
  return (VOID_SWEEP_STATUSES as readonly string[]).includes(status);
}
