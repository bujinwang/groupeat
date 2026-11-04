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
| **M7 — Reporting + organiser** | 🟡 | **FR-901 landed: `/admin/drops`**, the first M7 artefact and the first screen to render FR-902's double confirmation. **FR-903 is now reachable**: `/admin/drops/[id]` lists participants and issues per-diner refunds, which the endpoint could not do alone. **FR-905 landed**: `/admin/ai-drafts` and one run in full, reachable from the merchant page — the table `persistAuditRow` has been writing since M3, read for the first time. **FR-906 landed**: creating an organiser now creates its `OrganiserProfile` in the same transaction, and `/admin/users` lists organisers with their commissions plus a repair path for accounts made before the fix. **FR-801/802/805 landed**: `/organiser` lists live drops and hands over a tracked share link in two taps, with `DropParticipant.shareLinkId` now written. **FR-804 landed**: `/commission` states each organiser's monthly commission — 5% of what the restaurant *kept*, net of refunds — with a CSV export, and the tz database the month boundary depends on is now pinned. **Gap 15 closed**: merchant onboarding is the single transaction it always claimed to be, and `slugify` no longer splits accented names. **Gap 17 closed**: `/admin/commission` and `GET /api/admin/commission` give the e-transfer run one file for the whole roster, built as a roll-up of the organiser statements rather than a second implementation of the arithmetic. **Gap 18 closed**: the organiser role now has its full declared API surface — `GET /api/organiser/drops` and `POST /api/organiser/drops/:id/share` — with the route and the server action proved to return the same token, the same URL and the same message, in both orders. **Gap 12(a) closed**: `/admin/drops` is rendered, with `renderWithRouter` supplying the app-router context that made any page mounting `ForceFailControl` unrenderable. **Gap 12(b) closed**: `/admin/drops/[id]` is rendered too — five of `refusalFor`'s seven sentences asserted in full, the two it cannot reach named, and every branch of `moneySummary` reached including the one a force-fail leaves behind. **Gap 12(c) closed**: `/admin/ai-drafts` and its detail page are rendered, with the list's "from $X" proved against the detail page's cheapest proposal — the one claim neither page could make alone. **Gap 12(d) closed**: `/admin/users` is rendered too, and it turned out to have been skippable for no reason — the "genuinely browser-only" note in five places was about `useState`, which does not block a render. **Gap 12(e) closed, as far as a render can close it**: `/organiser` is rendered and its two-tap premise is asserted, including the one claim nothing else could reach — that the card's deadline and the pasted message's deadline are the same label in the merchant's zone. The taps themselves still need a browser. **All seven admin and organiser suites now exist, covering eight of the app's twenty-four pages**; the ten `/merchant/*` pages, `/admin/merchants/[id]` and the five diner-facing pages still do not. **Gap 16 closed**: FR-801's `likelyFill` ranking is built — a weighted heuristic over §9.3's four inputs, in a pure module, with the score carried on the wire so the page and the API cannot order the same data differently. Two corrections to the gap's own justification: every input §9.3 names was already in the schema (`MenuItem.category` was added by D-3 *for this*), and the definition is at §9.3, not §9.4. **M7 is now complete.** Section 6.7 (FR-701…705, merchant reporting) was, however, **entirely absent** — see the M9 section, where three of its four requirements are now built. |
| **M8 — Beta hardening** | ✅ | All three requirements shipped: **FR-902** (force-fail and refund all) with the `AuditLog` model it needed, **FR-903** (partial refund) with the ledger fix it forced, and **FR-904** (read-only impersonation) with the refresh path it nearly lost. All three were marked done while their UI obligations pointed at a screen that did not exist; FR-901 and the FR-903 detail page have since supplied it. See the M8 sections below. |

## Verified in this audit

- Full suite: **2057 tests — 2049 pass, 0 fail, 8 skip** (146 files; 145 pass, 1 skips).
  +81 for the **merchant write pipeline** — the six body-accepting merchant routes that had no
  route-level test: `POST /items/[id]/guardrail`, `POST /drops/[id]/publish`, `GET`/`POST`
  `/items`, `GET`/`PATCH` `/items/[id]`, `GET`/`POST` `/drops`, `GET`/`PATCH` `/drops/[id]`.
  These are the routes through which **cost data and money enter the system**, and every one of
  them makes a security claim in prose. Writing the tests found **three real defects**, all of a
  shape reading the code would not surface. (1) **A dish could be saved with a blank name.** Both
  `itemInputSchema` and `draftInputSchema` put `.min(1)` *before* the `.trim()` in their mappers,
  and a Zod transform runs after its checks — so `'   '` validated and was then trimmed to `''`.
  Probed on the real parser: `{ name: '   ' }` returned `ok: true` with `value.name === ''`. The
  same ordering also rejected 80 characters padded with spaces as if they were 84. Fixed in both
  schemas by moving `.trim()` into the schema ahead of `.min(1)`. (2) **A draft could be saved at
  a negative price.** `dealPriceCents` is an `Int`, `parseDraftInput` checked only `.int()`, and
  `collectDraftFieldErrors` skips price *on purpose* (a draft is allowed to be unprofitable) — so
  `-5000` reached the database. Probed against the real route. Publishing is refused, so no diner
  was charged; fixed with `.min(0)`, deliberately not `.positive()`, because `DropForm`
  initialises an untouched price to `0` and `PATCH` sends the whole body. (3) **The republish
  `NOT_DRAFT` refusal was a 422 and is now a 409**, found in the publish suite by asserting the
  *status* after `rejects.toThrow(/already been published/)` had passed against the wrong code.
  81 mutants across two sweeps, **all 81 kill**. The first sweep's only anomaly is the useful
  part: its parse-before-ownership mutant was killed by a `ReferenceError` (the mutation also
  deleted the `previous` binding), so it proved nothing about ordering — a **faithful** mutant
  that keeps `previous` bound survives, and only a two-edit version is killed by the ordering
  test alone. Recorded in `AGENTS.md`. The sweep also leaked 14 `DRAFT` drops, because refusals
  that *should* write nothing do write when mutated; cleanup is now by tenant rather than by an
  id list, and the residue is back to the baseline 96 merchants.
  +62 for **M9 — merchant reporting**, which was the largest hole left in the document: FR-701
  through FR-705 were marked done against **zero implementation anywhere in the repo**. Three
  of the four are now built end-to-end and the fourth is deliberately not built and says so.
  Requirements are FR-701 (the five figures), FR-702 (new versus returning diners), FR-703
  (which organiser drove which units) and FR-705 (what to do differently next time); FR-704
  (the weekly digest email) is not built. Writing the tests found **three real defects**, none
  of which reading the code would have surfaced: a fully refunded order reported **−$21.33**
  rather than zero, because contribution was computed as `Σ contribution − refunded` and the
  food cost is inside contribution; the whole page **500'd** instead of withholding one
  unreconcilable drop, because the delegated integrity check threw `SettlementIntegrityError`
  and the report's `catch` matched only `ReportIntegrityError`; and FR-702's own count
  **time-travelled** — January's report changed every time a customer bought again in March.
  47 mutants, **46 kill**; the one survivor is an equivalent mutant and is written up as one.
  +31 for `POST /api/public/drops/[code]/intent`, the only **anonymous** endpoint in the
  app that creates a real `PaymentIntent` on a merchant's connected account — no session,
  no phone, no cookie, so anyone holding a public code can make it mint an intent that a
  diner's card is later authorised against. Writing the suite found a genuine product bug:
  `quoteJoin` filtered `status: { in: ['PUBLISHED'] }`, so a **cancelled** drop answered
  `404 NOT_FOUND` — "check the link, it may have been mistyped" — and the `CANCELLED`
  refusal arm, together with the five-line comment justifying why it has its own reason
  instead of `CLOSED`, was **unreachable**. `FAILED` and already-`LOCKED` drops had the
  same shape. `/d/:code` and `/d/:code/join` both load through `getPublicDrop`, which
  accepts those statuses, so the page said "The restaurant called this drop off" beside a
  join form the API then refused as though the code were wrong. Fixed by reusing
  `PUBLIC_VISIBLE_STATUSES` — the rule `NOT_FOUND` protects (a guessed code must not
  reveal a `DRAFT`) is already written down there, and it is what the page filters on. 11
  mutants, all 11 kill, including one that widens the filter to include `DRAFT`.
  +20 for `POST /api/webhooks/stripe`, the only handler in the app whose caller is not a
  user — no session check, the signature *is* the authentication, and the thing it decides
  is whether a merchant can take money. Signed with
  `Stripe.webhooks.generateTestHeaderString` and verified by the same `stripe@23` code path
  a real delivery takes, so "rejects an unsigned body" is not an assertion about a stub.
  Nineteen mutants were run; **all nineteen fail the suite**. Getting there took four
  rounds, and every one was a fixture defect rather than a missing assertion — a
  `capability.updated` fixture that could not collide with an `account.updated` prefix
  match, a collision whose body put the account id where the handled branch does not read
  it, two `did-nothing` tests that asserted only `port.calls` and so could not see a
  `prisma.merchant.update` in the `default:` arm, and — the one worth remembering — a
  mutation harness that wrote `SUSPENDED` onto a real seeded merchant and then reported a
  *load-bearing* probe as a survivor, because the next probe took its baseline from the
  row the previous mutant had already changed.
  +94 for the five diner-facing pages, which closes gap 12: `/d/[publicCode]` (22),
  `/d/[publicCode]/join` (12), `/d/[publicCode]/mine` (22), `/login` (29) and
  `/change-password` (17), plus four new `Field` tests that live in the change-password
  suite because that is where the probe found the gap. Rendering them found **three real
  bugs** and repaired a fourth outside the pages themselves:
  `PUBLIC_VISIBLE_STATUSES` omitted `CANCELLED`, so `/d/:code` answered 404 to a diner whose
  money had already been taken and refunded, stranding five branches of cancellation copy;
  `safeNext` — the login open-redirect guard — forwarded `/\evil.example` to
  `https://evil.example` because it tested `//` and not what the URL parser does with a
  backslash; and `Field` rendered its error and helper paragraphs without ever associating
  them with the control, on 51 of its 52 call sites. The render harness itself had to change
  twice: `useActionState` throws outside a `Suspense` boundary, and once a boundary exists a
  failing page returns *markup* instead of rejecting, which made every existing
  `not.toContain` assertion vacuous until `onError` was made to rethrow.
  +22 for gap 12(m): `/admin/merchants/[id]`, the page that is `/merchant/settings`' mirror
  image on two counts — the minimum margin **is** editable here, and the page must
  therefore *not* contain the merchant page's sentence "This is not editable here."
  Rendering it found a **real bug** rather than a weak assertion: `ImpersonateControl`
  checked `if (!open)` before the `owners.length === 0` guard, so a MANAGER-only merchant
  got an **enabled "View as this merchant…" button** whose only outcome was the
  explanation the guard exists to show instead — the docblock's claim that it "renders a
  sentence explaining why rather than a control that would fail on submit" was false on
  first paint. The guard moved above the closed state and the second copy deleted as
  unreachable. Four assertions were repaired before probing, all four of types this repo
  has recorded before: a page-wide `not.toContain('$9.00')` that measured *another dish's
  row* (fixed with a `floorSentence()` extractor); `rejects.toThrow()` with no argument,
  which a Prisma error would satisfy (now the 404 digest); a test whose own docblock
  conceded it proved nothing (the closed control leaks no candidate email whether or not
  the owner filter works), narrowed to what a first paint can show and the filter left to
  the manager-only fixture where it is load-bearing; and a `tone` ternary no fixture could
  reach, now read off `bg-ok/10` on a `SUSPENDED` merchant. 16 probes, 16 kills — and one
  of those kills came **after** a survivor: probe B (highest dish → first dish) lived because
  the expensive dish happened to sort first, so the fixture could not tell "highest" from
  "items[0]"; renaming it to sort second made the probe kill.
  +20 for gap 12(l): `/merchant/payouts`, the last merchant page, and the first suite whose
  central claim is about a write that must **not** happen — an ordinary GET reads, only a
  return from Stripe writes. No rendered output can distinguish the two paths, so the
  assertion is on the call log; probe A kills 9 tests. Two assertions survived their first
  probe and both were presence-where-the-claim-was-identity-or-order: a null assessment
  falling back to `READY` was invisible because the **badge** was never asserted, and
  deleting `.sort()` was invisible because containment cannot see order. Repaired and
  re-probed; 15 of 15 now kill.
  +35 for gap 12(k): `/merchant/settings` (12 tests) and `/merchant/pickup` (23 tests).
  The settings suite turns two rules stated as absences — "the floor is not editable here"
  and "the warning appears only here, and only under 15%" — into an exhaustive field-name
  set and a two-sided boundary test at `0.14`/`0.15`. The pickup suite found a **real
  product bug** rather than a weak assertion: a `CAPTURED` drop with no participants badges
  **"All collected"**, because `outstanding` is `plates − collected` and `0 − 0 = 0`, so a
  drop whose food has not been cooked reads as fully handed over. 18 probes, 16 killing in
  this page's suite; one is pinned by the loader's own suite and one by `rules.test.ts`,
  both recorded where they live rather than duplicated here.
  +30 for gap 12(j): `/merchant/drops`, `/merchant/drops/new` (+`/new/ai`), and
  `/merchant/items/new` (+`/items/[id]`) rendered across three suites. Eight probes on
  the drops list and eight on the items form all killed; the create-a-drop suite killed
  seven of eight, and the survivor was a **half-asserted sentence** — the intro promise
  was asserted only up to "Five questions.", so mutating "three ways" to "one way" left
  the suite green. The repair was to assert the whole sentence, then re-run the probe.
  The lint pass also caught an unused `html` in the drops empty-state test, which was
  the signal that the test asserted the button's **label** but not its **href** — a
  reworded button still pointing at `/merchant/drops/new` is the dead end the branch
  exists to prevent. Three assertions added, two probes confirm they are load-bearing.
  +15 for gap 12(i): `/merchant/drops/[id]` rendered — the draft branch's refusals, the
  published branch's frozen money, and the one assertion no loader suite could make:
  **the page prints the snapshot's `$4.01` after the dish is edited to a `-$7.39` item.**
  Eight probes, seven load-bearing on the first pass; probe E survived and the repair was
  a **missing fixture, not a weak assertion** — every draft fixture refused something, so
  the "no refusals" branch had never rendered. A clean-draft fixture made E kill.
  +8 for gap 12(h): `/merchant/items` rendered against real Postgres — the first
  merchant-facing page, the paying customer's screen, and the five-label badge that no
  loader suite could see. **Seven** probes, all seven load-bearing, which is the first
  clean sweep since gap 17. The slice also established a fact about the page rather than
  about the test: `PanelState.OK` is unreachable from `/merchant/items`, because the page
  evaluates without `dealPriceCents`, so the evaluated price *is* `minViablePrice` and
  `resolvePanelState` returns `FLOOR` — checked by sweeping 252 cost combinations, of
  which only `FLOOR`, `THIN`, `INFEASIBLE` and `INVALID_COST_DATA` appeared.
  +37 for gap 16: FR-801's `likelyFill` ranking — §9.3's four inputs, a stated prior
  rather than a fitted model because the database has no successful drop to fit against,
  and cold start asserted as the primary case rather than an edge case. 24/24 mutation
  probes fail a named test.
  +19 for gap 12(e): `/organiser` rendered against real Postgres — the page and the pasted
  message asserted against the same deadline label, which is the one claim neither the
  loader suite nor the action suite can see. This is the last **admin and organiser** page
  to get one; sixteen of the app's twenty-four pages still have none.
  +17 for gap 12(d): `/admin/users` rendered against real Postgres, with every assertion
  scoped to a row this file created because the page lists the whole database. This is the
  last admin page, and it was skipped for four slices on a claim — "genuinely browser-only"
  — that had never been checked. See the 12(d) section below.
  +20 for gap 12(c): `/admin/ai-drafts` and `/admin/ai-drafts/[id]` rendered against real
  Postgres, plus the one assertion neither page could make alone — that the list's
  "from $X" is the cheapest proposal the detail page lists.
  +12 for gap 12(b): `/admin/drops/[id]` rendered against real Postgres, five of
  `refusalFor`'s seven sentences plus the two it cannot reach named as such, and every
  branch of `moneySummary` reached.
  +16 for gap 12(a): `/admin/drops` rendered against real Postgres, plus `renderWithRouter`
  — the app-router context that makes any page mounting `ForceFailControl` renderable at
  all.
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
P1 in the spec and deferred — gap 17. `likelyFill` ranking (gap 16) is now built; see
the M7 gap-16 section.

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

`likelyFill` ranking is **now implemented** — gap 16, in
`src/lib/organisers/likely-fill.ts`, and the paragraph that used to sit here saying it
was "a deliberate departure" was wrong twice:

- **It said the inputs do not exist.** They do. §9.3 names four — fill rate per
  merchant+item, group size vs `minQty`, days until cutoff, past success with a cuisine —
  and every one is readable from `Drop.status`, `Drop.minQty`, `Drop.cutoffAt` and
  `MenuItem.category` (which D-3 added specifically for this) joined through
  `ShareLink` → `DropParticipant.shareLinkId`. Nothing was missing; nothing had been
  written.
- **It cited §9.4.** The definition is at §9.3; §9.4 is prompt management. A citation
  nobody followed is how a gap stays "blocked" for several slices.

What *is* degenerate is the data: the database holds 55 failed drops and zero successful
ones, so both history axes read empty and the score falls back to its two structural
terms. That is why the ranking is a stated prior rather than a fitted logistic — there is
no positive class to fit — and why `likely-fill.ts` treats cold start as the normal case
rather than an edge case.

### Not proven

**Nobody has loaded `/organiser`**, and the copy buttons are the first client-side
clipboard use in the app. Gap 12 carries the checklist, extended with the organiser
walkthrough. The two-tap claim is a design claim, not a measured one.

*(Partly closed since: gap 12(e) renders the page and asserts the premise the tap count
depends on — both controls present on first paint, the message quoting the card's own
figures, and the deadline identical in the card and the paste. The taps themselves, the
clipboard and the click counter going up still need a browser. See the 12(e) section.)*

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

## M7 — gap 16, `likelyFill` was never blocked, it was unstarted

FR-801's acceptance column says *"Ranked by `likelyFill` (§9.3)"* — PRD-v1.md:536. The
page ordered by soonest cutoff for several slices. The reason recorded in three places
was that §9.3's inputs need history an organiser does not have.

That was checkable in one query, and it took two:

| §9.3 input | Where it actually is |
|---|---|
| historical fill rate for merchant+item | `Drop.status` — `FAILED` is a miss, `LOCKED`+ is a fill |
| group size vs `minQty` | `Drop.minQty`, already selected |
| days until cutoff | `Drop.cutoffAt`, already selected |
| organiser's past success with this cuisine | `MenuItem.category` (added by D-3 *for this*) via `ShareLink` → `DropParticipant.shareLinkId` |

Every one was present. None was being read.

| Piece | Where |
|---|---|
| The arithmetic, the weights, the reason sentences | `src/lib/organisers/likely-fill.ts` (new, pure) |
| The history, read from Postgres | `loadRankHistory` in `src/lib/db/share-links.ts` |
| Scoring and ordering | `listShareableDrops` — the only place rows are ordered |
| The wire | `shareableDropJson` forwards the rank; the route names the ordering |
| Tests | 28 unit (`likely-fill.test.ts`), 7 db-level ranking, 2 page, 2 route |

### Cold start is not the edge case, it is the only case that runs

The database holds **55 `FAILED` drops and 2 `PUBLISHED`, and zero successful ones.** So
both history axes read empty, `fillRate` returns `null`, and the score is its two
structural terms alone. That is not a limitation to be worked around — it is the state of
the product, and it decided the shape of the whole module:

- **A weighted heuristic, not a logistic.** §9.3 permits either. A fitted model on 55
  negatives and 0 positives learns "nothing fills" and ranks accordingly. The weights are
  a stated prior, in one table, so the argument about them happens over four numbers.
- **`CONFIDENCE_SAMPLE` rather than a raw rate.** One failed drop in a wet week is not a
  rate. Blending toward the neutral 0.5 in proportion to sample size means one outcome
  moves the estimate a fifth of the way and four move it half.
- **No renormalising when history is missing.** Renormalising would push a no-history drop
  toward 1 and let an unknown merchant outrank a known-bad one purely by having less
  evidence against it. The cold-start ceiling is therefore well below 1, and a test pins
  that.

### `Drop.status` is the outcome, so nothing sums participants

`cutoff-decision.ts` writes `LOCKED` only when `joinedQty >= minQty`, and the brand on
`LockedDrop` exists to make that unreachable any other way. So the status *is* the record
of the decision, and re-deriving it from participants would be a second implementation of
the threshold comparison. `outcomeOf` maps:

`FAILED` → miss · `LOCKED`/`CAPTURED`/`PICKUP_OPEN`/`COMPLETED` → fill ·
`PUBLISHED`/`DRAFT`/`CANCELLED` → **nothing**

`CANCELLED` → nothing is the row worth defending. A merchant closing their kitchen says
nothing about demand, and teaching the ranking that a closed day is a bad fill rate would
make the fix for a closed day *a better ranking*.

### The weights, and a fixture that had to respect them

`cuisine 0.35`, `merchantItem 0.30`, `deadline 0.20`, `threshold 0.15` — for the record
in `PROGRESS.md` that `D-3`'s `category` column had no consumer.

The first db-level ranking test failed, and the failure is the useful part: a perfect
merchant record (4 fills, blended 0.75) against a terrible one (4 misses, blended 0.25)
spans **0.15** of score, while a 2-hour vs 4-day cutoff spans **0.157**. So the deadline
term outvoted the history — correctly, by the weights as written. The fixture was fixed to
a three-day gap (0.12 of deadline against 0.15 of record), and the comment says why the
number is three rather than round.

### Twenty-four probes, twenty-four caught

Six passed on the first run and every one was a real hole or a defect of mine:

| Probe | Why it survived | Fix |
|---|---|---|
| D — delete the `Math.max(0, …)` clamp | no test looked past five days | added 6/9/30-day cases |
| E — linear threshold instead of saturating | `low > high * 3` is satisfied by linear too | assert the *fraction* lost, which distinguishes a curve from a line |
| F — collapse `minQty` 1 and 2 | **my probe was wrong** — `Math.max(1, m)` does not collapse them | repatched to `Math.max(2, m)`; caught |
| J — count `PUBLISHED` as a miss | the equivalence test's comment claimed PUBLISHED coverage the loop did not create | added a past `PUBLISHED` drop |
| P — treat a `null` category as its own cuisine | `not.toBe('organiser-record')` is satisfied by the score drop too | assert the score equals the no-history control |
| W — remove the reason line from the page | the only assertion was *absence* | added a page fixture with real history and a presence assertion |

Probe W's repair cost the most and taught the most: to assert a rendered sentence I had to
give drop A four decided past drops. My first attempt expected `75%` and got `63%` — the
blend, not the raw rate — and expected `your Bowls drops` for what is a *merchant* record,
because the cuisine axis needs a `ShareLink` on a past drop and these four have none. Both
corrections are in the comment. An assertion I write is as capable of being wrong as the
code it tests.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint (organisers, share-links, organiser pages, organiser api)   clean
npx vitest run                        1623 passed | 8 skipped (1631) across 123 files
residue gate                          no residue — 8 counts unchanged
24/24 mutation probes fail a named test
```

### Not proven

- **The organiser-record reason has never rendered.** The page fixture can only produce a
  *merchant* record, because the cuisine axis needs a share link on a past drop. The
  sentence is unit-tested; its appearance on a card is not.
- **The weights are a prior, not a measurement.** Nothing here has been compared against
  real fill outcomes, because there are none. When successful drops exist, the first thing
  to check is whether the ordering beats soonest-cutoff-first — and `rankByLikelyFill` is
  a pure function precisely so that comparison can be a test.
- **§9.3's "group size" input is a substitution.** The app has no self-reported or
  inferred group size, so `minQty` stands in. A small threshold is evidence that somebody
  chose a reachable target, not evidence about this organiser's reach.
- **Attribution is not causation.** A filled drop the organiser shared counts even if every
  diner walked in. There is no field that could distinguish them.
- **Nothing has been rendered in a browser** — the reason line's layout is unverified.

## M7 — gap 12(e), Journey B's acceptance test, minus the taps

`/organiser` is FR-801, FR-802 and FR-805, and it is the page the PRD judges with one
sentence: *"organiser can go from login to a shareable link in ≤2 taps."* It is the last of
the **admin and organiser** pages to get a render test — the ten `/merchant/*` pages,
`/admin/merchants/[id]` and the five diner-facing pages are still review-only, and this
section has now been wrong about that number twice: it first claimed to be "the last page in
the app", then "the other ten", when the count was sixteen.

| Piece | Where |
|---|---|
| Tests | `src/app/(organiser)/organiser/__tests__/page.test.ts` — 18, real Postgres |
| Harness | `renderToHtml` — the page mounts no router-using component |
| Production code changed | **none.** |
| Already covered | `lib/db/__tests__/share-links.test.ts` (the loader), `api/organiser/drops/[id]/share/__tests__/route.test.ts` (the action, and its equivalence with the API route) |

### A render cannot count taps, so it tests what the tap count depends on

The two taps are a button press and a clipboard write. Neither happens here. What the
render *can* prove is the premise: that the link and the pre-written message are on the
first screen an organiser sees with no navigation between them, that exactly one card
offers the button while the others show a message, and that the message quotes the figures
the card displays.

That last one is the claim only this file can test. The deadline appears **twice** for a
single drop — once in the card (`Orders close …`) and once inside the pasted message
(`… needed by …`) — and `ShareLinkControl`'s docblock claims composing the message in the
browser produces byte-identical text because both go through `momentLabel` with the
merchant's zone. Nobody could observe that until both were on screen at once.

### The fixture runs in a zone the host is not in

The merchant is `America/Toronto`; this host is `America/Edmonton`. Edmonton has been
UTC−6 year-round since 2026-11-01 and Toronto is UTC−5 in November, so every label is
exactly one hour from what the server's own local formatting would print. Probe D replaced
`drop.merchantTimezone` with the host zone and three tests failed. A page formatting in UTC
would be out by four or five hours; neither mistake looks wrong enough to notice by reading.

### Prices where the plausible wrong percentage is visible

Drop A: menu 1800, deal 1250, saving 550. That is **31%** of the menu price and **44%** of
the deal price — the reversed division being the wrong implementation somebody would
actually write. Drop B gives 13% against 14%. `fx.item()` hard-codes 1600 for the menu
price, so the suite creates three items and sets their prices explicitly; with the fixture's
constant, A and C would share a percentage and the per-drop assertion would prove nothing.

The threshold boundary is the other fixture decision: drop A joins to **exactly** its
minimum of 5. `>=` prints `Threshold met`; `>` prints `5 of 5`. Probe C confirmed the
assertion holds that line.

### Probe M is the sharpest statement of the render boundary in this repo

`ShareLinkControl` resolves its token with `state.token ?? props.existingToken`. Probe M
deleted the `state.token` half, and eighteen tests stayed green.

That is not a weak assertion. `useActionState` returns `INITIAL` in every render, so
`state.token` is `null` in every case a render can produce — the value only arrives as the
*return* of a submitted action. Anything on the far side of an action's return value is
unreachable from a render, including `state.error` and therefore the error sentence an
organiser sees after a refusal. So the `??` is one line of a client component, and the
whole class of "state that only exists after an event" is named as limit 2 in the suite.

Probe T passed for a duller reason: the empty-list arm needs a database with zero live
drops, and this one is shared with every other suite. Named as limit 3.

One probe was my own fault and is reported as such: probe A added an unused variable beside
the discount computation and changed nothing a test observes — the AGENTS.md failure mode,
committed by me, an hour after writing it down. Probe R targeted the wrong file and the
harness said `PATTERN DID NOT MATCH` rather than passing.

### Twenty-one probes, eighteen caught

| Probe | Change | Result |
|---|---|---|
| A | add an unused variable beside the discount | **BAD PROBE** — changed nothing observable |
| A2 | print the deal price as the "was" figure | the discount test |
| B | divide the saving by the deal price, not the menu price | the discount test |
| C | `joinedQty > minQty` | the `>=` boundary test |
| D | format deadlines in the host zone | three, including the page-equals-paste test |
| E | drop the pickup-address fallback | the list test |
| F | filter the list to a nonexistent drop | 13 tests |
| G | remove the missing-profile gate | both profile-less tests |
| H | change the FR-805 sentence | the privacy test |
| I | print only the window start | the pickup-range test |
| J | rewrite the commission link text | the commission-link test |
| K | point the commission link at `/admin/commission` | the commission-link test |
| L | reword "counted" to "calculated" | the commission-link test |
| M | drop `state.token` from the `??` | **PASSED — named limit 2** |
| N | remove the `token === null` early return | two, including "exactly one button" |
| O | always use the plural "opens" | the singular/plural test |
| P | shorten the relative-link warning | the relative-link test |
| Q | empty the hidden `dropId` | the link-button test |
| R2 | flatten the "It's on" sentence | two, including the page-equals-paste pair |
| S | drop the token from the share URL | the message test |
| T | `drops.length === 0` → `false` | **PASSED — named limit 3** |
| U | delete the `· pick` separator | the pickup-range test |
| V | reverse the drop order | the ordering test |
| W2 | mint a link while rendering | the read-only test, plus two |
| — | *(probe W first tried an undefined function)* | **BAD PROBE** — syntax break, proves nothing |

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint "src/app/(organiser)/organiser"   clean
npx vitest run                        1586 passed | 8 skipped (1594) across 122 files
residue gate                          no residue — 8 counts unchanged
```

### Not proven

- **No tap has happened, and no browser has loaded the page.** The clipboard path — the
  first `navigator.clipboard` use in the app — is unexercised. A browser that refuses the
  clipboard must show the manual-copy sentence rather than a "Copied" that copied nothing;
  that sentence is asserted to *exist* in the source, but the branch that renders it cannot
  be reached without a real refusal.
- **The journey is not walked**: sign in as an organiser, two taps, paste into a chat, open
  the link in a second browser, watch `clicks` increment, then `curl` the same link and
  confirm it does *not*. That is gap 12(e)'s remaining half and it needs a browser.
- **`state.token ?? existingToken` is unobservable** (limit 2 above), as is every error
  sentence the action can return.
- **The empty-list branch and the `1 open` singular arm** both need a database with no live
  drop or exactly one (limits 3 and 4).
- **Only the relative-link origin branch is exercised** — no `APP_URL` exists here
  (limit 5).
- Neither gap-18 API route has crossed a socket. Unchanged.

## M7 — gap 12(d), the page that was skipped for the wrong reason

`/admin/users` is FR-906. It is also the page that six passages across two documents said
could not be tested, and none of them had checked.

| Piece | Where |
|---|---|
| Tests | `src/app/(admin)/admin/users/__tests__/page.test.ts` — 17, real Postgres |
| Harness | `renderToHtml` — the page mounts no router-using component, so no router context |
| Production code changed | **none.** |
| Already covered | `admin/__tests__/organiser-actions.test.ts` — the action's own validation |

### The claim was in six places and it was never true

`AGENTS.md` said `/admin/users` was "genuinely browser-only: its role form is
`useState`-driven". `PROGRESS.md` said the same in the 12(a), 12(f) and 12(g) sections, in
the gap register's checklist, and in the commit for 12(c) — made twenty minutes before I
checked. Six passages, one unchecked assumption, copied forward.

The reasoning is seductive because it is *almost* right: the form really is `useState`,
and a render really does only show its initial branch.

But `useState` is not what blocks a render. `useRouter` is, because it throws
`invariant expected app router to be mounted` without an `AppRouterContext`, and the throw
happens inside the component so the page writes nothing at all. `useActionState` — what
all three forms on this page actually use — renders fine, as a `<form action={…}>` with a
`javascript:throw` guard attribute. The first attempt to render the page worked.

That is the finding, and it is not really about `/admin/users`. **A note saying "this
needs a browser" is a hypothesis about one import, and it had been copied forward for four
slices without anyone re-reading the file.** The check is one `grep`: is `useRouter` in the
tree?

### The page lists the whole database, so nothing here asserts a count

`listUsers()` is a `findMany` with **no `take`**, unlike `/admin/drops` (100) and
`/admin/ai-drafts` (50). At the time of writing the render reported 1544 users and 48
organiser profiles, plus dozens of organisers with no profile at all.

So every assertion is scoped to a row this file created, found by its own email, and the
suite never asserts a header count. It also never uses a bare `toContain` for a string
another row could contain — which mattered immediately, because an organiser appears
**twice** on this page: once in the Users list by email, once in the Organisers list by
display name. The first version of `cardFor` searched from the top of the document, found
the Users row, and asserted organiser wording against it. It now takes a section argument
and searches from that section's heading.

### What it asserts, and the two designs the fixtures had to force

The interesting assertions are not "the row exists". They are the ones with a plausible
wrong version that renders plausibly:

- **The role is a word, not the enum.** `ROLE_LABEL[user.role] ?? user.role` — one row is
  an `ORGANISER`, and the test asserts `Organiser` while asserting the raw token is gone.
- **A temporary password is badged, and on exactly one account.** A badge rendered on every
  row passes a `toContain`.
- **An account with two merchant memberships joins both names.** `fx.merchant()` names
  every merchant `${prefix} merchant`, so two fixture merchants are indistinguishable in
  the row and a page that joined only `merchantUsers[0]` would pass. Probe C proved it —
  the second merchant is now renamed and the assertion is on the joined string.
- **The stored commission is 7.5%, not the 5% default.** A defaulted fixture reads the same
  whether the page prints the stored value or the fallback.
- **`no phone`, not an empty gap**, and **`share link` singular vs `share links` plural**
  with the count in the sentence.
- **`never signed in`** for a null `lastLoginAt`, against a row that has a real one.
- **The merchant floor prints `25%`, not `0.25%`.** `floorPctOfMenu` is a share; the page's
  `Math.round(share * 100)` is the difference between a margin and a nonsense figure that
  an operator might not notice. Probed — see probe O below.
- **The payout disclaimer sits where the commission is displayed**: "Commission is
  recorded for the record only; nothing pays out automatically yet."

Two assertions are about the *repair* path FR-906 exists for: the profile-less account is
listed separately as broken, and the form it posts carries `value="<that user's id>"`. A
repair form that posted the wrong id would be worse than none — it would rewrite a healthy
organiser — so it is asserted against the id, not against the presence of a form.

### Probe O was not a probe failure, it was a missing assertion

Fifteen probes. Fourteen fail a named test. The one that passed is the slice's second
finding: mutating `Math.round(merchant.floorPctOfMenu * 100)` to print the raw share left
seventeen tests green, because **nothing asserted the merchant floor at all**. The page
rendered `min margin 0.25%` and the suite was happy.

I had written the fixture with `0.25` deliberately — a share whose percentage is a whole
number, so the two readings are visibly different — and then never asserted on it. That is
worth naming as its own failure mode: **a fixture designed to expose a bug is not an
assertion about that bug.** The design only pays off once a test reads the figure.

Three probes were self-inflicted and reported as such: L added a `data-order` attribute
that renders nowhere the test looks, M targeted `page.tsx` for a string that lives in
`CreateUserForm.tsx`, and K is discussed below.

### Three limits, named rather than papered over

- **The role `<select>` cannot be switched.** It is `useState('MERCHANT')`, so every render
  shows the non-organiser branch. The organiser branch of `CreateUserForm` is asserted by
  reading the conditional and by the action's own tests, not by a render. This is the one
  thing the "browser-only" note was right about, and it is one field of one form.
- **The repair card's zero arm is unreachable.** It needs a database with no profile-less
  organisers; this one holds dozens that are not this file's to delete. Probe I replaced
  `{profileless.length > 0 ? …}` with `{true ? …}` and every test stayed green — which is
  what an unasserted branch looks like. The guard is now asserted from the source and
  labelled as the weaker thing it is.
- **The heading's singular arm is untestable here.** Probe K deleted the
  `=== 1 ? '' : 's'` ternary and all seventeen tests stayed green: the count is 98, so both
  the correct and the broken form render `s`. No fixture of mine can separate them. The
  plural arm is asserted; the singular is read and believed.

### The teardown bug was reproduced, which is why it is now in AGENTS.md

An hour earlier I had fixed `share-links.test.ts`'s swallowed `ShareLink_organiserId_fkey`
violation. Writing this suite, I hit the identical error: the singular-share-link test
creates a link, and teardown deleted the profile first. Same file, same file shape,
different suite — **the lesson had lived only in a commit message.**

The second half was worse and is the reason for the `step()` collector. Every delete ran
in sequence inside `afterAll`, so the FK throw on step one skipped steps two and three — a
*failing* run therefore leaked more than a passing one. The suite accumulated 46
`aumw…-broken` organisers, one per red run, and the admin screen listed each of them as a
broken account. With every step attempted and the failures rethrown together, one run
leaves the count at 98 and so does a deliberately failing run. That check — count before,
count after, require equal — is the verification, because reading teardown proves nothing.

### Counting one thing let a second leak hide behind it

The residue check I wrote counted **profile-less organisers**, and this suite passed it
before and after. It was still leaking — it just was not leaking organisers, so the number
I chose to watch did not move.

Counting `User` rows instead, across one full suite run, showed 1736 → 1762: **26 accounts
per run.** They came from five files, and every one was the same shape:

| File | Leaked |
|---|---|
| `lib/drops/__tests__/cancel.test.ts` | 14 (`auditActor()`, one per test) |
| `lib/admin/__tests__/force-fail.test.ts` | 11 (the same helper) |
| `lib/refunds/__tests__/participant-refund.test.ts` | 1 (`ACTOR`) |
| `lib/redemption/__tests__/redeem.test.ts` | 1 (a second scanner) |
| `api/admin/participants/[id]/refund/…` | 1 (`fr…-admin`) |

The cause is identical in all five and it is not carelessness: `settlementFixtures.cleanup()`
deletes the drop, its participants and its customers, and **has no reason to know about a
`User`**. Every suite that needed a real actor for `AuditLog.actorUserId` created one, because
the FK demanded it, and then reasonably assumed `cleanup()` covered it.

Two of the five had a docblock that said the row existed and why, and neither said who
deletes it. `cancel.test.ts` and `force-fail.test.ts` had 25 accounts between them.

All five now track their ids and delete them, in FK order, through the same `step()`
collector. Verified by the count that actually moves: a full run is 1040 → 1040 for users,
and a deliberately failing run of `cancel.test.ts` is also unchanged.

The check is now `scripts/check-residue.mjs`, so the next slice does not have to reinvent
it — and, more to the point, so this lesson does not live in a commit message a third time:

```
node scripts/check-residue.mjs > /tmp/before.json
npx vitest run
node scripts/check-residue.mjs --compare /tmp/before.json
```

It paid for itself before the commit: run against the fixed tree it reported `auditLogs
3414 → 3485 (+71)`, a third accumulation nobody had noticed. That one is **not** residue —
`AuditLog` has no cascade from its target by design, because a trail that vanished with its
subject would not be a record of anything — so the script reports it and does not fail on
it. A gate that fails on every run is a gate nobody reads. The other eight counts are
fatal if they move, and a mutation probe that removed one `createdActorIds.push` was caught
by name and table (`users 1762 → 1775`).

Cleaning up afterwards was worth doing for its own sake: the dev database went from 1762
accounts to **1040**. 722 of them were this leak, accumulated across every run of this
project, and `/admin/users` had been listing all of them.

**The lesson is about the check, not the fix.** A residue assertion is only as good as the
row type it counts, and the obvious row type is the one the visible bug was about. Counting
`User` — the table every fixture writes and no fixture owns — is what found the other 26.
That belongs in `scripts/`, not in a heredoc someone deletes.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint "src/app/(admin)/admin/users" …   clean
npx vitest run                        1568 passed | 8 skipped (1576) across 121 files
npx next build                        ✓ /admin/users  2.5 kB  109 kB
residue, one full run                 organisers 98 → 98 · users 1040 → 1040 · no leak
residue, a deliberately red run       users unchanged
```

### Not proven

- **No browser has loaded this page.** What is proved is what the server sends. The forms
  are inert here: submitting one, the `useActionState` error message after a rejected
  submission, and the role switch are all unexercised.
- **The floor rounding is asserted at one value.** `0.25` distinguishes the two readings,
  which is what the assertion needs, but a floor like `0.255` would round to 26 and this
  suite would not notice.
- **Nothing here asserts a total or a count of the roster**, by design. A claim about "all
  users" is untestable against a shared database, and pretending otherwise is how a suite
  becomes flaky for reasons unrelated to the code.
- Gap 12(e), the organiser walkthrough, is untouched. _(Its render half has since landed —
  see 12(e); the walkthrough itself has not.)_ Neither gap-18 API route has crossed
  a socket.

## M7 — gap 12(c), two pages and the claim that spans them

`/admin/ai-drafts` is FR-905 and `/admin/ai-drafts/[id]` is the run in full. They are one
slice rather than two because gap 12(c)'s checklist sentence is a claim about **both**:
*"confirm the newest row is the most recent run, that the 'from $X' figure matches the
cheapest proposal on the detail page."* No test of either page alone can make it.

| Piece | Where |
|---|---|
| Tests | `src/app/(admin)/admin/ai-drafts/__tests__/page.test.ts` — 20, real Postgres |
| Harness | `renderToHtml` — neither page mounts a client component, so no router context |
| Production code changed | **none.** |
| Already covered | `lib/db/__tests__/admin-ai-drafts.test.ts`, the loader's 16 tests |

### Nothing was repeated from the loader suite, and nothing needed fixing

The loader suite already covers ordering, the merchant filter, the floor read from the
proposals, the orphaned merchant, malformed JSON and read-only behaviour. This suite does
not restate any of it. What it adds is the screen: every decision on these pages is made
in JSX from data the loader has already approved, so each has a plausible wrong version
that returns *identical data* and renders differently.

### The claim neither page could make

`shows the same lowest price on the row and as the cheapest proposal` renders both pages
from one stored row, reads the row's `from $X`, and then compares it to the **minimum of
the stored proposals computed in the test** — not to "appears somewhere on the detail
page". The fixture makes four prices distinct (1600 menu, 1200 and 1050 proposed, 1150
floor) precisely so the wrong one cannot pass: the list could print the menu price, the
floor, or the dearer proposal and still satisfy every loader assertion.

### Probe O found the gap, and it was a whole page

Fifteen probes. Fourteen failed named tests on the first or second attempt. **Probe O
passed**: replacing the detail page's `draft.merchantName ?? 'Merchant no longer on file'`
with a bare `draft.merchantName` broke nothing.

That is a real hole, not a probe artefact. The list has always rendered the orphan
sentence, and the loader suite asserts `merchantName` is `null` — but **no test had ever
rendered the detail page for an orphaned draft**, so the one screen whose entire purpose
is to answer "which merchant complained" could have lost its merchant label in silence.
React renders the value `null` as nothing, so the `<h1>` would simply be empty.

The repair is a test that renders the detail page for the orphan fixture and asserts both
the sentence and the absence of the literal string `null`. The distinction matters: React
elides the *value* `null`, but a template literal that produced the word would render it
as text, so the assertion is a string comparison rather than a truthiness check.

### Two probes had to be rewritten because the mutation was invisible

Probes H and J first used `className="hidden"` to remove a paragraph and a heading. Both
passed — correctly, and for a reason worth recording: **a CSS class does not remove text
from the HTML**. The render harness reads markup, not layout, so `hidden` changes nothing
it can see. Rewritten to change the *copy* instead, both then failed their named tests.

The general lesson, which belongs with the eight rendering rules: a mutation must remove
what the assertion actually reads. `display: none` is a browser fact and this harness has
no browser.

### Fifteen probes

| Probe | Mutation | Fails |
|---|---|---|
| A | order the list oldest-first | the ordering test |
| B | row price is `Math.max` of the proposals | the row-price test + the cross-page test |
| C | row price falls back to 0 instead of `null` | the row-price test |
| D | drop the `merchantId` filter | scoped-list test + the zero-run test |
| E | never render the orphan banner | the orphan test |
| F | orphan row prints an empty name | the orphan test |
| G | "Show every merchant" href emptied | the scoped-list test |
| H | footnote stops saying the column is a constant | the guardrail-footnote test |
| I | floor renders `$0.00` instead of a dash | the no-floor test |
| J | inputs card heading becomes "Inputs" | the inputs-first test |
| K | rejected-copy section always renders | the rejected-copy test |
| L | `Thin` badge on every proposal | the proposal test |
| M | guardrail value stated as a result | the guardrail-value test |
| N | raw payload re-serialised from lifted fields | the verbatim-JSON test |
| O | orphan heading drops its fallback | **passed at first** — see above |

### Not proven

- **Nothing is clicked, and nothing here needs to be.** Both pages are server components
  with no `useState` and no `onClick`; the `<details>` blocks are native disclosure
  elements, so their collapsed state is a browser behaviour the harness cannot observe.
  The raw JSON is asserted present and parseable, which is the part that could be wrong.
- **The list's 50-row cap is not exercised.** `drafts.length >= 50` adds "newest 50" to
  the header, and no fixture reaches it. Five rows are seeded. Stated rather than implied.
- **`guardrailPassed` false is unreachable by construction**, so the page's "never been a
  row where it was false" sentence is asserted as copy only. It is a claim about
  `persistAuditRow`, which the loader suite and `ai/persist.ts` already cover.

## M7 — gap 12(b), FR-903's reachable half is rendered too

`/admin/drops/[id]` is the page `ParticipantRefundControl` lives on, and it is the only
screen from which "issue a partial refund on one participant" can be done by a human.
Gap 12(a) rendered the list; this renders the drop.

| Piece | Where |
|---|---|
| Tests | `src/app/(admin)/admin/drops/[id]/__tests__/page.test.ts` — 20, real Postgres |
| Harness | unchanged — `renderWithRouter`, from 12(a) |
| Production code changed | **none.** The page and the loader were correct. |

### The slice found nothing wrong with the page, and that is the finding

Every failure in this slice was in the test. Eight of the first run's twenty failed, and
all eight were my own fixture arithmetic: I wrote `3/4 plates` for a drop whose five
participants join eight plates, `$28.75 still held` for a drop holding `$35.00`, and
"six participants" for a drop with five. The page had been printing the right numbers the
whole time.

That is worth recording precisely because it is undramatic. The two previous slices each
found a defect — 12(a) an unrenderable page, 12(g) a fixture that made its own probe
vacuous. This one found a *test* that was wrong in six places and a page that was right,
which is the correct outcome of a suite written after the code rather than alongside it:
the code had a head start and the suite caught up.

### Three fixture states that had to be got right, not merely plausible

The arithmetic was the shallow half. The deeper problem was that three of the fixtures
described states **the system never produces**, and each one passed for the wrong reason
until it was corrected:

1. **`PUBLISHED` with a captured order.** The first `unsettledDropId` was a `PUBLISHED`
   drop holding a `CAPTURED` participant. Nothing forbids that in the schema, so it
   seeded fine and rendered — but capture happens at settlement, after the cutoff, so a
   published drop cannot legitimately own a captured order. The page said so: it printed
   `$6.25 still held` on a drop that had not begun to capture. Replaced with `LOCKED`,
   which is the real state — settlement mid-flight, some participants captured and others
   not — and is the exact race the guard exists to lose gracefully.
2. **"No money captured" asserted on a drop that held money.** Same fixture, different
   assertion. `moneySummary`'s first branch is about a drop nobody has been charged on;
   reusing the settling drop conflated "has not captured yet" with "has no money". Fixed
   by a separate `PUBLISHED` drop with an authorised diner and no `Order` row, which is
   the ordinary pre-cutoff state.
3. **A `moneySummary` branch nothing reached.** The middle branch —
   `$12.50 refunded · nothing still held` — is the state **`forceFailDrop` leaves a drop
   in**, and the operator lands on this page immediately afterwards. No fixture reached
   it, so probe G (collapsing it into "No money captured") passed. Fixed with
   `returnedDropId`: one `CAPTURED` drop whose only order was fully refunded.

The general shape: a fixture that the schema permits but the code never writes will
happily render, and a suite built on one describes a system that does not exist. The
schema is not the specification; `settle.ts` is.

### The drop-scoped sentence had to move to its own drop

`"That drop has not finished settling yet"` is a verdict about the **drop**, read from
`isVoidSweepStatus(dropStatus)`. Every other refusal fixture shares `refundableDropId`,
which is `CAPTURED` — a settled status — so that sentence is *unreachable* there. The
first run asserted it against the shared drop and failed, correctly: the page declined to
print a sentence that was not true of the drop it was rendering.

That is the assertion that catches a naive `chargeStatus === 'CAPTURED'` predicate, so it
is worth the fixture it costs. On `unsettledDropId` the participant is otherwise a perfect
refund candidate — captured, charged, nothing refunded — and the only thing refusing them
is the drop. Probe D removes the guard and fails two named tests.

### Seven sentences, five reachable, two named

`refusalFor` has seven branches. A page render reaches five. The other two are named in
the test docblock with the reason each is unreachable, because "listed under not proven"
is a claim a reader can check whereas silence is not:

- **`MISSING_STRIPE_ACCOUNT`** needs a merchant with no connected account *and* a captured
  order. `settle.ts` throws `SettlementIntegrityError` before capturing anything on such a
  merchant, so the pair cannot be produced through the shipped path.
- **"never successfully charged"** needs `chargeStatus = FAILED` with a non-null `order`.
  The only writer of `FAILED` is the decline path in `settle.ts`, which `continue`s
  *before* `recordCapture` — so the shipped code never writes that pair either.

Both are covered by `refunds/__tests__/participant-refund.test.ts`, which was checked
rather than assumed before the docblock claimed it.

### Eleven probes, each failing named tests

| Probe | Mutation | Fails |
|---|---|---|
| A | sum gross `subtotalCents`, not `subtotal − refunded` | money summary, returned-drop branch, force-fail amount |
| B | keep only the last order's refund instead of summing | money summary |
| C | swap the "already refunded" sentence for another | the four-sentence test |
| D | remove the `isVoidSweepStatus` guard | the drop-status test + the force-fail symmetry test |
| E | count refundables with a local predicate, not `refusalFor` | the count test + the equivalence test |
| F | print gross captured cents as the headline | money summary + force-fail amount |
| G | collapse "nothing still held" into "No money captured" | the returned-drop branch |
| H | print the full phone instead of the last four | the privacy test + the equivalence test |
| I | drop the "settlement holds it" half of the force-fail sentence | the force-fail copy test |
| J | render nothing for a zero refundable count | **passed at first** — see below |
| K | replace the "never charged" sentence with a generic conflict | the four-sentence test |

**Probe J passed on the first attempt**, and it is the only probe in this slice that did.
Deleting the `: ' · none refundable in this state'` branch left all nineteen tests green,
which meant the zero-count path rendered as silence and nothing noticed — a page that had
forgotten to compute the count would have looked identical. Repaired by asserting that
sentence on the `openDropId` render, where the count genuinely is zero. The lesson is the
same one 12(f) recorded and 12(g) re-learned: **a ternary has two arms, and a suite that
only exercises the taken one has tested half a line.**

### Not proven

- **Nothing is clicked.** `ParticipantRefundControl` and `ForceFailControl` are client
  components; the render stops at their initial state. The refund dialog, the amount
  input, the reason textarea and the `router.refresh()` after success are gap 12(c)/(e)
  territory. What *is* proven is that the page hands each control the right props —
  including `capturedCents` rather than a gross total, via probe F.
- **The three route tests stop at the provider.** `STRIPE_SECRET_KEY` is absent, so the
  refund endpoint returns 503 before `issueParticipantRefund` is reached. The tests say
  that explicitly and assert nothing moved, rather than claiming a refund was created.
- **`moneySummary`'s middle branch is asserted from a seeded row, not from a force-fail.**
  `returnedDropId` is a hand-built state that matches what `forceFailDrop` produces, not
  the output of running it. The link is a claim about two code paths agreeing, verified by
  reading both, not by a test that drives the first.

## M7 — gap 12(a), the page the admin work was built for

`/admin/drops` is FR-901, and it is the screen the rest of M7 was written against. Until
it existed, force-fail, partial refund and impersonation were reachable only by composing
an HTTP request — which in practice meant not reachable. FR-902's own route docblock has
said since M8 that the double confirmation is "the client's" and that no client existed.

This slice renders it, and closes the last real gap in the file's most-criticised claim.

| Piece | Where |
|---|---|
| Tests | `src/app/(admin)/admin/drops/__tests__/page.test.ts` — 16, real Postgres |
| Harness extension | `renderWithRouter` in `src/lib/testing/render.ts` |
| One line of dead code removed | `page.tsx`, the chip's `!filterIgnored` (see probe L) |

### The page was not merely untested. It was unrenderable.

`ForceFailControl` calls `useRouter()`, and `next/navigation`'s implementation throws an
invariant — *"expected app router to be mounted"* — when `AppRouterContext` is absent.
Probed before any test was written: calling the page under the existing `renderToHtml`
fails **inside the control, before a byte is written**.

That is a different problem from "nobody wrote a test", and it is worth being precise
about, because the 12(f) docblock predicted it in general terms and this is the specific
case: *any page mounting a router-using client component is unrenderable by the plain
entry point.* `/admin/drops/[id]` mounts `ParticipantRefundControl`, which does the same,
so the next slice would have hit the identical wall.

The fix is `renderWithRouter`, and it supplies **the context Next supplies**, not a stubbed
component. The stub is a plain object satisfying `AppRouterInstance`; the assertion is that
the *real* component read a router and rendered. What a test can therefore see is the
control's initial state, which is more than nothing and much less than an interaction. The
router stub also records `refresh()` calls, which is how "this page never navigates on
load" became assertable.

The extension is **proved necessary by a test**, not by a comment: one test calls
`renderToHtml` deliberately and asserts the invariant. The obvious future "simplification"
of the file is to use `renderToHtml` everywhere, and without that assertion the only signal
would be a red suite with a confusing message.

### The chip bar has one bug it can have, and the test is written against that bug

Every chip shows a count. The count comes from a **separate unfiltered `groupBy`**, and
the wrong implementation is the obvious one: deriving each chip from `rows`, which is
already filtered. Under `?status=FAILED` that renders `All 1` beside `FAILED 1` — two
plausible numbers, one of them meaningless, and both of them internally consistent.

So the assertions compare each chip against a fresh `groupBy` taken in the test, and one
of them states the discriminating fact directly: under a filter, the `All` count and the
filtered count **must differ**. Probing it (probe A) fails a named test.

`listAdminDrops.totalDrops` exists for this (its docblock says so), so the bug was found
and fixed when the query was written — the test is what stops it coming back.

### The money column says three different things, and the fixture makes them disagree

One `CAPTURED` drop carries 2 plates at 625 = 1250 captured, with 250 refunded. So:

| Implementation | The card reads | Is it right |
|---|---|---|
| `subtotal − refunded` | `$10.00` + `$2.50 already back` | ✅ what a force-fail returns |
| `subtotal` | `$12.50` + `$2.50 already back` | ❌ promises money it will not deliver |

Both look plausible on a screen, and only one is the amount at risk. The same figure is
asserted twice — once on the card, once through the header's `N shown · $X at risk` line —
because the total has the same failure one level up. Probes E and J kill both.

The third case is a drop with no captures, which must print `—` and not `$0.00`: `$0.00 at
risk` reads as a problem to investigate, and it is the normal state of a published drop.
Same argument as the commission roster, different consequence.

### `DRAFT` is deliberately absent from the fixtures, and the first version of this file proved nothing

The empty-filter test originally created a drop in every status and then searched for a
status with none — found none, took its own early-return branch, and asserted that a
variable was defined. **It passed while testing nothing.** That is the third vacuous test
this milestone has produced, and it is the same shape every time: a guard that makes a test
green on the path where the fixture is wrong.

The repair was to leave one status out of the seed set, so the branch is reachable by
construction, and to assert `counts.DRAFT === 0` first so the fixture's premise is checked
rather than assumed.

### Probes

| Probe | Change | Result |
|---|---|---|
| A | chips count the filtered rows, not the unfiltered read | `prints each chip’s count from every drop…` |
| B | `All` chip prints `rows.length` | that test **and** the empty-filter test |
| C | drop the ignored-filter sentence | `lists everything and names what it ignored` |
| D | an unparseable status becomes a filter that matches nothing | two, including the chip-active test |
| E | money column reports `subtotal`, ignoring refunds | the total test **and** the card test |
| F | absorb the refund into the headline | `shows what is still out there…` |
| G | `$0.00` where the dash belongs | `says a drop with no captures has no money…` |
| H | offer force-fail on every row | two, including the mid-capture test |
| I | hide force-fail on everything but `PUBLISHED` | two, including the closed-state test |
| J | header total sums gross, ignoring refunds | `totals the money still out there…` |
| K | count joins rather than plates | `names each drop’s merchant, code, price…` |
| L | re-add `!filterIgnored` to the status chips | **PASSES — the guard is unreachable** |
| M | drop `!filterIgnored` from the `All` chip | `does not mark any chip active when the filter was ignored` |
| N | write an audit row during render | `renders several views without changing a row…` |
| O | call `router.refresh()` during render | same test |
| P | remove the router provider from `renderWithRouter` | **all 16** — nothing renders |

**Probe L is the finding of this slice.** Removing `&& !filterIgnored` from the status
chips changed nothing and broke nothing, because under an ignored filter `status` is
`null`, so `status === entry` is already false for every chip in that list. The guard could
never be reached — it was shipped dead code that *looked* like a considered defence. Probe
M proves the `All` chip genuinely needs its own, since `status === null` is exactly true in
that case. The line is now removed, with a comment saying why its absence is deliberate, so
the next reader does not helpfully put it back.

### Verified

```
node v24.21.0  tz 2026c
npx tsc --noEmit                      clean
npx eslint .                          clean
npx vitest run                        1511 passed | 8 skipped (1519) across 118 files
prisma migrate status                 no migration — this slice adds no schema
```

### Not proven, and this must not be overstated

- **No browser has loaded this page.** The suite proves what the server sends. The *two
  presses* FR-902 requires are still unproven: the closed state is asserted, and pressing
  it is not. `ForceFailControl`'s typed-code gate, its disabled button, its refusal
  rendering and its `router.refresh()` after success are all still review-only.
- `/admin/drops/[id]` (FR-903's per-participant refund), `/admin/ai-drafts` and
  `/admin/users` remain unrendered. *(Superseded: all three have since been rendered.
  The sentence about `/admin/users` — "cannot be finished by this harness, `useState`-driven
  form" — was the wrong diagnosis and is corrected in 12(d): `useState` renders, at its
  initial value; only `useRouter` blocks a render.)* `/admin/users` still cannot be finished by this
  harness — `useState`-driven form — and the router extension does not change that.
- **The row cap.** `listAdminDrops` takes 100; the "shows every drop" assertion checks the
  database is under that before asserting, so it fails honestly rather than silently.
- Gap 12(e), the organiser walkthrough, is untouched. _(Its render half has since landed —
  see 12(e); the walkthrough itself has not.)_ Neither gap-18 API route has crossed
  a socket.

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
  unrendered.** *(Superseded: all four have since been rendered — see 12(a), 12(b), 12(c)
  and 12(d). Kept as written because the `useState` note below was the reason they were
  skipped, and it was wrong.)* `/admin/users` remains the highest-value next one and the one this harness
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
  *(Superseded: every one of these has since been rendered. The sentence about
  `/admin/users` needing a browser was wrong — see 12(d).)* `/admin/users` is the
  highest-value next one, because its conditional form is
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

> **Superseded by M8.** The relation *was* subsequently added, with `SetNull`, and the
> row now records the name at write time instead of looking it up. The reasoning above
> was the right call for a slice that was not about retention; M8 is that slice, and
> this paragraph is kept because the sequence — defer with a note, then do it — is the
> part worth remembering.

**The relation is deliberately still not added.** It needs `onDelete` decided:
`Cascade` deletes audit rows when a merchant is deleted, defeating the point of an
audit trail; `Restrict` means a merchant that ever asked for proposals can never be
deleted. Either choice is a retention decision, and this slice is not about retention.
It is recorded as gap 14 below so it does not get lost, and the first thing the
migration would do is fail its own FK validation on any historical orphan.

> **Resolved in M8.** Neither worry materialised: measured 0 orphans, so validation had
> nothing to reject, and the retention decision was already made elsewhere in the repo
> (`AuditLog`). Recorded here because "it will fail on historical orphans" was an
> assumption I never measured until the slice that had to act on it.

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

## M8 — gap 14, the audit record that could not name its own subject

Closes gap 14. One migration (`20261103215813_aidraft_merchant_fk`), one loader change,
one write path, and 6 net new tests.

| Piece | Where |
|---|---|
| The constraint and the recorded name | `prisma/migrations/20261103215813_aidraft_merchant_fk/` |
| Capturing the name at write time | `persistAuditRow` in `src/lib/ai/deal-builder.ts` |
| Reading it, with a fallback for old rows | `resolveName` in `src/lib/db/admin-ai-drafts.ts` |
| The deletion banner | `/admin/ai-drafts` |

### The decision was already made, in another table

`AiDraft.merchantId` had been a bare `String` with an index since `init` — no
`@relation`, so it could hold any string at all, and the loader had to defend against a
dangling id by looking the name up separately and typing it `string | null`. The previous
slice wrote down why: choosing `onDelete` is a retention decision, and that slice was not
about retention.

This slice is. And the choice was not open, because the repo had already answered it:

```prisma
model AuditLog {
  actorUserId String?
  /// The actor's email at the time of the action. Denormalised on purpose.
  actorEmail  String
  actor     User? @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
```

`SetNull` plus a denormalised name column, so the record outlives the thing it names.
`AiDraft` now has the same shape for the same reason: `merchantId String?` with
`onDelete: SetNull`, and `merchantName String?` written once and never updated. `Cascade`
would have deleted the evidence when the merchant left — the opposite of an audit trail.
`Restrict` would have made any merchant that ever pressed "get proposals" permanent.

### The assumption I never measured was wrong

Gap 14 said the migration "will fail its own FK validation on any historical orphan".
That was written as a reason to defer, and it turned out to be a guess. Measured before
applying:

```
drafts: 2   orphans: 0   already-null ids: 0
```

Zero. The loader had been written to tolerate orphans and none had ever occurred. So the
data decision the gap insisted on did not exist — it was a schema change from the start,
and three sessions of deferral rested on a number nobody ran. The count is now in the
migration's header comment, because the next person deserves to find it there rather than
re-derive it.

### Two kinds of "gone", which the page used to print as one sentence

Adding the name column split a fact in two, and the page had to be taught the difference:

- **Merchant deleted.** `SetNull` blanks the id; the row still names the merchant. An
  operator answering "which merchant complained" gets an answer.
- **Nothing can name it.** A row written before the column existed, whose merchant was
  later deleted. Both sources empty → "Merchant no longer on file", which is then true.

The banner above the list counted `merchantName === null` — correct before the column
existed, and a lie after it: a deleted merchant that is still named would not be counted,
so the screen would under-report exactly the deletions it exists to disclose. It now
keys on `merchantId === null`, which is `SetNull` firing and means one thing only.

### Probe B: the assertion that could not fail

Six of eight probes were caught immediately. Probe B survived: setting the *audited*
name to the planner's `'Your restaurant'` placeholder left 12/12 green.

The temptation was to write a sharper assertion. It would not have worked, and the reason
is worth recording: `item.merchantId` is a foreign key, so `loadEligibleDish` cannot
return an item whose merchant is missing, so **neither `??` arm is reachable from any
fixture**. The `.not.toBe('Your restaurant')` I had written could never fire because the
placeholder could never be produced.

The actual defect was that `buildDealProposals` kept two variables — `merchantName` with a
placeholder, `auditedMerchantName` without — for one read of one column. Two variables
that agree only because a branch is unreachable is a divergence waiting for a reader. The
repair removed the second variable and applied the placeholder at the one call site that
needs it. Probe B now fails when reintroduced, and this time it fails for the right
reason: the code has one name to get wrong.

### Not proven

**No row in the dev database has exercised the `SetNull` path in production.** Two drafts
exist and both are named; the migration changed a column, not any row. The behaviour is
proven by tests that delete a real merchant and read the surviving row, which is the same
statement the database would make under real traffic — but it has not yet been made by
real traffic.

**Nothing prunes on age.** Gap 14 offered "a retention job that prunes on age" as one of
the three options; the answer chosen keeps rows forever. That is correct for an audit
trail in a five-merchant pilot and wrong eventually, so the screen is capped at newest 50
rather than the table.

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

    **Partly closed since:** `/commission`, `/admin/commission`, `/admin/drops`,
    `/admin/drops/[id]`, `/admin/ai-drafts`, `/admin/ai-drafts/[id]`, `/admin/users` and
    `/organiser` are now *rendered* by the suite — `src/lib/testing/render.ts` calls the
    real pages against real Postgres and asserts what the HTML says, so their branches and
    copy are no longer review-only. `renderWithRouter` extends that to pages mounting a
    client component that calls `useRouter()`, which was the blocking case. `/admin/users`
    was recorded here as needing a browser for no reason: `useState` does not block a
    render, only `useRouter` does. **There are now twenty-one page suites covering all
    twenty-four of the app's pages** — six under `/admin` covering seven pages (the AI-drafts
    suite renders the list and the detail; `organiser-actions.test.ts` is not a render
    suite), two under `/organiser`, eight merchant-facing ones covering ten pages (the drops
    list, the drop detail, both create-a-drop pages, the dish list, the dish form in both of
    its modes, settings, the pickup counter, and payouts), and the five diner-facing ones that
    closed the gap: `/login`, `/change-password`, `/d/[publicCode]`,
    `/d/[publicCode]/join` and `/d/[publicCode]/mine`. **Every page is now rendered.** This
    sentence said "every page" for about ten minutes before I counted, then said "the other
    ten" until I ran the `find | comm` in AGENTS.md, and then said "the remaining five" for
    four more slices. There is no remaining five.
    What the render harness still removes nothing from is everything about *interaction*:
    client components are not hydrated, so no `onClick` fires and `useState` — and
    `useActionState` — show their initial values. That leaves, precisely: `/admin/users`'
    role switch, FR-902's **second press** and typed-code gate, `/organiser`'s two taps and
    its clipboard (`state.token ?? existingToken` cannot be exercised by a render at all —
    probe M proved it), and the click counter incrementing. Read the boundary at the top of
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
    repairs it, and that the row moves out of the card and into the list.
    **The rest of the page is now rendered** (`page.test.ts`, 17 tests). What is left for
    a browser is exactly the part a render cannot reach: **switching the role `<select>`
    from its `MERCHANT` default**. That is one control, not the page — the note that used
    to sit here said the whole page was `useState`-unrendered, which was wrong and cost
    four slices. Everything else in (d) — the section membership, the commission, the
    repair card's presence, its form's hidden `userId` — is asserted as text and
    attributes without a browser; and
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
    sentence rather than a "Copied" that copied nothing.
    **The static half is now rendered** (`page.test.ts`, 18 tests): list, order, both
    link states, the four-line message, the merchant-zone labels, the threshold boundary
    and FR-805. What remains is genuinely event-driven and cannot move into a render:
    the two taps, the clipboard and its refusal path, and the click counter incrementing
    across three real fetches. `state.token ?? existingToken` — the one `??` probe M
    could not reach — is exercised by the first tap; and
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
14. ~~**`AiDraft.merchantId` has no foreign key**, and the deletion policy for AI drafts
    is therefore undecided.~~ **Fixed.** The column is now a `SetNull` foreign key and the
    row stores `merchantName`, captured at write time, so the audit record survives the
    deletion of the merchant it is about. `SetNull` rather than `Cascade` (which would
    delete the evidence) or `Restrict` (which would make any merchant that ever asked for
    proposals permanent): the repo had already settled what an audit record means —
    `AuditLog.actorUserId` is `SetNull` and `actorEmail` is denormalised for exactly this
    reason. Measured zero orphans before applying the constraint, which is why it needed
    no data decision after all. **Nine probes**, one survivor (probe B) that turned out to
    be an unfalsifiable assertion over an unreachable branch; the repair removed a
    redundant variable rather than adding a test. See *M8* below.
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
16. ~~**FR-801's ranking is not `likelyFill`.**~~ **Built.** The page ordered by soonest
    cutoff and this gap's justification was that §9.3's inputs "do not exist" because an
    organiser with no share links has no history. Two things were wrong with that: the
    schema has every input (`MenuItem.category` was added by D-3 for exactly this, and
    `Drop.status` records the fill outcome of every past drop), and the citation pointed
    at §9.4 when the definition is at §9.3. The ranking is now a pure weighted heuristic
    in `src/lib/organisers/likely-fill.ts`, scored per row in `listShareableDrops`, and
    carried on the wire so the page and `GET /api/organiser/drops` cannot order the same
    data differently. What remains true from the original gap is the *data*: 55 failed
    drops and zero successful ones, so cold start is the only path that runs today — which
    the module pins as its primary case and the tests assert.

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

## M7 — gap 12(h), the paying customer's screen

Gap 12's remaining half is the merchant and diner pages. Sixteen of twenty-four pages had
no render suite; sixteen is too many to do well at once, so this slice takes the ten
`/merchant/*` pages — one layout, one auth gate, the screens the restaurant actually pays
for — and of those, `/merchant/items` first, because its five-label badge is the most
consequential thing a render can reach.

| Piece | Where |
|---|---|
| The page | `src/app/(merchant)/merchant/items/page.tsx` |
| The suite | `src/app/(merchant)/merchant/items/__tests__/page.test.ts` |
| The auth mock it needed | `getSession` stubbed; `requireMerchant` and every query left real |

### The brief said five states and the type has seven

`statusOf` maps `PanelState` to a label, and the obvious reading of it is "seven cases,
seven tests". Both halves of that are wrong.

`ineligible` is checked *before* the switch and short-circuits to `Blocked`, so the two
disqualifiers (`CONTAINS_ALCOHOL`, `NOT_BATCHABLE`) collapse the state they arrive with
into one label. And `OK` and `FLOOR` collapse the other way, into `Ready`. Seven states
become five labels, and a test per state would have asserted the mapping I imagined rather
than the one the code performs.

### `PanelState.OK` cannot appear on this page

The suite has no `OK` fixture, and that is a property of the page, not an omission. The
page calls `evaluateItem({ item, floorPctOfMenu })` — **no `dealPriceCents`** — so there is
no proposed price to compare against the floor. `evaluateItem` therefore evaluates the
item's own `minViablePrice`, and `resolvePanelState` returns `FLOOR` for it by definition.
`OK` needs a price above the floor, and this page never supplies one.

Checked rather than reasoned: a sweep of 252 cost combinations across menu price, food,
packaging and floor produced only `FLOOR`, `THIN`, `INFEASIBLE` and `INVALID_COST_DATA`.
So the `case PanelState.OK:` arm and the `case PanelState.FLOOR:` arm are the same arm as
far as this page is concerned, and the `Ready` test is really a `FLOOR` test. A future
reader who notices the missing `OK` case should know it is unreachable here — it becomes
reachable the moment anyone passes a `dealPriceCents`, which is why the arm stays.

### Seven probes, seven kills

The first clean sweep in several slices. Each mutation is aimed at a different claim:

| Probe | Mutation | Killed |
|---|---|---|
| A | delete the `ineligible` short-circuit | 1 — both `Blocked` cards become `Can't deal` |
| B | `THIN` arm → `Ready` | 2 — the badge, and `THIN ≠ Ready` re-asserted against `evaluateItem` |
| C | `INFEASIBLE` arm → `Needs work` | 1 — collapses it with `INVALID_COST_DATA` |
| D | menu price → `evaluation.view?.dealPriceCents ?? 0` | 1 — every card would print `$0.00` or a price the page must not use |
| E | reverse `listItems` | 1 — the `indexOf` ordering test |
| F | `items.length === 0` → `false` | 1 — the empty state vanishes behind an empty list |
| G | drop `archivedAt: null` from `listItems` | 1 — the archived dish reappears |

Probe G needed fixing before it was worth running. Its anchor,
`where: { merchantId: { in: [...merchantIds] }, archivedAt: null },`, appears **twice** in
`src/lib/db/items.ts` — once in `listItems`, once in `highestMenuPriceCents`. A two-site
mutation that turns a test red does not tell you which site the test guards, which is the
same defect as an assertion that cannot distinguish the cases it claims. The anchor now
includes the `findMany` opening line, so it lands on `listItems` alone.

### What the fakes cost, stated

`getSession` is stubbed — `vi.mock('@/lib/auth/session')` returning whatever
`sessionState.session` holds — because a session cookie is not something a render can mint.
Everything below it is real: `requireMerchant`, `listItems`, `getFloor`, `evaluateItem`
and the `Badge`/`Card` components all run against Postgres. The stub moves one value, and
the empty-state test uses it to swap in a second merchant's owner rather than to fabricate
a merchant-less list.

### One assertion in this slice could not fail

The suite originally ended the `Blocked` test with a line proving the two blocked dishes
were blocked *for different reasons*:

```ts
expect(textFor(html, dish.alcohol)).not.toBe(textFor(html, dish.notBatchable));
```

It is vacuous, and reading the suite back is what caught it. `textFor` returns the whole
card, and each card prints its own dish name — `House Red` against `Hand-Plated Tasting` —
so the two strings differ no matter what the badge says. A page that printed one fixed
sentence for every blocked dish would satisfy it. Measured rather than argued: two card
bodies differing only in name are unequal with an identical badge.

The claim was about a reason sentence this page does not contain. `statusOf` returns
`{ label: 'Blocked', tone: 'blocked' }` for both disqualifiers — the distinction lives in
`ineligibilityOf`, in `evaluate.ts`, and is tested there. So the line was removed and the
comment now says why, which is the useful residue: the *page's* obligation is that it reads
`ineligible` at all.

Removing it did not cost coverage, and that was checked rather than assumed — probe A was
re-run afterwards and still fails the same test, on the two `toContain('Blocked')` lines
that carry the actual claim.

## M7 — gap 12(i), the page that must not re-price a drop

The second `/merchant/*` page, and the one carrying the most expensive property in the
group. `/merchant/drops/:id` has two modes chosen by `status`: a `DRAFT` is an editable form
with the blocking problems listed, and **everything else is read-only with the money read
from the frozen snapshot**.

| Piece | Where |
|---|---|
| The page | `src/app/(merchant)/merchant/drops/[id]/page.tsx` |
| The suite | `src/app/(merchant)/merchant/drops/[id]/__tests__/page.test.ts` |
| The claim under test | FR-207 — a published drop's page must not re-evaluate the guardrail |

### The assertion a loader test cannot make

`publish.test.ts` already proves the *row* survives a dish edit. It cannot prove what the
page **prints**, because a page is free to ignore the row it loaded — and the wrong version
of this page is not a crash, it is a plausible number. So the test publishes through the real
`publishDrop`, renders, edits the dish, and renders again.

The figure is checkable arithmetic rather than a fixture constant: vector A's dish at
`$11.12` leaves **$4.01** a plate (`1112 − 560 − 62 − 89`). After the edit the same
arithmetic gives `1112 − 1700 − 62 − 89 = −739`, so a page that rebuilt the view from the
current dish would print **`-$7.39`**. Both numbers are asserted — the one it must print and
the one it must not. Without the second the test would pass on a page printing a constant.

Probe A replaced the snapshot breakdown with a recomputation against the live dish and
**killed six tests**, which is the sweep's strongest result.

### Probe E survived, and the repair was a fixture

`{review.refusals.length > 0 ? (` mutated to `{true ? (` left 14/14 green. The page would
have rendered "Before this can go live" as an empty heading above nothing.

This is the gap 12(c) failure mode in its third form, and worth stating precisely: the
assertion was not weak and the code was not unreachable — **every draft fixture refused
something**, so the branch that only runs when a draft is clean had never been rendered.
Adding one clean draft (`dealPrice` at the floor, quantities inside the batch yield, timings
relative to now) made probe E kill the new test immediately.

The generalisation goes in AGENTS.md below: a surviving probe asks *which state has no
fixture*, before it asks *which assertion is weak*.

### One requirement asserted instead of restated

The page comments that only a `PUBLISHED` drop gets the cancel card, "because `LOCKED` is
mid-settlement and everything after it has already run". A comment is not a test. The suite
therefore renders **both** excluded states — a `LOCKED` drop and a `PICKUP_OPEN` one — and
asserts the card is absent while the read-only money view is present. `PICKUP_OPEN` is the
sharper of the two: diners are queueing at the counter, so offering "call it off" there would
be worse than at settlement, and it is the case a looser `status !== 'DRAFT'` guard would get
wrong. Probe B tried exactly that guard and killed three tests.

### A fixture that could not resolve, and the production path that could never reach it

The first run failed two tests honestly: `LOCKED` and `CANCELLED` rows were written with
`guardrailSnapshot: {}`, and every non-`DRAFT` status renders through
`readGuardrailSnapshot`, which throws on `{}`. The fixture was wrong, not the page — but
checking *why* it was wrong produced the useful fact: neither state is reachable by
`publishDrop`. `cancel.ts`'s CAS requires `PUBLISHED`, and settlement flips to `LOCKED` after
capture. So a `CANCELLED` drop always carries a snapshot, and the page cannot meet an
unreadable one through any production route. The fixtures now build their snapshots with
`buildGuardrailSnapshot`, so they carry the same version and shape as a published drop.

### What is passed and cannot be printed

`CancelDropButton` receives `participants` — the joined quantity — and uses it in the
confirmation panel's warning: *"3 people are holding plates"*. That sentence is inside the
`if (!open)` early return's **other** branch, and the component renders closed. **No fixture
can make this render print it.** The prop is computed and passed (`countJoinedQty` runs) and
is invisible to the suite. The counting is `countJoinedQty`'s, tested there; recording this
here so nobody adds an assertion on that sentence expecting it to fail.

For the same reason the typed confirmation code, the reason field and `router.refresh()`
remain browser-only. `PublishButton`'s `payoutsReady: false` branch *is* reachable — no
`stripeAccountId` means `readOnboarding` returns `NOT_STARTED` — and is asserted; the `true`
branch needs a Stripe account and is not.

## M7 — gap 12(j), the pages that decide almost nothing

The remaining merchant pages split into two shapes. `/merchant/drops` and the two
create-a-drop pages decide very little — a status lookup, one `hasBatchableDish` boolean, a
filter — and `/merchant/items/new` + `/[id]` are one component in two modes. A render suite
is the right size for all of them precisely *because* the logic is thin: what can go wrong is
not an algorithm but a page printing the wrong sentence, or offering an option the server
will refuse.

| Piece | Where |
|---|---|
| Drops list | `src/app/(merchant)/merchant/drops/__tests__/page.test.ts` — 9 tests |
| Both create-a-drop pages | `src/app/(merchant)/merchant/drops/new/__tests__/page.test.ts` — 10 tests |
| Dish form, both modes | `src/app/(merchant)/merchant/items/__tests__/edit-page.test.ts` — 11 tests |

### An assertion scoped to the wrong element measures its own fixture

The drops list maps eight `DropStatus` values to eight labels through `STATUS_COPY`, and a
missing entry does not crash — it falls through to `{ label: drop.status }` and prints the
raw enum on a merchant's screen. So the fixture renders one drop per status and asserts each
label. The obvious second assertion is that no card contains the raw enum.

That assertion failed on `DRAFT`, and the reason is worth keeping: the fixture was titled
**`Status DRAFT`**, so `DRAFT` was literally inside the title the test was asserting against.
The test was not measuring the badge; it was measuring its own fixture. The repair is not a
weaker assertion but a narrower one — `badgeTextFor()` regexes the badge `<span>` out of the
card, so the claim is about the element that carries it. A page that badged everything the
same way still fails.

### A fixture can model a state the database forbids

The first `'Dish removed'` test tried to delete a `MenuItem` that had a `Drop` pointing at
it, and Postgres refused: `Drop_menuItemId_fkey`. `Drop.menuItem` has **no `onDelete`
clause**, so a dish with any drop is undeletable by construction — the fixture was asserting
against an impossible world.

The reachable state is *archiving*. `listItems` filters `archivedAt: null`, so an archived
dish drops out of the name map the page builds, and the `?? 'Dish removed'` fallback is what
a merchant actually sees. The test archives the dish instead of deleting it, which is the
only path a real row can take.

The same test then failed a second time, in a way that is worth one line: the dish was named
`Its Dish Is Retired` under a title ending in `Retired`, and the assertion
`not.toContain('Retired Dish')` — meant to prove the dish's *name* was gone — matched across
that boundary. Renamed to `Aubergine Parm`, with the collision recorded in a comment.

### An `orderBy` that a naive fixture cannot defend

`listDrops` sorts `createdAt: 'desc'`. My first fixture set timestamps as
`Date.now() - minutesAgo * 60 * 1000`, which made insertion order and `createdAt` order
*disagree* — so the test failed for the wrong reason. The corrected formula,
`Date.now() - (1000 - minuteOffset) * 60 * 1000`, makes later rows newer, so dropping
`orderBy` still fails: Postgres's own default order is not insertion order either.

### Two claims a render cannot reach on the create-a-drop pages

`DealBuilder` starts at `{ kind: 'interview', step: 1 }`, which renders the day picker and
twelve hour options — **not** the dish `<select>`. So the interview's dish filter, which is
half of the suite's shared claim, **is not assertable on first paint**. Rather than drop the
claim silently, the test pins the boundary: `optionLabels(html)` must deep-equal the twelve
hours, and the dish names must be absent. That is what a later reader checks before
concluding the filter is untested.

`DealBuilder`'s `timeZone` prop is worse: probe H replaced the merchant's zone with `'UTC'`
and 10/10 stayed green. Investigation showed the prop is read only to label proposal cards,
which live behind `phase === 'results'` — and it has **no test anywhere in the repo**. So the
AI page's docblock claims ("the card labels and the generated group-chat message cannot
disagree about what time pickup starts") currently rest on review alone. Recorded in the
suite rather than papered over.

### The probe that survived on a sentence I had half-asserted

Probe H2 mutated the AI page's intro from `three ways` to `one way` — and stayed green,
because the suite asserted only `'Five questions.'`. This is the gap 12(i) lesson in its
fourth form, and the cleanest instance yet: not a weak assertion on a correct fixture, but an
assertion that stopped mid-sentence. The repair was to assert the whole promise
(*"Five questions. You will get three ways to run it, each with a price that still clears
your minimum margin."*), then re-run the probe, which then killed.

Seven of eight probes on that suite were load-bearing on the first pass. The eighth is
`timeZone`, above.

### The unused variable that was a missing assertion

`eslint` flagged `html` as assigned-but-unused in the drops empty-state test. The variable was
a symptom: the test was named *"…instead of a dead new-drop button"* and asserted the button's
**label** had changed to `Add a dish first`, but nothing checked its **href**. A page that
rewords the button and leaves it pointing at `/merchant/drops/new` reads perfectly in `text`
and is exactly the dead end the branch exists to prevent — the merchant lands on "No dish can
be a drop yet", the same fact one click later, phrased as a refusal.

Three assertions were added, and both directions were probed: rewording the button while
keeping the dead-end href fails 1 test; pointing `New drop` at the dish form fails 2. The
complement matters as much — the second test now asserts *both* hrefs, so swapping the two
destinations fails twice rather than passing on a page that renders one correct label.

### What stays browser-only

`DropForm` and `DealBuilder` are unhydrated, so no submit, no debounced re-evaluation, no
step advancement, and no pasted group-chat message. `ItemForm`'s `onChange` and its save are
likewise browser-only. The dish `<select>`, the three proposals and the price cards are
behind interactions. Everything else on these five pages — every label, every seeded field
value, every server-computed number, every link — is asserted.

### `MoneyInput` renders money, not a number

`inputValue(html, 'menuPriceCents')` is `'$16.00'`, not `'16.00'`. That is `formatCents`, and
the assertion is written against it rather than against the raw integer.

## M7 — gap 12(k), two rules stated as absences, and a bug found by a badge

`/merchant/settings` and `/merchant/pickup` are the last two merchant screens with real
branching. Both docblocks are written as lists of things the page **does not do**, which is
the hardest kind of rule to hold: a regression is an *added* field, not a changed line, and
there is no assertion that fails when someone adds one.

| Piece | Where |
|---|---|
| Settings | `src/app/(merchant)/merchant/settings/__tests__/page.test.ts` — 12 tests |
| The pickup counter | `src/app/(merchant)/merchant/pickup/__tests__/page.test.ts` — 23 tests |

### "The floor is not editable here" is asserted as an exhaustive set

There is no element to assert the absence of, and `not.toContain('floorPctOfMenu')` would pass
on a page that added a control named something else — which is exactly how an editable floor
would arrive. So the test collects **every `name=` in the markup** and requires the set to
equal `['pickupAddress', 'pickupInstructions']`, plus the absence of any `<select>`. A new
editable value on this page fails it whatever it is called. Probe K adds a percentage
dropdown and kills the test.

### The warning boundary is two-sided at the Decimal's resolution

`isThin` is `floorPctOfMenu < 0.15`, so `0.15` must be silent and `0.14` must warn. A
warning test alone would pass on a page that warns unconditionally — which is the precise
failure the docblock names ("a warning shown before the merchant has a reason to care
teaches them to dismiss warnings"). Both are asserted, and `0.14` is the tightest value the
`Decimal(5,2)` column can hold below the threshold. Probe A turns `<` into `<=` and kills
one test; probe B makes it `true` and kills two.

### The example price is three rules in one expression

`highestMenuPriceCents` + `?? 1600` means the figure is the merchant's **highest** live
dish, archived dishes are excluded, and a merchant with no dishes sees `$16.00`. Each has a
fixture chosen so a wrong implementation prints a **different dollar amount**, not merely a
different branch: `$24.00` (not the constant), `$8.00` with a `$50.00` archived row present,
and `50%` of `$16.00` for the fallback. Probes D, E, G and H each kill between one and three.

### A bug, not a weak assertion: "All collected" on a drop nothing has been collected from

The pickup badge is `drop.outstanding === 0 ? 'All collected' : '${n} plates left'`, and
`outstanding` is `plates − collected` summed over participants. A `CAPTURED` drop has **no
participants** until the cutoff job runs, so `0 − 0 = 0` and the counter screen offers
**"All collected"** for a drop whose window has not opened, let alone one whose food has been
cooked.

The docblock's own reason for including `CAPTURED` in the list is "a merchant who opens the
screen early should see the drop waiting" — so the state is expected, and the sentence it
produces is wrong. This is pinned as current behaviour rather than asserted as correct: the
right fix needs a sentence the badge does not have ("Nothing to collect yet"), which is a
product decision. What the test buys is that the behaviour cannot drift silently in either
direction.

### The time filter has no ceiling, and that is pinned separately

`listCounterDrops` filters `windowEnd: { gte: now − 12h }` with **no upper bound**, so a
`CAPTURED` drop three weeks out is listed. The docblock describes the filter as "open, or
about to open, or recently closed" — true of the past and not of the future. The test asserts
the current behaviour and says so in a comment, so the seam is a known one. Writing the test
against the docblock's implication would leave a red suite where a product question belongs.

### One field the page does not read, and the suite that owns it

Probe L replaced `loadManifest`'s `timeZone` with `'UTC'` and all 23 tests stayed green. That
looked like a hole until the call graph was read: the page takes its zone from `getMerchant`
and never touches `Manifest.timeZone`. The field is not dead — the JSON route
(`GET /api/merchant/pickup-queue/:id`) serialises it — and `manifest.test.ts` asserts it
directly; the same probe kills that test. So the fact is covered, once, where it lives. The
suite records the division so nobody adds a second and weaker assertion.

Two probes needed their anchors corrected before they meant anything. Probe G matched twice
because `listItems` shares the identical `where` clause with `highestMenuPriceCents`, and
probe R targeted `manifest.ts` when `summariseManifest` lives in `rules.ts`. Both are the
"pattern that matches twice applies nothing and reports PASSES" failure mode, caught this
time by the harness's own refusal to proceed.

### Also found by running it

React 19's server renderer emits `autoComplete` / `autoCorrect` / `autoCapitalize` in
**camelCase**, opposite to the HTML spec — an assertion written against `autocomplete="off"`
fails. And `AuthStatus` has no `CAPTURED` member: a paid order is `AUTHORIZED` +
`ChargeStatus.CAPTURED`, because authorisation and capture are separate axes. The fixture was
written from a name-guess and Prisma refused it, which is the cheapest possible way to learn
it.

## M7 — gap 12(m), the page that is the mirror image of the last one

`/admin/merchants/[id]` is `/merchant/settings`' opposite on the two points that matter, and
both are rules rather than layout. The merchant's own page states the minimum margin and
offers nothing; this page offers **the only control in the product that can move it**. And
because the merchant page says *"This is not editable here."*, this page must not — an admin
told to contact an admin is the failure a copy-paste across the two would produce.

| Piece | Where |
|---|---|
| The page | `src/app/(admin)/admin/merchants/[id]/page.tsx` — 144 lines, no logic of its own |
| The suite | `src/app/(admin)/admin/merchants/[id]/__tests__/page.test.ts` — 22 tests |
| The claim under test | US-A1/US-A2, FR-904's entry point, and PRD-sprint1 Q-4's exception |

### Rendering it found a bug, not a weak assertion

`ImpersonateControl` checked `if (!open)` **before** `if (owners.length === 0)`. On a merchant
with only a manager, that meant the admin saw an **enabled "View as this merchant…" button**,
and pressing it produced the explanation the guard exists to show *instead of* a button. The
component's own docblock claims the opposite — that it "renders a sentence explaining why
rather than a control that would fail on submit" — so the comment was describing code that
the branch order made unreachable on first paint.

The fix moves the guard above the closed state and deletes the second copy as unreachable.
Probe F removes the guard and kills 1 test; probe E removes the owner filter and kills 1.
The `ownerless` fixture is what makes both load-bearing: pass a MANAGER through the page and
the filter is the only thing that produces the sentence.

### Four assertions repaired before the probes ran

All four are types this repo has already recorded, which is the uncomfortable part:

   - **A page-wide `not.toContain` measured another element.** `not.toContain('$9.00')` on the
     document caught the *Side Salad's own price* in its dish row. The claim was about the
     floor sentence, so the assertion now extracts that sentence whole with `floorSentence()`
     and compares it. Third occurrence of this shape in the repo.
   - **`rejects.toThrow()` with no argument** passes on a Prisma error, a `TypeError`, or the
     render falling over — a completely broken page satisfies it. Now the 404 digest, which is
     the only value that separates "handled as missing" from "crashed".
   - **A test whose docblock conceded it proved nothing.** "Does not leak a manager's email"
     cannot see the owner filter: the control renders closed, so no address is in the document
     either way. A test that passes identically with the line under test deleted is not
     evidence. The claim is narrowed to "a closed control prints no candidate emails" and the
     filter is left to the manager-only fixture.
   - **A ternary no fixture could reach.** `tone={status === 'ACTIVE' ? 'ok' : 'neutral'}` —
     every merchant in the file was ACTIVE. The word does not discriminate (`SUSPENDED` prints
     the same in either tone), so `headerBadge()` now reads the class and a `SUSPENDED`
     merchant asserts `neutral`.

### The probe that survived, and what it said about the fixture

16 probes, 16 kills — but not on the first pass. Probe B swaps `highestMenuPriceCents` for
`items[0]` and **survived**, because the `pricier` fixture's expensive dish was alphabetically
first: `listItems` orders by `name asc`, so "the first row" and "the highest price" were the
same dish and the mutation was unobservable. The fixture could not distinguish the two
functions. Renaming the cheap dish to sort first (`Antipasto Plate`, $9.00, against `Family
Platter`, $24.00) made the same probe kill.

That is the more useful finding than the 16 kills: a fixture that cannot tell two queries
apart is indistinguishable from an assertion that does not check them, and the probe is the
only instrument that reports which one you have. `ids.full` was already unable to test this —
all four of its dishes are $16.00, which is also the no-dishes fallback constant, so a
hardcoded `1600` printed the same sentence.

### What a render still cannot reach here

`FloorEditor` uses `useActionState` and `ImpersonateControl` uses `useState`, so the form's
submit, the pending "Saving…" label, the six-field validation errors, the reason field, the
owner `<select>`, and the `fetch` to `/api/admin/merchants/:id/impersonate` are all
unexercised — the control's expanded state cannot be rendered at all without hydration, which
is why the closed state's absence of a `<select>` is asserted rather than its contents. The
endpoint itself is covered by its own route suite; the control that calls it is not.


`/merchant/payouts` is the last merchant page, and it is the first one in this stretch whose
central claim is about a **write that must not happen**. Every earlier suite asserted what a
page prints. This one has to assert which function ran.

| Piece | Where |
|---|---|
| The page | `src/app/(merchant)/merchant/payouts/page.tsx` |
| The suite | `src/app/(merchant)/merchant/payouts/__tests__/page.test.ts` — 20 tests |
| The claim under test | FR-102 — an ordinary GET reads; only a return from Stripe writes |

### Why the assertion is on a call log, and why that is not the weaker choice

The docblock is blunt about the reason: *"A page that flips `Merchant.status` on every
anonymous GET makes a status change impossible to attribute later."*

No rendered output can distinguish the two paths. A `READY` merchant renders the same HTML
whether the assessment was read or synced — so an assertion on the output passes on a page
that writes on every GET, which is exactly the regression the rule exists to prevent. The
suite therefore observes the call: with no query parameter `readOnboarding` runs and
`syncOnboarding` does not; `?state=return` and `?state=refresh` invert it; `?state=weird`
does not. That is the only reachable form of the claim, which is a different thing from a
weaker one. Probe A (`returnedFromStripe` forced true) kills 9 tests; probe B (forced false)
kills 2.

`refresh` gets its own test because it is the branch Stripe sends a merchant back with when
the hosted link expired — missing it would leave the merchant on a stale screen after the one
journey that most needs a re-read.

### The seam is mocked and the state machine is not

`readOnboarding` and `syncOnboarding` both end in `realConnectPort()`, which throws
`StripeNotConfiguredError` without `STRIPE_SECRET_KEY`, and this repo has no key by design.
So the boundary is mocked and everything behind it is real: the five assessments are built by
the real `assessOnboarding` from five real Stripe snapshots, and the sentences are the real
`onboardingMessage`. Each state's row is guarded by an assertion that the snapshot actually
produces the state the row claims — otherwise a wrong fixture would test a different state
under the right name.

Probe M removes `details_submitted` from the READY predicate and kills 5 tests, which is the
useful measure: FR-102's rule is not one condition, and the suite is sensitive to all of it.

### Two assertions the probes corrected

Both are the same shape — presence asserted where the claim was about identity or order —
and both survived their first probe.

   - **The badge.** The null-assessment test checked the body sentence and the absence of the
     success panel, but not the badge. Mutating the fallback from `STATE_TONE.NOT_STARTED` to
     `STATE_TONE.READY` stayed green: the page would have shown a green **"Ready"** above
     "Checking your payout status…". The badge is the loudest element on the card.
   - **The sort.** The requirements test asserted both names were present, so deleting
     `.sort()` changed nothing observable. The fixture now supplies the two names in the
     reverse of sorted order, and the assertion compares indexes.

Both were repaired and re-probed, and both now kill.

### The guard that cannot be reached

The page has `if (!merchant) return <p>No merchant is attached to this account.</p>` — and no
fixture can print it. `merchantId` comes from `primaryMerchantId(merchantIds)`, which throws
`AppError.notFound` when the list is empty, so the page function rejects before the guard;
and `MerchantUser.merchantId` cascades, so a dangling membership row cannot outlive its
merchant. The test asserts the 404 and records that the sentence is defensive code, so nobody
later reads its absence of a test as an oversight.

## M7 — gap 12(n), the five diner-facing pages, and the end of gap 12

Gap 12 opened as the weakest claim in this file: most screens were "verified by review and
`tsc`" and nobody had ever rendered one. It closes here — every page of the app is now
rendered by the suite against real Postgres. The last five were the diner's own, and they
were the five with the least excuse: a diner has no account, so every one of them is the only
place a stranger can learn what happened to their money.

| Page | Suite | Tests |
|---|---|---|
| `/d/[publicCode]` | `src/app/d/[publicCode]/__tests__/page.test.ts` | 22 |
| `/d/[publicCode]/join` | `src/app/d/[publicCode]/join/__tests__/page.test.ts` | 12 |
| `/d/[publicCode]/mine` | `src/app/d/[publicCode]/mine/__tests__/page.test.ts` | 22 |
| `/login` | `src/app/login/__tests__/page.test.ts` | 29 |
| `/change-password` | `src/app/change-password/__tests__/page.test.ts` | 17 (+4 for `Field`) |

### Three product bugs, found by rendering rather than by reading

**1. `PUBLIC_VISIBLE_STATUSES` omitted `CANCELLED`.** The deal page's cancellation copy was
written, tested at the `resolveDropView` level, and connected to nothing: `getPublicDrop`
answered `null` for a cancelled drop, so the page returned 404 to a diner whose card had
already been captured and refunded. Five branches depended on it — `headlineFor`'s two
cancellation arms, the deal page's `hadCaptures` paragraph, and both arms of the join-blocked
wording. The trigger was a fixture, not a review: the two `cancelledPaid` / `cancelledUnpaid`
fixtures threw `NEXT_HTTP_ERROR_FALLBACK;404`, which is not something a cancellation test can
produce by being wrong about copy.

**2. `safeNext` forwarded a backslash to another origin.** The login form's open-redirect
guard tested `next.startsWith('//')`. A value of `/\evil.example` has one leading slash, so
it passed — and `new URL('/\\evil.example', base).origin` is `https://evil.example`, because
the URL spec normalises `\` to `/`. The guard had **no test anywhere in the repo**; it looked
right and had never been run against a hostile input. Replaced with an origin comparison
against a dummy base, which settles every variant at once instead of enumerating the tricks I
happened to think of.

**3. `Field` never associated its error with its control.** It rendered `<p id="{id}-error">`
and left the input untouched, so the sentence was in the DOM, adjacent, unread. One of the
52 call sites in the repo passed `aria-describedby`, and that one points at a standalone
alert rather than a field error. Fixed in `Field` — it now extends any caller-supplied value
rather than replacing it — because 52 call sites is 52 chances to forget. This one was found
by **probe R surviving**, which is the sweep paying for itself.

### The render harness had to change twice, and the second change was dangerous

`useActionState` throws when rendered bare — `Cannot read properties of null (reading
'useActionState')` — so `renderToHtml` now wraps every element in `<Suspense>`, which is what
Next does. That is one line and it is correct.

The consequence was not: a `Suspense` boundary turns a recoverable error into **markup**.
React emits `<!--$!--><template data-msg="Switched to client rendering because the server
rendering errored: …">` and the stream completes *normally*. So every existing suite's failure
mode changed from "rejects" to "returns a near-empty string", and a near-empty string makes
`expect(html).not.toContain(…)` pass for the wrong reason — silently, across 136 files. The
1815-test run caught it exactly once, in `/admin/drops`' guard test, which asserts
`rejects.toThrow(/expected app router to be mounted/)`. Fixed by collecting errors through
`onError` and rethrowing after the drain, so a failing page still fails loudly.

Recorded because the failure was *quieter* than the one it fixed. A harness that swallows
errors does not fail; it makes every negative assertion in the repo meaningless at once, and
only a test asserting that something throws can notice.

### Four surviving probes, and the difference between a gap and an equivalent mutant

Two sweeps — 28 mutations on `/mine`, 32 on the auth pages — killed 26 and 30. The survivors
split cleanly, and the split is the lesson:

**Genuine gaps, now fixed.** The header's `plate`/`plates` ternary had no fixture with a
quantity of one, so nothing read the quantity line at all. The pickup window was printed
twice (emerald block and Pickup section) and a document-wide `toContain` was satisfied by
whichever copy was correct — the fourth occurrence of page-wide scoping in this repo. Every
forged token in the first draft was malformed in three ways at once, so a page that skipped
signature verification changed nothing; the fixture now keeps a genuine payload and replaces
only the signature. And the hidden `next` field was asserted against a query string that had
no `next`, so a hardcoded `value=""` produced identical markup — a fixture whose value equals
the fallback constant cannot test the lookup, which is `gap 12(m)`'s rule recurring.

**Equivalent mutants, recorded rather than "fixed".** `next.startsWith('//')` is redundant
against the URL check that follows it (`new URL('//evil.example', base)` is already off-origin)
— kept for cheapness and intent, with the redundancy documented at the line. And
`change-password`'s `state.field === null` branch is unreachable through the page, because the
only no-field failure is "Please sign in again." for a user row that `getSession` has already
implied exists. Writing a test for either would mean inventing a state the product cannot
reach. A survivor looks identical to an untested line, so both are written down next to the
code with the reason.

### What a render still cannot reach on these pages

`/login` and `/change-password` are client components, so a render sees their initial paint
only: the submit button's `pending` branch, the error paragraph, and the `aria-describedby`
switch are all POST states. That is why their suites are mostly about the **server actions** —
`loginAction` and `changePasswordAction` had no test anywhere before this, and they are where
the redirect target, the cookie timing and the rate-limit key are decided. `change-password`'s
own render asserts the two inputs, the policy in words, and the `Field` wiring.

On `/mine`, nothing is a client component, so there is no interaction to miss. What is
deliberately absent is asserted as absent: the phone number (only its last four digits), the
redemption code when pickup has ended, when everything is collected, when the charge was
refunded, and — the case no status-only implementation gets right — when this diner's card
declined on a drop that captured successfully.

## Gap 19 — the endpoint whose caller is not a user

`POST /api/webhooks/stripe` had zero tests. Eighteen `route.ts` files still do; this was the
first taken, because it is the only one with **no session check at all**. Every other handler
sits behind `requireMerchant`/`requireSession`, so a bug there produces a wrong answer to a
signed-in person who can complain. Here the signature is the authentication, and the decision
is whether a merchant may take money — the precondition `assertCanPublish` reads. A handler
that accepted an unsigned body would let anyone who can reach the URL set `Merchant.status`
to `ACTIVE`.

### The real SDK, not a stub, and why that was affordable

`Stripe.webhooks.generateTestHeaderString` and `constructEvent` are pure HMAC: no network, no
key, no clock beyond the 300-second tolerance. So the suite signs a payload exactly the way
Stripe does and lets the production code verify it with the same `stripe@23` path a real
delivery takes. Mocking `constructEvent` would have produced a stub that agrees with itself,
and every rejection assertion would have been an assertion about my own `vi.fn`.

The only module replaced is `@/lib/payments/real-connect-port` — the one file in the
onboarding path that imports `server-only` *and* reaches `api.stripe.com`, and which
`onboarding-service.ts` already loads through a deliberate dynamic import for exactly this
reason. Everything above it stays production code: `syncOnboarding`, `assessOnboarding`, and
the `prisma.merchant.update` that is the whole point of the endpoint. So "keeps
`Merchant.status` honest" is verified against real Postgres rows.

### Both claims in the route's header comment are now falsifiable

`1. Verify the signature against the raw body.` The raw-body test signs a **non-canonical**
payload — a space after a colon and a `\u00e9` escape — and asserts
`JSON.stringify(JSON.parse(raw)) !== raw` as a premise. If that ever stopped holding the test
would go green for the wrong reason, so it fails instead. Swapping `await request.text()` for
`JSON.stringify(await request.json())` re-serialises, the HMAC misses, and the event becomes a
400: probe A, one failing test.

`2. Always 2xx on an event we do not care about.` An `invoice.paid` returns 200 and does no
work; a 400 there is a retry storm. Probe B (answer 400) fails two tests. The subtler half is
probe C — a `default:` arm that writes *without* calling the port at all — which the first
version of the suite could not see, because it asserted only that `port.calls` was empty. That
is what the table-wide diff and the `logger.info` net are for.

### Four rounds of surviving probes, all of them fixture defects

Nineteen mutants now all fail the suite. The route between here and there is the useful part.

1. **`capability.updated` could not catch a prefix mutant.** A `switch (true)` on
   `event.type.startsWith('account.')` survived, because `capability.updated` does not start
   with `account.` — under the mutant it took the *unhandled* arm and behaved like production.
   A prefix mutant needs a prefix collision; the fixture is now
   `account.external_account.updated`, a real Connect event sharing seven characters.
2. **And the collision had to name a merchant that exists.** The handled branch reads
   `event.data.object.id`. My first collision fixture put our account id only in the top-level
   `account` field, so the loosened match found no merchant and took the same `break`. Third
   equivalent mutant in a row from one cause: *a mutant that cannot reach the code under test
   is indistinguishable from one that was caught.*
3. **Two `did-nothing` tests could not see a write.** They asserted `port.calls` was empty,
   which is blind to a direct `prisma.merchant.update`. They now snapshot the whole merchant
   table (96 rows, ~2 ms) and diff it, and assert no `stripe.webhook_processed` line — the log
   net catches a sync that changed no state, which the table diff cannot.
4. **My probe harness polluted the database and manufactured a false survivor.** The mutant
   for round 3 wrote `SUSPENDED` onto a real seeded merchant (`sl1793738360169`); the harness
   ran the next mutant without restoring it, so the following probe took its baseline from an
   already-changed row and a load-bearing mutation reported clean. The row was restored and the
   harness now snapshots the victim and reverts it between probes. This is the round worth
   remembering: a mutation run that can write to shared fixtures can produce false *survivors*
   as easily as false kills, and a survivor is the one signal a sweep exists to produce.

### What is deliberately not asserted

There is no event-id deduplication, and the suite does not pretend otherwise. Stripe
redelivers on any non-2xx and occasionally on its own schedule; the route answers that by
being *idempotent* — re-read the account, write only when the assessment changed — rather than
by remembering ids. The redelivery test pins the cost (the port is asked twice) and the
benefit (the row ends in one state), and its comment says it is the test to rewrite if a dedupe
table is ever added.

The two `503 NOT_CONFIGURED` branches are also genuinely indistinguishable from outside: both
return the same body and log the same reason. They are tested separately because the *second*
one is the one that matters operationally — without it a missing `STRIPE_WEBHOOK_SECRET` makes
`constructEvent` refuse a blank secret and every real delivery becomes `400 BAD_SIGNATURE`,
sending whoever is on call to hunt a signing bug that does not exist.

## Gap 20 — the anonymous endpoint that mints a hold

`POST /api/public/drops/[code]/intent` had zero tests. It is the only **anonymous** endpoint
in the app that creates a real `PaymentIntent` on a merchant's connected account: no session,
no phone, no cookie — anyone holding a public code can make it mint an intent, and a diner's
card is later authorised against whatever amount it carries. Two of its properties are
invisible to `quote.test.ts`, which covers `quoteJoin` directly, because both are statements
about how the *route* talks to the SDK:

- the **amount** comes from the server's frozen snapshot, never the body (ADR-002);
- the **account** is the merchant's (`forMerchant(quote.stripeAccountId)`). Calling
  `platform()`, or passing an account read from the request, puts a diner's hold on the wrong
  account — and Stripe accepts it.

The suite replaces only `@/lib/payments/stripe`, with a recorder that captures the **create
arguments**. That is the whole point: an assertion on the returned body passes for an intent
created with any amount, on any account, with any capture method.

### A real bug: the cancelled drop answered "check the link"

`quoteJoin` read:

```ts
where: { publicCode: request.publicCode, status: { in: ['PUBLISHED'] } },
```

which reads as the obvious choice — you can only quote a drop that is open. But it made
everything the refusal mapping below it exists to say **unreachable**. A `CANCELLED` drop
answered `404 NOT_FOUND`, whose copy is *"Check the link — it may have expired or been
mistyped."* A diner who had done nothing wrong was told their link was broken. `FAILED` and
already-`LOCKED` drops behaved identically.

It was a disagreement between two layers that both looked right:

- `/d/:code` and `/d/:code/join` load through `getPublicDrop`, which filters on
  `PUBLIC_VISIBLE_STATUSES` — a set that includes `CANCELLED`, `FAILED`, `LOCKED`, `CAPTURED`
  and `PICKUP_OPEN`. So the page rendered *"The restaurant called this drop off. Anyone who
  paid has been refunded in full."* next to a join form.
- `joinDrop` locks the row by code with **no status filter** and refuses with the correct
  reason. Only the quote path disagreed.

`quoteJoin`'s own docblock and the route's status table both described the correct behaviour;
the code did the narrower thing, and a five-line comment explaining why `CANCELLED` deserves
its own reason sat above a branch no request could reach. That is the `gap 12(m)` rule again,
in a query instead of a docblock: **a comment claiming a branch is reachable is a claim about
intent, not about code.**

Fixed by reusing the constant rather than restating the list:

```ts
where: { publicCode: request.publicCode, status: { in: [...PUBLIC_VISIBLE_STATUSES] } },
```

The rule `NOT_FOUND` protects is that a guessed code must not reveal a **`DRAFT`**, and
`PUBLIC_VISIBLE_STATUSES` is that rule already written down — it is what the page itself
filters on, so anything reachable here is a drop whose page is public anyway. Two lists would
drift; one cannot. The `DRAFT` half is now asserted directly: a draft's 404 body is
byte-identical to a nonexistent code's.

### The probe that survived three fixtures, and why the fourth was the only one that could work

Eleven mutants, all eleven kill. One took three attempts, and each attempt was a wrong belief
about *which* difference was observable:

1. *Bad quantity on a cancelled drop.* The route's hand-written `qty` guard deleted → the
   mutant survived, because `quoteJoin` runs `checkQty` **before** `refusalFromBlocked`, so
   the diner gets `422 BAD_QTY` either way. Two guards, one outcome.
2. *Bad quantity as a string or a fraction.* Same — every value the route rejects is also
   rejected by `checkQty`, with the same reason and status.
3. *Bad quantity on a deployment with no Stripe key.* This is the only ordering the guard
   changes. The route checks the quantity **before** the configuration gate, so the diner is
   told to fix their quantity. Delete the guard and the order flips to `503
   PAYMENTS_NOT_CONFIGURED` — a reason they cannot act on, for a problem that is not theirs.

The lesson is narrower than "check your fixture": when a guard duplicates a rule that lives
one layer down, the *rule* is never what distinguishes them — only the **ordering relative to
something else** can. Find the neighbouring branch, then put the fixture on the boundary
between them.

### What the suite deliberately does not claim

No card has ever been held against this route. `quote.test.ts` proves the quote and the join
authorise the same cents; this file proves the *intent* is created for those cents, on the
right account, with a manual capture. Whether Stripe accepts the request is a live question,
and `JOIN_FLOW_PROVEN_LIVE` remains `false`. The mock is a recorder, so it can prove the
arguments and nothing about the wire.

## M9 — Merchant reporting

The milestone the audit found **entirely absent**. FR-701 through FR-705 were marked done in
§6.7 of the PRD, and there was no file, table read, page or test for any of them anywhere in
the repo — not a gap in a feature, a gap in a milestone. Three requirements are now built
end-to-end against real Postgres and real ledger rows; the fourth is deliberately not built
and the page says why.

The slice is three modules and one surface: a pure arithmetic core (`lib/reports/drop-report.ts`),
a query layer that assembles its inputs from four flat reads (`lib/db/reports.ts`), and the
page a merchant opens after a drop closes (`/merchant/reports`). The split is the same one
`guardrail` and `commission` use, for the same reason: the arithmetic is where a report can be
wrong, and it is the only part that can be tested against literal integers.

### FR-701 — the five figures, and the refund that reported −$21.33

The PRD asks for units, GMV, the platform fee, contribution, and contribution as a percentage.
Four of those are sums. Contribution is not, and getting it wrong was the first real defect.

Contribution per plate is `dealPrice − food − packaging − card fee − platform fee`, with the
platform fee computed **per unit** and then multiplied. Both details are load-bearing and both
were probed:

- rounding the order total instead of the per-unit figure hits the fee floor (60¢) and cap
  (200¢) once instead of `qty` times — on `$11.12 × 3` that is a 67¢ divergence;
- `contributionPctOfMenu` already exists on `DealEvaluation` and divides by *menu price*,
  because it answers "is this price worth running". A reporting percentage must multiply back
  to the dollars printed beside it, so this one divides by GMV. Reusing the forward-looking
  figure is the tempting mistake and it renders as a plausible number.

The refund arithmetic is where the −$21.33 came from. The first version computed net
contribution as `Σ contribution − refundedCents`, which is wrong by the food cost: a
fully-refunded 3-plate order returned the diners' money but still charged the merchant for
food they had cooked, so the report claimed **−$21.33** instead of zero. Net contribution is
`roundHalfUp(gross × (subtotal − refunded) ÷ subtotal)` — exact at both endpoints (no refund
gives gross, a full refund gives 0) and pro-rata in between. The pro-rata middle is stated as
an approximation rather than hidden, because `Order` records refunded *cents* and not refunded
*units*, so there is no way to know which plates came back.

There is deliberately **no** `refundedCents === 0 → return gross` fast path. One was written,
then deleted: the scaling path already returns `gross` exactly when nothing was refunded, so
the branch was dead code, and a mutation sweep correctly reported it as surviving every probe.

Cost basis is read from `Drop.guardrailSnapshot.input`, never the live `MenuItem` — FR-207. The
proof is a test that doubles `MenuItem.foodCostCents` and asserts the report is unchanged.

### FR-702 — the rule in the PRD classifies nobody as new, ever

This is the finding of the slice, and it is three measured facts rather than an opinion:

1. `src/lib/drops/rules.ts:91` enforces `cutoffAt < windowStart` — joining must close before
   pickup opens, so the merchant knows how much to cook.
2. `Customer.firstSeenAt` defaults to `now()`, and `joinDrop` upserts the customer row **at
   join time**, which is before the cutoff.
3. Therefore `firstSeenAt < cutoffAt < windowStart` for every customer alive. Not usually —
   always, by construction.

So the PRD's literal rule (*new if `Customer.firstSeenAt` falls inside this drop's window*)
returns `false` for everybody on every drop. It is not a hard test to write; it is a test that
cannot fail.

An equality test against `DropParticipant.createdAt` is no better, and this was measured rather
than assumed: five transactional samples showed `Customer.firstSeenAt` landing **1–13 ms
before** `DropParticipant.createdAt`, because the two writes are separate statements with
separate `DEFAULT now()` calls. A test on that pair would be flaky by construction.

The replacement definition is **"this drop was the customer's first *capture* anywhere"** —
`priorCapturedOrderCount === 0`. Capture specifically, not join: an authorised-but-never-charged
card is not a purchase, and counting it would make a first-time buyer look returning.

The count is **time-bounded at `participant.createdAt`**, not "total captures minus one". That
second version is the defect the third real bug came from: subtracting one from a lifetime
total counted *future* purchases, so reporting January's drop in March counted February and
March, and January's report changed every time a customer bought again. A report has to be a
function of the past alone. Caught by a three-drop test against real Postgres, not by reading.

The limitation is recorded rather than papered over: there is no `Customer.merchantId`, so
"new to you" cannot be computed at all — the definition is platform-wide, and the page explains
that to the merchant in those words, because a merchant reading "3 new" would otherwise assume
"3 new to me".

### FR-703 — attribution walks the share link, not the drop

Which organiser drove which units. The obvious implementation joins on `dropId`, which credits
**every organiser on the drop with every unit on the drop** — the bug the requirement exists to
prevent. Attribution walks `participant.shareLinkId` to `ShareLink.organiserId`, over paying
participants only, and the plain-link diners become a named `unattributedUnits` remainder
rather than a silent shortfall.

Two mutants here behaved differently and the difference is the interesting part:

- replacing the lookup with "the first link on the drop" **is** killed, twice;
- appending `?? [...linksById.values()][0]` as a *fallback* **survives**, and correctly: the
  share-link read spans every drop in the report, so a non-null `shareLinkId` always resolves.
  It is dead code, and it was reported as a survivor for a while before anyone checked whether
  it could run. There is no test that could distinguish it. The fallback is not in the source.

### FR-705 — what to do next time

`suggestedActionFor` reads units sold against the drop's min and max. The suggestion for a
sold-out run is `maxQty + max(10, ceil(maxQty / 2))`, and a flat `+10` agrees with it at every
`maxQty ≤ 20` — so the discriminating fixture needs a drop that sells out at **30**, where the
formula says 45 and the flat ten says 40. This is the second time in this repo a formula has
been indistinguishable from its own simplification across the whole fixture set.

### FR-704 is not built, and the page says so

The weekly digest email. It needs a scheduler, an email provider and a template system — three
subsystems that do not exist — and a digest route that logs "would have emailed" would satisfy
a checklist and reach nobody. The other three requirements were still worth building without
it, and the two are not coupled. Recorded here so that the absence is a decision with a
reason rather than an oversight to be rediscovered.

### What the sweep taught about harnesses and honesty

47 mutants, **46 killed**, one survivor. Two harness failures are worth recording because both
produced a *false clean*:

- the first sweep reported `survivors: 0` over **forty probes that never ran**. `cp` to a
  backup path containing `(merchant)/` needed quoting on the destination too, the backup tree
  was never created, `perl` edited nothing, and `md5` compared two identical hashes. The
  harness now fails loudly when a mutation does not apply, instead of counting it as a pass.
- `restore()`'s loop variable `f` shadowed the caller's, so the harness's own lossless-backup
  self-test hashed the wrong file and reported the backup as lossy. Fixed with `local f`.

And one cross-suite interference that a per-test tenant cannot prevent: creating an organiser
`User` and its `OrganiserProfile` in two statements leaves a window in which the row is a
profile-less organiser, and `/admin/users` counts exactly those. The full suite failed once —
`"1 organisers missing a"` appearing inside another suite's `not.toContain` — so both fixtures
now create the profile nested in the same statement. A per-test tenant isolates *data*; it
cannot isolate the *clock*, and the database is shared by every suite running in parallel.

### What is not claimed

The page is rendered, not driven. Nothing here proves a merchant can navigate to it (it is in
`AppNav`, and that is asserted), that the CSV export works (there is none — FR-703's data is
on screen and not downloadable), or that any figure survives a timezone change beyond the
`YYYY-MM-DD` label, which is the only place a zone is read.

## Merchant write pipeline — the routes money enters through

Six routes had no route-level test. Together they are how a merchant's cost data and prices
reach the database: `GET`/`POST /api/merchant/items`, `GET`/`PATCH /api/merchant/items/[id]`,
`GET`/`POST /api/merchant/drops`, `GET`/`PATCH /api/merchant/drops/[id]`, plus the two already
closed in this slice (`guardrail`, `publish`).

### What the suites are for

Not coverage. Three specific claims that only a route test can falsify:

**The body cannot decide who owns the row.** `merchantId`, `id`, `archivedAt` and `photoUrl` are
not in `itemInputSchema`; `status`, `guardrailSnapshot`, `publicCode` and `publishedAt` are not in
`draftInputSchema`. Zod's `z.object` strips unknown keys, so a body naming them is ignored — but
"the response did not echo it" is compatible with "the code spread the body and the database
stored it". Both suites therefore assert the **stored row**, read back after the call. Two mutants
(`items-create-spreads-raw-body`, `drops-create-spreads-raw-body`) are the only way to know those
assertions are load-bearing; both are killed.

**The body cannot publish.** A `POST /drops` with `status: 'PUBLISHED'` and a hand-written
`guardrailSnapshot` stores `DRAFT` and `{}`. Since `Drop.guardrailSnapshot` is a required `Json`
column, `expect(snapshot).not.toBeNull()` would have been vacuous — a draft's snapshot is `{}`,
which is not null, and a published one's is `{...}`, also not null. The check that means
"nothing was frozen" is `Object.keys(snapshot).length === 0`.

**A draft may be unprofitable but not impossible.** `dealPriceCents: 900` against an $11.12 floor
is stored; a window closing before it opens, a cutoff after pickup starts, a `maxQty` above the
dish's `batchYield`, and a cutoff past §8.3's five-day cap are all 422s at save. `PATCH` re-runs
the identical policy through `collectDraftFieldErrors`, so a valid draft cannot be edited into a
state it could never have been created in — the defect `draft-validation.test.ts` was written for,
re-proved at the route where the *wiring*, not the helper, is what broke.

### The three defects

**1. A dish or drop could be saved with a blank name.** `.min(1)` sat before the `.trim()` in
both mappers, and a Zod transform runs *after* the checks on its chain. `'   '` passed validation
and was then trimmed to `''`. Probed on the real parser — `ok: true`, `value.name === ''` — then
fixed by moving `.trim()` into the schema ahead of `.min(1)`, which also stopped 80 padded
characters being counted as 84 and rejected. `.trim()` returns a ZodEffects, so it must come
first in the chain; there is no way to express "check the trimmed value" with the checks in the
other order.

**2. A draft could be saved at a negative price.** `dealPriceCents` is an `Int` and nothing looked
at its sign: `parseDraftInput` had only `.int()`, and `collectDraftFieldErrors` skips price
deliberately. `-5000` was accepted and stored. Publishing such a drop is refused by
`reviewForPublish` (`isBelowFloor` and `dealPriceCents < minViablePriceCents` both hold), so no
diner could ever be charged — but "you cannot store a row claiming a plate costs minus fifty
dollars" is cheaper to state than to reason about downstream. Fixed with `.min(0)` rather than
`.positive()`: `DropForm` initialises an untouched price to `0` and `PATCH` sends the whole body,
so a positive bound would 422 a merchant on a field they never edited. The line the schema draws
is **placeholder vs corruption**, and the test pins both sides.

**3. Republishing a drop answered 422 where 409 is the truth.** `NOT_DRAFT` went through
`AppError.validation`, so a drop already live returned `422 VALIDATION` with `fieldErrors: {}` —
a form with nothing to highlight, which reads as a server bug rather than "you already did this".
The body is valid and *empty*; no other body would be accepted; the obstacle is the resource's
state. Now a dedicated 409 in `src/lib/drops/publish.ts`. The unit test had missed it because it
asserted `rejects.toThrow(/already been published/)` — a message check, which passed for months
against the wrong status.

### The probe that proved nothing, which is the useful finding

The first `items-patch-ownership-after-422` mutant moved the ownership check below the body parse
and was "killed" — by four tests, which looked like strong coverage. It was killed by a
`ReferenceError`: the same edit deleted the `previous` binding that `recordAlcoholFlagChange`
reads, so the route crashed rather than reordered. A **faithful** mutant that moves `getItem`
past the 422 return while keeping `previous` bound **survives** all 20 tests. Only a two-edit
version — move the call, re-bind `previous` at its first use — is killed, and by exactly one test:
`answers 404 for a foreign id even when the body is also invalid`.

So the ordering is covered, but only by a test that asks the precise question, and the harness had
to be taught that some mutations are only meaningful as a pair. A mutation sweep that cannot tell
"killed by the behaviour" from "killed by a crash" reports coverage it does not have.

### The sweep leaked, and the leak was informative

Sixteen mutants, **16 kill**. But the run left **14 `DRAFT` drops** in the dev database, which then
failed an unrelated `/admin/drops` suite whose guard asserts the table holds no drafts — and that
guard's own message ("leaked data from another suite") was correct and was about this file.

Cause: several tests deliberately POST a body they expect to be *refused* — a bad window, a
whitespace title, a negative price — and register no id, because a correct implementation creates
nothing. **Under a mutant, something is.** Cleanup keyed on a list of pushed ids therefore cannot
hold while a probe is running. Both suites now delete **by tenant** (`merchantId: { in: merchantIds }`),
which is independent of which assertions passed. Re-verified after the fix: 96 merchants, zero
strays, zero draft drops — the residue baseline restored.

### What is not claimed

No browser has driven these forms; `DropForm`'s `belowFloor` hint and the panel's slider are read,
not exercised. `heroImageUrl` is validated as a URL and nothing fetches it, so a 404 image is
still storable. The 409-on-published rule is proved by moving the row with Prisma rather than by
publishing through the route, so this suite says nothing about the publish gate — that is the
publish suite's job, and it has one. And `parseDraftInput` still accepts a `menuItemId` that is any
non-empty string; that it must name a real dish in the caller's scope is enforced by
`createDraft` returning 404, not by the schema.

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
read-then-write · `gap 12(h)` a render test asserts the label a page computes, so the
seven-state type becoming five labels is a fact to write down, not a case to invent ·
`gap 12(j)` a claim about a button is a claim about its **destination**, not its label —
`text` cannot see an href, so an unused `html` in a render test is a missing assertion
rather than dead weight · `gap 12(k)` a rule enforced by *absence* is asserted as an
exhaustive set of what may exist, never as a `not.toContain` of one name · and a badge with
one branch for zero cannot distinguish "all collected" from "nothing to collect yet", which
is a product question to pin, not a defect to fix in a test · `gap 12(l)` when a page's claim
is "this GET does not write", no rendered output can reach it — assert the call, and say
which function ran · and a `toContain` on a sorted list asserts membership, not order ·
`gap 12(m)` when a guard's copy exists twice, the branch order decides which one is
reachable — and a docblock claiming the good branch is describing intent, not code ·
a fixture that cannot tell two queries apart is indistinguishable from an assertion that
checks neither, so a surviving probe is a question about the fixture before it is a
question about the code. · `gap 12(n)` an open-redirect guard must ask the URL
parser what a value resolves to, because `startsWith('//')` is a list of remembered tricks and
a backslash is not on it · a shared component that renders an error id without wiring it to
the control is an accessibility bug at every call site at once, so fix it in the component ·
and a `Suspense` boundary added to make a hook renderable also converts a thrown error into
markup, which makes every `not.toContain` assertion vacuous until the error is rethrown. ·
`gap 19` a webhook signature is verified against the **bytes**, so a test of it must sign a
payload that re-serialising would change, and assert that property rather than assume it ·
"does nothing" is a claim about the whole table, not about the rows a suite happens to own ·
a prefix mutant can only be caught by a prefix **collision** that also names a merchant the
mutant can resolve, or it takes the unhandled arm and survives as an equivalent —
and a mutation harness that writes to shared fixtures can manufacture false survivors, so it
must restore what a mutant changed before the next probe reads a baseline. · `gap 20` a query
filtered narrower than the page's own visibility set makes every refusal branch below it
unreachable, and a comment justifying a branch is a claim about intent — so reuse
`PUBLIC_VISIBLE_STATUSES` rather than restating it, and assert the one status it must still
hide · when a guard duplicates a rule that lives one layer down, the neighbourhood that
distinguishes them is not the rule but the **ordering** relative to a branch between them, so
put the fixture on that boundary and expect two wrong attempts first. · `M9` a rule the PRD
states can be unimplementable as written — FR-702's "new if `firstSeenAt` is inside this drop's
window" classifies nobody as new, by construction, because joining must close before the window
opens and the customer row is created at join — and the honest response is to measure that,
state the replacement definition, and name the limitation rather than write a test that cannot
fail · a net figure is not a gross figure minus a refund, because the cost sits inside the gross:
a fully-refunded 3-plate order reported −$21.33 until contribution was scaled pro rata, which is
exact at both endpoints and an approximation only in between, where the schema records cents and
not units · a module with a withholding policy must have **one** error type, or the type from the
layer it delegates to escapes the `catch` and turns a withheld drop into a 500 for the whole page ·
and a count for a past period must be time-bounded at the moment the row was created, never
computed as "total minus one", or the report changes retroactively every time a customer buys again.
· `merchant write` a Zod transform runs **after** the checks on its chain, so `.min(1)` before a
`.trim()` accepts a whitespace-only string and then stores `''` — the trim must be `.trim()` in the
schema, ahead of `.min(1)`, which also fixes padded values being measured untrimmed · a body that
can set a price but not its sign needs a bound even where the *policy* deliberately skips the field:
"a draft may be unprofitable" is why `collectDraftFieldErrors` ignores price, not a reason to store
`-5000` · the bound is `.min(0)` and not `.positive()` when the form initialises the field to `0`
and `PATCH` sends the whole body, so the line is placeholder versus corruption, not valid versus
invalid · a **409** is for a valid body against a resource in the wrong state, and a 422 there
sends a client into a correction loop that cannot terminate · a required `Json` column makes
`not.toBeNull()` vacuous, so "nothing was frozen" is `Object.keys(x).length === 0` · and a mutation
that moves a call without moving the binding it feeds is killed by a `ReferenceError`, which proves
nothing about ordering — if a mutant needs two edits to be faithful, it must have two edits, or the
sweep reports coverage it does not have · a test that expects a write to be refused registers no id,
so cleanup keyed on pushed ids cannot survive a probe: delete by **tenant**, or the sweep leaks and
an unrelated suite fails with a message that correctly blames yours.
