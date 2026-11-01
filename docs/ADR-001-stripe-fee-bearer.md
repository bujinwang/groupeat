# ADR-001 — Stripe fee bearer (D-1)

**Status:** Accepted, pending live test-mode confirmation
**Date:** 2026-11-01
**Supersedes:** PRD-v1 §17 D-1 recommendation ("Merchant, via `on_behalf_of`")
**Blocks:** M2 (Stripe Connect onboarding), M4 (PaymentIntent), M5 (capture/ledger)

---

## 1. The decision

**Use direct charges on the connected account.** The merchant account is the
business of record, the charge lives on their account, the Stripe processing fee
is deducted from the merchant's charge, and GroupEat collects its platform fee as
`application_fee_amount`.

This is the **only** charge model consistent with the guardrail that already
shipped. That is the whole argument, and §2 proves it.

## 2. Why the PRD's answer was wrong

PRD-v1 §17 D-1 said "Merchant, via `on_behalf_of`". The intent was right. The
mechanism does not do that.

Stripe's destination-charge documentation is explicit:

> "Your account balance is debited for the cost of the Stripe fees, refunds, and
> chargebacks."

and, for `on_behalf_of` specifically:

> "For destination charges, with or without `on_behalf_of`, Stripe debits dispute
> amounts and fees from your platform account."

`on_behalf_of` changes the **settlement merchant**, the settlement country and
currency, **the country fee structure used**, the statement descriptor, and the
payout `delay_days`. It does not change *whose balance the fee leaves*. On a
destination charge the platform always pays Stripe.

### 2.1 The arithmetic that makes this a bug, not a preference

Vector A: menu $16.00, food $4.80, packaging $0.80, deal price $11.12.

| Figure | Destination charge (platform pays Stripe) | Direct charge (merchant pays Stripe) |
|---|---|---|
| Merchant nets after our fee | $10.23 | $10.23 − $0.62 = **$9.61** |
| Merchant contribution | **$4.63** | **$4.01** |
| GroupEat nets | **$0.27** | **$0.89** |

The guardrail, the panel copy, and the frozen fixture all say **$4.01**. That is
the direct-charge number. Under destination charges the merchant actually keeps
**$4.63** — the panel overstates the cost of the deal by the full card fee, 62
cents a plate on a $11.12 item.

Two failures follow, and the second is worse:

1. **The merchant is told a number that is not what they will receive.** The one
   promise the sprint made — "if the breakdown doesn't add up on screen, nothing
   else on the page is believed" — is broken by the charge model, silently.
2. **GroupEat's own margin was never modelled.** Under destination charges the
   platform keeps $0.27 per unit, not $0.89. At $0.27 the business does not exist:
   the fee floor of $0.60 is below the card fee at any realistic price, so every
   low-ticket deal runs at a platform loss.

The PRD's own risk table said "Stripe fees land on platform, killing margin →
verify in test mode at M2; block launch if wrong." It was right to worry. The
recommended fix was the wrong lever.

### 2.3 Why the shipped tests could not catch this

`minViablePrice`, `evaluateDeal` and `buildDealView` all take `stripePct` and
`stripeFixedCents` as injected constants and assume the **merchant** bears them.
Every test asserts the module against those constants. Nothing in the suite
asserts the constants against the charge model, because the charge model did not
exist in Sprint 1.

That is why Sprint 2 ships `src/lib/payments/fee-bearer.ts` (§3): the assumption
becomes a typed, tested function instead of an implicit belief.

## 3. Consequences

### 3.1 What this buys

- Guardrail arithmetic, panel copy, and frozen fixtures are all correct **as
  shipped**. No change to `src/lib/guardrail/` and no change to any expected
  figure.
- GroupEat's revenue is the `application_fee_amount`, gross of fees. $0.89 on
  vector A, not $0.27.
- The merchant is the business of record, which is also what the terms of service
  and the food-safety posture require (§15.2: "Terms state merchant is the
  seller").

### 3.2 What this costs

| Cost | Detail | Mitigation |
|---|---|---|
| Platform visibility | PaymentIntents live on the connected account, not ours. Every read needs a `Stripe-Account` header. | One `paymentClient(accountId)` helper; no raw `stripe` import outside `lib/payments/`. |
| Reconciliation | Balance transactions are per-account. Summing platform revenue means summing application fees. | `LedgerEntry` is already the source of truth (M5); it records `platformFeeCents` per participant. |
| Disputes | Chargebacks land on the connected account, so the merchant handles evidence. | Correct for us: we are not the seller of record. Documented in merchant onboarding. |
| `application_fee_amount` is async by default | ApplicationFee object may not exist at charge time. | Never read `application_fee` from the charge response. Ledger writes use our own computed fee. |
| Refund plumbing | Application fees are **not** auto-refunded. A full refund that returns the fee needs `refund_application_fee=true`. | M5/M8 refund path must pass it explicitly. Table row added to M5 scope. |
| Onboarding friction | Connected accounts need a payments capability; Express accounts qualify. | Express onboarding (FR-102), unchanged. |

### 3.3 Rejected alternatives

| Option | Why rejected |
|---|---|
| **Destination charge + `on_behalf_of`** (the PRD's answer) | Platform pays Stripe; merchant keeps $0.62/plate more than the panel says; platform nets $0.27. Requires rewriting every frozen figure to match a worse business. |
| **Destination charge + gross-up the fee into `application_fee_amount`** | Works arithmetically (platform fee = 8% + card fee), but then the merchant-facing sentence "you keep $4.01 after ... card fees and our fee" is describing two charges where the merchant sees one, and the panel's `platformFeeCents` row would have to absorb a cost that is not ours. Two numbers wearing one name — exactly the defect class `CONTRIBUTING.md` exists to prevent. |
| **Separate charges and transfers** | More control, more moving parts, and the platform still funds the Stripe fee. Buys nothing here. |
| **Destination charge, platform absorbs the gap** | Platform nets $0.27/unit. At the $0.60 fee floor that is a loss on every low-ticket drop. Not a business. |

## 4. The test that must pass before this is "accepted"

This ADR is **Accepted pending confirmation**, because the claim "the connected
account bears the Stripe fee on a direct charge" is read from documentation, not
observed. Documentation has been wrong once already in this project.

The confirming test is `src/lib/payments/__tests__/fee-bearer.test.ts` against
Stripe test mode:

1. Create an Express connected account in test mode.
2. Create a $11.12 direct charge with `application_fee_amount = 89`.
3. Fetch the **connected account's** balance transaction for the charge.
4. Assert `fee` is non-zero and equals the card fee, and that the connected
   account's net is `1112 − 62 − 89 = 961`.
5. Assert the **platform's** balance shows `+89` and no card fee.

If step 4 fails — if the platform balance carries the card fee — then the
guardrail's `$4.01` is wrong for our actual charge model, and the correct
response is **not** to change the charge model but to re-run the vectors with the
platform as fee bearer and accept that the business needs a higher take rate.
That is a product decision, and this ADR returns to Proposed.

**Why the test is written but not yet green:** no Stripe test-mode keys are
present in this environment (`.env` has no `STRIPE_SECRET_KEY`). The suite skips
with a named reason rather than silently passing, so a green run cannot be
mistaken for a confirmed decision.

## 5. Related field naming

`DealView.breakdown.cardFeeCents` stays named as it is. It is not "our cost" — it
is the merchant's cost, and under a direct charge the merchant pays it. The name
is now accurate rather than merely conventional.

`platformFeeCents` is GroupEat's revenue, gross. The platform's own card-fee
exposure under this model is **zero**, which is why no platform-side margin
figure appears in the guardrail and why `CONTRIBUTING.md`'s fee-inclusive /
fee-exclusive rule continues to describe the merchant's numbers only.
