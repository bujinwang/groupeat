# ADR-005 — A held authorisation is released in every post-capture status

**Status:** Accepted
**Date:** 2026-11-01
**Amends:** `findDropsAwaitingVoid` and `voidRemainingAuthorisations` (M5 slice 1); design §2.1's transition table
**Decision owner:** Engineering, on QA's finding (`358f59d`) and the round-3 instruction to widen both halves together
**Blocks:** M6 (pickup window), M7 (merchant reporting), FR-902 (admin cancel)

---

## 1. The decision

There is **one** list of statuses in which a drop may still be holding a live
authorisation that must be released, it lives in
`src/lib/settlement/drop-status.ts`, and both the queue and the guard import it:

```ts
export const VOID_SWEEP_STATUSES = [
  'FAILED', 'CAPTURED', 'PICKUP_OPEN', 'COMPLETED', 'CANCELLED',
] as const;
```

- `findDropsAwaitingVoid` uses it as its `WHERE status IN (...)` — *what gets
  retried*.
- `voidRemainingAuthorisations` uses `isVoidSweepStatus(status)` as a refusal —
  *what is allowed*.
- `LOCKED` is in neither, and that asymmetry with the rest of the terminal statuses
  is the whole safety story.

## 2. Why one list instead of two literal arrays

The defect QA found in round 1 was not an arithmetic error. It was that the two
halves of one rule were written as two literals in two files and had drifted: the
queue said `FAILED`, the guard said `FAILED | CAPTURED`. A diner whose card was
declined on a drop that otherwise ran kept their authorisation held until the
issuer expired it, about seven days later, with nothing in the log. Both files
carried a docblock saying the two must list the same statuses.

A comment cannot enforce agreement between two arrays. A shared constant can,
because there is only one array to edit. So the list is a module, and widening one
half without the other is not a mistake anyone can now make — the other half does
not have a list of its own to leave behind.

## 3. Why the three not-yet-written statuses are in it

`PICKUP_OPEN`, `COMPLETED` and `CANCELLED` are values of the `DropStatus` enum that
**no code in this build writes**. `grep` finds them only in a status-label map in
`apps/(merchant)/merchant/drops/page.tsx`.

They are listed anyway, and this is the part worth defending. The failure mode is
identical to the defect that prompted this ADR, just one transition later: when M6
adds "pickup window opens", a `CAPTURED` drop that is still holding a declined
diner's un-voided authorisation leaves the queue on the way to `PICKUP_OPEN`. The
hold then sits until the issuer expires it. The author of that transition has no
reason to open a settlement constant — the change looks like a status write and
nothing more.

Listing the statuses now costs one line each and moves the decision to the moment
somebody is looking at this list. Not listing them means the decision is made by
whoever happens not to think about it.

## 4. Why this is not the same as "widen the guard and hope"

A status list that accepts a `LOCKED` drop would **release money we are about to
capture**, which is the only mistake in this area that loses money rather than
failing to release it. That is why both halves exist rather than just the queue:

| Half | Kind of check | Protects against |
|---|---|---|
| `findDropsAwaitingVoid` | a filter | work never being queued |
| `voidRemainingAuthorisations` | a refusal | money being released for a drop about to be captured |

`finaliseCaptured` calls the guard directly, and so does the tick's own loop —
only one of those paths is the queue. A guard that trusted the queue would be
wrong for the other. `LOCKED` is refused by the guard, and the registry test and
the cross-product test both assert it.

## 5. How it is verified rather than asserted

Three tests, deliberately at different levels, because the round-1 defect survived
a suite that checked the level below:

1. **`void-status.registry.test.ts`** starts from `ALL_DROP_STATUSES` — every enum
   value — and requires `VOID_SWEEP_STATUSES` to equal an independently written
   judgement (`CAN_HOLD_A_LIVE_AUTH`), which is a `Record<DropStatusLiteral, …>` so
   adding an enum member fails to compile until somebody decides what it means. It
   then asks the queue and the guard **separately** about a drop in each status, so
   a disagreement between them fails here even if the constant is self-consistent.
2. **`void-queue.cross-product.test.ts`** walks the full `authStatus × chargeStatus`
   grid (25 pairs × 2 statuses) against a hand-stated definition of "does a live
   hold exist at the provider", and checks the queue cannot be starved by drained
   work.
3. **`void-status.registry.test.ts`'s tick case** drives `runCutoffTick`, which is
   the path production takes. A query that never gets asked is still never asked.

Test 1's judgement table and test 2's hold definition are written out independently
of the implementation on purpose. A test whose input list is copied from the code
under test cannot notice a status that both halves are missing — which is exactly
what the round-2 suite did, over the same two statuses the code hardcoded.

## 6. Consequences

- **Adding a status to `DropStatus`** now fails a test until it is classified. That
  is intended friction: the classification is a money judgement, and the enum is
  the only moment it is cheap to make.
- **`CANCELLED` is included** because FR-902 (admin force-fail) will produce it and
  nobody will ever capture those holds. The behaviour it implies — a cancelled drop
  voids every remaining authorisation on the next tick — is what the eventual
  cancellation code needs to do anyway; writing it into the list does not implement
  FR-902, it only makes the sweep correct when FR-902 lands.
- **This ADR does not add a transition.** No code writes `PICKUP_OPEN`, `COMPLETED`
  or `CANCELLED` because of this document. It only decides what happens to held
  authorisations once something does.
