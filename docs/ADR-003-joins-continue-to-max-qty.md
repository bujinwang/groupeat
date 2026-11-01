# ADR-003 — A confirmed drop keeps taking joins up to `maxQty`

**Status:** Accepted
**Date:** 2026-11-01
**Supersedes:** PRD-v1 FR-305, second clause — "When threshold met, shows 'Confirmed — N units' and **stops accepting joins**"
**Decision owner:** Bujin (explicit instruction: "continuing to maxQty")
**Blocks:** M5 (cutoff job reads `joinedQty` at the cutoff, which this does not change)

---

## 1. The decision

Reaching `minQty` changes the drop's **status**, not its **door**. A confirmed drop
keeps accepting joins until `joinedQty` reaches `maxQty` or the cutoff passes,
whichever comes first. The page shows "Confirmed — N orders so far" while it is
still filling, and drops the "so far" once it cannot fill further.

The join button is now disabled for exactly three reasons, all of them facts about
the drop rather than about the threshold:

| Reason | Condition |
|---|---|
| `SOLD_OUT` | `joinedQty >= maxQty` |
| `CLOSED` | the cutoff has passed, or the drop is no longer `PUBLISHED` |
| `FAILED` | the cutoff passed below `minQty` |

## 2. Why FR-305 was wrong

### 2.1 `maxQty` is the merchant's own capacity statement

PRD-v1 §9.2 asks the merchant, in as many words, "How many can you commit to
making?" That number becomes `maxQty`, and `validateDropQuantities` refuses a drop
whose `maxQty` exceeds the dish's `batchYield`. So by the time a drop is
published, the merchant has already said: *I can make this many, and I will.*

Refusing joins between `minQty` and `maxQty` throws away plates the kitchen had
already agreed to cook, for people who had already decided to buy.

### 2.2 The gap is not small

For the three archetypes the planner produces (ADR-002 §3.1):

| Archetype | `minQty` | `maxQty` | Plates FR-305 would refuse |
|---|---|---|---|
| `QUIET_HOUR` | 15 | 30 | **15** |
| `TRIAL` | 20 | 30 | **10** |
| `SURPLUS` | 9 | 30 | **21** |

`SURPLUS` is the starkest: a drop that clears its low minimum stops taking orders
at 9 out of a 30-plate batch. That is not a guardrail, it is a self-inflicted
stockout.

### 2.3 The marginal plate is the cheapest plate

Batching economics improve with units per batch — the labour, the firing, the
packaging run are paid once. And every additional plate is priced **above the
floor**, because `minViablePrice()` is a lower bound and the planner never goes
below it. So each refused join is not "a discount avoided", it is contribution
the merchant already had the capacity to earn.

### 2.4 What FR-305 was protecting against, and why it is already covered

The real concern behind "stop at the threshold" is that the merchant starts
cooking the moment the drop confirms, so the count must not move afterwards.

That concern is addressed by three things that do not require closing the door:

1. The merchant was told **up to `maxQty`** when they published. A count rising
   from 20 to 30 is inside the promise they made, not outside it.
2. The count freezes at the **cutoff**, and capture happens at the cutoff
   (PRD-v1 §8.4). Nothing about *when* the number stops moving has changed.
3. The page now says so out loud: "The kitchen is on. More can join until
   {cutoff}, up to {maxQty}." and the headline says "so far" while that is true.

## 3. Consequences

**Code.**

- `canJoin` no longer derives from the offer phase. It is now
  `status === 'PUBLISHED' && !cutoffPassed && !soldOut`.
- `SOLD_OUT` is a reachable `JoinBlockedReason` again. It was removed in the
  previous slice as an unreachable branch — correctly, *under FR-305*, where
  `joinedQty >= maxQty` implied `joinedQty >= minQty` and therefore always meant
  `THRESHOLD_MET`. The branch is live now and has a test.
- `THRESHOLD_MET` is gone.
- Scarcity (`only N left`) can now render on a **confirmed** drop. It is more
  useful there than anywhere else: before confirmation it is a curiosity, after
  confirmation it is the only thing telling a diner how much time they have.

**Copy — and this is the part that carries risk.**

Three surfaces must now state that a confirmed drop can still fill, or the
merchant will cook 20 when 30 were ordered:

| Surface | Status |
|---|---|
| Public deal page | done — "The kitchen is on. More can join until …" |
| The confirmation SMS / notification (§6.5 FR-506) | **not built yet (M5)** — must say "still filling until {cutoff}" |
| Merchant dashboard (M7) | **not built yet** — the live count must be labelled as not final |

This ADR creates a copy obligation on two milestones that do not exist yet. If
either ships saying "Confirmed: 20" as a final number, the merchant undercooks
and this decision becomes a customer-complaint generator.

**Money.** Unchanged. Capture at the cutoff captures every authorised
participant, up to `maxQty`. §8.4's cutoff job and §8.5's 90% partial-capture
tolerance are about capture failures, not joins, and neither is affected.

## 4. What this does not decide

**Whether a merchant can close a drop early.** A merchant who has started cooking
and would rather not add plates has no way to say so. That is a real option —
"lock it now" — and it is a better answer than either extreme. Not in V1.

**Whether `maxQty` should be advisory.** It is enforced as a hard ceiling on
joins. If merchants routinely sell out in minutes, the right change is to raise
their `batchYield`, not to let the platform oversell a batch the kitchen cannot
make.

**Whether the threshold should still exist.** It does, and it still means what it
meant: below it, nobody is charged and the drop does not run. That is the whole
risk-transfer mechanism, and ADR-003 does not touch it.
