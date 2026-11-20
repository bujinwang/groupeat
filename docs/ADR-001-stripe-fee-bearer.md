# ADR-001 — Stripe fee bearer (D-1)

**Status:** Accepted — fee bearer confirmed 2026-11-07 (ch_3UZF9m…); §4.2 calibration OPEN
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

**Dated correction — 2026-11-07 (third, ruling D2):** the paragraph above is
historical. The claim is now observed, and the status is **split** — bearer
confirmed, §4.2 calibration OPEN. See the third dated correction at the end of
this section.

### 4.0 One PRD sentence still contradicts this decision

`docs/PRD-v1.md` §15.2, under **Food safety / seller of record**, says:

> Terms state merchant is the seller; **Stripe destination charge supports this**

That sentence assumes destination charges. It is not a fee-bearer claim — it is
about who is legally the seller, and destination charges are indeed one way to
express "the merchant is the seller" to Stripe. But it is the one remaining place
in the PRD that names a charge model, and a future reader comparing the PRD with
this ADR would reasonably conclude the code is wrong.

**Resolution:** the seller-of-record requirement is satisfied by a direct charge
on a connected account *at least as well* — the connected account is the
merchant of record, the charge is created on their account, and the funds never
pass through the platform. What the PRD needs is not the phrase "destination
charge" but the statement that the **merchant is the seller of record**, which
both models can satisfy. `PRD-v1.md` is a frozen requirements document and is not
edited retroactively; this note is where the divergence is recorded until the
next PRD revision replaces that cell.

**Why it matters beyond wording:** if a future change moved the product to
destination charges for a reason that seemed unrelated (payout timing, say), the
guardrail's fee arithmetic would silently become wrong for the merchant, because
the platform would begin bearing the card fee. The frozen snapshots would keep
reporting the old model's numbers. See §4.1.

### 4.1 The fee constants are now frozen into published drops

Introduced by M3 slice 2 (`Drop.guardrailSnapshot`). The snapshot records the fee
constants in force at publish — `platformFeePct`, `platformFeeFloorCents`,
`platformFeeCapCents`, `stripePct`, `stripeFixedCents` — so a report can always
reproduce the figure the merchant was shown.

The consequence is that **this ADR's uncertainty is now durable**. While the
decision is "accepted pending confirmation", every published drop freezes an
assumption that is *probably* right. If §4's test later fails, the correction is
not a code change: it is a `version` bump in `guardrailSnapshot` plus a decision
about what to do with drops already published under `version: 1`. Those drops are
not retroactively wrong — they record what was believed and agreed at the time —
but their figures will not match a recomputation under the corrected model, and
the reconciliation job must not treat that as a discrepancy.

This is why §4's test should run **before** the first real drop, not before the
first release.

**Dated correction — 2026-11-07 (third):** the uncertainty above is now split.
The **bearer** half is confirmed (see the third dated correction at the end of
§4); the **calibration** half (B) stays open. Published drops frozen at
`SNAPSHOT_VERSION=1` **stand**: their figures record what was agreed at publish
time and are not retroactively wrong, and the reconciliation job must **not**
flag the 9¢ gap as a discrepancy. As §4.1 itself requires, changing the constants
needs a `guardrailSnapshot` version bump plus a product decision; none has
happened. §4.1's frozen constants govern the (B) calibration question, **not**
charge-model topology — (B) must not gate the money-seam proof.

The confirming test is `src/lib/payments/__tests__/fee-bearer.test.ts` against
Stripe test mode:

1. Create an Express connected account in test mode.
2. Create a $11.12 direct charge with `application_fee_amount = 89`.
3. Fetch the **connected account's** balance transaction for the charge.
4. Assert `fee` is non-zero and equals the card fee, and that the connected
   account's net is `1112 − 62 − 89 = 961`.
5. Assert the **platform's** balance shows `+89` and no card fee.

**Dated correction — 2026-11-07 (third):** the five steps above are kept as the
original, **internally inconsistent** specification. Step 4 demands `fee === 62`
while the same step demands `net === 961`, but on a direct charge Stripe defines
`fee = Σ fee_details` and `net = amount − fee`; both cannot hold. The 62/961
numbers are §2.1's **frozen guardrail vectors**, not Stripe measurements. The
restated (qualitative) test is in the third dated correction below, and 62/961
are NOT asserted there.

If step 4 fails — if the platform balance carries the card fee — then the
guardrail's `$4.01` is wrong for our actual charge model, and the correct
response is **not** to change the charge model but to re-run the vectors with the
platform as fee bearer and accept that the business needs a higher take rate.
That is a product decision, and this ADR returns to Proposed.

**Why the test is written but not yet green:** the connected account's **net balance has
never been read after a capture**, so the fee bearer is still inferred from documentation,
not observed. **Dated correction — 2026-11-07:** the reason originally written here —
"no Stripe test-mode keys in `.env`" — is stale. A test-mode `STRIPE_SECRET_KEY` now exists,
and `scripts/verify-stripe.ts` captured and refunded a direct charge three times, but it
reversed the 89¢ `application_fee_amount` and never queried the connected account's balance
transactions. Reversing an application fee is not the same measurement as §4's step 4. The
suite is now explicitly opt-in (`RUN_STRIPE_LIVE_TESTS=1`) and still skips with a named
reason, so a green run cannot be mistaken for a confirmed decision. This ADR therefore
remains **Accepted, pending live test-mode confirmation**.

**Dated correction — 2026-11-07 (third):** the final sentence above is historical.
The net balance *has* since been read in three stamped runs (one RED, two green);
see the third dated correction below for the split ruling that supersedes the
pending status **for the bearer only**.

**Dated correction — 2026-11-07 (second measurement): §4 was finally measured, and it is
RED.** The paragraph above is kept as the historical record of why the net had not been
read; its first sentence no longer describes the repository. The §4 measurement was ported
into `scripts/verify-stripe.ts` (the single source of truth — the blocked
`fee-bearer.live.test.ts` cannot run here because it creates a throwaway Express account
and plain `vitest run` lacks `--conditions=react-server`). It runs after capture and
before the refund. A stamped live run using the existing connected account
`acct_1UYwu06TRDhMU3fu` is in `/tmp/stripe_feearer_stamped.log`; its literal last line is
`LIVE_EXIT=1`, not `LIVE_EXIT=0`.

Measured on charge `ch_3UZEji6TRDhMU3fu1H6e1jy7`:

| Field | Measured | §4 expected |
|---|---|---|
| connected balance txn `txn_3UZEji6TRDhMU3fu1zuElLOq` `type` | `charge` | — |
| `amount` | **1112** | 1112 |
| `fee` | **160** | 62 ("the card fee") |
| `net` | **952** | 961 |
| `fee_details` | `[{amount: 89, type: "application_fee", application: ca_…, currency: "cad", description: "Autobebe Systems Ltd. sandbox application fee"}, {amount: 71, type: "stripe_fee", application: null, currency: "cad", description: "Stripe processing fees"}]` | a 62¢ `stripe_fee` |
| platform `applicationFees.retrieve(fee_1UZEjl6TRDhMU3fuIanAcktm)` | `amount=89`, `amount_refunded=0`, `account=acct_1UYwu06TRDhMU3fu`, `charge=ch_3UZEji6TRDhMU3fu1H6e1jy7` | +89, this run's charge |
| platform fee balance txn `txn_1UZEjm6TRDmxPEEvvoziWY7W` | `type=application_fee`, `amount=89`, `fee=0`, `net=89`, `fee_details=[]` | +89, **no** card fee |
| `settleCharge({ chargedCents: 1112, platformFeeCents: 89, cardFeeCents: 62, model: 'DIRECT' })` | `merchantGrossCents=961`, `platformNetCents=89`, `cardFeeBearer=MERCHANT` | `merchantGrossCents === net` |
| same call with the **measured** `cardFeeCents: 71` | `merchantGrossCents=952`, `platformNetCents=89` | — |

**Reading, stated honestly.** §1's *direction* was observed: the connected account's balance
transaction carries the `stripe_fee` (71¢) and the `application_fee` (89¢), while the
platform's application-fee balance transaction carries `fee=0` and an empty `fee_details`.
No card fee landed against the platform, and the platform collected exactly +89. But §4's
**test as written did not pass**: Stripe's actual test-mode card fee on this account is
**71¢, not the guardrail's 62¢**; `fee` is **160¢ (89 + 71), not 62¢**; and the connected
net is **952¢, not 961¢**. `settleCharge` reproduces the measured net only when fed the
measured card fee. The 62¢ is `cardFeeAt(1112)` — a guardrail modelling constant, not
Stripe's measured fee — so §2.1's vectors and the merchant-facing contribution are 9¢ off
against this test-mode account. The charge was still refunded
(`re_3UZEji6TRDhMU3fu1JpQk2BT`, 89¢ reversed) before the script failed.

This ADR therefore **remains Accepted, pending live test-mode confirmation**. The fee bearer
was measured, but the §4 confirming test is red and its numeric vectors are unconfirmed;
**do not cite this run as a confirmation of §4**. The lead owns the decision about whether
§1's observed direction alone is enough to retire the pending status.

**Dated correction — 2026-11-07 (third):** the "remains pending" conclusion just
above was superseded by the architect's ruling below. The RED run was a **spec
defect**, not a code defect, and is preserved unchanged as the record that
exposed it.

**Third dated correction — 2026-11-07 (Gao's ruling, D1/D2/D3/D5): §4 restated, status split.**

§4 as written was **internally inconsistent**. On a direct charge Stripe defines
`fee = Σ fee_details` and `net = amount − fee`; the original steps 4–5 asked for
`fee === 62` **and** `net === 1112 − 62 − 89 = 961` on the same transaction. Both
cannot hold. The 62¢ comes from `cardFeeAt(1112)` — a **frozen §2.1 guardrail
constant** (domestic 2.9% + 30¢: `0.029×1112+30 = 62.248 → 62`), not from Stripe.
§2.1's `$4.01 / $9.61 / $0.89` vectors derive from those frozen constants, not
from a measured charge; they are the *quantitative* half of the decision and are
**not retired** by this correction.

**§4 restated — the test that confirms the bearer (qualitative only):**

1. Create a $11.12 direct charge with `application_fee_amount = 89` on a connected account.
2. Fetch the **connected account's** balance transaction for that charge.
3. Assert `amount=1112`; `fee !== 0`; `stripe_fee > 0`; `application_fee = 89`;
   `fee === stripe_fee + application_fee`; `net === amount − fee`.
4. Assert the **platform's** application fee `amount=89`, `amount_refunded=0`,
   matching charge/account, and its balance txn `fee === 0`, no `stripe_fee`,
   `net=89`.
5. Assert `settleCharge({ chargedCents: 1112, platformFeeCents: 89,
   cardFeeCents: <MEASURED stripe_fee>, model: 'DIRECT' })` yields
   `merchantGrossCents === net`, `platformNetCents === 89`,
   `cardFeeBearer === 'MERCHANT'`. **Never** feed the frozen 62¢ here.

**Status split (D2).** §4's pending covered ONE claim — "the connected account
bears the Stripe fee … not observed". Both halves of that claim are now observed.
The pending status is therefore retired **for the bearer only**:
`Accepted — fee bearer confirmed 2026-11-07 (ch_3UZF9m…); §4.2 calibration OPEN`.
§4.1's frozen constants at `SNAPSHOT_VERSION=1` govern the (B) calibration half,
**not** charge-model topology; (B) must not gate the money-seam proof.

**All three runs are evidence and all are recorded.** The first
(`/tmp/stripe_feearer_stamped.log`, `LIVE_EXIT=1`, charge
`ch_3UZEji6TRDhMU3fu1H6e1jy7`) is preserved unchanged: the honest record of the
FAILED measurement that exposed the spec defect. Its own banner says "do not cite
this run as a confirmation", so the status line does **not** cite it. The second
(`/tmp/stripe_feearer_final.log`, `LIVE_EXIT=0`, charge
`ch_3UZF9m6TRDhMU3fu1TYUh3ST`) runs the restated qualitative test with a fresh
UUID nonce on the existing account `acct_1UYwu06TRDhMU3fu`, and is the standing
proof for the bearer — that is the charge the status line cites. A third stamped
run (`/tmp/stripe_feearer_lead.log`, `LIVE_EXIT=0`, charge
`ch_3UZFJl6TRDhMU3fu0T3wIy8S`) was produced by the lead as an independent
reproduction: same `amount=1112 / fee=160 / net=952`, `stripe_fee=71` and
`application_fee=89` shape. It changes no conclusion.

Measured (first run, `ch_3UZEji6TRDhMU3fu1H6e1jy7`; the second and third
re-measure the same shape):

| Field | Measured |
|---|---|
| connected txn `amount` / `fee` / `net` | `1112` / `160` / `952` |
| `fee_details` | `application_fee=89`, `stripe_fee=71` |
| platform application fee | `+89`, `amount_refunded=0`, correct charge/account |
| platform fee balance txn | `amount=89`, `fee=0`, `net=89`, `fee_details=[]` |
| `settleCharge(DIRECT, cardFee=<measured>)` | `merchantGrossCents=952 === net`, `platformNetCents=89`, `cardFeeBearer=MERCHANT` |

The connected account bears the `stripe_fee`; the platform bears **none** of it
and collects exactly +89. `settleCharge` reproduces `net` when fed the measured
card fee. **Bearer confirmed; 62/961 vectors unconfirmed.**

**D3 — no constant changes.** `DEFAULT_FEES`, `cardFeeAt`, `SNAPSHOT_VERSION=1`
and §2.1's vectors are unchanged. `0.029×1112+30 = 62.248 → 62` is the standard
domestic 2.9% + 30¢ base, **not an error**. The measured 71¢ (62 + 9) on all
three runs is *consistent with* a cross-border surcharge — **a HYPOTHESIS, not a
fact**.
§4.1 requires a `guardrailSnapshot` version bump plus a product decision before
any constant changes. (B) stays OPEN. **Version-1 drops stand**: they record what
was believed and agreed at publish time and are not retroactively wrong; the
reconciliation job must **not** flag the 9¢ as a discrepancy.

**Risks recorded, not resolved.**

- (B) needs a domestic-CA **multi-card** re-measurement before any constant
  change, followed by the §4.1 version bump and a product call.
- The bearer is proven on three CAD charges against **ONE connected account**
  with the same test card — not a multi-card or multi-account sample; re-verify
  at M2 (Connect onboarding).
- The 9¢ surcharge explanation is a hypothesis; no conclusion about fee tables.
- The corrected `fee-bearer.live.test.ts` now mirrors D1's assertions but stays
  **UNEXECUTED** (Connect + react-server blockers, `RUN_STRIPE_LIVE_TESTS=1`
  gate). `scripts/verify-stripe.ts` is the single standing proof.

### 4.2 Quantitative calibration — OPEN

This subsection is the referent for the `§4.2 calibration OPEN` half of the
status line. The restated §4 test above confirms only the **qualitative bearer**;
the quantitative half is deliberately **not** retired:

- `cardFeeAt(1112) = 62¢` (§2.1's frozen domestic 2.9% + 30¢ base) was not
  reproduced by Stripe test mode: the measured `stripe_fee` on all three
  2026-11-07 CAD charges was 71¢, a +9¢ divergence. §2.1's
  `$4.01 / $9.61 / $0.89` vectors and the 62/961 figures derive from those
  frozen constants, not from a measured charge.
- A domestic-CA **multi-card** re-measurement is required before any constant
  change. Per §4.1, changing `DEFAULT_FEES`, `cardFeeAt` or `SNAPSHOT_VERSION`
  also needs a `guardrailSnapshot` version bump and an explicit product decision;
  none has happened. Version-1 drops stand, and the reconciliation job must
  **not** flag the 9¢ as a discrepancy.
- The 9¢ gap is *consistent with* a cross-border surcharge — a **hypothesis,
  not a fact**. No conclusion about Stripe's fee tables is drawn here.

`scripts/verify-stripe.ts` prints the divergence as INFO only: it is never an
assertion and never fed to `settleCharge()`. The corrected
`fee-bearer.live.test.ts` mirrors the qualitative assertions but remains an
unexecuted, opt-in record. Re-verify the bearer at M2 (Connect onboarding).

## 5. Related field naming

`DealView.breakdown.cardFeeCents` stays named as it is. It is not "our cost" — it
is the merchant's cost, and under a direct charge the merchant pays it. The name
is now accurate rather than merely conventional.

`platformFeeCents` is GroupEat's revenue, gross. The platform's own card-fee
exposure under this model is **zero**, which is why no platform-side margin
figure appears in the guardrail and why `CONTRIBUTING.md`'s fee-inclusive /
fee-exclusive rule continues to describe the merchant's numbers only.
