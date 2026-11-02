# GroupEat — progress

> **Audited:** 2026-11-02 20:35 CST · **Branch:** `sprint-2/payments-fee-bearer`
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
| **M3 — Drop creation + AI** | ✅ | `plan.ts`, ADR-002, interview, copy lint, publish gate, frozen snapshot. |
| **M4 — Public page + join** | 🟡 | Slice 1 (FR-301…308) shipped at `fe47cbf`. **Slice 2a (FR-401…407 domain + API)** at `f3982ed`. **Slice 2b (the join page, `/intent` endpoint) shipped keyless** — the page exists and is tested, but no card has ever been held. **Slice 2c (diner order page, `/d/:code/mine`, the still-filling emitter)**. **Slice 2d (the confirmation link + the one wire type)** — see below. |
| **M5 — Cutoff + capture** | 🟡 | Code and tests for FR-501…505, 507 at `9f3ea4f`. **The pickup-window transition landed** (`pickup-window.ts`, tick phase 5) — before it, no drop could ever become collectable. FR-506 is a no-op seam, but the charged intent now carries a working order link built from `APP_URL`. Live capture never run against Stripe. |
| **M6 — Redemption** | 🟡 | Scanner, manifest, idempotent redeem (FR-601…605). The diner-facing code page now exists (2c). FR-606 deferred (optional V1.1). |
| **M7 — Reporting + organiser** | ⬜ | `/organiser` is still the Sprint 1 placeholder. |
| **M8 — Beta hardening** | ⬜ | Admin refunds, force-fail, impersonation absent. |

## Verified in this audit

- Full suite: **904 tests — 896 pass, 0 fail, 8 skip** (78 files; 77 pass, 1 skips).
  Run with arm64 Node:
  `~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run`
  Verified identical under PATH Node 22.22 (`tzdata 2025c`) and Node 24.21
  (`tzdata 2026c`); see gap 6 for why that matters.
- The 8 skips are all Stripe-dependent. The **contract** suite is not among them
  when `stripe-mock` is up: it then runs 6 tests against the mock, and skips 5 of
  them (with a printed reason) when the mock is down.
- `npx tsc --noEmit` — clean. `npx eslint .` — clean.
- `prisma migrate status` — 2 migrations, schema up to date; `prisma validate` — valid.
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
| FR-408 confirmation SMS with consent | 🟡 | consent ✅ (`ConsentRecord`, `EXPRESS`, `drop_join`, same transaction) and the checkbox exists in `JoinForm`. The charged intent now carries a real `orderUrl` to `/d/:code/mine`, built against `APP_URL` (refused if not a public https origin) or omitted entirely; the still-filling intent has an emitter. **Still no sender** — D-5. Nothing is delivered. |

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
| FR-506 notify ≤60s | 🟡 | `notify-port.ts` logs an intent; no provider, no delivery |
| FR-601 scan screen | 🟡 | `/merchant/pickup` + `RedeemScanner`; iOS/Android device check not recorded |
| FR-602…605 | ✅ | verify, per-unit, glanceable, idempotent double-scan |
| FR-606 offline 20 min | ⬜ | explicitly optional for V1 |

Deliberate deviations, already decided and not to be "fixed":

- ADR-003 replaces FR-305's "stop at threshold" with "continue to `maxQty`".
- ADR-002 replaces the PRD §9.2 model-authored price with server-authored numbers.
- M5 has no job table; `Drop.status` is the job (M5 design §1.2).

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

**Still 🟡:** FR-408, FR-506. Nothing delivers these messages (D-5).

### Next — the sender, then the live join

1. **A sender (D-5).** `NotifyPort` has one implementation and it logs counts. Until
   something delivers, every fix above is plumbing behind a closed valve. Needs a
   provider decision — and the OTP question rides on the same choice.
2. **`JOIN_FLOW_PROVEN_LIVE = true`** only after a live run with test-mode keys:
   join → `AUTHORIZED` → no `CHARGE` row → page shows confirmation.

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
