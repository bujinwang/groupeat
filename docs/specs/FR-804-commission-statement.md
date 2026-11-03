# FR-804 — Commission statement (incremental spec)

`FR-804 | Commission statement: units × 5% of captured GMV | Monthly, exportable` — PRD-v1.md:539. Scope: compute and display the number. A human pays by e-transfer. **No money moves** (§3.3).

## The decision

Commission is `commissionPct` (default 5%) of **net captured GMV** — what the restaurant actually kept — on orders attributed to the organiser's `ShareLink`. A refunded diner earns no commission, in whole or in part: the base is `subtotalCents − refundedCents`, not `subtotalCents`. The month is the calendar month in which the money was **captured** (`Order.createdAt`), evaluated in `America/Edmonton`. "Exportable" means a CSV download of the same aggregate rows the organiser sees on screen. The statement is a read-only query: no payout table, no job, no write path.

## The formula

Attribution grain is one `ShareLink` row = one (drop, organiser) pair, already enforced by `@@unique([dropId, organiserId])`.

```
lines(organiser, period) =
  { sl ∈ ShareLink : sl.organiserId = organiser.id
      ∧ ∃ od ∈ Order : od.participant.shareLinkId = sl.id
                     ∧ od.createdAt ∈ [period.from, period.to) }

per line:  grossCents = Σ od.subtotalCents      refundedCents = Σ od.refundedCents
           netCents = grossCents − refundedCents    units = Σ od.qty
           commissionCents = roundHalfUp(netCents × bp / 10000)
                             bp = integer basis points of commissionPct (5.00 → 500)

total:     commissionCents = Σ over lines of commissionCents   // sum the rounded lines
```

Three ways to get this wrong, all silent:

- **Walk `Order → DropParticipant.shareLinkId → ShareLink`.** Not `Order.dropId = ShareLink.dropId`: a drop has one `ShareLink` per organiser, so joining on `dropId` attributes every participant to every organiser who ever shared it.
- **`Order` is the unit of money, not `DropParticipant`.** A participant may have no `Order` at all (authorised, never captured), so every aggregate must **start from `Order`** — starting from `DropParticipant` counts money that was never taken. `shareLinkId IS NULL` belongs to nobody.
- **Rounding.** `roundHalfUp` (`src/lib/guardrail/money.ts`) is the codebase's only rounding point; reuse it, never `Math.round`/`toFixed`. Integer cents and integer basis points (`Decimal(5,2)` → bp is exact).

**"units × 5% of captured GMV" is dimensionally wrong read literally** (units × 5% × GMV); GMV already contains the units. It means *5% of captured GMV*, and `units` is a display column.

**"captured GMV" as gross is wrong.** A force-failed drop captures then refunds everyone (FR-502/FR-902), so gross pays the organiser for a drop that never happened and that the restaurant earned nothing on; §3.3 ties the incentive to what the link *sold*. Decisive corroboration: the ledger already defines the truthful "what we actually hold" figure as net — `src/lib/settlement/ledger.ts` L1 is `charged − refunded == Σ (order.subtotalCents − order.refundedCents)`, and L4 asserts per order that `refunded == order.refundedCents`. The system's authority on money therefore treats `subtotalCents − refundedCents` as the number, on every settlement. Commission reading gross would be the only place in the codebase that disagrees with the ledger. (`Order.subtotalCents` is copied from `DropParticipant.amountCents` by `settle.ts` at capture, so it is exactly what Stripe took — gross-of-refunds is genuinely "captured", just not "kept".)

Per-order `netCents` cannot go negative — `refundedCents` accumulates via `{ increment }`, `assertRefundAmount` refuses more than `subtotalCents`, `issueParticipantRefund` refuses a second refund — so assert `0 ≤ refundedCents ≤ subtotalCents` and fail loudly. A clamp would hide a ledger defect.

## Period definition

Key: `Order.createdAt`, `America/Edmonton`, half-open `[from, to)`.

- **Not `ShareLink.createdAt`** — a one-time event unrelated to any money; a link created on the 28th for a drop selling on the 3rd pays the wrong month.
- **Not `Drop.cutoffAt` / `Drop.windowEnd`** — scheduled instants, not events. A refund can land in a later month than the window and then has no month to belong to: the gross-captured defect one level down.
- **`Order.createdAt`** is the instant the number being taxed at 5% came into existence — the only candidate causally identical to the money.

Timezone: one constant, `COMMISSION_PERIOD_TZ = 'America/Edmonton'` — **not** `Merchant.timezone`. The period belongs to the organiser and `OrganiserProfile` has no timezone column; per-merchant zones would make one organiser's "March" a union of windows no single `[from, to)` pair can express, so the CSV and the query could not be proven equal. `Merchant.timezone` already defaults to Edmonton and §1.3 defines the corridor as one zone. If a merchant outside Mountain Time ever onboards, this constant is the line to revisit.

Build the boundary with `Intl.DateTimeFormat`/`formatToParts`, **never** `new Date(y, m, 1)`: the server runs UTC, so `new Date(2026, 2, 1)` is `2026-03-01T00:00Z` = `2026-02-28T17:00` in Edmonton — seven hours of orders silently move into the previous month.

**Refunds restate.** `Order` stores cumulative `refundedCents`, not a refund timestamp, so a refund arriving after a month was paid cannot be attributed to its own month without a new column. Decision: the statement is a **live query, not a frozen document**. Re-render March after an April refund and March changes. Ops export at the moment of payment. The `refunded_cents` column exists so a changed figure is explainable instead of mysterious.

## Export

CSV, `text/csv; charset=utf-8`, `groupeat-commission-{organiserSlug}-{YYYY-MM}.csv`, from `GET /api/organiser/commission?month=YYYY-MM&format=csv`. PRD-v1.md:875 declares that path **with no query parameters**, so `?month=` and `?format=csv` are this spec's addition and the parameter shape is *not* frozen by the PRD; do not cite §12 as evidence that it is. A plain `<a download>` — no account, no email, no job. The CSV is a **serialisation of the table, not a transaction export**: a per-order CSV would be a participant-level document by another name. ASCII only; integers authoritative. Columns: `merchant`, `drop`, `pickup_date`, `units`, `gross_captured_cents`, `refunded_cents`, `net_captured_cents`, `commission_pct`, `commission_cents`, `commission_dollars` (`0.00`, no symbol, no separator), `drop_status`.

Admin variant `GET /api/admin/commission?month=YYYY-MM`: one row per organiser for the whole month, adding `organiser_name`, `organiser_email` — the human doing e-transfers works from one file, not fifteen. Same query, organiser filter omitted. **P1**; the organiser's own CSV is P0.

## Statement contents

One row per line (per `ShareLink`). **Presence is decided by activity, not by money:** a link nobody joined is omitted as noise, but a link whose orders netted `$0.00` (a force-failed drop) **must** appear — the organiser worked that drop and should read why it paid nothing rather than open a support ticket.

| Field | Source | Rule |
|---|---|---|
| `merchant` | `ShareLink.drop.merchant.name` | string |
| `drop` | `Drop.title` | string |
| `pickup_date` | `Drop.windowStart` | date in `Merchant.timezone`; display only, never the period key |
| `units` | `Σ Order.qty` | captured units; a fully refunded line still shows them |
| `gross_captured_cents` | `Σ Order.subtotalCents` | integer |
| `refunded_cents` | `Σ Order.refundedCents` | integer; shown so restatement is legible |
| `net_captured_cents` | gross − refunded | integer ≥ 0 |
| `commission_pct` | `OrganiserProfile.commissionPct` | `5.00`, two decimals |
| `commission_cents` | `roundHalfUp(net × bp / 10000)` | integer; the number ops pays |
| `drop_status` | `Drop.status` | lets `FAILED` + `$0.00` explain itself |
| totals row | `Σ` of each money column and of `commission_cents` | sum the rounded lines |

## Privacy boundary (FR-805)

P0: aggregate counts only, never participant PII. Enforced **structurally**, the way `ShareableDropRow` already does it — the row type must have no field capable of holding the following, so there is no projection to get wrong.

- **Never, in any form:** `Customer.phone` (E.164 *or* last four *or* masked), `Customer.email`, `Customer.name`, `Customer.id`, `DropParticipant.id`, `paymentIntentId`, `stripeChargeId`, `redemptionCode`, `Order.id`. No per-order or per-participant rows, on screen or in the CSV. "2 people called J." is PII.
- **Also excluded: other organisers' figures.** No drop-level totals, no "your share of the drop", no ranking. An organiser seeing "drop total 40 units" beside "your line 12 units" has learned a competitor sold 28. Not an FR-805 violation — it is not PII — but the same competitive sensitivity and the same one-line fix.
- **Permitted:** their own aggregate units, GMV and commission, plus the merchant and drop names they already saw.
- The test asserts the serialised row *and the CSV bytes* contain neither the phone nor its last four digits — because "the type has no field for it" stops being true the first time someone adds one for a good reason.

## Acceptance criteria

1. Captured `$24.00`, refunded `$6.00` → net `1800`; at 5.00% the line commission is `90` (`$0.90`).
2. **Force-fail.** 20 × `$24.00` = `48000` captured, all refunded → `gross 48000`, `refunded 48000`, `net 0`, `commission 0`. A gross-based implementation pays `2400` for a drop that never happened.
3. **Partial refund, one diner (FR-903).** 10 × `$24.00` captured, one refunded `$6.00` → `net 23400`, commission `1170` (`$11.70`), not `1200`.
4. **Half-up, not half-even, not truncate.** Net `1810` at 5.00% = `90.5` → `91`; net `10` = `0.5` → `1`; net `9` = `0.45` → `0`.
5. **Sum the rounded lines.** Two lines each netting `1810` → `91 + 91 = 182`. Rounding the summed base gives `181`. The printed total must equal the column sum a human gets in a spreadsheet.
6. **Month boundary in Edmonton.** `createdAt = 2026-03-01T06:30:00Z` is `2026-02-28 23:30` MST → **February**. A UTC-naive filter says March. (DST 2026 starts 03-08, so 03-01 is still UTC−7.)
7. **Attribution.** 30 joins on a drop, 20 carrying this organiser's `shareLinkId` → the statement counts 20. `shareLinkId IS NULL` counts for nobody; a participant with no `Order` contributes `0` units and `0` cents.
8. **Cross-attribution.** Two organisers share one drop, 12 and 8 participants. Each statement shows only its own 12 or 8; neither total is 20.
9. **Zero-activity vs zero-value.** A `ShareLink` with no participants is absent; one whose orders netted `0` is present with `commission 0`.
10. **Privacy.** The serialised row and the CSV bytes contain no E.164 phone, no phone last four, no customer email, no customer name.
11. **Purity.** The same organiser and month rendered twice, with no intervening refund, return byte-identical figures — no `new Date()` may leak into the period.
12. **No writes.** Rendering the statement and downloading the CSV write zero rows to `Order`, `LedgerEntry`, `Drop` or `AuditLog`.

## Decisions (ruled by the delivery director)

1. **No `CommissionPayout` table; the statement stays a live query.** No schema change, no migration. A payout table is the first brick of a payouts system, and we would be building it for 5–15 organisers who are paid by e-transfer from a spreadsheet — PRD-v1 §3.3: *"do not build automated organiser payouts in V1."* The mitigation is a **UI obligation, not a data one**: the page must say in words that the figure is current-as-of-now and that a refund landing later restates a closed month. An operator must not be able to believe a March statement is frozen; "it silently restated" is exactly the class of defect this project keeps finding.
2. **A rate change takes effect for the whole month in which it is set; ops do not change rates mid-month.** No column, no history table. The honest consequence, stated rather than implied: a mid-month change restates that month, the figure stops being reproducible after the edit, and **the export taken at payment time is the record**. That is acceptable *because of* decision 1 — with no frozen document, a frozen rate would be false comfort.
3. **CAD throughout.** Integer cents, no currency column, `formatCents` prints `$`. `Order.qty` is the units source, not `DropParticipant.qty` (written equal, and `Order` is the money row).

Decisions 1 and 2 are one position, not two shortcuts: **nothing here is frozen, so nothing pretends to be.** The statement is a snapshot of a live number, the CSV is the record, and the words on the page have to say so.
