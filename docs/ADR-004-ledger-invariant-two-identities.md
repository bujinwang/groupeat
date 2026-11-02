# ADR-004 — The ledger invariant, restated as two identities

**Status:** Accepted
**Date:** 2026-11-01
**Supersedes:** PRD-v1 §8.7 — "For every drop: `SUM(LedgerEntry.amountCents) == Stripe net balance change for that drop`"
**Decision owner:** Bujin (accepting the arithmetic over the frozen sentence, on the same principle as ADR-003)
**Blocks:** M5 (FR-507, the ledger writes), M8 (the nightly reconciliation job)
**Depends on:** ADR-001 (direct charges; the merchant bears the Stripe processing fee)

---

## 1. The decision

PRD-v1 §8.7 states one sum and one comparison:

> For every drop: `SUM(LedgerEntry.amountCents) == Stripe net balance change for that drop`.
> A nightly reconciliation job asserts this and alerts on mismatch. **Non-negotiable.**

Under ADR-001's direct charges, **there is no single "Stripe net balance change for that drop"**. One drop moves money on two Stripe accounts in two directions, and the amounts do not sum to either side. The sentence is unsatisfiable — not approximately, not after rounding, but by construction.

It is replaced by **two reconciliation identities, one per account** (L5 in §3.2), each compared against a named Stripe surface on a named account — plus a small set of **in-process identities** (L1–L4) that assert the ledger agrees with our own `Order` rows on every settlement, so a wrong-cent bug fails on the tick that creates it rather than at month-end. The reconciliation requirement is unchanged in force: the nightly job still asserts and still alerts. What changes is that it asserts two things instead of one, because the money goes to two places.

`docs/PRD-v1.md` is a frozen requirements document and is not edited. This note is where the divergence is recorded, exactly as ADR-001 §4.0 records its own.

---

## 2. Why §8.7 as written cannot hold

### 2.1 One drop, two accounts

A direct charge (ADR-001) puts the `PaymentIntent`, the `Charge`, the balance and the disputes on the **connected account**. GroupEat's revenue is the `application_fee_amount`, which moves to the **platform**. Two accounts, two balance deltas, opposite in sign from each other's point of view:

| Account | Delta for a drop of N units at price P, platform fee F per unit | Which Stripe object proves it |
|---|---|---|
| connected account (merchant) | `+ N·P − cardFee − N·F` | `balance_transaction` attached to each charge |
| platform (GroupEat) | `+ N·F` | the `application_fee` balance transaction |

The two deltas are not related by a constant, and neither is a sum of our ledger entries.

### 2.2 The arithmetic, worked

Vector A from PRD-v1 §7.4: menu $16.00, deal price $11.12, platform fee $0.89 per plate. One participant, three plates, one charge of $33.36.

| Figure | Cents | Where it comes from |
|---|---|---|
| diner charged | `3336` | `3 × dealPriceCents` |
| platform fee (our revenue) | `267` | `3 × roundHalfUp(platformFeeAt(1112))` = `3 × 89` |
| Stripe's card fee on the charge | `≈127` | `0.029 × 3336 + 30` — Stripe's number, not ours |
| **connected account delta** | **`+2942`** | `3336 − 127 − 267` |
| **platform delta** | **`+267`** | `application_fee_amount` |

Now try to satisfy §8.7 with our entries. Suppose the ledger records what §8.7 needs — a `CHARGE` of `3336` and a `PLATFORM_FEE` of `267` for this participant. Then:

- `SUM(amountCents) = 3603`, which equals **neither** `2942` nor `267`.
- Drop the `PLATFORM_FEE` row and the sum is `3336` — the gross, before any fee. Not a balance delta either.
- Record only the `PLATFORM_FEE` row and the sum is `267`, which does equal the platform delta — but only because every other entry type has been thrown away, and then the ledger no longer records what the diner was charged, which is the thing a merchant complaint is about.

There is no choice of sign convention that makes one sum equal both deltas, because the card fee (`≈127`) is a third party's cut that leaves the system entirely, and it is not in any ledger column.

### 2.3 Why the card fee is not in the ledger, and should not be

We could add a `CARD_FEE` entry of `−127` and make the connected-account sum reconcile. This is rejected:

1. **The number is Stripe's, and it is only knowable after the charge.** Writing it means either a second write after a Stripe read (a new failure window between "charged" and "recorded") or recording an estimate we computed ourselves — and `cardFeeAt()` is a *model*, not Stripe's actual fee (see §6.1).
2. **ADR-001 makes it not ours.** Under a direct charge the merchant bears the card fee. Putting it in our ledger would put a cost on our books that never touches our balance, which is the same defect class ADR-001 §2.1 rejected: a figure that looks right and describes the wrong party.
3. **It makes the platform's revenue depend on a merchant's card mix.** Two merchants charging identical amounts would show different platform revenue, which is false.

So the card fee stays out, and the consequence is that the ledger cannot reconcile to the connected account's delta on its own. That is not a gap to be closed by a column; it is the shape of a direct charge.

### 2.4 What the old sentence was protecting, and why it is still protected

§8.7's real demand is in the next two sentences, not the formula: *a nightly job asserts it, and a mismatch pages someone.* The formula was the author's attempt to say "the books must agree with the money", and it was written when §8.1 still assumed destination charges, where the platform's balance does carry the card fee and a single sum is at least conceivable.

The replacement in §3 preserves the demand and drops the false premise: two identities, each with a named counterparty, both asserted nightly, both alerting.

---

## 3. The replacement

### 3.1 Sign convention

**Positive = money arrived. Negative = money left.** Every entry is denominated in the account named by its `type`:

| `LedgerEntry.type` | Account whose balance it moves | Sign | Meaning |
|---|---|---|---|
| `CHARGE` | connected account, from the diner | `+` | the diner paid |
| `REFUND` | connected account, back to the diner | `−` | the diner was repaid |
| `PLATFORM_FEE` | platform, from the connected account | `+` | GroupEat's revenue |
| `ADJUSTMENT` | platform, when an application fee is reversed | `−` | revenue given back with a refund |
| `ORGANISER_COMMISSION` | platform, paid out to an organiser | `−` | not written in M5; see §5 |

The convention is stated per-account rather than per-entry because the two accounts see the same event with opposite signs. A single global sign would be a lie for one of them.

### 3.2 The identities

`entries` and `orders` are for one drop. `orders` is the `Order` table, which is our own durable record of each captured participant.

| # | Identity | Reconciled against | Available |
|---|---|---|---|
| **L1** | `Σ CHARGE + Σ REFUND == Σ order.subtotalCents where not refunded` | the `Order` rows | M5, in-process |
| **L2** | `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ order.platformFeeCents where not refunded` | the `Order` rows | M5, in-process |
| **L3** | `−Σ REFUND == Σ order.subtotalCents where refunded` | the `Order` rows | M5, in-process |
| **L4** | per order: `CHARGE.amountCents == order.subtotalCents` **and** `PLATFORM_FEE.amountCents == order.platformFeeCents` | the order it hangs off | M5, in-process |
| **L5** | `Σ CHARGE + Σ REFUND + Σ card fees == connected-account balance delta`; and `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ application_fee` | Stripe balance transactions, **both accounts** | M8, needs Stripe |

L1–L4 are asserted by `assertLedgerReconciles()` in `src/lib/settlement/ledger.ts`, on every settlement, with no provider and no network. They catch the failure that actually happens: a rounding change, a fee computed from the wrong constants, an order written with one total and a ledger row with another. L4 is the strictest of them and the cheapest — one entry against the row it hangs off — and it is what makes a wrong-cent bug fail on the tick that creates it rather than at month-end.

L5 is the reconciliation §8.7 asked for, and it is the M8 nightly job. It needs a `stripeAccount` header on every read (ADR-001 §3.2) and a sum over balance transactions rather than over charges, because refunds and reversals are separate transactions. It is **not** in M5 and this ADR does not pretend otherwise: M5 proves the ledger is internally consistent and that it agrees with our own orders. Proving it agrees with Stripe is a different test, on a different schedule, with different failure modes.

### 3.3 What the nightly job must do differently

Not one query. Two, against two accounts, with different expected values:

1. For each drop, sum the connected account's balance transactions attributable to it and compare to L1's left-hand side plus the card fees Stripe reports for those charges.
2. Sum the platform's `application_fee` transactions for those charges and compare to L2's left-hand side.

A single-account job would pass on the platform side (our fee is exactly what we set) and fail on the merchant side by the card fee, every drop, forever. That is the failure this ADR exists to prevent: a nightly alert that is always red is a nightly alert nobody reads.

---

## 4. The second decision: the platform fee is rounded per unit, then multiplied

Recorded here because it is currently only a convention in `docs/M5-cutoff-design.md` §11.1 and the join path — which does not exist yet — will be written against it.

### 4.1 The rule

```
feeConstants = readGuardrailSnapshot(drop.guardrailSnapshot).input   // platformFeePct, FloorCents, CapCents
perUnitCents = roundHalfUp(platformFeeAt(drop.dealPriceCents, feeConstants))
participant.platformFeeCents = participant.qty * perUnitCents
```

Per unit first, then multiplied. `roundHalfUp` from `src/lib/guardrail` is the only rounding function; no `Math.round`, no `toFixed`.

### 4.2 Why

The merchant's promise and the guardrail's clamp are **both per plate**. The panel says:

> "You keep $4.01 per plate after ingredients, packaging, card fees **and our fee** ($0.89)."

`platformFeePct`, `platformFeeFloorCents` and `platformFeeCapCents` are applied to a per-plate price, so the floor and the cap are per-plate bounds. Rounding the order total instead makes our fee a per-order number, and then the merchant's per-plate figure — the one number this product exists to make honest — disagrees with what they actually keep, on every order above one unit. `CONTRIBUTING.md` is about exactly this class of defect: a sentence and a figure that describe different transactions.

### 4.3 The counter-example that makes it concrete

At `dealPriceCents = 500` (below the point where 8 % clears the floor: `0.08 × 500 = 40 < 60`), three units:

| Method | Arithmetic | Our fee |
|---|---|---|
| per unit, then × qty | `roundHalfUp(60) × 3 = 180` | **$1.80** |
| round the order total | `roundHalfUp(platformFeeAt(1500)) = roundHalfUp(120) = 120` | **$1.20** |

A 60-cent divergence, and it is entirely the floor: three plates each cleared a 60-cent floor, so the floor was cleared three times. Rounding the total applies a 60-cent floor to a $15.00 order, which is not a floor at all.

The cap diverges the same way and by more. At `dealPriceCents = 1112`, three units: per unit gives `3 × 89 = 267`, while rounding the total gives `roundHalfUp(platformFeeAt(3336)) = 200` — the cap binds once for the whole $33.36 order, where per plate it allows up to $2.00 each. Per-order rounding would let a large order buy our fee down to 6 % of the transaction, which is the opposite of what a cap is for.

### 4.4 Which constants

The frozen snapshot, not `DEFAULT_FEES`. `Drop.guardrailSnapshot.input` records the fee constants in force at publish (ADR-001 §4.1), so two participants joining the same drop a day apart cannot pay different platform fees because someone changed a constant in between. This also means the drop's fee arithmetic is reproducible in six months, which is the whole reason the snapshot exists.

**Trap, stated because the types make it easy to fall into:** `snapshot.result.platformFeeCents` is **unrounded** (`88.96` for vector A). `snapshot.input` gives the constants; the per-plate integer is `roundHalfUp(platformFeeAt(dealPriceCents, snapshot.input))`. Reading `result.platformFeeCents` and multiplying it by `qty` produces `266.88`, and whatever you do with the fractional cent afterwards is a second rounding decision that nobody made on purpose.

---

## 5. What this does not change

- **Capture, void and refund behaviour.** The port, the 90 % tolerance, the void sweep, the "refunds complete before `FAILED` is written" ordering — all unchanged. They were designed against the money, not against the reconciliation statement.
- **The `Order` rows.** `subtotalCents`, `unitPriceCents`, `platformFeeCents` are the same numbers under both readings. L1–L4 use them as the authority, which is why they are already sufficient.
- **The `LedgerEntry` schema.** No new column, no new `LedgerType` member. The sign convention and the two identities are a reading of the existing shape, which is why this ADR needs no migration. M5 adds one unique index (`[orderId, type]`) for idempotency; that is independent of this decision.
- **`ORGANISER_COMMISSION`.** Still not written in M5. Commission (FR-804) is a payout calculation over captured GMV, not a movement of money at capture time. L2's left-hand side already names the types it sums, so adding commission later extends the identity rather than breaking it.

---

## 6. Consequences

### 6.1 A known divergence between the guardrail's card-fee model and Stripe's

`cardFeeAt(priceCents)` is `stripePct × price + stripeFixedCents`, applied **per plate**. Stripe charges `2.9 % + 30 ¢` **per charge**, and one participant's order is one charge regardless of how many plates it holds. So on a multi-unit order the guardrail subtracts the fixed 30 ¢ once per plate rather than once per charge.

At vector A, three plates: the guardrail subtracts `3 × 62.248 = 186.744 ¢`; Stripe takes `0.029 × 3336 + 30 = 126.744 ¢`. A 60-cent difference — exactly `2 × 30 ¢`.

This is a **conservatism in the merchant's favour**: the panel subtracts more cost than Stripe actually takes, so the merchant's real contribution is at least the figure shown. No merchant is misled downward, no price is published that loses money, and the frozen fixtures are correct for what they assert (a per-plate contribution).

It is recorded here because it is the single thing that will make a naive L5 fail: a nightly job that compares our ledger to the connected account's delta must use **Stripe's reported card fees**, not `cardFeeAt()`. Recomputing them from our model would produce a mismatch of `(qty − 1) × 30 ¢` on every multi-unit order and page someone at 3 a.m. for a rounding model.

Whether the guardrail's per-plate card-fee model should change is **not decided here** and must not be changed as a side effect of building M8: the model is frozen into published snapshots and into the copy fixture.

### 6.2 M8 must reconcile two accounts

Every read against a connected account needs a `Stripe-Account` header, which `forMerchant(accountId)` in `src/lib/payments/stripe.ts` supplies by construction. The nightly job's per-drop loop therefore needs the drop's `merchant.stripeAccountId`, which means M8's query joins `Merchant` — not a field the ledger has.

### 6.3 `LedgerEntry` has no account dimension, and that is now a dated gap

An entry's account is inferable from its `type` (§3.1), and that inference is correct today. It is also the kind of thing that breaks silently: the day someone adds a `CHARGEBACK` type, or records a platform-side charge for a future non-Stripe path, the inference becomes ambiguous and every historical row is retroactively ambiguous too.

This must be decided **before** the nightly job is written, not after: adding an `account` column to `LedgerEntry` after M8 has reconciled six months of rows means either backfilling it from `type` (possible, and lossy if `type` was ever ambiguous) or carrying the inference forever. No change is made now — M5 does not need it, and a column with one possible value is not worth a migration today. It is a decision with a deadline, and the deadline is the first line of M8's reconciliation job.

---

## 7. What this does not decide

**Whether the ledger should record the card fee at all.** §2.3 rejects it for M5 and M8. A future product change — destination charges, or a platform-funded fee — would reverse the reasoning entirely, and this ADR would return to Proposed.

**Whether `ORGANISER_COMMISSION` is a ledger entry or a payout statement line.** FR-804 wants a monthly statement. Whether that statement is derived from ledger entries or from `Order` rows plus the `ShareLink` relation is M7's decision, and §5 only guarantees that adding it does not break L2.

**How an out-of-band adjustment is recorded.** FR-903 (admin partial refund) and FR-902 (admin force-fail) will need entries that are neither a capture nor a refund of a captured order. `ADJUSTMENT` is the obvious home and its sign convention is stated, but the *identity* those entries participate in is not specified here.

**Whether §8.7 should be rewritten in the next PRD revision.** This ADR is the interim record. If the PRD is revised, §8.7's sentence should be replaced with §3.2's table and this ADR superseded in turn.
