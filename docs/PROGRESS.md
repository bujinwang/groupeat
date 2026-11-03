# GroupEat — progress

> **Audited:** 2026-11-03 10:05 CST · **Branch:** `sprint-2/payments-fee-bearer`
> · **HEAD:** `git log -1` · **Tree:** `git status`
> · **Ahead/behind:** `git rev-list --left-right --count master...HEAD`
> This file is the status board. Update it in the same commit as the slice it describes.
>
> The ahead-count is deliberately not written here. It was a literal, and it was
> wrong three commits running — it drifts the instant the commit that updates this
> file is created, and a hand-maintained number that is wrong teaches readers to
> distrust the numbers that are right. Run the command.

## Status at a glance

| Milestone | Status | Evidence / gap |
|---|---|---|
| **M0 — Foundations** | ✅ | Auth, roles, admin shell, schema, seed, env validation. |
| **M1 — Guardrail** | ✅ | Pure module, test vectors, fuzz, snapshot, purity guards. |
| **M2 — Merchant + items + Connect** | 🟡 | CRUD and the Connect onboarding state machine exist (`src/lib/payments/`). Live `charges_enabled` **never verified** — no Stripe key. |
| **M3 — Drop creation + AI** | ✅ | `plan.ts`, ADR-002, interview, copy lint, publish gate, frozen snapshot. **FR-208 (merchant cancel) landed later**, in its own slice — the last gap in drop lifecycle. |
| **M4 — Public page + join** | 🟡 | Slice 1 (FR-301…308) shipped at `fe47cbf`. **Slice 2a (FR-401…407 domain + API)** at `f3982ed`. **Slice 2b (the join page, `/intent` endpoint) shipped keyless** — the page exists and is tested, but no card has ever been held. **Slice 2c (diner order page, `/d/:code/mine`, the still-filling emitter)**. **Slice 2d (the confirmation link + the one wire type)** — see below. |
| **M5 — Cutoff + capture** | 🟡 | Code and tests for FR-501…505, 507 at `9f3ea4f`. **The pickup-window transition landed** (`pickup-window.ts`, tick phase 5) — before it, no drop could ever become collectable. FR-506 is a no-op seam, but the charged intent now carries a working order link built from `APP_URL`. Live capture never run against Stripe. |
| **M6 — Redemption** | 🟡 | Scanner, manifest, idempotent redeem (FR-601…605). The diner-facing code page now exists (2c). FR-606 deferred (optional V1.1). |
| **M7 — Reporting + organiser** | 🟡 | **FR-901 landed: `/admin/drops`**, the first M7 artefact and the first screen to render FR-902's double confirmation. **FR-903 is now reachable**: `/admin/drops/[id]` lists participants and issues per-diner refunds, which the endpoint could not do alone. **FR-905 landed**: `/admin/ai-drafts` and one run in full, reachable from the merchant page — the table `persistAuditRow` has been writing since M3, read for the first time. **FR-906 landed**: creating an organiser now creates its `OrganiserProfile` in the same transaction, and `/admin/users` lists organisers with their commissions plus a repair path for accounts made before the fix. **FR-801/802/805 landed**: `/organiser` lists live drops and hands over a tracked share link in two taps, with `DropParticipant.shareLinkId` now written. **FR-804 landed**: `/commission` states each organiser's monthly commission — 5% of what the restaurant *kept*, net of refunds — with a CSV export, and the tz database the month boundary depends on is now pinned. **Gap 15 closed**: merchant onboarding is the single transaction it always claimed to be, and `slugify` no longer splits accented names. **Gap 17 closed**: `/admin/commission` and `GET /api/admin/commission` give the e-transfer run one file for the whole roster, built as a roll-up of the organiser statements rather than a second implementation of the arithmetic. **Gap 18 closed**: the organiser role now has its full declared API surface — `GET /api/organiser/drops` and `POST /api/organiser/drops/:id/share` — with the route and the server action proved to return the same token, the same URL and the same message, in both orders. M7 is complete except `likelyFill` ranking (gap 16). |
| **M8 — Beta hardening** | ✅ | All three requirements shipped: **FR-902** (force-fail and refund all) with the `AuditLog` model it needed, **FR-903** (partial refund) with the ledger fix it forced, and **FR-904** (read-only impersonation) with the refresh path it nearly lost. All three were marked done while their UI obligations pointed at a screen that did not exist; FR-901 and the FR-903 detail page have since supplied it. See the M8 sections below. |

## Verified in this audit

- Full suite: **1503 tests — 1495 pass, 0 fail, 8 skip** (117 files; 116 pass, 1 skips).
  +20 for gap 12(g): `/admin/commission` rendered against real Postgres, with cell-scoped
  assertions so a name and its figure are on the same row or the test fails.
  +15 for gap 12(f): the `/commission` page rendered against real Postgres, plus the
  render harness it needed (`src/lib/testing/render.ts`) and the one vitest config line
  that lets a page file compile under esbuild.
  +115 for FR-804: 96 from the engineer (59 pure period/rounding/CSV, 21 against
  Postgres, 16 through the route) and 19 from QA's independent verification, which
  assert the same properties by construction rather than by mutating source.
  +12 for gap 15 (`createMerchantWithOwner`, `slugify`) against Postgres.
  +26 for gap 17 (13 roll-up+CSV against Postgres, 13 route end-to-end).
  +40 for gap 18 (13 list route, 23 share route, 2 for `ensureShareLink`'s `created`,
  2 for the organiser root the impersonation scan now walks).
  Run with arm64 Node: `~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run`
  **This is not optional.** The previous version of this line claimed the suite was
  green under both Node 24.21 (tzdata 2026c) and Node 22.22 (tzdata 2025c). Re-running it
  during gap 15 showed that is false: under 22.22 exactly one test fails
  (`shareMessageFor`, `Thursday 5:00 PM` vs the stale-rule `4:00 PM`). The suite is
  green on 24.21 alone. See gap 19.
- The 8 skips are all Stripe-dependent. The **contract** suite is not among them
  when `stripe-mock` is up: it then runs 6 tests against the mock, and skips 5 of
  them (with a printed reason) when the mock is down.
- `npx tsc --noEmit` — clean. `npx eslint .` — clean.
- `prisma migrate status` — 5 migrations, schema up to date; `prisma validate` — valid.
- `.next/` build artifacts exist; **no server is running** on :3001 at audit time.
- The M4.1 and M6 live checks described in their commit messages were **not**
  re-run here; they are claims in the commit log, not audit results.

## M4 — the split that matters

| FR | State | Where |
|---|---|---|
| FR-301 SSR, no login | ✅ | `src/app/d/[publicCode]/page.tsx` |
| FR-302 page fields | ✅ | same |
| FR-303 live count ≤30s | ✅ | `CountPoller.tsx`, `api/public/drops/[code]/count` |
| FR-304 honest scarcity | ✅ | `src/lib/public/drop-view.ts` |
| FR-305 threshold state | 🟡 **superseded by ADR-003**: joins continue to `maxQty`; confirm state still renders | `drop-view.ts` |
| FR-306 FAILED says nobody charged | ✅ | `drop-view.ts` |
| FR-307 closed after window | ✅ | `drop-view.ts` |
| FR-308 OG/Twitter + 1200×630 | 🟡 code and image exist; **no evidence of a real WhatsApp/WeChat device test** | `opengraph-image.tsx` |
| FR-401 qty 1..maxPerCustomer | ✅ | `join/rules.ts` (`checkQty`, `qtyLimitFor`); capped again at `MAX_JOIN_QTY = 20` |
| FR-402 phone E.164 + Payment Element | ✅ | `normalisePhone` + storage; **Payment Element now renders** in `JoinForm.tsx` against a server-quoted `clientSecret`. The `pm_…` reaches the port — see the 2b note below |
| FR-403 manual-capture PaymentIntent | 🟡 | intent created **unconfirmed** by `/intent` with `capture_method: 'manual'`, confirmed server-side by `/join`. `join/real-payment-port.ts` written and asserted at source; **never executed against Stripe** — live test skips |
| FR-404 no charge at join | ✅ | `JOIN_CAPTURE_METHOD = 'manual'` is a constant, not a parameter; tests assert no `CHARGE` ledger row and `chargeStatus = NONE` |
| FR-405 idempotency `dropId:customerId` | ✅ | `(dropId, customerId)` unique index + service behaviour; double submit and 3-way concurrent tap both produce one row and one hold |
| FR-406 race-safe sold out | ✅ | `SELECT … FOR UPDATE` on the drop row; proven — removing the lock makes one plate sell twice and a 4-plate drop sell 6 |
| FR-407 confirmation copy | ✅ | `joinConfirmationCopy`; the pre-cutoff disclosure renders **before and after** the tap from the same helper. The confirmation also links to the diner's own order (2d) |
| FR-408 confirmation SMS with consent | 🟡 | consent ✅ (`ConsentRecord`, `EXPRESS`, `drop_join`, same transaction), the checkbox exists in `JoinForm`, and the message is now **composed and wired**: `joinDrop` builds it (with the merchant's zone, the diner's amount, and a link to `/d/:code/mine`) and the route hands it to a sender. The consent gate is a parameter of `joinConfirmationMessage`, so an unticked box produces nothing. **Not delivered** — no message has reached a phone; `twilio-sender.ts` has never run against Twilio. |
| FR-506 notify ≤60s | 🟡 | Copy, composer, sender and wiring exist for all five intents, including `DROP_FAILED_NO_CHARGE` — which, until this slice, had **no production route at all** for the most common failure. **Not delivered**: no provider has been contacted. |

Hard evidence that the join flow now exists:

- `joinDrop()` writes `DropParticipant` rows: `PENDING` under the lock, then
  `AUTHORIZED` or `FAILED` after the provider answers.
- `POST /api/public/drops/[code]/join` answers 200/402/404/409/422/503 with
  finished copy; 12 route tests.
- `POST /api/public/drops/[code]/intent` (new in 2b) quotes a quantity and returns
  a `clientSecret` **without writing anything**. Read-only on purpose: `PENDING`
  rows count toward capacity, so creating a participant at quote time would let
  abandoned page views consume a drop's plates and close it out from under real
  diners. No route test yet — `quoteJoin` itself has 9.
- 107 join tests (8 files), all green. Counted by running
  `vitest run src/lib/join src/app/api/public/drops`, not by arithmetic:
  47 rules, 20 service, 12 route, 9 quote, 7 fake port, 4 purity, 4 boundary,
  4 funnel-wiring.

The bug 2b found, because it is the most useful thing in this slice:

- **With keys configured, every real join would have thrown.** The real port
  refuses an authorisation with no `paymentMethodId` — deliberately, so a keyed
  deployment could not silently create an unconfirmable intent. But `joinSchema`
  never accepted the field, so the `pm_…` was dropped at the wire and the port
  always saw `undefined`. The whole suite was green, because **a fake never needs
  a card**, and `tsc` could not see it because both fields were optional. Fixed
  in `input.ts`/`service.ts`/the route, and pinned in `service.test.ts` by
  asserting `port.calls[0].request.paymentMethodId`; verified by deleting the
  forward and watching it fail with `expected undefined to be
  'pm_card_visa_from_element'`.

Still absent, and deliberately:

- `JOIN_FLOW_PROVEN_LIVE = false` in the deal page. The page exists and is
  reachable at `/d/[publicCode]/join`, but the flag gates the *link* from the deal
  page, and flipping it before a live join has run would promise a diner a working
  card form on the strength of a fake. "The page exists" and "a card can be held"
  are different claims.
  It is **not** the only gate: `resolveJoinGate` (`src/lib/public/join-gate.ts`,
  7 tests) also requires a publishable key, and its tests pin the rule that keys
  alone cannot open the button. Two independent ways to be unready, two different
  disabled messages, because a diner can verify "this site cannot take a card" and
  cannot verify "this build was never tested against Stripe".
- No real `pm_…` has ever come from Stripe, because no key exists on this
  machine. The path is wired end to end and unexecuted.

## M4 slice 2c — the diner's own page, and the code that was never displayable

Before 2c, a redemption code was minted at capture and existed **only in the
merchant's manifest**. FR-601's scanner could verify a code the diner had never
been shown. FR-408 promised an SMS that had nothing to link to.

What 2c adds:

| Piece | File | Why it is a separate file |
|---|---|---|
| the bearer token | `lib/participant/access.ts` | separate HKDF key from the redemption code — see below |
| the three-state decision | `lib/participant/order-view.ts` | pure; every sentence the page can say is decided and tested here |
| the read | `lib/participant/order-page.ts` | one `findFirst`, scope from the token |
| the page | `app/d/[publicCode]/mine/page.tsx` | `noindex`, `no-referrer`, `no-store` |
| the link | `orderUrl()` in `order-page.ts` | rebuilt from ids, never stored |
| the emitter | `joinDrop` step 6 | ADR-003's "still filling" copy, exactly once |

**The token is not the redemption code.** The code is the food; whoever holds it
eats. Putting it in an SMS link puts it in a message archive, a browser history
and — because every drop is shared into group chats — possibly a link-preview
fetcher's logs. `access.ts` derives a **read-only** key under a different HKDF
`info`, and `access.test.ts` asserts the separation in both directions: a
redemption code does not verify as an access token, and an access token does not
satisfy the scanner. A leaked link shows a merchant name, a quantity and four
digits; it does not feed anyone.

**The bug 2c found, which is the most useful thing in this slice.** The first
draft of `order-view.ts` had its own collectable-status list,
`['CAPTURED', 'PICKUP_OPEN']`. It disagreed with `REDEEMABLE_STATUSES`
(`PICKUP_OPEN`, `COMPLETED`) in **both** directions:

- `CAPTURED` — capture happens at the cutoff, which can be the day before the
  kitchen cooks. The scanner refuses a code then, deliberately. So that draft
  would have shown a diner a code the counter rejects, on the one screen in the
  product whose entire job is to be true about money.
- `COMPLETED` — a late collector is a real conversation at a counter, and the
  scanner accepts the code. That draft would have blanked the page for them.

Fixed by importing the scanner's constant and exporting it under this module's
own name, with an identity assertion (`toBe`, not `toEqual`) so the two values
cannot become a copy of each other. Verified by deleting `dropId` from the
`where`: exactly one test fails, and it is the one written to detect that
(`refuses a token whose dropId does not match the row, when the URL is right`).
The other scope tests still passed under the mutation — their mismatch is caught
by the `publicCode` join — which is the illusion that test exists to pierce.

**The status fact this exposed:** nothing in this build moved a drop to
`PICKUP_OPEN`. `grep` found it only in status-label maps and in the void-sweep
list. So at the time of slice 2c, **no diner's page could ever show a code**,
because the status stayed `CAPTURED` until something transitioned it. The page was
right and permanently useless. (That gap is now closed — see "The drop could never
be collected" below. It turned out to be worse than "not yet useful": `redeem.ts`
reads no clock, so the missing transition also meant no diner could ever *collect*
food on any drop.)

**FR-506 / FR-408 remain 🟡.** The charged intent carries a real `orderUrl`, and
`joinDrop` emits `THRESHOLD_REACHED_STILL_FILLING` on the crossing. Neither is
delivered, because there is still no sender (D-5). "The message is composed" and
"the message arrived" are different claims.

## M5 and M6 — what exists, precisely

| FR | State | Note |
|---|---|---|
| FR-501…505, 507 | ✅ | `cutoff-decision.ts`, `settle.ts`, `ledger.ts`, `redemption-code.ts`, `/api/jobs/cutoff` |
| FR-506 notify ≤60s | 🟡 | Copy, composer, sender and wiring exist for all five intents, including `DROP_FAILED_NO_CHARGE` — which, until this slice, had **no production route at all** for the most common failure. **Not delivered**: no provider has been contacted. |
| FR-601 scan screen | 🟡 | `/merchant/pickup` + `RedeemScanner`; iOS/Android device check not recorded |
| FR-602…605 | ✅ | verify, per-unit, glanceable, idempotent double-scan |
| FR-606 offline 20 min | ⬜ | explicitly optional for V1 |

Deliberate deviations, already decided and not to be "fixed":

- ADR-003 replaces FR-305's "stop at threshold" with "continue to `maxQty`".
- ADR-002 replaces the PRD §9.2 model-authored price with server-authored numbers.
- M5 has no job table; `Drop.status` is the job (M5 design §1.2).

## FR-208 — a merchant calls off their own drop, and the ordering that makes it work

`FR-208 | Merchant can cancel a PUBLISHED drop | All auths voided; participants
notified. Reason required` — PRD-v1.md:461; endpoint at PRD-v1.md:863.

| Piece | Where |
|---|---|
| The cancellation | `src/lib/drops/cancel.ts` |
| The endpoint | `POST /api/merchant/drops/:id/cancel` |
| The confirmation UI | `src/components/drops/CancelDropButton.tsx` |
| The participant count it names | `countJoinedQty` in `src/lib/db/drops.ts` |
| The copy | `DROP_CANCELLED_NO_CHARGE`, already written by FR-902's slice |

No migration. `AuditLog.action` is a `String` column with a TypeScript union in front of
it, so `drop.cancel` cost one line in `audit/log.ts` and nothing in the schema.

### The ordering is the inverse of FR-902's, and getting it backwards fails silently

`forceFailDrop` refunds **then** writes the status, because money must be back before
anything claims it was. `cancelDrop` writes the status **then** releases the holds, and
the reason is not stylistic.

`voidRemainingAuthorisations` re-reads the drop's status on every call and refuses
anything not in `VOID_SWEEP_STATUSES`. `PUBLISHED` is deliberately absent from that list
— "nothing may be voided before the decision". So a sweep attempted before the flip
sees `PUBLISHED`, refuses, returns `{voided: 0}` and releases **nothing**, with no error
and no log line. A test asserting only "status is `CANCELLED`" would pass on a build
where every diner's money stayed held.

Mutation-probed: moving the sweep above the flip fails three tests, all on the released
count (`expected +0 to be 3`). Restoring it turns them green.

### The CAS decides the race with the cutoff tick, and the first test for it was worthless

Both writers start from `PUBLISHED`: the merchant's cancellation, and the settlement
tick that locks any published drop whose `cutoffAt` has passed. The flip is
`updateMany({where: {id, status: 'PUBLISHED'}})`, so exactly one wins — either the drop
is cancelled and never charged, or it is locked and the merchant is told the cutoff
passed. Without the status in the `where`, the cancellation would overwrite `LOCKED`
mid-capture: merchant told "cancelled", thirty diners charged.

**My first race test passed with the CAS deleted.** It moved the drop to `LOCKED`
before calling `cancelDrop`, which exercises the *pre-check* in `cancelDropRefusal` —
the function never reached the write. A green test, a dead assertion, and only the
mutation probe found it.

The real window is between `loadDrop`'s read and the flip, so
`cancel.test.ts`'s second block opens it deliberately: `prisma.drop.findFirst` is
spy-wrapped to let the tick's write land immediately after the read returns, leaving the
cancel path holding a stale `PUBLISHED` row. With the CAS the flip matches nothing and
the merchant gets a 409; without it the test fails with
`promise resolved "{ kind: 'CANCELLED' }" instead of rejecting`. There is a control case
beside it — same instrumentation, a no-op interleaved write, cancellation succeeds — so
a failure proves the status change and not the spy.

### Read-only impersonation now covers this, and the guard proved it without being asked

The route calls `requireMerchantWrite()`. Downgrading it to `requireMerchant()` fails
two tests, and the message names the file:

> `…/[id]/cancel/route.ts` exports POST but never calls `requireMerchantWrite(). An
> impersonating admin could change this merchant's data.

That is FR-904's walker firing on a file written the day after it — which is the
argument for a walking test over eleven hand-placed assertions. Cancellation is the
worst thing a borrowed session could do: irreversible, and it texts every diner.

### "Nobody was charged" is a claim the guards make true

`cancelDrop` refuses everything that is not `PUBLISHED`, so no cancellable drop has a
captured order — a merchant cannot cancel after money moved (that is FR-902's job, with
FR-902's refund loop). Every notification is therefore `DROP_CANCELLED_NO_CHARGE`, and
that sentence stays honest because of the refusal, not because of a check at the message
site. Sending "refunded" to a diner whose statement never showed a debit sends them
looking for a credit that does not exist.

### Not proven

**Nobody has clicked the button.** The service and route are tested against real
Postgres and real HTTP; the component is verified by review and `tsc`, since this repo
has no `.tsx` tests by design. Related: the `countJoinedQty` figure in the warning is a
scoped read, and a foreign drop id returns `0` — which renders as "nobody has joined
yet". That sentence is wrong, but the cancellation it describes is refused with a 404
before any money moves, so it cannot be acted on.

## M7 — FR-804, commission is what the restaurant kept

`FR-804 | Commission statement: units × 5% of captured GMV | Monthly, exportable` —
PRD-v1.md:539. Spec: `docs/specs/FR-804-commission-statement.md` (written by the PM,
107 lines, 12 numbered acceptance criteria).

| Piece | Where |
|---|---|
| Period maths, rounding, CSV (pure) | `src/lib/organisers/commission.ts` |
| The statement query | `src/lib/db/commission.ts` |
| The screen | `src/app/(organiser)/commission/page.tsx` |
| `GET /api/organiser/commission` | `src/app/api/organiser/commission/route.ts` |
| Tests | 96 (engineer) + 19 (QA, independent) |

### The requirement's own wording is wrong, and someone had to notice

`units × 5% of captured GMV` read literally is units × 5% × GMV — GMV already contains
the units. An engineer implementing the sentence as written produces a number 20× too
large, and the only test that catches it is one you write *because* you noticed. The PM
flagged it in the spec rather than quietly implementing the sensible reading; `units` is
a display column.

### "Captured" is ambiguous, and the gross reading is the plausible wrong answer

A force-failed drop captures every card and refunds every card. Gross-based commission
pays the organiser $24.00 for a drop that never happened and that the restaurant earned
nothing on. The base is therefore `subtotalCents − refundedCents`, which is also the
figure `ledger.ts` already asserts as its L1 invariant — so a gross implementation would
make commission the only place in the codebase that disagrees with the ledger about what
a captured dollar is. Probed: `expected 2400 to be 1800` and `expected 48000 to be +0`.

### Three wrong answers that are all silent

- **Joining `Order` to `ShareLink` on `dropId`.** A drop has one `ShareLink` per
  organiser, so a `dropId` join credits every organiser with the whole drop. Two
  organisers who shared one drop each get paid in full, and no single-organiser test can
  see it. Probed: the statement grew a second line per organiser.
- **Starting from `DropParticipant` instead of `Order`.** A participant with no `Order`
  was authorised and never captured; counting from participants counts money that was
  never taken.
- **Rounding the summed base instead of summing the rounded lines.** Two lines netting
  1810 each are 91 + 91 = 182; rounding the sum gives 181. The printed total must equal
  the column sum a human gets in a spreadsheet. Probed: `expected 181 to be 182`.

### The month is defined by a tz database, which is now pinned

The period is the calendar month in `America/Edmonton` in which the money was captured
(`Order.createdAt`), half-open, built with `Intl` rather than `new Date(y, m, 1)` — the
server runs UTC, so the latter shifts seven hours of orders into the previous month.

QA then found that the runtime's tz database changes the answer. `process.versions.tz` is
**2026c** on Node 24.21 and **2025c** on Node 22.22, and they disagree about Edmonton
because **Alberta genuinely stops changing clocks from 2026-11-01** (in IANA tzdata as of
2026e). So 2026c is correct and 2025c is stale — but the practical effect is that
`monthKeyOf('2026-12-01T06:30:00Z')` is `2026-12` on one and `2026-11` on the other. One
hour of every month boundary, attributed differently on two machines.

The engine's first framing of this was a curiosity; it is a deploy hazard. The runtime
was unpinned (`engines: ">=20.0.0"`, no `.nvmrc`, no CI, no Dockerfile), so the tz
database computing a paid figure was whatever the host happened to ship. Now `.nvmrc`
pins `24.21.0` and `engines` floors at `>=24.0.0`. **No test asserts an hour count** — that
would encode the tz database and start failing the next time the rules move; the
invariant test asserts instead that a period boundary is local midnight on the 1st and
that consecutive months tile with no gap or overlap, which holds under any database.

### Two decisions recorded as one position

No `CommissionPayout` table: the statement is a live query, so a refund landing in April
silently restates March. The mitigation is a UI obligation, not a data one — the page
says, in words, that the figures are current as of right now and that re-opening March
after an April refund makes March smaller. And no rate-history column: a mid-month rate
change restates that month and the figure stops being reproducible, which is acceptable
*because* nothing is frozen — with no frozen document, a frozen rate would be false
comfort. The export taken at payment time is the record.

### What QA proved that the engineer's own tests could not

Different claims, not a re-run. The engineer probed by mutating source; QA constructed
data where each wrong implementation yields a different number, and computed the wrong
answer from the same inputs so a formula change cannot make the comparison vacuous:
12/8 attribution on one shared drop with neither reading 20, the 4800/3000/1800/90 base
asserted *not* to be 240, the 182 total parsed back out of the CSV column, privacy across
three haystacks (rows, totals, raw bytes) with the PII confirmed present in the database
first, and zero writes to five tables including `ShareLink.clicks`.

QA also found the one real defect: `csvText`'s docblock claimed it quotes on a newline,
but `toAscii` folds `\n` to `?` first, so that branch was unreachable. No data
corruption — a comment that disagrees with the behaviour is the worse problem, because
the next maintainer trusts it. Fixed, along with three smaller comment inaccuracies and a
`?month=a&month=b` silence that fell through to "no month given".

### Not built, deliberately

The admin variant (`GET /api/admin/commission`, one row per organiser for a month) is
P1 in the spec and deferred — gap 17. `likelyFill` ranking is still gap 16.

## M7 — FR-801/802/805, the share link that finally has a writer

`FR-801 | Organiser sees available drops from their merchants | Ranked by likelyFill`
— PRD-v1.md:536. `FR-802 | "Get share link" generates unique token, 2 taps max | Link
+ copyable pre-written message` — PRD-v1.md:537. `FR-805 | Organiser cannot see
participant phone numbers | P0 privacy requirement` — PRD-v1.md:540.

Journey B's acceptance is the sentence this slice is judged by: *"organiser can go from
login to a shareable link in ≤2 taps"* — PRD-v1.md:157.

| Piece | Where |
|---|---|
| Token shape, share URL, pre-written message (pure) | `src/lib/organisers/share-link.ts` |
| The drops, the link, the click, the token resolver | `src/lib/db/share-links.ts` |
| The screen | `src/app/(organiser)/organiser/page.tsx` |
| The two taps | `src/components/organiser/ShareLinkControl.tsx` + `organiser/actions.ts` |
| Attribution on the public page | `src/app/d/[publicCode]/page.tsx` |
| Attribution through the join | `join/service.ts`, `join/input.ts`, the join route, `JoinForm` |
| One link per organiser per drop | migration `20261103030000_share_link_one_per_organiser_per_drop` |
| Tests | 17 pure + 19 DB + 4 route, all against real Postgres except the pure ones |

### `ShareLink` was the third table with no writer

`AiDraft` had no reader (FR-905). `OrganiserProfile` had no writer outside the seed
(FR-906). `ShareLink` had **neither**: a token, a click counter, an `organiserId`, two
indexes, and not one line of code that created or read a row. The organiser's whole job
— *share a link, get credited* — had a table and no product.

So `/organiser` stopped being the Sprint 1 placeholder that said "share links arrive in
a later release". Login lands on the drop list; tap **Get share link**, tap **Copy
message**. That is the two taps, and there is no navigation step between them.

### A token that nothing reads is theatre

The tempting version of this slice generates a token, puts it in the URL, and stops —
the link works, the page renders, and the organiser believes they are being tracked.
Nothing reads `?o=`, so nothing is attributed, and the first commission statement is
where the lie surfaces.

So the token is read in two places, and both are tested:

- **Clicks**, on the deal page, gated by the existing `isHumanView` — the same reason
  `deal_page_viewed` is gated. Every share is fetched by WhatsApp's and WeChat's
  unfurler to build the link card, so an ungated counter measures sharing *effort* and
  penalises the behaviour it is meant to reward.
- **Joins**, in the join transaction, written to `DropParticipant.shareLinkId` — a
  column that existed since the init migration and had never been set.

### The omission `tsc` cannot see

`organiserToken` is optional on `JoinRequest`, so a route that parses it and then
forgets to pass it to `joinDrop` compiles cleanly, validates the body, returns 200, and
stores `shareLinkId: null` for ever. Every join works; no organiser is ever credited.

That is exactly what `paymentMethodId` did in slice 2b — and the comment above the
`paymentMethodId` line in the route says so. So `join/__tests__/attribution.test.ts`
asserts on the **participant row**, not the parsed body, because the parsed body would
be correct in the broken version too. Probed by deleting the route's line: `tsc` printed
nothing, and the test failed with `expected null not to be null`.

### Attribution must never cost the merchant a sale

A malformed token, an unknown token, a token from another drop, no token at all — all
four join successfully, with `shareLinkId: null` where it cannot be resolved. A stale
link, a hand-edited URL and a deleted drop are all ordinary, and the diner did nothing
wrong and cannot fix any of them.

The scoping is the part that matters for money: `resolveShareToken` refuses a real token
pointed at a different drop, because FR-804 pays commission on this number and a token
that works anywhere could be farmed by pasting one shared link onto every drop in the
corridor. Probed by dropping the `dropId` check: one failure, on that test.

### One link per organiser per drop is a constraint, not a lookup

The second tap of a two-tap flow is also the tap that gets double-fired on a slow
connection. A `findFirst`-then-`create` has a window exactly that wide, and the result
is two rows for one organiser on one drop — after which `clicks` splits and a link
already pasted into a group chat counts on a row nobody looks at.

So `@@unique([dropId, organiserId])` and an `upsert`. This is the first migration since
FR-904, and it was taken deliberately: `ShareLink` had never had a writer, so there was
nothing to deduplicate and nothing to decide. Adding the same constraint after the first
organiser had shared a link would mean choosing which of two rows to keep. Probed by
swapping the `upsert` for a `create`: `Unique constraint failed on the fields:
(dropId, organiserId)`, on both the double-tap and the concurrent-pair tests.

### FR-805 has no field to leak

The organiser row carries counts. There is no phone, no name, no customer id — so there
is no projection to get wrong, which is a stronger guarantee than a careful `select`.
The test asserts it anyway: it serialises the rows and checks the real phone number is
not in there, and not its last four digits either. Probed by adding a phone to the
query: `expected '[...]' not to contain '0001'`.

### "From their merchants" has no schema to read

The PRD's phrase assumes an organiser-to-merchant relationship. There is none — no join
table, no column. Before a first share, an organiser is attached to no merchant at all,
because `ShareLink` is what records the merchant.

Rather than invent an assignment table (a product decision nobody has made, needing an
admin screen to maintain), the query reads the V1 reality: 5–15 organisers, one
corridor, one live drop per merchant. **Every live drop is offered to every organiser.**
It fails safe — a wasted row versus a lost drop.

`likelyFill` ranking is **not** implemented, and that is a deliberate departure from
FR-801's acceptance column. It is defined as a function of the organiser's *history*
(fill rate per merchant+item, group size inferred from the last drop, past success with
a cuisine), and an organiser with no share links has no history to rank with. The order
here is the honest one: soonest cutoff first, because that is the drop that needs
somebody today. It belongs in a pure module beside `likelyFill` once history exists.

### Not proven

**Nobody has loaded `/organiser`**, and the copy buttons are the first client-side
clipboard use in the app. Gap 12 carries the checklist, extended with the organiser
walkthrough. The two-tap claim is a design claim, not a measured one.

## M7 — gap 18, the organiser role gets an API surface

PRD §11 declares three organiser endpoints. One was built (`/api/organiser/commission`).
The other two were not, and the reason is a good one that stopped being true.

| Piece | Where |
|---|---|
| The read route | `src/app/api/organiser/drops/route.ts` |
| The share route | `src/app/api/organiser/drops/[id]/share/route.ts` |
| The composition both entry points use | `shareOfferFor`, `shareableDropJson`, `src/lib/organisers/share-offer.ts` |
| The gates | `requireOrganiser` / `requireOrganiserWrite`, `src/lib/auth/authorize.ts` |
| One query, two views | `listShareableDrops({ …, dropId })`, `src/lib/db/share-links.ts` |
| Tests | 13 (list, real Postgres) + 23 (share, real Postgres + the real auth module) |

### The gap was recorded as one route. It is two.

Gap 18 named `POST /api/organiser/drops/:id/share`. A diff of PRD §12's API list against
the filesystem found `GET /api/organiser/drops` missing as well — so the organiser role
had exactly one endpoint, the commission export, and no way to *read the drops that
export is about*.

The same diff found two more entries that are **not** gaps, and recording why is the point
of doing the diff:

- `POST /api/staff/redeem` → `api/merchant/redeem`; `GET /api/staff/drops/:id/manifest` →
  `api/merchant/pickup-queue/[id]`. There is no `STAFF` role in the schema, and the
  endpoints were built under the role that exists. A naming departure, not a hole.
- `GET /api/public/drops/:publicCode` and `GET /api/public/participants/:code` map to
  server-rendered pages (`/d/[publicCode]`, `/d/[publicCode]/mine?t=…`). The second is
  deliberately *better* than the PRD: it is reached by a signed token, not by the
  participant code, so the code cannot be guessed into somebody else's order. Both are
  reasonable departures; neither needs an endpoint.

### A second entry point has to be proved equivalent, not assumed to be

This is the whole thesis of the slice. The capability already worked — FR-802's share link
ships as a server action. Adding a route to the same capability is easy. The failure mode
is a route that is *almost* the same product:

| If the route… | Then… | Visible? |
|---|---|---|
| minted its own token | `clicks` splits across two rows; commission is paid off one of them | no |
| returned a bare token | the client assembles `/d/:code?o=…` and forgets `?src=organiser_link`, so every view classifies as `direct` — the organiser's contribution vanishes from PRD §10.2's only organiser metric | no |
| composed its own message | the four-line format drifts, and the text still looks right | no |
| skipped the `mustChangePassword` refusal | a brand-new organiser farms links before ever choosing a password | no |

So the route calls `ensureShareLink` (one mint), `shareOfferFor` (one URL and message
composition, shared with the client component), and `requireOrganiserWrite` (one refusal
vocabulary — extended from the action's, not re-invented). The test that matters drives
**both** entry points for real, on the same organiser and drop, and asserts the same token,
in both orders.

### What is deliberately different, and it is only the vocabulary

The action returns `{ error, token: null }` because a React form can only render a
sentence. A JSON client needs the status. So:

- **`null` from `ensureShareLink` → 409.** Not 404 and not 400. The request was well formed
  and no different body would help — the drop is in a state that forbids the action. The
  three underlying cases (not published, past cutoff, nonexistent) stay collapsed, exactly
  as `ensureShareLink` collapses them, because splitting them would tell an unauthenticated
  guesser which drop ids are real.
- **A malformed `:id` needs no special case.** Probed, not assumed: Prisma answers
  `findUnique` with `null` for a non-uuid string rather than throwing, so `not-a-uuid`
  reaches the same 409 as a closed drop — and leaks nothing, which a 400 "not a uuid"
  would.
- **No `revalidatePath`.** The action purges `/organiser` because it *is* that page
  refreshing. A route is not, and purging a cache as a side effect of an API call is
  something the caller did not ask for. Asserted, so nobody adds it for symmetry.

### The real auth module, because a stub cannot fail

Every other route test in this repo mocks `@/lib/auth/authorize` wholesale. These two mock
`server-only` and `@/lib/auth/session` instead, and import the **shipped** gates. That was
probed first rather than hoped for: mocking `server-only` is enough, and five files in this
repo already do it. The difference matters because this slice's design decisions *are* in
the gate — `requireOrganiserWrite` did not exist before it — and a test against a look-alike
gate would assert the look-alike.

The impersonation refusal is tested even though it is unreachable today (impersonation is
merchant-only, so the role check answers first). A signed claim can carry the marker, so
the guard can break — and a guard that can break is one worth a test. If organiser
impersonation is ever added, the write path is already shut.

### The log event was counting taps

Found while reading the test output, which printed `organiser.share_link_created` **eleven
times** in one file — including on every second tap that created nothing. The event named
a creation that had not happened. With one emitter that was a small lie; with two it would
have been twice as common, and "how many links did Sam make this week" was really "how many
times did Sam press the button".

`ensureShareLink` now returns `created`, read before the `upsert`. That read is
**advisory** — two concurrent taps can both see no row and both report `created: true` —
and the docblock says so. Nothing depends on it being exact: the row count is guaranteed
by the unique index, not by this flag, and its only consumer is a log line. The alternative
(inferring from `createdAt`) was rejected because it is exact only if the clock and the
database agree to the millisecond, and reading a floor from a column that cannot store it
is a mistake this codebase already recorded once.

A tap that finds an existing link now emits `organiser.share_link_reused`. Same fields,
plus `source: 'action' | 'api'` — which is the only question a route that exists purely for
a future client can be judged by: are organisers using it?

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint .                          clean
npx vitest run                        1460 passed | 8 skipped (1468) across 114 files
prisma migrate status                 no migration — this slice adds no schema
```

Twelve probes, each failing exactly its own tests:

| Probe | Change | Result |
|---|---|---|
| A | `created` hardcoded `true` | `reports which tap inserted the row` + `reports created: false for an organiser who already has a link` |
| B | the route always logs `created` | `emits created on the tap that inserts and reused on the tap that finds` |
| C | `source: 'action'` on the route | `names its own entry point, so the two are distinguishable` |
| D | drop the `cache-control: no-store` header | `is not cacheable, because the body carries a credential` |
| E | return a bare token, no `url`/`message` | `composes the identical URL…` + `composes the identical message…` |
| F | compose the URL without `?src=organiser_link` | `composes the identical URL the pure formatter produces` |
| G | write gate drops `refuseIfImpersonating` | `refuses a borrowed session, which the server action cannot be asked about` |
| H | write gate drops the `mustChangePassword` refusal | `refuses a temporary password, exactly as the server action does` |
| I | the list route re-projects its own rows | `is the same rows the organiser page renders` + `carries the numbers a client needs…` |
| J | 404 instead of the FR-906 profile sentence | `answers 403, not 404, for an organiser whose account has no profile` |
| K | `ensureShareLink` stops checking status and cutoff | the 5 tests in `share-links.test.ts`; **not** the route suite — see below |
| L | the share route calls the **read** gate | `POST …/share/route.ts` + `no mutating handler still calls a read gate only` |

**Probe K needed correcting.** It was run against the mint-then-read version of the route
and passed with 5 route failures; the route was then reordered to read-first, which makes
the route's own filter answer before `ensureShareLink` ever runs — so re-running K on the
shipped code now fails only `share-links.test.ts`'s two `ensureShareLink` tests, and the
route suite stays green. The gap guard is still real (the action calls `ensureShareLink`
with no read in front of it, and those two tests prove it), but the earlier table entry was
describing code that no longer existed. Stating the correction rather than leaving a probe
result that only held for one commit is the whole discipline this file records.

That reorder also produced a second finding: `if (!row)` is not decorative. Deleting it —
the "remove the unreachable branch" instinct — fails `tsc` with `ShareableDropRow |
undefined` is not assignable, because `shareOfferFor` needs a whole row. So the guard is
compiler-required even though no test can reach it. The two refusals now share one
`notShareable()` closure, so there is one sentence for one situation rather than two copies
that could drift.

Probe L is the one that reaches outside this slice: `impersonation-readonly.test.ts` now
walks `src/app/api/organiser` as well, with `requireOrganiserWrite()` as its expected gate.
Its docblock had predicted this exact moment — *"a mutating operation added … under a new
route group would not be caught until its roots are extended"* — so the root was extended
with the route rather than afterwards. Writing that extension cost one bug of my own: the
new "found both roots" assertion compared absolute paths against relative ones and failed
on the merchant root. The assertion caught it, which is what it was for.

### Not proven

- **Neither route has been called over HTTP.** They are driven as handlers with a
  `NextRequest`, which is the whole of what the handler decides, but no request has crossed
  a socket and `middleware.ts`'s `/api/organiser` gate has not been exercised against them.
  That is gap 12's checklist, extended with: `curl` both routes as an organiser, confirm
  401 without a cookie, 403 as a merchant, and that the share route's token appends to a
  real `/d/:code` URL.
- **The `created` flag under genuine concurrency.** The advisory read is documented as
  inexact; no test races two taps to *prove* it, because the assertion would be about a
  log line's accuracy and the behaviour it could affect is already guaranteed elsewhere.
  Stated rather than left looking covered.
- **The route's second 409.** The `if (!link)` branch after a successful read is a
  microsecond race and no test reaches it. It is documented as correctness rather than as
  coverage, and probe K's correction above says so explicitly instead of implying the
  route suite proves it.
- **`shareOfferFor` is not tested as a unit.** It is covered through the route, which is
  where its behaviour is observable. A unit test would assert the same composition twice.

## M7 — gap 12(g), the page the operator pays from is rendered too

Gap 12(f) built the harness and rendered `/commission` — the organiser's own screen.
This slice renders `/admin/commission`, which is the one an operator reads immediately
before transferring money from the file it exports. Same mechanism, second page, and the
first page test written by someone who had already made the mistakes once.

| Piece | Where |
|---|---|
| Tests | `src/app/(admin)/admin/commission/__tests__/page.test.ts` — 20, real Postgres, real `requireAdmin` |
| Harness | unchanged — `src/lib/testing/render.ts`, from 12(f) |

### The fixture is the test, and this time it was designed rather than discovered

Ada has two July drops, each netting **1250 cents**: 2 units untouched, then 3 units with
one refunded. At 5% each line is 62.5 → **63**, so her month is **126**. Applying the rate
once to her 2500-cent month gives **125**. Bo is the single-line control at 7.5%: 93.75 →
**94**, where both implementations agree, so his row proves the arithmetic is right while
Ada's proves which arithmetic is being done.

The previous slice's commit message ends with the sentence *"With round prices the two
agree and the assertion would prove nothing."* The first version of **this** file then used
5400-cent and 4500-cent fixtures, where the two implementations agreed, and probe M passed.
That is the same mistake, made again, one slice later, by the same author who had just
written it down. It is now a comment above `DEAL_PRICE` naming the failure mode, because a
lesson that lives only in a commit message does not survive to the next file.

### Two harness gaps this page needed that `/commission` did not

Both are cell-scoping problems, and both would have produced assertions that pass for the
wrong reason.

- **`toContain` against the document cannot see a table.** A roster that puts the right
  names against the right figures in the wrong rows renders perfectly and pays the wrong
  person. `cellsOf(html, needle)` finds the `<tr>` containing a name and returns each
  `<td>` through `textOf`, so a name and a figure are asserted on *the same row or not at
  all*.
- **`cellsOf` cannot be skipped in favour of the row's raw HTML.** React renders the rate
  as `5.00<!-- -->%`, so `toContain('5.00%')` against the `<tr>` fails for a reason that
  has nothing to do with the page. Every cell goes through `textOf` for that reason.
- The footer's `Total` cell has `colSpan={2}` (Organiser + Rate), so the footer has **four**
  cells, not five. Asserted with an explicit `toHaveLength(4)` so the next person changing
  the markup gets a failing test rather than a silent off-by-one.

### What the page test asserts, and why each one exists

- **`no activity` and `—`, and `$0.00` is asserted absent.** Not a style preference: the
  page's own comment argues `$0.00` reads as *"computed, and it is zero"* while a profile
  with no lines has nothing attributed at all. The difference is "nothing to pay" versus
  "attribution may be broken", and an operator about to send money needs the second.
- **`2 to pay, N with nothing this month`**, derived on the page from the roster.
- **The live-not-frozen paragraph, positionally above `<table`** — the stakes are higher
  here than on the organiser page, because the file is downloaded *from* this list.
- **The header and the footer are the same number**, read out of the render rather than
  recomputed in the test.
- **The CSV fetched through the real route** (real `requireAdmin`, not a stub) whose
  `commission_cents` column sums to its own `TOTAL` row — the property the file exists for.
- **A MERCHANT session gets a 403 with no roster in the body**, because one organiser must
  not learn what the others earned.
- **`?month=nonsense` and `?month=a&month=b`.** The repeated-parameter case is the one that
  broke on the organiser page: an array read as *absent* means the fallback silently answers
  a question nobody asked, with no note attached.
- **No "next" link past the current month**, on the explicit path *and* on the default path.
- **Nothing writes**, measured by counting five tables before and after two renders.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx vitest run                        1495 passed | 8 skipped (1503) across 117 files
prisma migrate status                 no migration — this slice adds no schema
```

Twelve probes, each failing a named test:

| Probe | Change | Result |
|---|---|---|
| A | count `to pay` from the whole roster, not the owing bucket | `counts who is owed and says why a missing name would matter` |
| B | print `$0.00` instead of the dash | the `$0.00` test **and** the cell test |
| C | round the rate to whole percent (7.50% → 8%) | three, including the equivalence test |
| D | drop the next-month guard | both `offers no next month…` tests |
| E | read `?month[]` as its first element | `treats a repeated ?month= as unreadable, not as absent` |
| F | footer Kept column sums gross, ignoring refunds | `prints a grand total that is the sum of the roster…` |
| G | label the CSV total row as a person | `produces a file whose rows sum to its own TOTAL row` |
| H | skip organisers with no lines | three, starting with `lists every organiser…` |
| I | let a MERCHANT session through `requireAdmin` | `refuses a merchant session with a 403 rather than the roster` |
| J | move the live paragraph below the table | `says the figures are live, above the table…` |
| K | write an audit row while rendering | `renders a month without changing a single row` |
| M | roll up `net × rate` instead of summing rounded lines | four, incl. the equivalence test at `$1.25` vs `$1.26` |
| N | header prints the month's net instead of its commission | `prints a grand total…` at `$2.20` vs `$37.50` |

**Probe E passed on the first attempt.** Replacing `monthKey < currentMonth ? shiftMonthKey(…) : null` with an unconditional shift went unnoticed, because the only month rendered was July — in the past, where both behave identically. A guard that lives on a comparison is only tested by rendering on both sides of it. The repair was to add renders of the *current* month and of no month at all; the probe now fails two named tests.

### Not proven, and this must not be overstated

- **No browser has loaded this page either.** The harness proves what the server sends.
  Nothing here exercises the link a human clicks, the download a browser actually performs,
  or any hydration.
- **`/admin/drops`, `/admin/drops/[id]`, `/admin/ai-drafts` and `/admin/users` are still
  unrendered.** `/admin/users` remains the highest-value next one and the one this harness
  cannot finish, because its conditional form is `useState`-driven.
- **The roster is global**, so counts and totals are asserted against the rendered table's
  own row count rather than against this file's three fixtures. The `$0.00`-absent and
  "same number on both screens" claims are the ones that survive any roster size.
- Neither gap-18 API route has crossed a socket. Unchanged.

## M7 — gap 12(f), the commission page is finally rendered

Gap 12 is the weakest claim in this file: every admin and organiser screen was "verified by
review and `tsc`". This slice removes the `/commission` page from that list — and, in doing
so, builds the mechanism the other pages need.

| Piece | Where |
|---|---|
| The renderer | `src/lib/testing/render.ts` — `renderToHtml`, `textOf`, `hrefsOf` |
| The one config line that made it possible | `vitest.config.ts` — `esbuild: { jsx: 'automatic' }` |
| Tests | `src/app/(organiser)/commission/__tests__/page.test.ts` — 15, real Postgres, real auth module |

### The constraint and the goal were never actually in conflict

Gap 12 assumed a browser, and the repo's "no `.tsx` tests by design" rule made that look
expensive: a jsdom harness would be a second runtime to keep alive and would *still* not
exercise `<form action={serverAction}>`.

The rule is about tests, not about rendering. A server component is an `async` function
that returns an element tree. Calling it and serialising the tree is a real render: every
branch executes, the queries run, `next/link` becomes an `<a href>`, and the copy is what a
browser receives as its initial payload. No DOM is involved, so `environment: 'node'` and
the `include` glob are both untouched. That is what `src/lib/testing/render.ts` does.

Three mechanics were probed before the module was written, and each could have sunk it:

- **`renderToStaticMarkup` cannot render an async component.** It throws *"A component
  suspended while responding to synchronous input."* `renderToReadableStream` awaits it.
  Probed both ways.
- **`tsconfig` sets `jsx: "preserve"`** for Next's compiler, which leaves esbuild on the
  *classic* transform — a page file then compiles to `React.createElement` with no `React`
  in scope and dies with `React is not defined`. `esbuild: { jsx: 'automatic' }` is what
  Next itself uses. Probed both ways, and all 1460 pre-existing tests still pass with it.
- **`next/link` renders to a plain `<a>`** under a bare render, so an href assertion is
  asserting what a browser would request.

### The harness shipped two defects, and both were found by running it

Neither would have been caught by reading it.

1. **The docblock closed itself.** The prose originally spelled the `include` glob out. A
   `*` immediately followed by `/` terminates a block comment, so the file failed to
   compile with `Unexpected "*"` at a line inside what was meant to be a comment. Rewritten
   without the glob, with a note saying why.
2. **`textOf` inserted spaces a browser never shows.** React's server renderer emits
   `<!-- -->` between adjacent text nodes — JSX produces this wherever a sentence
   interpolates a value — and turning tags into spaces turned those into visible gaps.
   Measured output before the fix: `we can read ( nonsense), so` and `5.00 %`, where the
   screen says `(nonsense)` and `5.00%`. A tag boundary also contributed a space before
   punctuation, so the restatement sentence read `right now , not`. Both are now normalised
   away, because the alternative is writing assertions in a dialect no human reads.
   `hrefsOf` had the sibling defect: React escapes `&` to `&amp;` in an attribute, so a
   two-parameter URL came back escaped and the natural repair — loosening the assertion to
   `toContain('format=csv')` — would have stopped checking the month.

### What the page test actually asserts

The fixtures are chosen so that two plausible implementations print different numbers.
Both March drops net **2152 cents**; 5% is 107.6 → **108** each, so the month is **216**
and the page prints **$2.16**. Applying the rate to the month's net instead (4304 → 215.2 →
**215**) prints **$2.15**. With round prices the two agree and the test would prove nothing.

- the restatement sentence, in full, and **positionally above the table** — it is the only
  place the live-query decision is honoured, and nothing in `commission.test.ts` can see it;
- the headline and footer totals, **counted** rather than merely present (see probe G);
- the selector's hrefs, including that no "next" link is offered past the current month;
- `?month=nonsense`, `?month=2026-3`, and **`?month=a&month=b`** — the variant that broke,
  which must be treated as unreadable rather than as absent;
- a month with no activity saying so in a sentence instead of an empty table, and still
  offering its own CSV;
- the CSV the page links, fetched through the real route with the real auth gate, whose
  `commission_cents` column sums to 216 — the number printed on the screen;
- FR-805: no diner phone, email or name, against a diner whose all three are really stored;
- FR-906: the profile-less organiser gets a sentence, not a statement and not a download;
- nothing writes.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx vitest run                        1475 passed | 8 skipped (1483) across 116 files
prisma migrate status                 no migration — this slice adds no schema
```

Thirteen probes, each failing exactly its own tests:

| Probe | Change | Result |
|---|---|---|
| A | delete the restatement paragraph | `says the figures are live, in words, above the table` |
| B | normalise `?month[]` to its first element | `treats a repeated ?month= as unreadable, not as absent` |
| C | delete the `ignored` note | all three `an unreadable ?month=` tests |
| D | always offer a "next" month | `does not offer a month after the current one` |
| E | CSV anchor points at `currentMonth` | `links the download to the month being viewed` + the empty-month test |
| F | empty month renders a table instead of a sentence | `says so in a sentence rather than rendering an empty table` |
| G | headline = `net × rate` (215) | **passed at first** — see below; caught after tightening |
| H | footer Kept column sums gross | **passed at first** — same repair |
| I | FR-906 branch falls through | `prints a sentence they can act on, not an error page` |
| J | footer Refunded shows `$0.00` not `—` | `prints the summed-line total in both the headline and the footer` |
| K | stop stripping `<!-- -->` | the drop test, with `5.00 %` and `Total (5.00 %)` in the received string |
| L | `hrefsOf` returns raw attributes | the CSV tests, on `&amp;` |
| M | `renderToHtml` returns `''` | 14 of 15 — a renderer that renders nothing fails everything |

**G and H passing is the finding of this slice.** Both mutations change a figure on the
page, and both passed the first version of the suite, because `$2.16` and `$21.52` also
appear in the per-line rows: `toContain` cannot distinguish which cell it found. The repair
was to *count* occurrences — `$2.16` exactly twice (headline and footer), `$43.04` and
`$4.96` exactly once (footer only) — and both mutants die. Writing the count also produced
a wrong assertion of my own: I had asserted `$48.00` was absent, on the reasoning that an
accurate page sums the kept column. It is present, correctly, as the footer's **Charged**
column. The test was wrong about the page; it now asserts that count positively, so nobody
"fixes" the page to satisfy a misreading.

### Not proven, and this must not be overstated

- **No browser has loaded any of these pages.** This proves what the server sends, not what
  a browser does with it. Client components are not hydrated: `onClick` is inert and a
  `useState` branch renders its initial value only. Gap 12 keeps its full interaction
  checklist — `ShareLinkControl`'s clipboard fallback, `CancelDropButton`,
  `ForceFailControl`'s two-step confirmation and `ParticipantRefundControl` are all still
  only partly covered, and this module must not be cited as covering their behaviour.
- **The journey is not walked.** The organiser's actual sequence — sign in, two taps, paste
  into a chat, open the link in a second browser, watch `clicks` increment — is
  interactivity, cookie handling and middleware, none of which a bare render touches.
- **`/admin/commission`, `/admin/drops`, `/admin/drops/[id]`, `/admin/ai-drafts` and
  `/admin/users` are still unrendered.** They now have a mechanism; they do not have tests.
  `/admin/users` is the highest-value next one, because its conditional form is
  `useState`-driven and therefore *not* fully reachable by this harness even once written —
  that one genuinely needs a browser.
- **Neither gap-18 API route has crossed a socket.** Unchanged by this slice, still in gap
  12.

## M7 — gap 17, the e-transfer run becomes one file

The P1 half of FR-804, deferred when the organiser's own statement shipped and closed
here.

| Piece | Where |
|---|---|
| The roll-up | `adminCommissionRollupFor`, `src/lib/db/commission.ts` |
| The admin CSV serialiser | `toAdminCsv` + `ADMIN_COMMISSION_CSV_COLUMNS`, `src/lib/organisers/commission.ts` |
| The route | `src/app/api/admin/commission/route.ts` |
| The screen | `src/app/(admin)/admin/commission/page.tsx` |
| Nav entry | `src/components/AppNav.tsx` |
| Tests | 13 (roll-up + CSV, real Postgres) + 13 (route, end to end) |

### The gap's own plan was the trap

Gap 17 predicted this was "the same query with the organiser filter omitted". It is not,
and taking that prediction at face value would have produced the one thing FR-804 spent
a whole slice avoiding: a **second implementation of the commission arithmetic**.

The first implementation has three documented ways to go silently wrong — gross vs net,
attributing through `dropId` instead of `shareLinkId`, and rounding the summed base
instead of summing the rounded lines. A `groupBy` variant would have all three available
again, and nothing would catch a drift: the organiser sees their own statement and never
sees the admin's, so the two numbers disagreeing is invisible until someone is paid the
wrong amount.

So the roll-up calls `commissionStatementFor` once per organiser and sums the results.
The admin's figure and the organiser's figure are the same computation, two views. It
costs N statements instead of one query — ~30 indexed reads at PRD §3.3's 5–15
organisers, once a month — which is the right trade for removing the possibility
entirely rather than testing for it.

### Every organiser appears, including the ones owed nothing

An activity-filtered roster is the obvious query and the dangerous one. The operator is
paying a *known roster*; an organiser whose attribution broke would vanish from the list
and be quietly unpaid, which is undetectable from a file that simply omits a name. The
row carries `lineCount: 0` and renders "no activity" with a dash rather than `$0.00`,
because a computed zero reads as "we checked and it is nothing" and a dash reads as "there
was nothing to check here" — different questions, different operator responses.

### The file is payable from, so it has a TOTAL row

The organiser's CSV has no totals row on purpose: it is a copy of a table they just read
on screen. The admin file is what someone pays *from*, adding a column across fifteen
people. So it closes with a `TOTAL` row whose `commission_cents` is the sum of the rows —
AC5's property lifted to the roster — and whose `commission_pct` is **blank**, because the
rates differ and one cell showing `5.00%` would be a single number standing for a set that
is not all 5.00%.

No per-organiser subtotals, for the same reason: they would make `SUM(commission_cents)`
double-count, destroying the one property the totals row exists for.

### Authorisation is a separate route, not a flag

`/api/organiser/commission` resolves the caller's own profile; its entire authorisation is
"you are this organiser". An `?all=1` switch inside that handler would put two
authorisation paths in one function whose failure mode is one organiser reading another's
statement. Two routes, one guard each. The organiser is refused with 403 rather than
offered a filtered view, because the roster is the resource — this is competitive
information, not PII, and the spec rules out both.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint .                          clean
npx vitest run                        1420 passed | 8 skipped (1428) across 112 files
npx next build                        /admin/commission and /api/admin/commission both compiled
prisma migrate status                 no migration — this slice adds no schema
```

Five probes, each failing exactly its own tests:

| Probe | Change | Result |
|---|---|---|
| A | filter the roster to organisers with lines | `lists an organiser who earned nothing…` + the route's `lists every organiser…` |
| B | round the grand total from the summed base | `sums the roster total from the rounded per-organiser figures` |
| C | blank the CSV total cell | `ends with a labelled TOTAL row…` + `has a commission_cents column that sums…` |
| D | remove the malformed-month 400 | `is 400 on a malformed month, and downloads nothing` |
| E | relax the admin role check | `refuses an ORGANISER…` + `refuses a MERCHANT` |

### Two mistakes the tests caught in the writing of them

Worth recording because both are the class of error this milestone is about:

- I asserted a May boundary using **February's** offset. May is MDT (UTC−6), so the last
  half hour of May is `2026-06-01T05:30Z`, not `06:30Z`. The test failed with `0` units
  and the arithmetic, not the code, was wrong. The test now also asserts the control
  half-hour, so it is a boundary rather than a month that happens to contain everything.
- I built an "1810 net" line by subtracting from a $12.00 price, producing a **negative**
  refund. The pure module refused it by name — `refundedCents -610 is outside 0..1200` —
  which is the assertion working exactly as designed. Fixed by giving the fixture its own
  unit price instead of bending the deal price.

## M7 — gap 15, the transaction that was only a sentence

Not a PRD requirement: a defect found while building FR-906, recorded as gap 15, and
closed here.

| Piece | Where |
|---|---|
| The three writes in one `$transaction` | `createMerchantWithOwner`, `src/lib/db/merchants.ts` |
| The client-agnostic slug lookup | `uniqueSlug(client, …)`, same file |
| Two `slugify` fixes found on the way | same file |
| Tests | 16 in `src/lib/db/__tests__/merchants.test.ts` (real Postgres) |

### The docblock was the bug report

`createMerchantWithOwner` has said since Sprint 1 that it creates "the merchant, the
owner's MERCHANT account and the `MerchantUser{role: OWNER}` link" in one transaction.
It did not: `createUser` ran as a separate statement and only the link was nested inside
the merchant create. A failure between them leaves a `MERCHANT` account with no merchant
— an account that passes the password check, passes the role check, and then has nowhere
to go.

Nothing about the code *looks* wrong, which is why it survived three milestones and
accreted a paragraph in a neighbouring module (`organisers.ts`) pointing at it. The prose
described a guarantee the body did not make. That is this milestone's recurring defect
shape in its mildest form: the other four instances were capabilities nothing could
reach; this one was a promise nothing kept.

### A failed insert has to be a real failure

The test forces SQLSTATE `22021` — a NUL byte in a UTF-8 `TEXT` column — which fires on
the `Merchant` insert *after* the owner `User` insert has succeeded inside the
transaction. That is precisely the sequence the gap described, and it needs no mock.

A spy would not have worked, and this is worth recording because it has already fooled
this codebase once: `prisma.$transaction` hands its callback a **different client**
(`tx`), so `vi.spyOn(prisma.merchant, 'create')` never fires. The first attempt at
FR-906's equivalent test passed for that reason. Un-wrapping the transaction and
re-running gives `expected 1 to be +0` — the orphan, counted.

### Two things the fix turned up that were not in the gap

**`slugify` split accented names.** `NFKD` decomposes `é` into `e` plus a combining
acute, and the next step replaces anything that is not `a-z0-9` with `-`. So one letter
became two separators: `Déjà Vu` → `de-ja-vu`. The URL is the merchant's identity in
every share link, so a hole in the middle of their name is a link that looks broken.
Separately, a name with no slug-worthy characters produced `merchant-` — trailing
hyphen, and not the same value twice. Both fixed; one caller, no seeded slug depends on
the old output, so nothing needed migrating.

**My first explanation of the slug read was wrong.** I wrote that putting
`uniqueSlug`'s `findUnique` inside the transaction closed a same-name onboarding race.
A probe against real Postgres says otherwise: two `Promise.all`'d onboardings of the same
trading name both succeed with distinct slugs (`race-…`, `race-…-2`), because the read
and the insert are close enough that the second transaction sees the first one's
uncommitted row. The retry loop handles it. The read stays on `tx` because it costs
nothing and keeps the decision on one snapshot — but the docblock now says that, and
says that no test can distinguish it, rather than claiming a guarantee. Writing the
tidier, false version would have been the same mistake one layer up.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx vitest run                        1394 passed | 8 skipped (1402) across 110 files
npx eslint src/lib/db/merchants.ts    clean
```

Four probes, each failing exactly its own test and nothing else:

| Probe | Change | Result |
|---|---|---|
| A | un-wrap to two statements | `leaves no account behind…` → `expected 1 to be +0` |
| C | `mustChangePassword: false` | `creates the merchant, the owner account…` |
| D | drop the combining-mark strip | `slugify › folds accents rather than splitting them` |
| E | drop the final hyphen trim | `slugify › pads a name too short…` + `never ends in a hyphen` |

Probe B — moving the slug read back outside the transaction — **passed**, which is what
prompted the re-write above rather than a test. No test can see it, so none was added
that pretends to.

## M7 — FR-906, the organiser account that was only ever half-created

`FR-906 | Manually create organiser accounts |` — PRD-v1.md:553. Context:
*"The organiser is onboarded **manually by ops** in V1 — no self-serve. There are 5–15
of them in beta"* — PRD-v1.md §3.3.

| Piece | Where |
|---|---|
| `createOrganiser`, the two-row transaction | `src/lib/db/organisers.ts` |
| The list, the gap, and the repair | same module |
| The branch in the admin action | `createUserAction` in `src/app/(admin)/admin/actions.ts` |
| The repair action | `backfillOrganiserAction`, same file |
| The conditional form | `src/components/admin/CreateUserForm.tsx` |
| The repair control | `src/components/admin/BackfillOrganiserForm.tsx` |
| The screen | `src/app/(admin)/admin/users/page.tsx` |
| Tests | 21 (service, real Postgres) + 10 (the action itself) |

### The dropdown offered a role the code did not implement

`/admin/users` has offered `Organiser` since Sprint 1, and `createUserAction` accepted
it. What happened next is the whole bug: `createUserAction` called `createUser`, which
writes a `User` row and nothing else. `OrganiserProfile` was created in exactly one
place in the entire repository — `prisma/seed.ts`. So an organiser made through the UI
got no `displayName`, no `commissionPct` (`@default(5.0)` on a row that does not exist),
and nothing for `/organiser` or a future `ShareLink.organiserId` to point at.

And it *looked* like it worked: the action returned "Created someone@…", the list
rendered them, and signing in succeeded — because `role` is what the layout gate reads.
The account was real and the organiser behind it was missing.

This is the mirror image of the defect FR-901/903 kept turning up. There the screen was
missing and the record existed; here the screen existed and the record behind it did
not. Both are invisible to the PRD's acceptance column and to the type checker, and in
both cases the failure surfaces much later, in front of a person.

### Only a test of the *action* can catch it

The defect was neither in `createUser` (correct for the roles it was written for) nor in
`createOrganiser` (which did not exist). It was a missing branch. So the 10 action tests
drive `createUserAction` with a real `FormData` against real Postgres and assert on
**both** rows — the account and the profile. An assertion that stops at "the user was
created" is the same mistake the page made.

Probed by reinstating the original bug (routing `ORGANISER` back through `createUser`):
three failures, the first being `expected null not to be null` on the profile.

### One transaction, because a half-built account is not a partial success

`createOrganiser` writes both rows inside `prisma.$transaction`. A `User` with
`role: 'ORGANISER'` and no profile is not a degraded state, it is a broken account that
signs in successfully and lands on a page with nothing to show — so the window, and the
permanent state a unique-constraint race could leave behind, must not exist.

Proving it needed a failure *between* the two inserts. The obvious approach — spying on
`prisma.organiserProfile.create` — does not work and is worth recording: the transaction
hands the callback its own `tx` client, so the spy never fires, the test passed, and
`mockRestore` then corrupted Prisma's client proxy for every later test in the file. The
test now fails the profile insert with a **real** constraint violation (`Decimal(5,2)`
cannot hold `1234.56`) and asserts no `User` survives. Probed by removing
`$transaction`: `expected 1 to be +0` — the orphan, exactly.

That `1234.56` also situates the validation: `commissionRefusal` is the friendly check
the form calls, and the schema's precision is the backstop. The service does not
re-validate the range, deliberately — if it did, this test could not fail and the
transaction would be untested.

### Defaults come from the schema, and zero is a number

`commissionPct: null` means "use the schema default", so the service passes nothing and
`@default(5.0)` applies. Restating `5` in TypeScript would give two copies of one fact,
and the day the default changes they disagree. Probed: `?? 6` → `expected 6 to be 5`.

The related trap is `...(x ? { x } : {})`, which treats an agreed **0%** commission as
absent and silently grants 5%. Zero is a real value here and it has its own test.
Probed: `expected 5 to be +0`.

### The gap is listed, not just repaired

`listProfilelessOrganisers` returns the accounts this bug produced, and `/admin/users`
renders them in a blocked-tone card with a per-account repair control. It is a permanent
query rather than a one-off backfill script because accounts can still arrive from other
paths — the seed, an import, a hand edit in Postgres — and every one of them can produce
this state again.

The repair asks the operator for the display name instead of deriving it from the email
local-part, because that name is what a diner reads next to a share link; `bujin1984` on
a stranger's link is not a name. It refuses an account that already has a profile rather
than silently succeeding, since a "repair" that reports success on a healthy row means
whatever flagged the row was wrong. Probed by loosening the guard to `if (!user)`:
two failures, including the MERCHANT case — a `where: { organiser: { is: null } }` with
no `role` filter matched **521 rows** in the dev database, i.e. every merchant in it.

### Also noted, not fixed

`createMerchantWithOwner`'s docblock says it writes three rows "in one transaction". It
does not: `createUser` runs as a separate statement before the merchant create, and only
the `MerchantUser` link is nested. A crash between them leaves a `MERCHANT` user with no
merchant — the same shape of defect as this one, one path over. It is left alone here
because changing merchant onboarding is a different slice with a different blast radius,
and it is recorded as gap 15.

## M7 — FR-905, the screen that answers "it told me to sell at $9"

`FR-905 | View raw AI drafts and guardrail results | For debugging merchant complaints`
— PRD-v1.md:552.

| Piece | Where |
|---|---|
| The query, and the floor it has to derive | `src/lib/db/admin-ai-drafts.ts` |
| The list | `src/app/(admin)/admin/ai-drafts/page.tsx` |
| One run in full | `src/app/(admin)/admin/ai-drafts/[id]/page.tsx` |
| The way in, from a complaint | the “AI runs” card on `/admin/merchants/[id]` |
| Tests | 17, real Postgres (`src/lib/db/__tests__/admin-ai-drafts.test.ts`) |

`AiDraft` has recorded the answer since M3. Nothing had ever read it back: the table
was written by `persistAuditRow` and read only by its own test. So a merchant who
phoned about a price got "we'll look into it", which is what this screen replaces.

### The floor is not in `inputJson`, and reading it there type-checks

`persistAuditRow` stores four costs and `floorPctOfMenu`. It does **not** store
`minViablePriceCents` — the floor rides on each `PlannedProposal` instead. My first
version of the loader read `inputJson.minViablePriceCents`, which compiles, returns
`null` for every row ever written, and turns the screen's central number into a
permanent dash. Probed by substituting exactly that line: `expected null to be 1150`,
on the test that asserts a real number, plus the older-shape test. The floor is now
`Math.min` over the proposals' `minViablePriceCents`, and a run with no proposals
reports `null` rather than inventing a zero.

This is worth naming because nothing would have caught it later: the page renders `—`
for a missing value, and `—` is a plausible thing to see on an old row.

### `AiDraft.merchantId` has no foreign key, so the join is a lie the types tell

The `CREATE TABLE` in `20261028120000_init` declares `merchantId TEXT NOT NULL` and
an index, and the migration's FK block never mentions `AiDraft`. A draft can therefore
outlive its merchant — and `persistAuditRow` swallows its own write failures on
purpose, and the table's whole reason for existing is to answer a complaint *months
later*. The case where the merchant is gone is not hypothetical; it is the case.

Prisma types a required relation as non-null, so `merchant: { select: { name: true } }`
compiles, returns `null` at runtime for a dangling id, and throws `TypeError` at a page
with no error boundary. It would have taken the whole list down for one bad row.

So the name is a second `findMany` over the distinct ids, `merchantName` is
`string | null`, and an orphan row renders as "Merchant no longer on file" with its
run intact. Probed by fabricating a name — one failure, on the orphan test.

**The relation is deliberately still not added.** It needs `onDelete` decided:
`Cascade` deletes audit rows when a merchant is deleted, defeating the point of an
audit trail; `Restrict` means a merchant that ever asked for proposals can never be
deleted. Either choice is a retention decision, and this slice is not about retention.
It is recorded as gap 14 below so it does not get lost, and the first thing the
migration would do is fail its own FK validation on any historical orphan.

### `guardrailPassed` is a tautology, and the screen says so out loud

`persistAuditRow` writes `true` by construction — nothing unvalidated can reach
storage. Rendering a green tick beside it would present a statement about what the
database accepts as a check that ran and reported. Both pages state the stored value
and then state what it means, and the real evidence — margin, menu price, costs, and
the floor those produced — is lifted out of the JSON into `<dl>` rows instead of being
left in a blob.

### Everything else is defensive on purpose

The two `Json` columns hold whatever the current prompt version wrote, and the screen
exists to look at *old* rows. A strict parser breaks the list for every operator the
moment a shape changes. So the readers degrade: a non-array `proposals` yields `[]`,
entries that are not objects are dropped, a string `inputJson` yields five `null`s, and
the raw pretty-printed JSON is always on the page as the fallback for a field the
loader does not lift. Probed with a throwing parser: three failures, including the
no-writes test.

A row is the exhibit in a merchant dispute, so nothing in this module writes — and
that is asserted against a row the test itself creates, for a reason worth recording.
My first version snapshotted a row that earlier tests had already loaded, so a write
inserted into the loader had already happened before the "before" snapshot and the
probe **passed**. The assertion was order-dependent and self-defeating. Repaired, the
same probe fails one test, correctly.

## M7 — FR-903 reaches a human, and the audit row it turned up missing

`FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe refund
created` — PRD-v1.md:550.

| Piece | Where |
|---|---|
| One drop, every participant, eligibility included | `src/lib/db/admin-drop-detail.ts` |
| The per-participant control | `src/components/admin/ParticipantRefundControl.tsx` |
| The screen | `src/app/(admin)/admin/drops/[id]/page.tsx` |
| The audit rows, gap 13 | `issueParticipantRefund` in `src/lib/refunds/participant-refund.ts` |
| Tests | 7 (detail query, real Postgres) + 3 (audit ordering) + 3 (route branches) |

### The same defect FR-901 closed, one level down

FR-901 listed drops and put a force-fail on each — which refunds *everyone*. It gave
no way to reach one diner, and the refund endpoint keys on a **participant** id that
no page rendered. So FR-903's acceptance criterion ("ledger adjusted; Stripe refund
created") was genuinely met and, at the same time, the requirement was not: the only
way to exercise it was to read a uuid out of Postgres and `curl` it. Two slices in a
row now, the pattern is worth naming — **an operator capability is not delivered until
a page renders it**, and the acceptance column of the PRD cannot say so because it
describes effects, not surfaces.

### Eligibility is `refusalFor`, not a second predicate

The detail query calls the *same* function `issueParticipantRefund` refuses by, and
passes its `publicMessage` through as the row's refusal sentence. The tempting
alternative — `chargeStatus === 'CAPTURED'` — is wrong in a way that is invisible on a
settled drop: it offers a refund on a `LOCKED` drop, where the sweep is about to void
or capture and a refund races it. Probed by substituting exactly that predicate: one
failure, `expected null not to be null`, on the test written for the case.

Carrying the sentence rather than a boolean is the second half. A `canRefund: false`
would force the UI to invent its own explanation, and the two would drift the first
time a guard was added. The row stores the sentence the server would have thrown, so a
greyed control explains itself.

### Gap 13 — closed, and it was worse than a stale comment

`audit(log)`'s `AuditAction` has declared `'participant.refund'` since FR-902, and
`AuditLog` has existed since the same commit. Nothing wrote the row. The type system
could not see it (an unused union member is not an error) and neither could the suite
(nothing asserted a row existed), which is why it survived four slices.

Now: two rows, `REQUESTED` before `port.refund` and `COMPLETED` after — the shape
`cancelDrop` and `forceFailDrop` already use. The ordering is the guarantee, not a
style choice: `writeAuditEntry` throws, so if the insert fails no provider call has
happened. Probed by moving the insert below the provider call — one failure, the
watching port fired (`expected 1 to be +0`), and the test names the property.

Two things this forced, both correct:

- `reason` became **required** on both the service and the route. A money movement
  with no stated justification is the thing the trail exists to prevent, and an
  optional field would have been a convention callers forget.
- The actor's **email** became a required argument, read from the `User` row in the
  route — because `SessionClaims` deliberately carries no email (it would go stale),
  and `AuditLog.actorEmail` is what survives when `actorUserId` is `SetNull`.

The existing refund tests then failed on `AuditLog_actorUserId_fkey`: a fabricated
`'admin-1'` is not a `User`. That is the constraint doing its job — an audit trail
naming a user who does not exist is not a record of anything — so the tests now create
a real actor and a shared `ACTOR` constant, and one of them deletes the actor to prove
the route 401s before touching money.

### Not proven

**Nobody has loaded this page either.** The query, the audit ordering and the route
branches are tested against real Postgres; the two client controls are review and
`tsc` only. Gap 12 covers both admin screens now, and the checklist there is the one
to run.

## M7 — FR-901, and the capability that was never reachable

`FR-901 | List/filter all drops by status |` — PRD-v1.md:548; endpoint at
PRD-v1.md:889.

| Piece | Where |
|---|---|
| The query, and why it is its own module | `src/lib/db/admin-drops.ts` |
| `GET /api/admin/drops` | `src/app/api/admin/drops/route.ts` |
| The screen | `src/app/(admin)/admin/drops/page.tsx` |
| FR-902's missing client half | `src/components/admin/ForceFailControl.tsx` |
| The one shared status list | `FORCE_FAILABLE` / `isForceFailable`, `src/lib/admin/force-fail.ts` |
| Nav entry | `src/components/AppNav.tsx` |
| Tests | 10 (query, real Postgres) + 7 (route) + 2 (list agreement) |

### Why this was worth a slice, when the endpoint is the smallest part of it

Because every admin capability built so far was reachable only by composing an HTTP
request — which means, in practice, not reachable. `force-fail/route.ts` has carried a
docblock since FR-902 saying the double confirmation is "the client's" and that no
client existed. FR-903's refund endpoint says the same. So M8 was marked ✅ with three
requirements whose UI obligations were all deferred to a screen nobody had built, and
the honest status of FR-902 was *"the server half is done and the requirement is not
met"*. This page is that client.

### The chip-counter bug, caught in the page I had just written

`countsByStatus` comes from a separate unfiltered `groupBy` — that part was right, and
it is the thing a filter bar usually gets wrong. But the **"All" chip** read
`list.rows.length`, which under `?status=FAILED` is the *filtered* count: the bar would
read "All 3" beside "FAILED 3" for a table of eight drops. Plausible-looking and
useless, which is exactly what the docblock thirty lines above it warned about.

Fixed by adding `totalDrops` to the query's return, derived from the same unfiltered
read (`Σ countsByStatus`) so the two cannot drift, and exposing it on the wire too.
Probed by making it `rows.length` again: one failure, `expected 1 to be 6`. The route
test did **not** catch it, which is the point — the bug lived in the page, and the page
has no test, so the fix had to move the number somewhere a test could see it.

### Why `admin-drops.ts` is a new module rather than a parameter on `db/drops.ts`

`db/drops.ts` is merchant-scoped **by construction**: every function takes
`merchantIds` and filters by it, and that is what makes a foreign drop id a 404. An
admin list asks the opposite question — it spans tenants on purpose. Reusing that module
meant either passing every merchant id (a query that grows with the customer base) or
adding an "all" escape hatch to the one module whose entire job is to be scoped. The
escape hatch is how a scoped query eventually gets called unscoped from a merchant page.

### `capturedCents` is money still out there, not money ever charged

`Σ (order.subtotalCents − order.refundedCents)`. A drop already partly refunded by hand
(FR-903) must not present its original total as the amount a force-fail would return —
that number is shown back in the confirmation dialog, so getting it wrong would
misstate the consequence at the exact moment the operator is deciding. Probed: making it
ignore refunds fails one test, `expected 3000 to be 2600`.

### The disagreement that is now structurally impossible

The screen decides **per row** whether to offer a force-fail. If that were
`status !== 'COMPLETED'` or any hand-written list, the UI would offer a button on a
`LOCKED` drop whose only possible outcome is a 409 — teaching the operator that the
button exists and the server is broken. So `FORCE_FAILABLE` and `isForceFailable` are
exported from `force-fail.ts`, and two tests walk every status asserting the screen and
the service agree. Probed by replacing `isForceFailable` with `status !== 'DRAFT'`: one
failure naming `LOCKED`, the most expensive status to offer, since a refund mid-capture
writes the ledger twice.

### The refusals are reported, not swallowed

`?status=WHATEVER` is a 200 with every drop plus `requestedStatus`, `appliedStatus` and
`filterIgnored` — not a 422, and not a silent unfiltered list. A filter that quietly
matches nothing is indistinguishable from a filter that found nothing, and on this
screen that difference is "there are no failed drops" versus "you are looking at the
wrong list".

### Not proven

**Nobody has loaded the page.** No browser has rendered it; the query and the route are
tested, `tsc` and `eslint` are clean, and the screen is verified by review — this repo
has no `.tsx` tests by design. `ForceFailControl` is the first admin control ever
rendered, so the click path has never executed. Same gap as cancel's.

Also unproven and now recorded as a *gap* rather than a comment:
**`issueParticipantRefund` writes no `AuditLog` row.** The table has existed since
FR-902 and `AuditAction` has declared `'participant.refund'` since the same commit, but
the only manual-refund path still only logs the reason. FR-903 will put a button on
that endpoint, which makes it the next thing worth fixing.

## M8 — FR-904, and the refresh path that would have erased it

`FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log` —
PRD-v1.md:551; the admin's "everything, plus … impersonation" at PRD-v1.md:105.

| Piece | Where |
|---|---|
| The claim, its bounds, the constructors | `src/lib/auth/jwt.ts` |
| Start / end / the refusals | `src/lib/auth/impersonation.ts` |
| The read gate and the write gate | `refuseIfImpersonating`, `requireMerchantWrite` in `src/lib/auth/authorize.ts` |
| Mint the session | `POST /api/admin/merchants/:id/impersonate` |
| Give it back | `POST /api/auth/impersonation/end` |
| The standing warning | `src/components/merchant/ImpersonationBanner.tsx`, mounted in `(merchant)/layout.tsx` |
| Choosing who to view | `listMerchantMembers`, `src/components/admin/ImpersonateControl.tsx` |
| The 403 it produces | `src/middleware.ts` step 3a |

No migration. The `AuditLog` row FR-902 introduced already carries everything this
needs; `stage` became `STARTED` / `ENDED` and `startAuditId` links the two.

### `signSession` is the refresh path as well as the login path

This is the defect the feature walked into, and it is the reason the claim's handling
is written the way it is.

`signSession` issues the cookie at login. It is also what middleware calls whenever a
live session is inside the 15-minute sliding window — so on any long visit it is the
*normal* path, not an edge case. An impersonation session is 30 minutes long, which
means **roughly half of every impersonation is running on a re-signed token.** If that
function had built the new token from `userId`/`role`/`mustChangePassword` and stopped
there, the first refresh would have produced a plain `MERCHANT` session for the same
user id and the claim would be gone. Concretely, all of this at once, silently:

- the read-only guard stops firing — the admin can now mutate the merchant's account;
- the audit link is lost, so `ENDED` can never be tied to `STARTED`;
- `/api/auth/impersonation/end` answers "you are not impersonating anyone";
- the admin is left holding a merchant cookie, with their own admin role gone.

No error. No log line. A 30-minute session that becomes a permanent one, and the only
symptom is a support engineer wondering why the button says "End session" on a page
that no longer shows a banner.

So `signSession` carries `imp` through every re-sign, and `expiresAt` is recomputed as
`min(now + 60m, absoluteExpiresAt, imp.expiresAt)` — an impersonation cannot be extended
by activity, only ended by the clock. The invariant is pinned by a test that runs the
refresh path explicitly and asserts the claim survives it. Deleting the `imp` spread
fails **two** tests and nothing else, which is the check that the test is guarding the
line and not the file.

### An impersonation is refused by the write gate, not merely hidden by the UI

Read-only here is a server rule. `requireMerchantWrite()` is `requireMerchant()` plus
`refuseIfImpersonating()`, and all **eleven** mutating merchant handlers call it —
`ai/deal-builder`, `drops` POST, `drops/[id]` PATCH, `drops/[id]/publish`, `items` POST,
`items/[id]` PATCH, `items/[id]/guardrail`, `pickup`, `redeem`, `settings`, and
`stripe/onboard`.

A route handler that forgets this is the failure mode, so the discipline is not a
convention in a docblock: `impersonation-readonly.test.ts` walks `src/app/api/merchant/**`,
asserts a floor on how many files it found (so a broken glob cannot pass by finding
nothing), asserts it saw both `GET` and mutating exports, and then asserts **per
mutating handler** that the file calls the write gate. Reverting `settings/route.ts` to
`requireMerchant()` fails exactly two tests and both name the file.

The refusal is also checked **before** the body is parsed. A borrowed session that
POSTs malformed JSON gets the read-only sentence, not a 422 about its payload —
otherwise the validation errors become a free schema oracle, and the first thing the
admin learns is that their write was *shaped* wrong rather than that it was never going
to be allowed.

### The exit route cannot live under `/api/admin`, and that is structural

The obvious home for "end impersonation" is `/api/admin/impersonation/end`, beside the
route that starts it. It cannot be. Starting an impersonation **replaces the admin's
cookie with a `MERCHANT` cookie**, and middleware gates `/api/admin` on role. The route
that gives the admin their account back would be behind the gate their borrowed account
cannot pass — they would be locked in for the full 30 minutes, in a read-only view,
with no way out but clearing cookies.

So it lives at `/api/auth/impersonation/end`, where the authorisation is the **signed
claim** rather than the role. `endImpersonation` reads the actor id out of `imp.a`,
re-checks that the actor is still an `ADMIN` in the database, and only then writes
`ENDED` and returns session claims rebuilt from that user's current row. A demoted or
deleted admin gets a 401 — and, because the cookie is simultaneously cleared, does not
keep a borrowed session in the browser while being told it is invalid. Both branches
have tests, and the body never names the admin's email: the merchant may be screensharing.

The same asymmetry explains the middleware branch. An impersonation session that
reaches `/admin` or `/api/admin` gets a 403 with `{ error: 'IMPERSONATING' }`, or a 307
back to `/merchant/drops` for a page request. It deliberately does **not** use `deny()`,
because every non-API 403 there redirects to `/change-password`, which would tell an
admin mid-support-call to change a password they are not using. A test asserts the
redirect target specifically, because "redirected somewhere" is not the property.

### The banner is in the layout because the twelfth page does not exist yet

`(merchant)/layout.tsx` renders for every route in the group, so one mount covers all
eleven merchant pages and whatever gets added next month. A banner placed per page is
the same class of mistake as a write gate placed per handler without a test: correct on
the day it was written, quietly absent from the next thing.

It is the *hint*, not the rule — the rule is in `authorize.ts` regardless. But a hint
that appears on only some pages is worse than none, because its absence reads as "this
account is mine". It shows the merchant being viewed, the admin doing the viewing, a
live countdown, and the audit id; the countdown starts at `'—'` and fills in on the
first client tick rather than rendering a server-computed second and jumping.

### A malformed claim rejects the token, not the claim

`verifySession` returns `null` for the whole token if `imp` is present but wrong — not
an object, missing a field, an empty string, a non-finite `e`, or an `e` in the past.
The alternative is to drop the unreadable claim and honour the rest, which would turn a
corrupted impersonation into a fully privileged merchant session: the guard would read
"not impersonating" and wave the write through. Ignoring bad security data is how bad
security data becomes an authorisation bypass, so the token is simply not valid.

`newSession` deliberately cannot mint an impersonation — its argument list is closed, and
`newImpersonationSession` is the only constructor that sets the claim, with
`absoluteExpiresAt` fixed at 30 minutes and no parameter to raise it. There is a test
asserting the two paths are not interchangeable.

### Not proven

**The flow has never been driven through a browser.** Both routes, both components, the
middleware branch and the gate are unit- and integration-tested, including against real
Postgres for the audit ordering, but nobody has clicked "Open read-only session" and
watched the banner appear. The layout mount is asserted by reading the component tree,
not by rendering it — this repo has no `.tsx` tests by design (`environment: 'node'`,
`include: ['src/**/*.test.ts']`), so the banner's own behaviour is verified by review
and by `tsc`, and that is a weaker claim than the rest of this file.

**`impersonation_readonly` is enforced per handler, not by the framework.** The walk in
`impersonation-readonly.test.ts` only sees files under `src/app/api/merchant/**`. A
mutating merchant operation added outside that tree — a server action, a new route
group — would not be caught until the walk's roots are extended. The docblock says so;
it is a real edge and not a hypothetical one, because server actions are the obvious
way somebody would add the next mutation.

## M8 — FR-903, and the ledger defect it exposed

`FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe refund
created` — PRD-v1.md:550.

| Piece | Where |
|---|---|
| The refund itself | `src/lib/refunds/participant-refund.ts` |
| The endpoint | `POST /api/admin/participants/:id/refund` |
| Two new `Order` columns | `refundedCents`, `platformFeeReversedCents` (migration `20261102233154_order_refund_totals`) |
| The reported fee reversal | `RefundOutcome.applicationFeeRefundCents`, read from `ApplicationFee.amount_refunded` |

### The defect a partial refund exposed

`refundEntries()` wrote `−order.platformFeeCents` — the **whole** application fee —
while taking `refundedCents` as an argument. Every caller passed a full refund, so it
was correct and untested against any other input. Under a partial refund it would
have written a phantom credit of about half the fee on this repo's 8% rate, and
**no identity would have caught it**: the surplus landed in `ADJUSTMENT`, which L3
does not read, and L1–L3 partitioned orders by a `refunded` **boolean** that cannot
represent "half".

So the ledger changed before the feature could be honest:

- `LedgerOrder.refunded: boolean` → `refundedCents` + `platformFeeReversedCents`.
- L1–L3 are **net** sums over all orders; L4 gained per-order checks on the refund
  and on the reversal, because two orders wrong in opposite directions cancel in an
  aggregate.
- `refundEntries` takes the reversal as an argument. It does not compute it.

### Why the reversal is Stripe's number

Stripe documents that a partial refund reverses *"a proportional amount of the
application fee"* and **does not document the rounding** — no formula, no minor-unit
rule, nowhere in the Connect docs. Any figure we computed would be our guess presented
as fact, wrong by a cent on roughly half of partial refunds. `real-charge-port.ts`
therefore reads `ApplicationFee.amount_refunded` back from the charge with
`expand: ['application_fee']`, and refuses to proceed if it cannot — a retry is safe
because `refundKey(participantId)` is stable.

`fake-charge-port.ts` models the proportion with `proportionalApplicationFeeRefund()`
so test fixtures are not magic numbers. That function is **not** called by the real
port, and the asymmetry is deliberate.

### Not proven

**No refund has ever been created against Stripe.** `real-charge-port.ts` has never
been executed at all — see its docblock and gap 4. What is proven is the ledger
arithmetic, the guards, the transaction, and the reconciliation, all against real
Postgres with a fake provider. The first test-mode partial refund is still the
evidence that matters, and the number to check is whether
`ApplicationFee.amount_refunded` matches what we store.

**V1 permits one refund per order.** `@@unique([orderId, type])` allows a single
`REFUND` row, so a second refund is refused with a sentence rather than attempted.
Correcting a refund that was too small is a Stripe-dashboard action plus a
reconciliation note until that index is revisited.

~~**No audit log.**~~ **Added in the FR-902 slice.** `AuditLog` and
`lib/audit/log.ts` now exist; see below. Before that model, this slice logged
`admin.participant_refunded` with the actor and the operator's reason, which was a log
line and not an audit trail: no retention guarantee, not queryable by participant. The
log line is still written, and the row is what makes it a record.

## M8 — FR-902, the audit trail, and the ordering it forces

`FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry` —
PRD-v1.md:549; endpoint at PRD-v1.md:883.

| Piece | Where |
|---|---|
| The cancellation and every refund | `src/lib/admin/force-fail.ts` |
| The endpoint | `POST /api/admin/drops/:id/force-fail` |
| The audit trail | `prisma.AuditLog`, `src/lib/audit/log.ts` (migration `20261102235649_audit_log`) |
| The public page state | `OfferPhase.CANCELLED` in `src/lib/public/drop-view.ts` |
| The message copy | `DROP_CANCELLED_REFUNDED`, `DROP_CANCELLED_NO_CHARGE` in `notify/copy.ts` |

### `CANCELLED` was a phase the state machine could not describe

`CANCELLED` had been listed in `VOID_SWEEP_STATUSES` since ADR-005 — the docblock there
predicted exactly this slice — but **nothing wrote it**, and `resolveDropView` had no
branch for it. The status is not in `SETTLED_STATUSES` and it is not `FAILED`, so it
fell through to `thresholdMet`: a called-off drop with thirty orders rendered as
`CONFIRMED` and told diners *"We're charging cards now"*, and one cancelled before its
cutoff on a short count rendered as `OPEN` with a live join button.

That branch had to land in the same slice as the writer, because until then no test
could see it — the status was unreachable. Five tests now pin it, and mutation-probing
the branch away fails four of them.

`CANCELLED` is its own phase rather than a shade of `FAILED` because the two make
different claims: `FAILED` says demand fell short, `CANCELLED` says somebody decided.
A diner on a 30-order drop told "this didn't reach 20" would reasonably conclude the
page was broken, and the same sentence sits next to a true one about their money —
which is exactly why a false half would be believed. The copy carries the distinction
through to the SMS.

### The audit row is written before a cent moves

`writeAuditEntry` throws rather than swallowing. Its docblock says a caller must not
refund every participant if the record of who authorised it could not be written, and
`forceFailDrop` makes that structural by writing the row **first** — before any
provider call. If the insert fails, nothing has been refunded and the drop is
untouched. The cost is a row naming an action that then failed partway; for an
irreversible operation a record of an attempt is worth more than its absence, so the
trail carries two rows: `stage: REQUESTED` (the intent, the counts, the amount about to
move) and `stage: COMPLETED` (what actually moved). A later reader can tell them apart.

This is asserted, not just described: a test induces a real insert failure — an
`actorUserId` with no `User` row, so the foreign key rejects it — and then checks that
no `REFUND` ledger row exists, no `Order` total moved, no participant left `CAPTURED`,
and the drop is still `CAPTURED`. Reordering the write to after the refund loop fails
that test and only that test.

### Append-only is proved by grepping the source tree

A docblock cannot keep the append-only promise. `audit-append-only.test.ts` walks all
of `src/` and asserts three things: `lib/audit/log.ts` is the **only** file calling
`auditLog.create`; no file calls `update`, `updateMany`, `upsert`, `delete` or
`deleteMany` on it; and no raw SQL names the table. Comments are stripped first, so
the docblock's own prose about `.delete` does not trip it, and the scan includes
`__tests__` — a test that truncates the table to make itself repeatable is the
violation the guard is for. Planting an `auditLog.delete` in `log.ts` fails it.

### The refund mechanics are shared; the outcome is not

`finaliseFailed` already refunds everyone and was the obvious thing to reuse. It is
wrong twice: it needs a `LockedDrop` snapshot the admin path cannot honestly build, and
it writes `FAILED`, which would tell every diner and every report that the drop missed
its minimum. So `forceFailDrop` shares the *mechanics* — `refundKey`, `refundEntries`,
`assertLedgerReconciles`, and the same CAS-guarded per-order transaction shape — and
owns its own outcome.

A `LOCKED` drop is refused outright: settlement holds it and is about to capture, so a
refund now would race that job and write the ledger twice. A `DRAFT` is refused because
it has never been published. A `PUBLISHED` drop with no captures is accepted — there is
nothing to refund and the holds are released by the same sweep.

### The double confirmation is half client, half server

The PRD asks for two confirmations. One is the client's dialog. The other is the
request body: it must echo the drop's `publicCode`, and a mismatch is refused before
any money moves. That is the strongest form HTTP allows — any client can POST twice —
but it is the difference between a request that names its target and one that acts on
whatever id a stale tab held. The second call on an already-`CANCELLED` drop returns
`alreadyCancelled: true` and moves nothing.

### `refundedCents` means what this call refunded, and nothing else

The first draft accumulated earlier manual refunds into the reported total, and the two
paths disagreed about whether that happened — a participant already marked `REFUNDED`
was filtered out before the counting loop, while one left `CAPTURED` with a non-zero
total was added inside it. The same drop could report two different figures depending
on which half-finished state it was in. It is now two disjoint fields:
`refundedCents` (this call) and `alreadyRefundedCents` (already returned by an FR-903
refund), and neither absorbs the other.

### Not proven

**No refund has ever been created against Stripe.** Same gap as FR-903: the whole
suite runs against a fake provider. What is proven is the ordering, the ledger
arithmetic, the CAS, the sweep, and the audit trail, all against real Postgres.

**The two-factor confirmation is only as good as the admin UI** — and that UI now
exists. `ForceFailControl` renders on `/admin/drops` (FR-901): typed public code, a
reason, and the refundable amount shown as *approximately* before the press. So the
requirement is met on paper and by construction. It has still never been clicked: no
browser has loaded the page, which is gap 12.

**There is no idempotency key**, which PRD-v1 §11 asks of every mutating endpoint. The
second call is already a no-op, so a key would add a table this slice does not have in
exchange for no behaviour — a real gap, recorded rather than papered over.

## Known gaps and risks

1. **The join UI exists but is unreachable from the deal page.** The page ships
   at `/d/[publicCode]/join` (2b) and renders correctly in both keyed and keyless
   states, but `JOIN_FLOW_PROVEN_LIVE` is `false` so nothing links to it. One flag
   flip after a live run is all that remains — do not flip it on the strength of
   the fake, and note that flipping it alone is still not enough on a keyless
   deployment: `resolveJoinGate` keeps the button shut.
2. ~~**No diner-facing code page (P0 once join ships).**~~ **Fixed in 2c.** Codes are
   minted at capture and now render on `/d/:publicCode/mine`, reached by a tokenised
   link that is **not** the code. No QR is generated; a diner shows the alphanumeric
   code or the link.
3. **SMS is a seam only.** No provider (D-5), no sender. The link is now composed
   with a real origin (`APP_URL`, via `notify/public-origin.ts`) rather than missing,
   so what remains is delivery alone. FR-408 and FR-506 cannot be called done.
   Consent *is* recorded at join.
4. **Stripe is named in config but unkeyed in practice.** `.env.example` and
   `src/lib/config.ts` declare `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, but no key exists here.
   **The client deps landed in 2b**: `@stripe/stripe-js` and
   `@stripe/react-stripe-js` are now installed, so the Element *would* render if a
   key appeared. A missing key is no longer a code gap, only a credential gap —
   and the page says so out loud (`PaymentsNotConfigured`) instead of drawing a
   card field that cannot work.
5. **Analytics now covers the diner funnel** — `deal_page_viewed`, `join_started`,
   `join_authorised`, `join_failed { reason }`, `threshold_reached`,
   `drop_published`, `drop_locked`, `drop_failed`, all emitted and tested, so
   PRD §10.2's **join conversion** (authorised ÷ deal page views) and
   **threshold hit rate** (reached ÷ published) finally have both inputs.
   Two subtleties are load-bearing rather than cosmetic:
   - **Link-preview fetchers are not views.** Every drop is distributed by pasting
     a URL into a group chat, so the first request for a new link is usually
     WhatsApp's or WeChat's unfurler. Counting those adds one guaranteed "viewer"
     per share, so the better a drop is shared the *worse* its conversion looks.
     `isHumanView` requires `sec-fetch-mode: navigate` and a non-bot user agent.
   - **The threshold counts `AUTHORIZED` only**, while capacity counts `PENDING`
     too. Proven, not asserted: switching the threshold query to include `PENDING`
     makes a drop report reaching its minimum on an unconfirmed card.
   Still absent from §10.1: `drop_created`, `drop_cancelled`, the `capture_*`
   pair, the `redemption_*` pair, `report_viewed`, `ai_draft_generated`.
6. ~~**One pre-existing test failure.**~~ **Fixed.** The suite is green.
   What it was, because the first write-up of it had the direction backwards:
   **Alberta adopted permanent DST on 2026-11-01** and stays on UTC−6 year-round
   instead of falling back to UTC−7. `plan.ts` was right; the *fixture* was stale.
   The old note blamed "this host's tzdata", which would have sent the next
   reader to patch a correct module. Corrected diagnosis, and the fixture fix:
   - the label is now asserted on a **July 2027** instant, which is UTC−6 under
     every tzdata release old and new, so this cannot rot the next time the
     database moves;
   - the width of the window is asserted offset-independently, since the span is
     the one property no time zone can change;
   - a second test asserts the label in `UTC` too, so a silent fallback to
     server-local time shows up as a wrong label rather than passing by luck.
   Both assertions were verified to fail when the corresponding bug is injected.
7. **OTP ambiguity.** PRD-sprint1 §9 lists "SMS OTP" for M4; no FR specifies it.
   Do not build it without an explicit decision.
8. **M5 live capture unverified.** The real charge port test skips with a named
   reason. Until a test-mode key exists, "capture works" is a unit-test claim.
9. **The join's real port has never run against Stripe — but it has now run against
   `stripe-mock`, which is not nothing.**
   `join/real-payment-port.ts` is transcribed from documentation, like
   `real-charge-port.ts` before it. As of the contract suite it *has* been executed
   for real: the actual port, the actual `stripe` SDK, over HTTP, against a server
   that validates every parameter against Stripe's OpenAPI spec (612 validators).
   That proves the **request construction** — which is what a transcription error
   breaks — and it caught nothing, so the shape is right.
   **What it still cannot prove**, and this is the part to keep reading:
   `stripe-mock` is stateless and returns a fixed fixture per endpoint, so
   `POST /v1/payment_intents` always answers `status: "requires_payment_method"`.
   A successful manual confirmation is therefore **unreachable on the mock by
   construction**, and the contract suite asserts the port's refusal of that fixture
   rather than a success. Still unverified, with a real key only:
   - that a real confirmation yields `requires_capture`;
   - that a real decline arrives as `StripeCardError` with a usable `decline_code`;
   - that the intent is created on the **merchant's** account (the mock accepts any
     `Stripe-Account` header without checking it exists).
   Treat the first failure against Stripe as a bug in that file before a bug in a
   diner's card — ADR-001 §4 is the precedent for documentation being wrong here.
   A green suite still never means "joining works".
10. **FR-904 has never been driven through a browser.** Both routes, the middleware
    branch and the write gate are tested, the audit ordering against real Postgres.
    But nobody has clicked "Open read-only session" and watched the banner appear,
    and this repo has no `.tsx` tests by design (`environment: 'node'`,
    `include: ['src/**/*.test.ts']`) — so the two components are verified by review
    and `tsc`, which is a weaker claim than the rest of this file. Related: the
    read-only walk in `impersonation-readonly.test.ts` only scans
    `src/app/api/merchant/**`, so a mutating merchant operation added as a **server
    action** or under a new route group would not be caught until its roots are
    extended. First end-to-end check: start a session, confirm the banner, try one
    write (expect the 403 sentence), end it, confirm the admin cookie is back.
11. **FR-208 has never been driven through a browser.** `cancelDrop` and its route are
    tested against real Postgres and real HTTP — including the interleaved race with
    the cutoff tick, and the FR-904 gate on a borrowed session — but `CancelDropButton`
    is verified by review and `tsc` only, because this repo has no `.tsx` tests by
    design. The first end-to-end check: publish a drop, join it from a phone, cancel
    from another browser, confirm the diner's card hold is released in the Stripe
    dashboard and the SMS names a released hold rather than a refund.
12. **Most admin and organiser screens have never been loaded in a browser**, and this is
    the one that matters most for the deferred UI obligations. `ForceFailControl` and
    `ParticipantRefundControl` are the **first admin controls ever rendered**, so
    FR-902's "double confirmation, audit log entry" and FR-903's per-diner refund both
    rest on buttons no human has pressed. Nothing on any of the three admin pages has
    executed — not the chips, not the filter links, not the dialogs, not FR-905's
    `<details>` blocks. All are verified by review, `tsc` and a clean build.

    **Partly closed since:** `/commission` and `/admin/commission` are now *rendered* by
    the suite — `src/lib/testing/render.ts` calls the real pages against real Postgres and
    asserts what the HTML says, so their branches and copy are no longer review-only. That
    removes "has never rendered" from this gap for two pages and leaves everything about
    *interaction* untouched: client components are not hydrated, so no `onClick` fires and
    a `useState` branch shows its initial value. Read the boundary at the top of
    `render.ts` before claiming anything else is covered. First
    end-to-end check: sign in as admin, confirm the chip counts
    match the table, filter by a status, open a drop, then
    (a) force-fail a `FAILED` drop with a deliberately wrong code first (expect the 422
    sentence) and a correct one second, confirming the response names the dollars
    refunded rather than silently refreshing; and
    (b) on a `CAPTURED` drop, refund one participant a partial amount and confirm the
    `ALREADY_REFUNDED` / `$X refunded` outcome renders, that the row's badge moves to
    `REFUNDED`, and that two `participant.refund` audit rows exist naming the signed-in
    admin's email; and
    (c) open `/admin/ai-drafts`, confirm the newest row is the most recent run, that the
    "from $X" figure matches the cheapest proposal on the detail page, and that the
    merchant filter link from `/admin/merchants/[id]` lands scoped with a way back; and
    (d) on `/admin/users`, switch the role to Organiser and confirm the three extra
    fields appear (and the optional name disappears), create one, and check it lands in
    the Organisers section with the commission typed; then insert a profile-less
    `ORGANISER` by hand and confirm the blocked-tone repair card appears, that the form
    repairs it, and that the row moves out of the card and into the list. The
    conditional form is `useState`-driven and **has never been rendered**, so a mistake
    in it (a field that does not appear, or one that appears for the wrong role) is
    invisible to `tsc` and to the suite; and
    (e) **the organiser walkthrough, which is Journey B's acceptance test.** Sign in as
    an organiser (not an admin — the role gate is a different path), confirm the drop
    list shows live drops soonest-deadline-first, then count the taps: one on "Get
    share link", one on "Copy message", and nothing in between. Paste into a chat and
    confirm the message is four lines with a real price, a real deadline in the
    merchant's zone, and a working link. Open that link in a second browser and confirm
    the deal page loads and the `clicks` count on `/organiser` goes up by one; reload it
    twice more and confirm it goes up twice more, then fetch it with `curl` (no
    `sec-fetch-mode: navigate`) and confirm it does **not** — that is the unfurler gate.
    Then join through the link and confirm `DropParticipant.shareLinkId` is set for that
    row. The clipboard path is the first in the app and the least verifiable from a
    test: a browser that refuses `navigator.clipboard` must show the manual-copy
    sentence rather than a "Copied" that copied nothing; and
    (f) **the commission statement.** ~~Open `/commission` as an organiser, confirm the
    restatement sentence renders above the figures, step the month selector back and
    forward, and confirm a month with no activity says so rather than rendering an empty
    table. Then feed `?month=nonsense` and confirm the page names the month it could not
    read — `?month=a&month=b` is the variant that broke.~~ **Mostly closed, without a
    browser.** `src/app/(organiser)/commission/__tests__/page.test.ts` now renders the
    real page against real Postgres and asserts all of the above as text and hrefs,
    including `?month=a&month=b`. What remains for a browser: **download the CSV and open
    it in a spreadsheet** — the route is fetched and its `commission_cents` column is
    summed to the printed total in the test, but nobody has opened the file in Excel, and
    `Content-Disposition` has never made a browser save anything.
    **(g) the admin roster.** Open `/admin/commission`, confirm the live-not-frozen
    sentence renders and the total matches the sum of the rows, then download the CSV and
    check the `commission_cents` column sums to the `TOTAL` row — the same property as
    (f), one level up. Confirm an organiser with no activity shows `no activity` and a
    dash rather than `$0.00`, and that `?month=nonsense` names the month it ignored.
    None of this is browser-verified yet: it is asserted at the query and route level
    only, and the page itself has never been rendered in a browser. Nor is either
    organiser **API** route: they are driven as handlers with a `NextRequest`, so the
    `middleware.ts` gate on `/api/organiser` has never been hit by a real request. First
    end-to-end check: `curl` both as an organiser (a 401 without the cookie, a 403 as a
    merchant, a 200 with a token), then take that token from the API's `url` and open it
    in a browser — the `clicks` count on `/organiser` must go up by one, which proves the
    route minted a token the public page accepts rather than merely a well-formed one.
13. ~~**`issueParticipantRefund` writes no `AuditLog` row.**~~ **Fixed.** The path now
    writes `REQUESTED` before the provider call and `COMPLETED` after, and `reason` is
    mandatory on both the service and the route — an optional one would have been a
    convention callers forget, which is how the gap opened. Probed by moving the insert
    below `port.refund`: the watching port fires and the test fails on
    `expected 1 to be +0`. The first attempt at the fix was rejected by Postgres with
    `AuditLog_actorUserId_fkey`, because the tests passed a fabricated `'admin-1'` —
    the constraint catching exactly the thing the trail exists to prevent.
14. **`AiDraft.merchantId` has no foreign key**, and the deletion policy for AI drafts
    is therefore undecided. The column exists and is indexed, but no `@relation` was
    ever declared, so a draft outlives its merchant — and `/admin/ai-drafts` handles
    that case explicitly rather than crashing (gap 14 is a *modelling* debt, not a
    live defect). Someone has to choose: `Cascade` (deleting a merchant erases its
    audit trail, which is the opposite of an audit trail), `Restrict` (a merchant that
    ever asked for proposals can never be deleted), or a retention job that prunes on
    age. Until then, do not "fix" it by adding the relation with a default `onDelete` —
    the migration will also fail validation on any historical orphan, which is why it
    needs a data decision before it needs a schema change.
15. ~~**`createMerchantWithOwner` is not the transaction its docblock claims.**~~ **Fixed.**
    It *said* it created "the merchant, the owner's MERCHANT account and the
    `MerchantUser{role: OWNER}` link" in one transaction, and it called `createUser` as
    a separate statement first — so only two of the three were atomic, and a failure
    between them left a `MERCHANT` account with no merchant: an account that signs in
    and is attached to nothing.

    It now runs all three writes (and `uniqueSlug`'s read) inside one
    `prisma.$transaction`, with `createOrganiser` as the template. Probed by
    un-wrapping the transaction and re-running: the failure is
    `expected 1 to be +0` on the orphan count, which is the defect stated as an
    assertion. The test forces a **real** Postgres error (`22021`, a NUL byte in a
    UTF-8 `TEXT` column) *after* the owner insert, rather than a mock — a spy on
    `prisma.merchant.create` would not fire, because the transaction hands the
    callback its own `tx` client, and that mistake was already made once in
    `organisers.test.ts`.

    Two things found while fixing it, neither of which was in the gap text:

    * **`slugify` mangled accented names.** `NFKD` splits `é` into `e` + a combining
      accent, and the `[^a-z0-9]+ → '-'` step then turned one letter into two
      separators: `Déjà Vu` became `de-ja-vu`. A name with nothing slug-worthy in it
      produced `merchant-`, trailing hyphen included. Both are fixed; `slugify` has one
      caller and no seeded slug depends on the old output, so nothing needed migrating.
    * **The slug read on `tx` does not do what I first wrote that it did.** My initial
      docblock claimed it closed a race. A probe against real Postgres showed two
      concurrent same-name onboardings **both succeeding** with distinct slugs
      (`race-…` and `race-…-2`), because the read and the insert are close enough
      together that the second transaction sees the first one's uncommitted row. The
      retry loop is what handles that case; the read on `tx` only keeps the decision on
      the same snapshot, and no test can distinguish it. The docblock now says that
      instead of the tidier, false version — over-claiming in a comment is the exact
      failure mode this gap was.
16. **FR-801's ranking is not `likelyFill`.** The organiser page orders by soonest
    cutoff, not by likely fill. §9.4 defines `likelyFill` as a function of the
    organiser's *history* — fill rate per merchant+item, group size inferred from the
    last drop, past success with a cuisine — and an organiser with no share links has
    none of those inputs. Ordering by deadline is the honest stand-in and it is
    documented as such in `lib/db/share-links.ts`, but it is a departure from the
    requirement's acceptance column and should not be forgotten. It becomes
    implementable once a few months of `ShareLink` history exist, and it belongs in a
    pure module beside `likelyFill`, not folded into the query.

    (FR-804 was the other half of this gap and is now built — see the M7 section above.)
17. ~~**The admin commission CSV does not exist.**~~ **Built.** `GET /api/admin/commission`
    serves every organiser's month in one file, plus `/admin/commission` to look at it
    first. The prediction in this gap was that it is "the same query with the organiser
    filter omitted" — it is not, and the difference matters: a filter-omitted `groupBy`
    would have been a **second implementation of the commission arithmetic**, free to
    drift from the organiser's statement with nothing to compare it against, because an
    organiser never sees the admin's number. It is built as a roll-up of
    `commissionStatementFor`, so both views are one computation. See the M7 section.
18. ~~**`POST /api/organiser/drops/:id/share` is declared in the PRD and not built.**~~
    **Built, and the gap was one route short.** The organiser role now has its full
    declared API surface: `GET /api/organiser/drops` and
    `POST /api/organiser/drops/:id/share`. PRD-v1.md:873–874.

    The original note said the capability "is delivered and tested; the *route* is not",
    and suggested it was "worth building when a second client exists, not before". Both
    halves were half right. The capability was delivered; the *interface* was also missing
    a read endpoint nobody had noticed, which meant a non-browser client could mint a share
    link for a drop id it had no way to learn. And a route is not only for a future client
    — it is the only way to prove the server action is not the product, because the two can
    be compared. See the M7 gap-18 section.

    Still true: no second client exists, so this route has no consumer yet. It is built to
    the spec, tested end to end, and recorded as unexercised over a socket.

    Two further PRD §12 entries are **not** gaps and are now recorded as departures
    instead: `staff/*` shipped as `merchant/*` (there is no `STAFF` role), and
    `/api/public/*` shipped as the server-rendered `/d/:code` and `/d/:code/mine?t=…`
    (the latter token-gated rather than code-gated, which is stronger than the PRD).
19. **The commission figure depends on the runtime's tz database, and that is now
    pinned but not eliminated.** `.nvmrc` pins `24.21.0` and `engines` floors at
    `>=24.0.0`, which excludes the observed stale case (Node 22.22 ships tzdata 2025c,
    which believes Alberta still falls back in November; it does not, as of 2026-11-01).
    The residual risk is that any host can ship a different database again: a tz rule
    change silently restates closed months, because the statement is a live query
    (decision 1) and the export at payment time is the only record. No test asserts an
    hour count on purpose — that would encode the database and fail the next time the
    rules move. If this ever bites, the fix is to bundle the tz rules with the app
    rather than trust the runtime.

    Note what the floor actually promises: `>=24.0.0` excludes the stale Node 20/22
    *lines* — which is what it claims to do and no more. It is not a guarantee of
    2026c, because Node 24.0.x shipped an earlier database. The real control is the
    `.nvmrc` pin on the deploy image; if a hard guarantee is ever wanted, the check is
    `process.versions.tz` at boot, which nobody has asked for at 5–15 organisers.

    **This is now observed, not theoretical.** The full suite was run on a shell that
    had drifted to Node 22.22.2 (tz 2025c) and failed exactly one test —
    `shareMessageFor › says how many are needed and by when, before the threshold`,
    which expected `Thursday 5:00 PM` and got `Thursday 4:00 PM`, the DST offset
    Alberta no longer uses. On the pinned 24.21.0 (tz 2026c) the same suite is green.
    So the pin is load-bearing for the test suite as well as for a paid figure, and
    the failure mode is a wrong *hour*, not a crash — quiet, and plausible enough to
    be read as a display bug.

## M4 slice log — 2a, 2b, 2c

### 2a — DONE

Shipped: `src/lib/join/` (`rules.ts`, `payment-port.ts`, `fake-payment-port.ts`,
`real-payment-port.ts`, `input.ts`, `service.ts`), the POST route, and 79 tests.
Two design decisions worth not re-litigating:

- **Two transactions, not one.** The provider call happens with no row lock held,
  because a 20-second timeout inside the reserve transaction would serialise every
  other join on the drop. The reserve transaction decides the race; the second one
  records the answer.
- **`PENDING` counts toward capacity but not toward the threshold.** Capacity must
  include it or a drop oversells by the number of in-flight joins; the threshold
  must exclude it or a crashed join helps a drop reach its minimum. Each is the
  safe reading for its own question.

### 2b — DONE, keyless

Shipped: `/d/[publicCode]/join` + `JoinForm.tsx` + `/api/public/drops/[code]/intent`
+ `join/quote.ts` + `join/fees.ts`, and **12 new tests** (9 quote, 3 service —
749→752 with nothing else moving; counted from the diff, not estimated). The page
degrades to `PaymentsNotConfigured` when `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is
absent, which is the state it ships in.

A follow-up commit then split the deal page's single `JOIN_FLOW_READY` boolean into
`resolveJoinGate`'s two conditions (capability + evidence, 7 more tests, 752→759).
The old comment had already gone stale — it claimed the join page did not exist —
which is what an untested constant does. The gate is now unit-tested, and the
regression test asserts the property that matters: **keys alone cannot open the
button**, because a keyed deployment still has no evidence that a card can be held.

Three decisions worth not re-litigating:

- **The quote is read-only, and there is a second endpoint for it.** The Element
  needs a `clientSecret` bound to an amount before the diner submits, so the
  amount must be quoted before `joinDrop` runs. Creating the participant at quote
  time would have put `PENDING` rows on the drop for everyone who opened the page
  and changed their mind — and `PENDING` counts toward capacity, so abandoned
  quotes would have closed drops out from under real diners.
- **The quote and the authorisation are the same computation, not two that a test
  hopes agree.** Both go `feesFromSnapshot` → `platformFeeCentsForOrder` →
  `resolveJoinMoney`; that extraction is why `fees.ts` exists. The test reads the
  participant row — what settlement actually acts on — and compares it to the
  quote. Verified by injecting a round-after-multiply fee: both agreement tests
  failed (`expected 178 to be 238`).
- **Changing the quantity discards the card.** The amount is fixed by the quote,
  so re-quoting means a new intent and a fresh Element. A form that re-priced
  while keeping a tokenised card would authorise an amount the diner never saw.

Bundle cost, measured by `next build`: the join page is **9.03 kB / 115 kB first
load**, +11 kB over the 104 kB deal page. That is Stripe.js, and it is confined
to the one page that needs it — the deal page stays at 104 kB, which is the whole
reason 2b is a separate page.

### 2c — DONE

Shipped: `lib/participant/access.ts`, `order-view.ts`, `order-page.ts`,
`app/d/[publicCode]/mine/page.tsx`, `orderUrl` threading through
`settle.ts` → `buildCapturedIntents`, and the `THRESHOLD_REACHED_STILL_FILLING`
emitter in `joinDrop`. **61 new tests** (14 access, 25 order-view, 19 order-page,
4 settle-order-link, 7 threshold-notify — 765→834, minus the 8 skips now counted
as skips rather than passes). See the section above for what the slice found.

What it deliberately does **not** do:

- **Send anything.** No provider (D-5). The intents are composed and logged.
- **Flip `JOIN_FLOW_PROVEN_LIVE`.** Still `false`, still correct.

### The drop could never be collected — FIXED

Found while looking for the next nicety, and it was not a nicety. `redeem.ts`
decides whether to hand over food with **one** check — `isRedeemableStatus(drop.status)`,
i.e. `PICKUP_OPEN | COMPLETED` — and reads **no clock at all**. The status *is* the
clock. Nothing in the build wrote `PICKUP_OPEN`; `grep` found it only in status-label
maps and in `VOID_SWEEP_STATUSES`. So after a successful capture a drop sat in
`CAPTURED` forever, every scan of a valid, paid code answered `NOT_YET`, and a diner
standing inside their window was told the window had not opened. Money taken, food
never handed over, no error anywhere to notice it by. ADR-005 §6 had explicitly
reserved the transition ("This ADR does not add a transition"), so it was ours.

`settlement/pickup-window.ts` — pure rule and DB layer in one module so they cannot
drift. `pickupTransitionFor({status, windowStart, windowEnd, now})` returns
`OPENED | COMPLETED | null`: `CAPTURED` past `windowStart` opens; `CAPTURED` already
past `windowEnd` goes straight to `COMPLETED` (the missed-tick path — a job that was
down must not flash a collectable drop for a pickup that already ended); `PICKUP_OPEN`
past `windowEnd` completes. Forward only, never re-opened. `FAILED` and `CANCELLED`
never open, tested across the whole enum.

`run-tick.ts` phase 5. **The ordering is load-bearing**: pickup runs *after*
settlement, so a drop captured this tick is already `CAPTURED` when the pickup query
runs and opens in the *same* tick. Moving the phase above settlement still passes
every other test — verified by doing it — and exactly one test fails, the ordering
one.

The guarded write puts the from-status in the `where`, not in an `if` around it —
the same discipline `settle` uses for capture and `decideFor` uses for the lock — so
two ticks racing produce one transition and one `count === 0`.

**Bounds are inclusive at `windowStart`, exclusive at `windowEnd`,** the same rule
`resolveOrderView` uses, so the page and the till close at one instant. 28 new tests.
The one that matters is `pickup-window.redeem.test.ts`: a real scanner over a real
signed code on one row — `NOT_YET` before the transition, `REDEEMED` after, same code
and same participant, only the status moved.

### The link now has an origin — DONE

`settle()` and `finaliseCaptured()` take an optional `baseUrl`;
`buildCapturedIntents` omits `orderUrl` when it is absent. `runCutoffTick` threads
it, and `/api/jobs/cutoff` supplies `publicOrigin()`.

The decision that mattered: **an explicit origin, or no link.** The onboarding route
derives its return URL from the incoming request (`Host` + `x-forwarded-proto`), and
is right to — the merchant's own browser just talked to that host. A notification
link is the opposite question: it is built by a **job**, and the `Host` on a job
request is whatever the scheduler sent, which behind a k8s CronJob is a container
name. `notify/public-origin.ts` therefore reads `APP_URL`, refuses anything that is
not a public https origin (`http:`, `localhost`, loopback, bare IPv4, `.local`, a
bare hostname), and returns `undefined` — which the tick treats as "no link".

Two deliberate non-decisions:

- **Not `NEXT_PUBLIC_APP_URL`.** Only this server-side job reads it; a public prefix
  would inline the deployment's origin into every client bundle.
- **A bad value degrades, it does not refuse.** One `warn`
  (`notify.public_origin_rejected`) and no link. A misconfigured link is not a reason
  to leave due cards uncharged — and the alternative, refusing to boot, would turn a
  cosmetic mistake into an outage.

21 new tests (15 origin, 3 tick-level link, 3 route pass-through; suite 834→883,
875 pass and 8 skip, identical under Node 24.21 and 22.22). Mutation checked: each
refusal clause, the warn-once guard, `href` vs `origin`, and dropping `baseUrl` at
either of its two hops each fail exactly the test that claims to guard them. One test
was **vacuous on first write** — the localhost-leak scan ran against an empty intent
list and passed under a mutation injecting exactly the fallback it names. It now
creates a drop and asserts the list is non-empty first.

Still not done, and the commit does not claim otherwise: **nothing delivers these
messages.** `FR-408` and `FR-506` stay 🟡. No sender (D-5), so the intent is composed
with a real origin and logged, and nothing reaches a phone.

### The pattern, named — and one deliberate sweep

Three commits in a row found the same defect shape: **a capability built, wired into
a channel that was never opened, invisible from every angle except the diner's.**

| Commit | The capability | The channel that was never opened |
|---|---|---|
| `9a01015` | pickup transition | nothing wrote `PICKUP_OPEN`, so no code could be redeemed |
| `c3d0853` | `orderUrl` in notifications | no origin, so the link was silently omitted every time |
| `619edab` | the order token | composed only inside a job for an SMS with no sender |

So 2d began with a sweep rather than a task: every `NotifyIntent` kind and every
success-response field, each asked "who renders this?"

- **All five intent kinds are constructed and delivered** to the port. No orphan.
- **The response fields were the problem.** `JoinForm.tsx` declared
  `cutoffLabel: string`; the route sent `cutoffAt`. One reader, zero producers.

### The diner was told "people join by undefined" — FIXED

```
You will only be charged if at least 4 people join by undefined.
```

`tsc` could not see it: the component cast the response (`body as JoinSuccess`) to
its own local declaration of the shape. A cast is a promise, and the promise was
false. The field had been declared in 2b (`de9c7d6`) and never sent — so this was
already broken, and every test was green because no test read the sentence.

**The fix is a declaration, not a field.** `src/lib/join/wire.ts` declares the
success body once. The route builds it with `satisfies JoinSuccessBody` (omission is
TS1360, a typo is an excess-property error); the component imports the type instead
of redeclaring it. Adding `cutoffLabel` to the JSON would have fixed the symptom and
left the mechanism intact.

Verified the hard way: deleting `cutoffLabel` from the route body left all 14 route
tests **passing** — only `tsc` objected. That was a real hole, so a route test now
inspects the key, and the mutation fails 1 test. A type is not a runtime check.

The label is authored server-side, in `Merchant.timezone`, because `cutoffAt` is an
instant and "Thursday 1:00 PM" is a *place* — a browser would use the diner's zone.
Proven with a Tokyo merchant at a fixed instant: `Thursday 12:00 PM`. Hardcoding
Edmonton fails exactly one test with `expected 'Wednesday 9:00 PM' to be
'Thursday 12:00 PM'`.

Two cleanups it forced, both real rather than cosmetic:

- **`src/lib/time/labels.ts`** — three copies of `momentLabel` existed, two with a
  comment claiming they were local "so the two pages cannot drift". They had already
  drifted in *form* and agreed only by spelling. Measured before consolidating: 384
  instants × 4 zones, zero differences. Latent, not live.
- **`dollars()` was a second rounding rule** — `$${(cents/100).toFixed(2)}` in a
  module whose own docblock warns against exactly that. `100.5` gave `$1.00` where
  `formatCents` gives `$1.01`. It now delegates. Fixing it required relaxing
  `rules.purity.test.ts` from "imports nothing at all" to an allow-list — **the
  guard meant to protect the browser bundle was the thing keeping a money bug
  alive** — compensated by asserting no `toFixed` outside comments, plus that the
  function actually returns `formatCents(...)`.

Bundle unchanged: `/join` 9.15 kB, `/mine` 177 B. A type import is erased.

### The sender — D-5, three modules

`twilio-sender.ts` is written and `resolveSender()` is wired into both call sites.
**Nothing has been sent to a phone.** This is the same standing as
`real-charge-port.ts`: the request construction is tested against a stubbed `fetch`,
and the module has never been executed against Twilio.

- **`notify/copy.ts`** — the words. It takes integer cents and calls `formatCents`
  itself, so no call site can introduce a second rounding rule. `stillFillingSms`
  deliberately names no number: the intent carries `qty` but not `minQty`, and a field
  added to fill a sentence will disagree with the database.
- **`notify/sender.ts`** — the transport seam. `loggingSender` when unconfigured,
  `recordingSender` for tests. Not `server-only`, because the recorder runs in tests.
- **`notify/twilio-sender.ts`** — `fetch` against Messages (2010-04-01), no SDK and no
  `twilio` dependency. Sequential sends, so one 21610 rate limit cannot fail the last
  messages in a batch. **Over-long bodies are refused, not truncated** — a half
  redemption code scans as valid at a counter.
- **`notify/compose-port.ts`** — intent → sentence → sender. The consent gate for
  FR-408 lives here, in one function, rather than at a call site.

### Three defects this slice found, all by writing the end-to-end test

The test that joined the four layers was worth more than the four layers, because
every one of these was green at every level and wrong in the join:

1. **A drop that missed its threshold notified nobody.** `decideFor` wrote `FAILED`
   and the drop never entered `toSettle`, so `buildFailedIntents` never ran for the
   most common failure there is. `DROP_FAILED_NO_CHARGE` had copy, an intent, and a
   passing unit test, reachable only through the capture-tolerance path. FR-506 says
   *every* participant hears the outcome within 60 s of the transition. The decision
   now hands its participant roster to the tick, from rows it had already read.
2. **A missing time zone silenced the messages that name no time.** The zone guard was
   per batch, so one threading bug suppressed `DROP_FAILED_NO_CHARGE` — the sentence
   FR-306 makes mandatory — in a batch that also contained a time-naming intent. The
   guard is now per message.
3. **`joinConfirmationMessage` had no production caller.** Written, gated, tested, and
   never invoked: the fifth instance of "capability built, wired into a channel nobody
   opened". `joinDrop` now composes it and the route supplies the sender.

Also fixed: `void deliverNotify(...)` on the still-filling path. On a serverless
deployment the invocation freezes when the response returns, so an unawaited promise
may never settle — the message was composed, logged as attempted, and never sent.

**Still 🟡: FR-408 and FR-506.** Composed, wired, and sendable; **not delivered.**
`twilio-sender.ts` has never run against Twilio, and no message has reached a phone.
The three `TWILIO_*` variables are documented in `.env.example`; absent, the app runs
in logging mode, which is a supported mode rather than a failure.

### The verification path — `npm run sms:verify`

```
npm run sms:verify -- +14035551234 --dry     # compose, print, send nothing
npm run sms:verify -- +14035551234           # send one real message, then check it
```

`scripts/verify-sms.ts` is the smallest thing that can end the "never executed"
caveat. Three things about it are deliberate:

1. **It sends the real message, not a test string.** The intent is a genuine
   `DROP_CONFIRMED_CHARGED` run through the real composer, so what arrives on the
   handset is the sentence a diner would get — amount, window, code and link. A
   hand-written "hello" would skip the layer where a bug would live.
2. **It asks Twilio what became of the message, and does not trust the `201`.** On a
   Canadian number with an unregistered sender, Twilio accepts, bills, and the
   carrier silently filters — no error, no bounce. The script polls the message
   resource until a terminal status and prints it. `delivered` is proof; `sent` is
   progress; `failed` with a code is the answer.
3. **It fails loudly when nothing could have been sent.** A keyless run exits 1
   rather than printing a tick, and it refuses to continue if `resolveSender()` chose
   anything but `twilio` despite complete credentials.

`--conditions=react-server` is required (and baked into the npm script): the module
imports `server-only`, which throws outside the React server graph. The guard stays;
the flag resolves the module the way a Server Component does.

**To promote FR-506 out of 🟡**, the check is: `npm run sms:verify -- <a real handset>`
prints `DELIVERED`. Anything less — `queued` past 30 s, `sent`, a silent zero — is not
evidence, and the A2P registration in D-5 is the usual cause.

One finding worth carrying into the live run: a charged-message body measures
**245 characters**, i.e. two SMS segments. At Twilio's Canadian rate that is two
billed segments per message, and a 500-participant drop is ~1000 segments. Worth
knowing before a large drop, and the fix — if it matters — belongs in the composer,
not the sender.

### Two runtimes, one tzdata trap

The suite is run under Node 22.22.2 (x64) and 24.21 (arm64). They disagree about
`America/Edmonton` after 2027: Node 24 ships tzdata `2026c` with Alberta's scheduled
move to permanent daylight time, Node 22 ships `2025c` without it. A test that pinned
`Thursday 2:00 PM` passed on one and failed on the other — **not a code defect, a
database difference**. Assertions about a window now pin the *weekday* (which is stable
across the rule change) and the shape of the clock, never the hour.

### Next — the live join

1. **A live Twilio send.** One real message to one real handset, with test
   credentials. Until then "FR-506 delivered" is a claim nothing supports.
2. **`JOIN_FLOW_PROVEN_LIVE = true`** only after a live run with test-mode keys:
   join → `AUTHORIZED` → no `CHARGE` row → page shows confirmation. **This is now
   worth more than it was**, because a join also sends an SMS: the confirmation is a
   second, independent signal that the whole path ran.

**Acceptance (M4 DoD):** cold tap to authorised in <45s on a real phone, no
charge before cutoff, the page's count and the join's capacity check agree, and
a double submit produces one participant.

**Blocked by:** a live Stripe run, and the exact requirements are narrower and
longer than "two keys":

- `sk_test_…` and `pk_test_…` in `.env` — `.env` is git-ignored, and `stripe.ts`
  validates the `sk_`/`rk_` prefix, so a fabricated value cannot pass. **Do not
  invent one**: `isStripeConfigured()` would return true and every join would then
  attempt a real call and fail on auth, which is strictly worse than the honest 503.
- **A connected account (`acct_…`) with `charges_enabled`.** Two keys alone are not
  enough and this is the part that surprises: `forMerchant()` refuses a non-`acct_`
  id, and `quoteJoin` returns `PAYMENTS_NOT_CONFIGURED` when
  `merchant.stripeAccountId` is null — which it is in the seed. So a keyed `.env`
  still cannot join until a merchant completes Connect onboarding
  (`/merchant/payouts`), and `onboarding.ts` requires `charges_enabled &&
  payouts_enabled && details_submitted` before it counts.
- **Register the Stripe account in Canada.** `real-connect-port.ts` hard-codes
  `country: 'CA'` and currency `cad`; cross-border Connect needs extra approval.
- **Not `STRIPE_WEBHOOK_SECRET`.** The webhook route handles only `account.updated`,
  and the join confirms synchronously, so a first live join does not need it. It is
  needed for onboarding state to refresh without a manual poll.
- Then one real join → `AUTHORIZED` → no `CHARGE` row → confirmation renders, and
  only then does `JOIN_FLOW_PROVEN_LIVE` flip.

D-5 for actual SMS; the OTP decision. Keyless work is now exhausted — 2a and 2b
have both landed, plus the `stripe-mock` contract suite, so **the next slice that
touches money needs a key.** 2c's code page is the remaining keyless work.

## Commands

```bash
# tests (arm64 node — see AGENTS.md for why)
~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run
npx tsc --noEmit && npx eslint .

# app
npm run dev            # http://localhost:3001
npx prisma migrate status
npx prisma db seed

# the Stripe request-contract suite (the only execution of real-payment-port.ts)
# Needs stripe-mock listening; the suite skips with a reason when it is absent,
# which is why skipping is not a pass. No Stripe account and no key required —
# stripe-mock accepts `sk_test_123`.
stripe-mock -http-port 12111 -https-port 12112 &
~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run \
  src/lib/join/__tests__/real-payment-port.contract.test.ts
# Override the location with STRIPE_MOCK_HOST / STRIPE_MOCK_PORT.

# the live suites — these need a real test-mode key and skip without one
~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run \
  src/lib/settlement/__tests__/real-charge-port.live.test.ts
```

## Decision log

`docs/ADR-001` direct charges, merchant bears Stripe fee ·
`docs/ADR-002` server authors money, model authors words ·
`docs/ADR-003` joins continue to `maxQty` ·
`docs/ADR-004` ledger identities L1–L5 ·
`docs/ADR-005` void-sweep status list.

Decisions taken inside slices, recorded where they were made rather than as ADRs:

`gap 15` merchant onboarding is one transaction, and a comment may only claim what a
test can break · `gap 17` the admin commission view is a roll-up of the organiser
statements, never a second implementation of the arithmetic · `gap 18` a second entry
point to an existing capability is proved equivalent to the first, not assumed to be —
same query, same formatters, one mint · `FR-906` an organiser's
commission defaults to the schema's 5%, never a second copy in TypeScript · `FR-804`
commission is net of refunds, and the statement is a live query, not a snapshot ·
`FR-802` one share link per organiser per drop, by unique index rather than
read-then-write.
