# GroupEat — progress

> **Audited:** 2026-11-04 18:00 CST · **Branch:** `sprint-2/payments-fee-bearer`
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
| **M2 — Merchant + items + Connect** | 🟡 | CRUD and the Connect onboarding state machine exist (`src/lib/payments/`). **FR-101's invitation link landed later**: creating a merchant owner now issues a hashed, one-time, 72-hour `/set-password` token and emails it when `APP_URL` and a provider are configured; the temporary password remains the fallback. Live `charges_enabled` **never verified** — no Stripe key. |
| **M3 — Drop creation + AI** | ✅ | `plan.ts`, ADR-002, interview, copy lint, publish gate, frozen snapshot. **FR-208 (merchant cancel) landed later**, in its own slice — the last gap in drop lifecycle. **FR-206 landed later still**: a draft links to `/d/{code}?preview=1`, which renders the real public page through a merchant-scoped `DRAFT` read — same component, same copy, joins disabled. **FR-205 landed after that**: the draft form accepts a hero URL, and a drop with no photo gets a server-composed SVG card rather than no image. |
| **M4 — Public page + join** | 🟡 | Slice 1 (FR-301…308) shipped at `fe47cbf`. **FR-302's organiser name landed later**: a visit carrying a tracked share token now prints "Shared by {displayName}"; a direct visit prints nobody, because there is nobody to name. **Slice 2a (FR-401…407 domain + API)** at `f3982ed`. **Slice 2b (the join page, `/intent` endpoint) shipped keyless** — the page exists and is tested, but no card has ever been held. **Slice 2c (diner order page, `/d/:code/mine`, the still-filling emitter)**. **Slice 2d (the confirmation link + the one wire type)** — see below. **FR-308's card is now addressed correctly**: `metadataBase` derives from `APP_URL`, so `og:image` is the deployment rather than a laptop (proved on a production build). |
| **M5 — Cutoff + capture** | 🟡 | Code and tests for FR-501…505, 507 at `9f3ea4f`. **The pickup-window transition landed** (`pickup-window.ts`, tick phase 5) — before it, no drop could ever become collectable. FR-506 is a no-op seam, but the charged intent now carries a working order link built from `APP_URL`. Live capture never run against Stripe. |
| **M6 — Redemption** | 🟡 | Scanner, manifest, idempotent redeem (FR-601…605). The diner-facing code page now exists (2c). FR-606 deferred (optional V1.1). |
| **M7 — Reporting + organiser** | 🟡 | **FR-901 landed: `/admin/drops`**, the first M7 artefact and the first screen to render FR-902's double confirmation. **FR-903 is now reachable**: `/admin/drops/[id]` lists participants and issues per-diner refunds, which the endpoint could not do alone. **FR-905 landed**: `/admin/ai-drafts` and one run in full, reachable from the merchant page — the table `persistAuditRow` has been writing since M3, read for the first time. **FR-906 landed**: creating an organiser now creates its `OrganiserProfile` in the same transaction, and `/admin/users` lists organisers with their commissions plus a repair path for accounts made before the fix. **FR-801/802/805 landed**: `/organiser` lists live drops and hands over a tracked share link in two taps, with `DropParticipant.shareLinkId` now written. **FR-803 landed**: the `joined / needed` badge polls `GET /api/organiser/drops` every 15 seconds — one poller for the whole list, half the requirement's 30-second budget — and the pasted share message reads the same live count. **FR-804 landed**: `/commission` states each organiser's monthly commission — 5% of what the restaurant *kept*, net of refunds — with a CSV export, and the tz database the month boundary depends on is now pinned. **Gap 15 closed**: merchant onboarding is the single transaction it always claimed to be, and `slugify` no longer splits accented names. **Gap 17 closed**: `/admin/commission` and `GET /api/admin/commission` give the e-transfer run one file for the whole roster, built as a roll-up of the organiser statements rather than a second implementation of the arithmetic. **Gap 18 closed**: the organiser role now has its full declared API surface — `GET /api/organiser/drops` and `POST /api/organiser/drops/:id/share` — with the route and the server action proved to return the same token, the same URL and the same message, in both orders. **Gap 12(a) closed**: `/admin/drops` is rendered, with `renderWithRouter` supplying the app-router context that made any page mounting `ForceFailControl` unrenderable. **Gap 12(b) closed**: `/admin/drops/[id]` is rendered too — five of `refusalFor`'s seven sentences asserted in full, the two it cannot reach named, and every branch of `moneySummary` reached including the one a force-fail leaves behind. **Gap 12(c) closed**: `/admin/ai-drafts` and its detail page are rendered, with the list's "from $X" proved against the detail page's cheapest proposal — the one claim neither page could make alone. **Gap 12(d) closed**: `/admin/users` is rendered too, and it turned out to have been skippable for no reason — the "genuinely browser-only" note in five places was about `useState`, which does not block a render. **Gap 12(e) closed, as far as a render can close it**: `/organiser` is rendered and its two-tap premise is asserted, including the one claim nothing else could reach — that the card's deadline and the pasted message's deadline are the same label in the merchant's zone. The taps themselves still need a browser. **All seven admin and organiser suites now exist, covering eight of the app's twenty-four pages**; the ten `/merchant/*` pages, `/admin/merchants/[id]` and the five diner-facing pages still do not. **[Corrected in the `layouts` slice: that sentence was true when written and is now stale — a caller-based scan finds all 26 pages AND all 4 layouts referenced by a suite. See the last section.]** **Gap 16 closed**: FR-801's `likelyFill` ranking is built — a weighted heuristic over §9.3's four inputs, in a pure module, with the score carried on the wire so the page and the API cannot order the same data differently. Two corrections to the gap's own justification: every input §9.3 names was already in the schema (`MenuItem.category` was added by D-3 *for this*), and the definition is at §9.3, not §9.4. **M7 is now complete.** Section 6.7 (FR-701…705, merchant reporting) was, however, **entirely absent**. All five are now built: FR-704's weekly digest landed in the slice recorded at the end of this file, after the M9 section's three-way split. |
| **M8 — Beta hardening** | ✅ | All three requirements shipped: **FR-902** (force-fail and refund all) with the `AuditLog` model it needed, **FR-903** (partial refund) with the ledger fix it forced, and **FR-904** (read-only impersonation) with the refresh path it nearly lost. All three were marked done while their UI obligations pointed at a screen that did not exist; FR-901 and the FR-903 detail page have since supplied it. **L5 landed later**: the nightly two-account reconciliation, with its own port, route and cron, and the account dimension derived from the entry type rather than duplicated in a column. See the L5 section at the end. |

## Verified in this audit

- **A `PATCH` to the merchant's own pickup details no longer erases what it omits.** The route
  answered `200` while deleting the field the body had not mentioned, because the parser collapsed
  "absent" and "blank" into the same `null`. Fixed in three places that had to move together: the
  parser tests key **presence**, `updateOwnPickup` lets Prisma omit an `undefined` column from the
  `UPDATE`, and the response now reads back the stored row instead of echoing the patch — a fourth
  defect, found only because the write became partial. A body naming no known field is a `422`
  rather than a silent no-op, which is the only way a misspelled key can be caught, since Zod
  strips unknown keys rather than rejecting them. Four probes, all killed. See *The PATCH that
  erased what it omitted, and the three places the fix had to land*.

- **A diner's link now resolves however it arrives, and the obvious fix would have hidden 55
  drops.** `normalisePublicCode` and `isWellFormedPublicCode` were fully unit-tested and called by
  nothing, so `/d/8en9ajca` 404'd. Measured before wiring anything: **55 of 57 stored codes fail the
  shape check** — all `FAILED` drops, all 11 characters — so gating on the shape check would have
  turned 55 working "nobody was charged" pages into 404s while the suite stayed green. The fix
  normalises instead, at all five reads, including the `FOR UPDATE` in `joinDrop` that would
  otherwise lock nothing. Six probes, all killed; the sixth surviving mutation is the shape gate
  itself. See *The tested function nothing called, and the 55 drops a gate would have hidden*.

- **`/admin/users` is bounded, filterable and 78% smaller.** It was an unbounded `findMany`, so
  the page grew with the `User` table. Measured on a production build in both directions:
  **1,856,483 → 400,428 bytes** and **11,205 → 2,294 element nodes**, with the cap paired to a
  `?role=` chip filter and a `?q=` search so no row becomes unreachable. A second defect was
  found behind the first — 98 profile-less organisers each rendering a full repair form — now
  bounded to 10 with an honest total. Twelve mutation probes, eleven killed immediately and the
  twelfth killed only after it was proved observable. See *The page that listed everything, and
  the cap that would have lost rows*.

- **The share card now resolves to the deployment, proved on a production server.** `metadataBase`
  is derived from `APP_URL` (via the existing `validatePublicOrigin`) and declared once in the root
  layout, so `og:image` is `https://groupeat.example/d/{code}/opengraph-image` instead of
  `http://localhost:3001/…`. Verified with `next build` + `next start` in **both** directions plus
  a counterfactual — the same build with the fix removed, which reproduces `localhost:3103`.
  A production deployment with no usable `APP_URL` now emits **no card image** and one
  `metadata.public_origin_missing` error per process. Seven mutation probes, two of which were
  real coverage gaps and are now tests. See *The share card was correct, and still pointed at a
  laptop*.

- **A browser visited the running app for the first time**, over CDP with no new dependency.
  Confirmed against real HTML: `<title>`/`og:*`/`twitter:*`/`robots` in a real `<head>`; the FR-308
  card as a **1200×630 PNG (35,947 bytes)** that renders correctly and differs per drop; **59
  applied CSS rules**; **zero hydration warnings**; a real **307 → `/login?next=…`**; an
  `httpOnly` `SameSite=Lax` session cookie; a visible wrong-password message; a sign-out that
  clears the cookie and keeps `/admin/users` shut; and **404s served as the app's own page**
  (`/d/NOPE123`, an unknown path while authed, `/admin/drops/not-a-uuid`, a 5,000-char segment,
  `' OR 1=1--`). **Four defects it found:** `og:image` pinned to `http://localhost:3001` in any
  deployment without Vercel env vars (**fixed** — see the first entry above); `/admin/users`
  returning **6.3 MB / 12,518 nodes** (**fixed** — that figure was a dev-server reading; the
  production page was 1,856,483 bytes and is now 400,428, see *The page that listed everything*);
  lowercase `/d/8en9ajca` → **404** because `normalisePublicCode` is unwired; and a `notFound()`
  body that is blank without JavaScript.
  **That slice changed no production source.** See *A browser finally visited, and "unmet" turned
  out to be measurable*.

- Full suite: **2411 tests — 2403 pass, 0 fail, 8 skip** (166 files; 165 pass, 1 skips).
  One flake observed here — `reports.test.ts:570` failed one of three full runs in this slice,
  a fixture using two wall-clock `createdAt` reads where a sequence is needed, against a strict
  `<` in FR-702's classifier. See *Found while closing* below. **Since fixed** in the fixture
  with explicit ordered instants; `reports.ts` was never changed. See *The flake that was a
  fixture telling time* further down.
  **The suite must be run with the pinned Node 24.21.0.** `npm run verify` uses whatever `node`
  is on `PATH`, which on this machine is 22.22.2 / tzdata 2025c, and that fails **two** time-zone
  tests (`share-link`, `merchant/pickup`) for reasons unrelated to any change. See
  *`verify` does not pin the interpreter* in the D2 section.
  Residue gate **green**: `npm run verify` reports `no residue — 9 counts unchanged`, with
  `auditLogs +71` noted and non-fatal as documented.
  +19 for **the five runtime files that V8 found executing zero statements** — the FR-308
  OpenGraph card (the PRD's P0 launch blocker), the 404 and 403 pages, the instrumentation
  hook, and the real charge port's unconfigured refusal. This is the first slice scoped by
  **execution** rather than by imports: every page, layout and route was already covered, so
  the only way to find remaining untested code was to measure what actually ran. See *What
  never ran, and the difference between a file being covered and being executed*.
  +34 for **the four layouts**, the last page/layout files with no render test: the root
  shell and the ADMIN / MERCHANT / ORGANISER role shells. This closes the gap left by gap 12's
  page count — every one of the app's 26 pages and all 4 layouts is now referenced by a suite.
  It also produced the **fourth distinct way a coverage count has lied here** (a relative
  *dynamic* `await import('../page')`), and corrected a stale sentence in the M7 row and in gap
  12(e) that still named fourteen untested pages. See *The last four files, and the count that
  was wrong about them*.
  +69 for **the last four routes with no route-level test** — `POST /api/merchant/ai/deal-builder`,
  `GET`/`PATCH /api/merchant/pickup`, `POST /api/merchant/stripe/onboard` and
  `GET /api/public/drops/:code/count`. Two of the four have **no caller in a browser test and no
  service test covering their own half**: the deal-builder route is the only place the body schema
  meets the orchestration, and the onboard route is the only place the Stripe return URL is
  *built*. Also two modules that no test file had ever named — `src/lib/ai/input.ts` and
  `src/lib/merchants/pickup.ts`. One defect reproduced there and **fixed later** (a partial pickup
  PATCH erased the field it omitted) — see *The PATCH that erased what it omitted* at the end of
  this file; three surviving probes, each classified rather than excused. See
  *Four routes, three false positives, and a PATCH that erases what it omits*.
  +132 for **the auth surface** — `src/lib/auth/{password,rate-limit,credentials}.ts` and all
  four `src/app/api/auth/*` routes, the largest genuinely untested area in the app and the one
  the login path runs through. Also one **pre-existing flake** found and fixed in
  `src/app/d/[publicCode]/__tests__/page.test.ts` (see below). Module was **mocked everywhere
  it appeared**, so this is the first execution of the rate limit, the enumeration guard or the
  password policy under test: see *The front door, and the three times I could not count what
  was tested*.
  +37 for **the pickup-queue routes** — `GET /api/merchant/pickup-queue` and
  `GET /api/merchant/pickup-queue/:id`, the last two merchant handlers with no route-level
  test. Also one **pre-existing flake** found and fixed in the M9 reports suite (see below),
  which is the more consequential half of this slice. See *The endpoints nothing calls, and
  the wall clock that was pretending to be a sequence*.
  +10 for **`src/app/page.tsx`, the role router** — the last page in the app with no test of any
  kind, and the only one every signed-in user passes through whichever role they hold. Nothing
  interesting is in the destination table (`roleHome` is pure and tested with its own callers);
  what the suite pins is the **gate order** — no session → `mustChangePassword` → role — which is
  the same order `middleware.ts` and `requireRoleOrRedirect` use, and which is what makes S1-019
  hold at the front door instead of depending on a layout gate three layers down. Two findings,
  neither a code defect: the page's docblock promised `MERCHANT → /merchant/items` while `roleHome`
  returns `/merchant/drops` (a deliberate M3 departure already pinned in four suites — the
  **comment** was corrected, not the code), and my own coverage scan was wrong three times running
  before it was right — see below. 7 mutants, **all 7 kill**; the gate-order mutant is caught only
  by the MERCHANT and ORGANISER cases, so the per-role `it.each` is load-bearing rather than
  decorative.
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
[This paragraph is a historical record of gap 12(e), not current status. Corrected in
the `layouts` slice: all 26 pages and all 4 layouts are now covered — see the last section.]

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

## `src/app/page.tsx` — the role router, and three wrong coverage scans

Four lines of logic, and the only page every signed-in user passes through. It had no test of
any kind.

### What is actually at stake, and what is not

Not the destination table. `roleHome` is pure, has its own callers, and is asserted in `/login`,
`/change-password`, the impersonation route and `/admin/merchants/[id]`. Restating it here would be
a fifth copy of the same fact.

What the suite pins is the **gate order**:

```
no session          → /login
mustChangePassword  → /change-password
else                → roleHome(role)
```

`mustChangePassword` is checked **before** the role, and that ordering is the entire security
property of S1-019. A temporary-password user routed to `/merchant/drops` reaches a screen whose
layout gate then has to catch them — and three entry points (`page.tsx`, `middleware.ts`,
`requireRoleOrRedirect`) have to agree, or "where does a temporary-password user land" depends on
which one ran. The mutant that narrows this to `session.role === 'ADMIN'` is caught **only** by the
MERCHANT and ORGANISER cases: a single-role test survives it. That is the argument for the
per-role `it.each` being a real test rather than a formality.

The other property worth naming is `force-dynamic`. A module-scope cache of the session would
serve the first caller's role to everyone — the worst failure this page could have, and invisible
to every single-call test. The mutant that caches is killed by nine tests, but the one written for
it is `re-reads the session for each caller`, which counts the calls.

### Finding: the docblock disagreed with the function

PRD-sprint1 §6.1 and the page's own docblock both said `MERCHANT → /merchant/items`. `roleHome()`
returns `/merchant/drops`, and has since `9280441` ("M3 slice 2"), when a merchant's first
meaningful screen became their drops rather than their dishes.

The departure is intentional — four suites already pin the literal, and the impersonation route's
comment calls it pinned on purpose. So the **comment** was corrected and the code left alone. Worth
recording because the tempting move is to "fix" the code to match the PRD and break four suites plus
a deliberate product decision, and because a docblock that disagrees with its function is how a
reader learns to distrust the file.

### Finding: I could not count coverage, three times in a row

This is the part worth keeping. Asked what was left untested, I produced **three different wrong
answers** before a right one:

1. **A grep for alias imports** (`@/app/.../page`) reported 5 pages untested. Wrong: tests import
   `await import('../page')` relatively.
2. **A scan for a colocated `__tests__` directory** reported 5 again, and falsely cleared
   `src/app/page.tsx`. Wrong in both directions: `(admin)/admin/ai-drafts/page.tsx` is tested from
   its parent's `__tests__` via a dynamic alias import, and the root page *has* a `__tests__`
   directory that did not exist yet.
3. **A "literal alias import" scan** reported 3 untested. Wrong again: it required a trailing quote
   after the module path, so `await import('../page')` and destructured
   `const { default: Page } = await import('../page')` were both invisible.

The accurate method is narrow and I should have reached for it first: for each page, check whether
**any** file under `src/` imports it by alias *or* by relative path, in *any* binding form. Nothing
short of that is a coverage claim. The cost of getting it wrong is not a wrong number in a report —
it is proposing to "close a gap" that does not exist, which is what happened: I offered `/login`
and `safeNext` as the next slice, and `/login` already has a dedicated 11-test `safeNext` suite.

`src/app/page.tsx` is the only page with no importer, and that was true before any of the three
scans. Every other page is rendered somewhere.

### What is not claimed

The suite mocks `getSession`, so nothing here proves the cookie is what `getSession` reports — that
is `session`'s job. No browser has visited `/`, so the redirect is proved as a thrown
control-flow error, not as an HTTP 307. And `roleHome`'s `default` arm returns `/login`; that an
unknown role lands there is asserted through "every case redirects somewhere absolute", not by
fabricating a fifth `SessionRole` the type does not permit.

## The 1114 organisers who were never missing a profile

This one starts as a false alarm with a true cause, and the interesting part is not the bug.

While scanning for untested routes I noticed `profilelessOrganisers: 1114` in the residue report —
the count of `ORGANISER` accounts with no `OrganiserProfile`. FR-906 had shipped a repair path for
exactly this state six slices earlier, so the obvious reading was that a backfill had never been run
against the local database, and the obvious next task was to write one.

That reading was wrong, and the number was wrong for a reason worth recording.

### The counter that moved and the counter that did not

`scripts/check-residue.mjs` prints ten counts. Run in **dump mode** it tells you what is in the
database; it says nothing about what the suite just added. Run with `--compare` it exits non-zero on
any growth. I had been running it in dump mode for several sessions — reading `1114` each time,
registering it as "large but stable", and moving on. The gate that was already written to catch
this was never switched on.

Switching it on took three commands, and the finding took one more: `organiserProfiles` sat at a
flat **52** while `users`, `organisers` and `profilelessOrganisers` each moved **+5** per run. A
counter that moves beside a counter that does not is a diagnosis, not two facts. The profiles were
being deleted. The accounts that owned them were not.

The source is `src/lib/db/__tests__/reports.test.ts`, the M9 reporting suite. `makeOrganiser()`
creates a `User` with a nested `OrganiserProfile` — the nesting itself was a deliberate earlier fix,
so that `/admin/users` could never catch a half-made organiser mid-flight. It pushed the
**profile** id into the collector, and `afterAll` deleted profiles. Nothing ever named the user, so
five accounts per run outlived their own teardown. Because the profile delete succeeded, the residue
presented as *an account with no profile*: the symptom of a missing backfill, produced by a leak.

### The fix is one level up, not one more line

`makeOrganiser` now collects the **user** id and returns the profile id unchanged; teardown deletes
`User`, which cascades `OrganiserProfile`. Naming the parent is both the smaller delete and the
complete one — there is no ordering to get wrong and no child to remember. The same edit removes
every `.catch(() => undefined)` from this teardown and replaces it with the `step()` collector, since
a file that needs to be trusted about deletion is a bad place to swallow errors; the local reasoning
is written into the file above `afterAll`.

The historical backlog was cleared after verifying it was orphaned: 1026 accounts matching the
fixture's own shape (role `ORGANISER`, placeholder hash, `RPT-RPT ` prefix), with **0** share links,
**0** merchant memberships, **0** audit rows as actor, **0** as target and **0** redemptions
referencing any of them. `profilelessOrganisers` then read **98** — the same number the residue
script's docblock cites as the historical baseline, which is the independent confirmation that this
leak, and nothing else, was the whole of the discrepancy.

### What a green suite could not see, and the probe that shows it

The teardown was reverted to delete the profile instead of the account and the suite re-run: **all
12 tests pass.** No assertion here could ever have caught this, at any strength — a test that does
not say "and afterwards the database looks like it did" cannot fail on a leak. Only the counter
could see it, and only in `--compare` mode:

```
RESIDUE — the suite left rows behind:
  users                  2061 → 2066  (+5)
  organisers             1171 → 1176  (+5)
  profilelessOrganisers  1119 → 1124  (+5)
```

With the fix in place the same probe reports `no residue — 9 counts unchanged`, and a full-suite
`--compare` is clean for the **first time this project has had a green gate on it**: 2059 passing
tests, 9 counts unchanged, `auditLogs +71` noted and non-fatal exactly as the script documents.

### The process fix, because the bug was in the process

A documented three-command ritual that nothing enforces is a ritual that gets half-done, and half of
this one is indistinguishable from the whole of it: dump mode *looks* like a check. `package.json`
now carries the pairing:

- `npm run residue` — the counts, unchanged and still useful for diagnosis.
- `npm run verify` — baseline, `vitest run`, compare. Non-zero on residue, one command, no
  transcription of a temp path.

Nothing stops a future session from running `vitest run` alone. But the honest statement of the
lesson is not "remember to check" — it is that the check had a wrong-looking half and a right half,
and the wrong half was the default reading. Making the right half a single word is the only part of
this that generalises.

### Not claimed

The 98 remaining profile-less organisers were **not** investigated and are not asserted to be
legitimate. They are stable across runs, which is what this slice was about, and stability is a
weaker property than correctness. If a backfill is owed against the dev database, this slice neither
performed nor ruled it out — it established that the 1114 was not evidence of one. And the
verification is single-run: two consecutive `npm run verify` runs were green, which rules out
per-run growth but says nothing about a leak that only fires on a red run — the case `AGENTS.md`
warns about, and the reason the `step()` collector replaced the swallowed catches rather than merely
being added to them.

## The endpoints nothing calls, and the wall clock that was pretending to be a sequence

`GET /api/merchant/pickup-queue` and `GET /api/merchant/pickup-queue/:id` were the last two
merchant handlers in the app with no route-level test. The interesting thing about them is not
that they were untested — it is what they turned out not to be.

### They have no caller, and that is the reason to test them rather than a reason not to

`/merchant/pickup` calls `listCounterDrops` and `loadManifest` **directly**, as a server
component. So the two JSON routes are the PRD's `staff` endpoints (§12 lists
`GET /api/staff/drops/:id/manifest`; there is no `STAFF` role, so they were built under
`MERCHANT`) and no code in this repo fetches them. Their only caller is a future client.

That is precisely the condition under which a route drifts from the function behind it. The page
is exercised by an 800-line suite; the route is exercised by nothing, and nothing compares them.
So every payload assertion here is made **field by field against `listCounterDrops` and
`loadManifest`**, not against literals — the same discipline gap 18 used to prove that a second
entry point to a capability is not *almost* the same product. A literal would pass while the route
and the page disagreed.

The endpoints also carry the one deliberate asymmetry in the merchant surface: they call
`requireMerchant()`, not `requireMerchantWrite()`, because reading is what impersonation is *for*.
`impersonation-readonly.test.ts` exempts them by walking the exported verbs. Two tests here state
the same thing from the other side — a borrowed session gets a 200 — so nobody reading only the
two files can conclude the exemption was an accident.

### The wall clock was standing in for a sequence number, in a suite that was green

The flake was not in the new file. Running the full suite five times to check the new tests
surfaced a failure in **`reports.test.ts`**, one run in three, with a message pointing at
a test called *does not credit one organiser with another organiser's units*:

```
Unique constraint failed on the fields: (`paymentIntentId`)
```

The cause is one line. `makeCapturedParticipant` built the provider ids as
`` `pi_${PREFIX}_${Date.now()}_${phoneSeq}` ``, and `phoneSeq` advances **only inside
`makeCustomer()`**. Two participants created for the same customer inside the same millisecond
therefore produced the same `paymentIntentId` on a `@unique` column. The test that failed had
nothing to do with ids, in a file that had nothing to do with the change, and it failed on
`Date.now()` landing twice — which is what `Date.now()` does when you call it twice in a loop.

This is a general rule and it is now in `AGENTS.md`: **a wall clock is not a sequence.** If an id
must be unique and it is built from a timestamp, it needs a counter beside the timestamp, not a
timestamp with a counter that advances somewhere else. `providerSeq` now does that, and
`stripeChargeId`, `paymentIntentId` and the ledger's `stripeRef` all draw from it — one identity
per charge, shared between the `Order` row and its ledger entries, which is what production does.

Five consecutive full runs after the fix: `2096 passed | 8 skipped`, five times.

### What the mutation sweep found: five fixture gaps, not five redundant tests

27 probes, **22 killed, 5 survived** — and every survivor is accounted for rather than waved away.

Four are **equivalent mutants**, verified rather than assumed:

| Survivor | Why it cannot be killed |
|---|---|
| empty-scope short circuit → `in: []` | Measured: Prisma returns 0 rows for an empty `in` list. Same answer, one wasted query. The short circuit is a cost decision, not a behaviour. |
| `gte` → `gt` on the 12-hour edge | Every fixture window is at least an hour from the boundary; the two that bracket it bracket it by two hours. |
| `windowStart: Date` instead of `.toISOString()` | Verified: `JSON.stringify(new Date(x))` produces byte-identical output. |
| `redeemedAt` as a bare `Date` | Same, and the two-value test (`string`, then ISO round-trip) pins the shape that matters. |

The fifth is a **defensive** survivor and the honest write-up matters more than the count. Replacing
the list route's `drops.map(...)` with a bare `drops,` changes nothing a client can observe:
`listCounterDrops` already returns exactly those six fields, and `NextResponse.json()` serialises a
`Date` to an ISO string by itself. The projection is a **boundary that cannot widen silently** — the
day someone adds `customer: { phone }` to that query for another screen, the map keeps it off the
wire — and the key-set assertion is what keeps the map honest. It is not currently load-bearing
against a behavioural change, and saying so is more useful than a test that pretends otherwise.

Four surviving probes were real gaps, and all four had the same shape: **a fixture that satisfies
two exclusion rules cannot say which one excluded it.**

- **The status filter was unasserted.** `drops.failed` and `drops.draft` sat thirteen hours back, so
  the *window* excluded them and widening the status list to `['DRAFT', …, 'FAILED']` left every
  assertion green. Fixed by adding a second drop in each excluded status **inside** the window, with
  the included `drops.open` in the same window as the control.
- **The scope filter's first-element bug was unasserted.** The two-owner test looked symmetric and
  was not: each owner has exactly one merchant id, so `merchantIds[0]` *is* their scope. Fixed with
  a user who is `OWNER` of both merchants — the only fixture that can see it, and the ordering of
  `merchantIds` means which one `[0]` picks is not even stable.
- **The floor at zero was unasserted.** No fixture had `redeemedQty > qty`. Fixed with an
  over-redeemed drop, asserting `0` and explicitly `not.toBe(-2)`.
- **The row ordering was unasserted.** The collected diner happened to be created first *and* named
  earlier, so `createdAt` order, name order and outstanding-first order all agreed — a
  `sort(byName)` added to the route survived. Fixed by naming the collected order `Aaa…` and the
  outstanding one `Zzz…`, so every ordering disagrees with every other.

### Not proven

The list route's projection is not proven to be behaviourally necessary today (above). No client
fetches either endpoint, so the JSON contract is asserted against the server functions and not
against anything that consumes it. The 12-hour constant is pinned from both sides at ±1 hour, which
bounds it to the range 11–13 hours but does not assert the number 12 itself — a deliberate choice,
since asserting the literal would make the boundary a magic number rather than a product decision.
And the log-line assertions prove no diner's name or phone appears in `redemption.manifest_viewed`;
they do not prove the same for events written by other paths.

## The front door, and the three times I could not count what was tested

`src/lib/auth/credentials.ts` is the single implementation of the login sequence — both
`POST /api/auth/login` and the login server action call it, on purpose, so the rate limit and the
enumeration guard cannot be lost from one of them. It had **zero** real tests. Not "thin tests".

The module appeared in two suites and **both mocked it**:

```
src/app/login/__tests__/page.test.ts:78
  vi.mock('@/lib/auth/credentials', () => ({ authenticate }))
src/app/change-password/__tests__/page.test.ts
  (the same shape)
```

Those suites test what a *page renders*, and mocking the operation is correct there. The
consequence was that the security properties this module claims in prose — the 10-attempt limit,
the dummy-hash timing equaliser, the one-message-for-both-failures rule, the policy bounds — had
never been executed by anything that could fail. Three of the four claims turned out to be true
and none of them was tested; one of the four was written in a comment that describes code that
does not exist.

This is the same mistake the pickup-queue slice found, in a worse form. There, an endpoint had no
caller and the *page* was well covered. Here, **a mock is a mention and not coverage**, and every
coverage count in this repository has been counting mentions. The audit that led here scanned for
imports; the scan was accurate and still misleading, because `vi.mock('@/lib/auth/credentials')`
is an import.

### `!user ||` is the whole difference between a guard and a universal login

The dummy hash exists so that "no such account" and "wrong password" cost the same. What the
comment said was "a real bcrypt hash of a value nobody knows". What the code says is:

```ts
dummyHash = await hash('groupeat-timing-equaliser-not-a-password', BCRYPT_COST);
```

The plaintext is a string literal in the file's own body. So anyone reading this repository can
produce a password that *satisfies* the dummy hash, and the reason that is harmless is one clause:

```ts
if (!user || !passwordMatches) return { ok: false, status: 401, … };
```

Probed: deleting `!user ||` and leaving `if (!passwordMatches)` makes the dummy hash a **universal
login** for every email that does not exist — one test failed, and it is the test written for it.
Deleting the other half failed twenty-one. The asymmetry is the lesson: the obvious guard is the
one with a test, and the clause that is load-bearing here is the one that looks redundant because
`passwordMatches` is already false when there is no user.

Two assertions now pin it from both ends: `password.test.ts` asserts the literal verifies against
`getDummyHash()`, and `credentials.test.ts` asserts that literal cannot log in to a non-existent
account. Neither can drift without the other.

### Three arithmetic findings, and only one of them was a bug in the code

1. **`Math.max(1, Math.ceil(ms / 1000))` is dead code.** The refusal branch is only reachable after
   `resetAt > now` has been established, so the remainder is strictly positive, and `Math.ceil` of
   any positive value is already ≥ 1. The probe that strips the clamp **survived the whole suite**.
   It is a genuine equivalent mutant, and the clamp stays because the invariant it *states*
   (`Retry-After` is never 0) is what a client depends on. The test asserts the invariant across the
   window and the block comment explains why no test can kill the mutation without weakening it.
2. **`getDummyHash` is not concurrency-safe.** `if (dummyHash === null) dummyHash = await hash(…)` is
   a read-check-write across an `await`, so two callers arriving before either write both hash.
   Found by writing a test that assumed the opposite and watching it fail. Cost: one extra bcrypt
   (~54 ms) per concurrent cold start; not a correctness bug, self-heals when the last writer wins.
   The test had to `vi.resetModules()` to see it, because every earlier test in the file had already
   warmed the module-level value — the same "fixture satisfies two rules" trap in a new costume.
3. **`Math.floor(Math.random() * 9000 + 1000)` collided on `Customer.phone`.** Not this slice's
   code: `src/app/d/[publicCode]/__tests__/page.test.ts` drew diner phone numbers from a space of
   9,000, about twenty times a run, and the full suite failed once with
   `Unique constraint failed on the fields: (phone)`. That file passed **eight consecutive isolated
   runs**. It is the same defect as the M9 `paymentIntentId` flake with a different entropy source:
   a random value is not a sequence. Replaced with a per-file counter.

### The two docblocks that described code that does not exist

`changePassword`'s comment promised that "the flag is cleared, `lastLoginAt` is refreshed and the
session is re-signed". The function updates `passwordHash` and `mustChangePassword` and **never
calls `touchLastLogin`**. A test now pins the current behaviour against a fixed date, and the
comment has been corrected rather than the code changed — `authenticate` already stamps
`lastLoginAt` at sign-in, and a forced change always follows a sign-in, so the value is current.
Whether a *voluntary* change should also count as activity is a product question and not one to
answer by accident.

`rate-limit.ts` carried a lapsed commitment: "**Before M9 this must be replaced** with a durable,
shared counter". M9 shipped and it was not replaced. A stale deadline reads as "someone is on it"
when nobody is, so the note now says **re-deferred, with the reason**: the replacement needs
infrastructure this repo does not have, the trigger is "the app runs on more than one process"
rather than a milestone number, and the arithmetic that *can* be unit-tested now is.

### A defect found and not fixed: a borrowed session can change the merchant's password

`change-password/route.ts` calls `getSession()` directly and never imports `authorize.ts`, so
`refuseIfImpersonating` is never reached. Middleware's impersonation rule covers `/admin` and
`/api/admin`; the `mustChangePassword` allowlist covers this path; nothing refuses a borrowed
session. Probed with a real `newImpersonationSession` token: **200, and the merchant's password
changes.**

It is a write during a read-only session (FR-904), and the audit trail does not record it as the
admin's — `changePassword` logs `auth.password_changed` with the *merchant's* id and no actor, so
`actorFor` is never consulted. Scope: the admin must already hold a valid borrowed token. It is not
fixed here because the fix is a product decision (should a borrow be able to complete a forced
password change the merchant cannot?) and this slice writes tests. The reproduction is
`session-routes.test.ts`, *"does not require the impersonation guard, and a borrowed session can
change the merchant password"*, which asserts the current behaviour so the day it changes is a
deliberate edit rather than a silent one.

### Twenty-two probes, twenty-one caught

Forty mutations across the seven files. **Thirty-nine killed, one survives** — and the survivor is
the `Math.max` clamp argued above. Two of the early survivors were *my* fixtures, not the code:

- **The trim was never exercised.** `'   10.0.0.1   '` reaches `request.headers.get()` as
  `'10.0.0.1'`, because the HTTP layer strips surrounding whitespace before the route sees it. So
  deleting `.trim()` from `clientKey` survived. What reaches the trim is whitespace *inside* the
  first element: `'10.0.0.1 , 10.0.0.2'` splits to `'10.0.0.1 '`. **Probe the framework's
  normalisation before asserting on your own.**
- **A single default-clock call cannot distinguish the default.** `hit(key)` returns
  `{ allowed: true, remaining: 9 }` whether `now` defaults to `Date.now()` or to `0`, because a
  fresh bucket looks identical whenever it was created. Setting `now = 0` survived. The
  distinguisher is a *second* call at real time: under the real default it is attempt 2 (8
  remaining); under `now = 0` the bucket was created at epoch + 900 s and is long expired (9). The
  consequence of the mutant is total: every bucket is permanently expired, and the limiter never
  fires.

### Verified

- `npm run verify` exits 0: **2228 pass, 0 fail, 8 skip** (153 files), `no residue — 9 counts
  unchanged`, `auditLogs +71` expected.
- `npx tsc --noEmit` and `npx eslint src/lib/auth src/app/api/auth` clean.
- Real Postgres, real bcrypt, real `authenticate`/`changePassword`. Only `server-only` (it throws
  outside an RSC graph) and the logger are replaced. `rate-limit` is **not** mocked in the
  credentials suite, because the limit is under test.
- Timing: the equaliser measured rather than assumed — ~54 ms per bcrypt compare at cost 10 against
  ~1 ms for a bare `findUnique`, so the 20 ms floor has 50× headroom, and the two paths' medians are
  asserted within a factor of two of each other.
- Cookies asserted from the `Set-Cookie` header, not from a mock: `httpOnly`, `SameSite=Lax`,
  `path=/`, `Max-Age=604800`, and `Secure` absent under test.
- `clientKey` precedence proved by saturating a bucket: first `x-forwarded-for` entry beats the
  last, `x-real-ip` is the fallback, `'local'` is the last resort, and a whitespace-padded first
  element lands in the same bucket as the trimmed one.

### Not proven

- **Nothing here was exercised against a real proxy.** `x-forwarded-for` is only trustworthy when
  something strips a client-supplied value, and no test can establish that from inside the app. The
  module still says "not a security control", and this slice did not change that.
- **The rate limiter is still in-memory**, so its two most important properties — survives a
  restart, shared between replicas — are untestable by construction. Re-deferred above.
- **`Math.max(1, …)` has no killing test**, deliberately; the reasoning is in the block comment.
- The 200-character ceiling is asserted at the boundary but nothing asserts *why* 200 is the number;
  like the 12-hour pickup window, the literal is a product decision the test brackets rather than
  pins.
- The borrowed-session password change above is reproduced, not repaired.

## Four routes, three false positives, and a PATCH that erases what it omits

Four handlers were the last ones in the app with no route-level test:
`POST /api/merchant/ai/deal-builder`, `GET`/`PATCH /api/merchant/pickup`,
`POST /api/merchant/stripe/onboard`, and `GET /api/public/drops/:code/count`. Sixty-nine assertions
and fifty-six mutation probes later, the interesting results are three that are not about those
routes at all.

### The coverage figures for routes were wrong three times, in three different ways

This slice began with a survey that printed a per-route tested/untested column. It said **six**
routes were untested. Two of those six — `merchant/drops/[id]` and `merchant/items/[id]` — have
nineteen and twenty-three tests respectively, in their parent suites, imported as `from
'../[id]/route'`. The grep looked for the absolute path and the import is relative.

That is the third distinct way a coverage count has lied in this repository, and they are worth
naming together because each needs a different defence:

- **A mock is a mention.** `credentials.ts` appeared in two suites, both doing `vi.mock(...)`, so
  every import-based count said it was covered and no test had ever executed it. (The auth slice.)
- **A relative import is not a string match.** `'../[id]/route'` names
  `src/app/api/merchant/drops/[id]/route.ts` to a human and to Node, and to nothing else. (This
  slice.)
- **A path that no longer exists is not an error.** An earlier scan of this file was rescued only
  because `impersonation-readonly.test.ts` asserts its own walk found at least twelve files — a
  glob that matches nothing passes every assertion in it.

The general form: **a count is only as good as the join between what it searches for and what the
runtime resolves.** Here the fix was to stop counting and read the four files, then search for the
*callers* rather than the paths.

### The pickup PATCH erases a field the caller did not mention, and answers 200

`pickupSchema` marks both fields `.nullish()`, and `parsePickupInput` collapses "absent" and "blank"
into the same `null`:

```ts
const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};
```

So `{"pickupAddress": "1 New Rd"}` — a body that says nothing about instructions — is parsed to
`{ pickupAddress: '1 New Rd', pickupInstructions: null }`, both columns are written, and the route
returns 200 describing the erasure as the new state. A `PATCH` that deletes a field it was not
asked about is the opposite of what `PATCH` means.

**It was reproduced, not repaired, in this slice.** Four tests asserted the damage and were named
`erases …` so the fix would find them first. It was not a live bug: `PickupForm` posts both keys on
every save, seeded from the server's `GET`, so the shipped client could not express a partial body.
What made it worth recording is that the docblock discussed the all-whitespace case at length and
never mentioned the absent one — the code and its comment disagreed about the case that matters, and
the only thing keeping it unreachable was a property of the caller, not of the route.

**Fixed in a later slice.** See *The PATCH that erased what it omitted, and the three places the fix
had to land* at the end of this file. Every statement above about the defect still holds; the four
`erases …` tests are now eight tests asserting the corrected behaviour in both directions.

### Three probes survived, and all three were the probe's fault

Fifty-six mutations, fifty-three killed. The three survivors are not coverage gaps:

1. **`if (!merchant)` in the pickup `GET`, and `if (!written)` in the `PATCH`.** Changing the
   status from 404 to 410, or deleting the `!written` check entirely, changes nothing observable.
   Both are evaluated *after* `requireMerchant`, which derives `merchantIds` from the caller's own
   `MerchantUser` rows, and `primaryMerchantId` already throws when that list is empty. The merchant
   is in scope by construction. These are **unreachable**, not untested, and the honest response is
   a test that pins the *reachability* — that the 404 comes from `primaryMerchantId`'s message, not
   from the route's own guard — plus a note saying a concurrent merchant delete is the only way in.
2. **The schema's `.trim()`.** `parsePickupInput` trims again downstream, so removing the schema's
   trim is invisible — except at the `.max(300)` boundary, where a 300-character value with one
   leading space is 301 characters on the wire. That test did not exist and now does; it is the
   single case where the first of the two trims can be observed, and BOTH trims are load-bearing in
   different places.

Two further probes in this slice reported `PATTERN NOT FOUND` and one reported a false kill, and
each was a harness bug worth writing down: a multi-line pattern against single-line source, a
`replace` on text that appears **twice** in `db/merchants.ts` (so three probes mutated the admin
`updatePickup` and left `updateOwnPickup` untouched — three false survivors pointing at dead code),
and a probe that only *imported* `createDraft` without calling it, which of course changed nothing.
A probe that mutates nothing proves nothing, and a probe that mutates the wrong function proves
something about the wrong function.

The pickup harness also initially ran **one** test file when the scope check's real test lives in
`src/lib/db/__tests__/merchants-pickup.test.ts`. The scope mutation "survived" until the harness
ran both files. **A mutation sweep is only as wide as the suites it runs** — narrower than the
tests, it manufactures survivors; wider, it costs minutes.

### The Stripe route's most important line is a string it builds, not a call it makes

`onboarding-service.test.ts` proves the sequencing with a fake port and literal URLs. Nothing
proved the URLs. `originOf` derives `return_url` and `refresh_url` from `host` and
`x-forwarded-proto`, and a route that hardcoded `localhost` would pass every service assertion
while sending every merchant, in production, to a host that does not resolve — after they had
completed onboarding and believed they were done. Eleven of the twelve onboard probes are about
that one function and the 503 beside it; the twelfth (`actorId: 'unknown'`) initially survived
because the spy captured only the URLs, which is its own small lesson about spies that capture
"enough".

The missing-key path is asserted against the **real** `realConnectPort` rather than a stub, because
`isStripeConfigured()` reads `process.env` directly and stubbing it would remove the only code that
decides whether a deployment can take money. The consequence is recorded as a named limitation: the
successful happy path cannot run from this file, because a real `sk_test_` key would make
`beginOnboarding` open a socket.

### The count route's payload assertion is a privacy control

`GET /api/public/drops/:code/count` is anonymous, enumerable and polled every fifteen seconds.
`PublicDrop` carries about twenty fields; the route narrows it to nine. The test asserts the
response's key set with `toEqual` on the **whole object**, not `objectContaining` — because
`objectContaining` passes when the response also carries `participants: [...]`, which is exactly
what a refactor returning `PublicDrop` directly would produce. `getPublicDrop` is also proved to
count only `AUTHORIZED` participants via a fixture holding both, since a `reduce` that lost its
`where` clause would report 12 instead of 7 and flip a drop to "confirmed" while a diner was still
the difference between running and not running.

`CountPoller` reads nine properties literally and compares `offerPhase` to decide whether to
refresh the page, so a property computed correctly and then **omitted** from the payload does not
fail anywhere: the poller sees `undefined !== 'OPEN'` on every tick and refreshes twice a minute for
the life of the drop. There is no client test runner here, so the key-set assertion is the only
thing that can catch it, and four of the twelve count probes are exactly that omission.

### Verified

- `npm run verify` exits **0**, twice, with identical totals: **2305 pass, 0 fail, 8 skip** (157
  files; 156 pass, 1 skips), `no residue — 9 counts unchanged`, `auditLogs +71` expected.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Real Postgres throughout; real `requireMerchant`/`requireMerchantWrite`, real Zod schemas, real
  `resolveDropView`/`headlineFor`, real `updateOwnPickup`, real `planProposals`. Replaced:
  `server-only` (it throws outside an RSC graph), `getSession` (the seam `authorize.ts` already
  reads through), the logger, and — in the onboard suite only — a spy on `beginOnboarding` that
  captures its arguments rather than replacing its behaviour.
- The deal-builder suite runs **keyless**, so the happy path it asserts is the one every deployment
  without an AI key is in: three usable proposals, `source: 'planner'`.
- 56 probes: 53 killed. The four per-file tallies are 12/12 (count), 12/12 (onboard), 17/17
  (deal-builder), and 12/15 (pickup) — the three survivors classified in the section above.

### Not proven

- **The pickup partial-write defect was open at the end of this slice.** Reproduced and pinned
  there, fixed in the next one. The reason it waited is worth keeping: the fix is a product
  decision (reject a body missing a key, or treat the key as "leave alone"), and the second
  option changes what a `200` response means.
- **`beginOnboarding`'s success path is not exercised through the route.** It is covered by the
  service suite with a fake port; the route's half — the URLs and the 503 — is covered here. The
  seam between them is asserted by argument capture, which proves what was passed and not what
  Stripe would do with it.
- **`charges_enabled` still has never been true against a real account.** No key exists in this
  environment; M2's 🟡 is unchanged by this slice.
- **`CountPoller` itself is untested** — it is a client component and there is no DOM runner. This
  slice pins the contract it consumes, which is as far as the server can go.
- Nothing was exercised behind a real proxy, so `x-forwarded-proto` is trusted here and unverified
  in deployment — the same limitation the auth slice recorded.

## The last four files, and the count that was wrong about them

Thirty `page.tsx`/`layout.tsx` files live under `src/app`. Twenty-six pages had render tests.
The four that had none were not pages — they were **layouts**: `src/app/layout.tsx`,
`src/app/(admin)/layout.tsx`, `src/app/(merchant)/layout.tsx` and
`src/app/(organiser)/layout.tsx`. Thirty-four tests and thirty-nine probes later, all thirty
are referenced by a suite. The more durable result is that the *status board was wrong about
what remained*, and finding that out took three different broken counts.

### The fourth way a coverage count lied, and the two that were my own bugs

The status board's M7 row and the gap 12(e) section both still said "the ten `/merchant/*`
pages, `/admin/merchants/[id]` and the five diner-facing pages still do not [have tests]".
A caller-based scan — resolving **static `from`, dynamic `import()` and `vi.mock`**
specifiers back to real files — finds **26/26 pages referenced**, every one through
`await import('../page')`, and before this slice **0/4 layouts**.

Three wrong answers were produced on the way to that one, and each has a different cause:

1. A **plain path/alias grep** reported 4/30 referenced. It cannot see a relative
   **dynamic** `await import('../page')` — the fourth distinct way a coverage count has
   lied here, after *a `vi.mock` is a mention, not coverage*; *a relative import is not a
   string match*; and *a walk that matches nothing passes every assertion in it*. An
   additional wrinkle: docblocks in the new suites *name* their layout paths, which
   bumped the naive grep from 4 to 7. A comment is also a mention.
2. A resolver that `path.resolve()`d specifiers into **absolute** keys while storing
   page paths as **relative** strings reported 0/30. Mixed key types mean every
   comparison silently fails; uniform relative keys fix it.
3. The very first scan searched for the absolute route path and missed
   `from '../[id]/route'` (the previous slice). That one is a relative *static* import.

**The general form: a coverage count is only as good as the join between what it
searches for and what the runtime resolves.** The defence is not a better grep — it is
stopping the count and reading the callers. The two stale sentences are preserved with a
bracketed correction rather than rewritten, because they were true when written and a
status board that quietly edits its own history is worse than one that dates its mistakes.

### What the four layouts actually decide

The three role shells call `requireRoleOrRedirect` — the **second** gate behind
middleware. The merchant layout's docblock says a matcher change "must not become an
authorisation hole" and that the FR-904 banner lives in the layout so one line "covers all
eleven merchant pages … and the twelfth somebody adds next month". Neither sentence had
ever executed. The root layout had no gate and no docblock claim at all: `metadata`,
`viewport`, `<html lang="en">`, four body design tokens and a `max-w-[420px]` phone shell,
true by inspection on all 26 pages and asserted by nothing. Dropping `viewport.width`
would break mobile rendering everywhere with the entire suite green.

The suites pin the gate **order** per role (no session → `/login`, `mustChangePassword` →
`/change-password`, wrong role → `roleHome(role)`), with each wrong-role destination
asserted against the real shared function **and** a literal. `redirect` is observed as a
thrown control-flow error whose *argument* is asserted, and `html === undefined` for a
refused caller is the no-leak proof: a layout that rendered children first would emit the
ADMIN nav and a `<main>` to a signed-out caller. One probe (removing the `await` on the
gate) was verified to die on exactly that assertion — it produced
`expected '<!--$--><header…' to be undefined` — rather than on an unhandled rejection.

The merchant banner is the subtlest wiring in the app. `expiresAt` is consumed **only**
inside a client component's `useEffect`, so it never appears in server HTML; the real
component is therefore wrapped with `vi.fn(real)` rather than stubbed, and its props are
captured as a whole object with `toEqual`. That is the count-route payload lesson one layer
up: a prop a client reads literally can be omitted and no value comparison will see it.
`impersonationBanner` receives **the same session object the gate returned**, pinned with
`toBe` identity against a `getSession` that yields a fresh object per call — deep equality
would let a clone through. `mockClear()`, never `mockReset()`, because the probe's
implementation is the real component.

### Five survivors, all classified

Thirty-nine probes, thirty-four killed. The five that survived are **not** coverage gaps:

| Probe | Classification | Argument |
|---|---|---|
| reorder the four body classes | equivalent mutant | Tailwind utilities are independent declarations; order in `class` is unobservable. The assertion is deliberately token-based. |
| `'device-width'` → `"device-width"` | equivalent mutant | Identical runtime string; `toEqual` pins the value, not source text. |
| remove `import './globals.css'` | equivalent mutant **relative to a render** | Vitest stubs CSS, so it contributes zero bytes to server HTML. It *is* load-bearing in a browser — named as a limit, not dressed up as a kill. |
| `role="ADMIN"` → `role={'ADMIN'}` | equivalent mutant | Identical prop value, same `createElement` call. |
| `['ADMIN']` → `['ADMIN','GHOST']` | **dead code with no purpose** | `SessionRole` is a closed union of three; `verifySession` rejects a fourth, so the extra `includes()` operand is unreachable. `tsc` *does* catch it (`TS2322`), which means the typecheck gate — not the render suite — is the real guard. |

The last one is worth keeping visible: proving "the exact role list" behaviourally is
limited by the type system's own domain. The per-role admission table is complete over
every role the type permits, and the type checker is what forbids a fifth.

The harness itself was held to the standard from the previous slice: one mutation at a
time, byte-identical restore verified, **each pattern asserted to occur exactly once**
before running, all four layout suites run per probe, and `suitesImporting()` proving each
layout has exactly one importing suite and it is in the run set. All probe scripts deleted.

### Verified

- `npm run verify` exits **0**, independently re-run by the lead: **2339 pass, 0 fail,
  8 skip** (161 files; 160 pass, 1 skips), `no residue — 9 counts unchanged`,
  `auditLogs +71` unchanged from baseline — confirming the four suites write no DB rows.
- `npx tsc --noEmit` and `npx eslint .` clean. Lead independently re-ran both, plus the
  coverage resolver: **30/30** page/layout files referenced, and **no layout is mocked
  anywhere** (so every reference is an execution, not a mention).
- Real `requireRoleOrRedirect`, `roleHome`, `AppNav`, `SignOutButton` and the real
  `ImpersonationBanner` component. Replaced: `server-only`, `getSession`, `next/navigation`'s
  `redirect`, and — in the merchant suite only — the `impersonationBanner` DB boundary, whose
  real two-row behaviour is already covered against real Postgres in
  `src/lib/auth/__tests__/impersonation.test.ts`.
- No production source changed, no commit made by the QA teammate, no probe files tracked.

### Not proven

- **The Definition-of-Done browser step is unmet.** No browser has visited `/`, `/admin/*`,
  `/merchant/*` or `/organiser/*`. A redirect is proved as a thrown error, not an HTTP 307;
  middleware's matcher and the cookie are outside these files, so "second gate behind
  middleware" is asserted as the layout's *own* gate, not as agreement with middleware.
  **[Corrected in the `browser` slice: a browser has now visited `/`, `/login`, `/admin/users`,
  `/admin/drops`, `/d/[code]`, `/d/[code]/join` and the 404/403 paths — the step is met for
  those, and the redirect is now measured as a real 307. The ten `/merchant/*` pages and
  `/organiser` were not driven, so the sentence remains true only of those. See *A browser
  finally visited*.]**
- `metadata`/`viewport` reaching a real `<head>` is framework wiring Next performs outside
  `RootLayout`'s element tree. A serialised render never contains `<title>` or `<meta>`;
  only the exported objects are pinned. CSS application is unproven (survivor 3).
  **[Corrected in the `browser` slice: both are now measured — a real `<head>` carries
  `title`/`og:*`/`twitter:*`/`robots`, and 59 CSS rules are applied.]**
- The banner's countdown, "End session" click and fetch are inert — no hydration, no
  `useEffect`. `expiresAt` is a captured prop, not a tick. `AppNav` links are asserted as
  hrefs, not working destinations.
  **[Partially corrected in the `browser` slice: hydration is now proven real and silent
  (zero warnings), and the login form's click-through is measured. The impersonation
  banner's countdown is still unverified, because `/organiser` and the impersonation flow
  were not driven — and `AppNav`'s destinations were read as the nav the login redirect
  landed in, not individually clicked, so that half stands.]**
- No source defect was reproduced. The pickup-PATCH erasure from the previous slice, the
  `page.tsx` docblock/PRD mismatch, and every Stripe live-mode item remain open.

## What never ran, and the difference between a file being covered and being executed

With all 30 page/layout files and every API route referenced by a suite, the obvious next
question had no answer: *what else has never executed?* Imports cannot answer it. A file can
be imported by six suites and still have no statement run — `credentials.ts` was the first
proof of that here. So this slice started by measuring instead of counting: a V8 coverage run
over the whole suite, keyed by **statements executed**, not by who mentions what.

The answer was **eight source files with zero executed statements** out of 218. Three were
`page`/`layout`-adjacent runtime that the previous slice had not reached, one was a factory
with a safety branch, and four were files with nothing to run at all (two pure type modules,
a re-export barrel, a wire-shape file). The eight were invisible to every earlier scan for the
same reason: a caller-based count finds *references*, and a reference is not an execution.

### The stale coverage report, and why re-running mattered

The first read of the coverage report said the four new files were *still* at zero after their
suites passed. That was not a test failure — it was a **stale JSON file**. The coverage run had
written to a different directory than the one being read, so an old report was inspected and
nearly sent the slice looking for a phantom bug. Re-running into a named directory moved the
same four files to 72/72, 14/14, 11/11 and 6/6 statements. The lesson is the same shape as the
others in this repository: **the artifact you are reading is part of the measurement**, and a
report is not evidence until you know which run produced it.

### The FR-308 card is the clearest case of a client nothing could see

`opengraph-image.tsx` is described in its own docblock as *the* P0 launch blocker: *"A broken
link preview kills distribution."* There is no feed, so a drop spreads by being pasted into a
group chat, and this image is the only thing forty people see before deciding to tap. It
printed a price, a "was" price, a pickup time and a money sentence, and **no test had ever
rendered it** — a wrong price or a missing "nobody is charged" would have shipped to WhatsApp
and WeChat with the whole suite green.

Its two claims are the ones a value comparison cannot make on its own. The "was" price is
**frozen** at publish time, not read from the dish today: the fixture's snapshot says `$20.00`
while `MenuItem.menuPriceCents` is `$16.00`, so a card that reached for the live item would
advertise a discount the merchant never agreed to. And the pickup hour is formatted in the
**merchant's** zone, not the host's: the host is `America/Edmonton` and the fixture is
`America/Toronto`, one hour apart in November, so dropping `timeZone` prints a pickup time an
hour early on the one artefact a diner uses to decide whether they can make it. Both are
asserted against the shared function **and** a literal, because the first is satisfied by a
module that imports the function and the second is not.

The missing-drop card is the other half. A draft and a code that was never issued must return
**byte-identical HTML**, asserted with `toBe` on two full renders — because the endpoint
answers 200 on purpose (a cached failed image renders as a bare URL, which for a drop that did
not run is the worst outcome), and that 200 must not distinguish "unpublished" from "never
existed".

### The charge port's guard is testable without a key; the rest honestly is not

`real-charge-port.ts` carries the strongest warning in the repository: *"THIS IMPLEMENTATION
HAS NEVER BEEN EXECUTED AGAINST STRIPE."* Its live test skips with a named reason, and that is
correct — no key exists here. But the factory's **first statement** is a refusal: if
`isStripeConfigured()` is false it throws `StripeNotConfiguredError` rather than returning a
port that would fall back to the platform account, the wrong-account bug that *succeeds*
instead of failing. That branch needs no network and no key, only the absence of one, so it is
now proved in both directions: refuses with no key, refuses a `changeme` placeholder (an `sk_`/
`rk_` prefix is required, so "set" is not "configured"), and returns a full port once a
well-formed key is present. The module moved from 0 to 11 of 152 statements. **The other 141
remain unexecuted, and this slice does not claim otherwise** — today's answer to "does capture
work against Stripe?" is still *nobody knows*.

One trap worth recording: the first version of that suite called `vi.resetModules()` and then
re-`import()`ed the module, which creates a **second copy of the error class**, so
`toThrow(StripeNotConfiguredError)` failed against an error that *was* that class from a
different module instance. The reset was unnecessary — the guard reads `process.env` at **call**
time, not at import — and deleting it fixed both the failure and the duplication.

### Verified

- `npm run verify` exits **0**: **2361 pass, 0 fail, 8 skip** (164 files; 163 pass, 1 skips),
  `no residue — 9 counts unchanged`, `auditLogs +71` unchanged from baseline — the new suites
  add no DB writes beyond the OpenGraph fixture, which deletes by tenant.
  **[This is the `browser` slice's own run, kept as the record of that slice. The current baseline
  is 2392/2384/8 over 165 files — see *Verified in this audit* at the top. Do not read this line as
  the gate for a later slice.]**
- `npx tsc --noEmit` and `npx eslint .` clean.
- Coverage re-measured after the work: **218 source files, 215 executed, 3 zero** — and the
  three are a re-export barrel (`lib/auth/index.ts`) and two type-only files
  (`lib/guardrail/types.ts`, `lib/join/wire.ts`) with nothing to execute.
- Real `getPublicDrop`, real frozen-snapshot reading, real `formatCents`, real
  `Intl.DateTimeFormat`, real `buttonClass`, real `isStripeConfigured()` and real
  `StripeNotConfiguredError`. Replaced: `next/og`'s `ImageResponse` (needs WASM and an encoder,
  neither of which is the subject), `server-only` (throws outside an RSC graph), and the logger.
- 17 mutation probes, **17 killed, 0 survived**: 11 on the OpenGraph card (branch inversion,
  `showMerchant` flip, both prices crossed, the money sentence off by one, `timeZone` → UTC,
  alt, contentType, size, the unavailable text, the card background), 2 on the error-page links,
  and 4 on the charge-port guard (invert it, delete it, throw the wrong type, refuse when
  configured). Every pattern asserted unique before mutating; every file restored byte-identical
  in a `finally`; all probe scripts deleted.

### Not proven

- **The Definition-of-Done browser step is unmet**, and this slice cannot move it: a crawler
  fetching the card, WhatsApp's cache behaviour, and an actual `<head>` are all outside these
  element trees. The assertions read the React tree the stub receives, which is the true input
  to `ImageResponse` — not the PNG it would produce. **[Corrected in the `browser` slice: this
  was right about *this* slice and wrong as a general claim. That slice rendered the card as a
  PNG — 1200×630, 35,947 bytes — and read a real `<head>`. The part that remains outside a
  browser is WhatsApp's cache, not the card. See *A browser finally visited*.]**
- **`ImageResponse`'s own rendering is stubbed**, so a card that is right as an element tree
  and wrong as pixels (overflowing the 1200×630 frame, a font that renders nothing) is not
  caught. That is a real, named limit.
- **141 of `real-charge-port.ts`'s 152 statements remain unexecuted** — capture, void and
  refund against Stripe. The live test still skips with its reason; M2/M5 stay 🟡.
- `not-found.tsx`/`forbidden.tsx` are proved as components, not as what Next serves for a 404
  or 403; middleware's matcher is outside them, as recorded in the layouts slice.

## A browser finally visited, and "unmet" turned out to be measurable

The Definition-of-Done browser step had been recorded as unmet **in at least eight places in
this document** — the verbatim sentence *"the browser step is unmet"* twice, and a named
remaining half in half a dozen other sections (*"The taps themselves still need a browser"*,
*"Nothing has been rendered in a browser"*, *"No browser has visited `/`"*, *"the page itself
has never been rendered in a browser"*). Each instance came with a good reason and each was
deferred. The reasons were all true: a serialised render never contains `<title>` or `<meta>`,
a redirect thrown as an error is not an HTTP 307, `useState`/`useEffect` do not run, CSS is
stubbed, and `ImageResponse`'s pixels never exist. But "cannot be proved by a render test" had
quietly become "cannot be proved", and that is a different sentence. It can be proved — with a
browser, on the running app, over the DevTools Protocol. This slice did that and changed no
production source.

**The harness.** No Playwright, no Puppeteer, and none was installed — `package-lock.json` is
part of the deliverable and a browser dependency to answer a one-off question is a poor trade.
Node 24 ships a global `WebSocket`, and Headless Chrome already existed on this machine as a
Playwright *browser download* with no driver attached. So the harness is ~60 lines:
`GET /json/new?url=` for a target, then JSON `{id, method, params}` frames over its
`webSocketDebuggerUrl` — `Page.navigate`, `Runtime.evaluate`, `Network.enable`,
`Emulation.setScriptExecutionDisabled`. Everything lives in `/tmp`; nothing is tracked.

### What the browser confirmed that no suite could

- **A real `<head>`.** `/d/8EN9AJCA` serves `<title>Beef Bowl — Thursday lunch — $13.10</title>`,
  `meta[name=viewport]`, `og:title/description/type/site_name`, `twitter:card=summary_large_image`
  and `robots=noindex`. The claim `renderToHtml` could never make — that the exported metadata
  objects reach the document — is now measured.
- **The OG card as pixels.** `GET /d/{code}/opengraph-image` returns `image/png`, **1200×630,
  35,947 bytes**, and it renders correctly: `$13.10 a plate, was $16.00`, `Pickup Monday 7:30 PM`,
  `20 orders or nobody is charged`. Two different codes produce two different cards
  (`9f5a20b4…` vs `fb0a4b50…`), so the card is per-drop and not one static image. The two claims
  the suite could only make structurally — the frozen "was" price and the merchant-zone pickup
  hour — are visible and correct.
- **CSS is applied.** `body` computes to `rgb(246, 247, 249)` / `rgb(20, 24, 31)` /
  `ui-sans-serif`, `--color-surface: #ffffff` resolves, and `layout.css` 200s with **59 rules**.
  The survivor the suite reported for "CSS application is unproven" is closed.
- **Hydration is real and silent.** 6 chunk requests, all 200; React fiber markers present on the
  DOM; **zero console errors, zero warnings, zero hydration mismatches** across `/login`,
  `/d/[code]` and `/d/[code]/join`.
- **Redirects are HTTP, not thrown errors.** Logged out, `GET /admin/users` → **307** to
  `/login?next=%2Fadmin%2Fusers`; `/merchant/drops` → **307** likewise; `/api/auth/me` → **401**
  JSON. `next` survives the round trip and lands on the originally requested page.
- **The happy path and one failure path, end to end.** In a clean tab with cookies cleared: the
  login form submits, navigates to `/admin/users`, and sets an `httpOnly`, `SameSite=Lax` session
  cookie (232 chars). A wrong password stays on `/login` and renders
  *"⚠ Email or password is incorrect."* Sign out clears the cookie to `[]` and returns to
  `/login`, and re-requesting `/admin/users` afterwards redirects again — signing out is not
  cosmetic.
- **404 as the server serves it.** `/d/NOPE123` → **404** with the app's own copy; an unknown
  path while authed → **404** with the same copy; `/admin/drops/not-a-uuid` → **404**, so a
  malformed id is treated as absent rather than throwing.
- **The malformed input that was not a hole.** A 5,000-character path segment, an 8-char
  garbage code and a `' OR 1=1--` payload all answer **404 in ~40 ms** with no error page and no
  500. They reach `findUnique`, because `isWellFormedPublicCode()` has no production caller — but
  a miss is still a miss: Prisma parameterises the value, so an over-long or quote-bearing
  segment is a lookup that finds nothing rather than an injection or a crash. The shape check's
  docblock ("a request with an arbitrary string in the path never becomes a `findUnique` on
  attacker-controlled input") therefore describes intent that is **not** in the code path. It
  costs nothing exploitable today; it is the same unwired-helper defect as the lowercase code
  above, seen from the security side instead of the usability side.

### Four defects the browser found that 2,369 green tests could not

**1. FR-308's share card points at the developer's laptop.** `og:image` and `twitter:image` both
resolve to `http://localhost:3001/d/{code}/opengraph-image?…`, and they **ignore the `Host`
header** — `curl -H "Host: groupeat.example.com"` returns the same `localhost` URL. There is no
`metadataBase` anywhere in the repo, so Next falls back, and its own source says exactly what to
(`node_modules/next/dist/lib/metadata/resolvers/resolve-url.js`):

```
if (process.env.NODE_ENV === 'development') { fallback = defaultMetadataBase }   // localhost
else { fallback = metadataBase || productionDeploymentUrl || defaultMetadataBase }
```

which I measured rather than inferred by calling Next's own
`getSocialImageMetadataBaseFallback()`: dev → `http://localhost:3001`, **production self-hosted
with no Vercel env → `http://localhost:3001`**, production with
`VERCEL_PROJECT_PRODUCTION_URL` → `https://groupeat.ca`. The share card is the entire
distribution funnel (a drop spreads by being pasted into a group chat), so a card whose image
URL is a laptop is a broken preview for every recipient. Two details make it worse: Next's
warning is **suppressed** for `opengraph-image` in development
(`shouldWarn = … || NODE_ENV === 'production' || !isStaticMetadataRouteFile`), so the terminal
never says a word; and this project already wrote the opposite rule down — `public-origin.ts`
exists precisely because "a message carrying a broken link is worse than one carrying no link",
and refuses `localhost` by name. `og:image` is violating that principle in the one place that
matters most. Severity: **blocker for launch**, invisible to every test. **[Closed in the
`share-card` slice, which is the next section: `metadataBase` is now derived from `APP_URL` and
declared in the root layout, and the origin was proved on a real `next start` in both directions.
Two corrections to the paragraph above, both measured later: the fallback is
`http://localhost:${PORT || 3000}`, so it read `3103` under `next start -p 3103` rather than
`3001`; and the warning is suppressed only in **development** — in production it does print. The
"silent terminal" claim was true of `next dev` and false of a self-hosted production run, where
what was missing was not the warning but anyone reading it.]**

**2. `/admin/users` returns 6.3 MB.** With 1,040 user rows it renders **6,289,787 bytes** and
**12,518 element nodes**; `/admin/drops` at the same moment is 479,861 bytes and 1,044 nodes.
`listUsers()` in `src/lib/db/users.ts:71` has no `take` and no pagination, so the page grows
linearly with the user table — fine at seed scale, and a page that will not load at beta scale.
No render test can see a payload size; the suite asserts text and hrefs. **[Closed in the
`admin-users-cap` slice — search for *"The page that listed everything"*. Two corrections to the
figures above, both measured: the 6.3 MB was a **dev-server** reading, and the same page on a
production build is **1,856,483 bytes / 11,205 nodes**. The defect was real and the number was
3.4× too large, because dev-mode flight data is about 3.4× production. The slice also found a
second defect behind it — 98 profile-less organisers each rendering a whole repair form — and
reduced the page to 400,428 bytes / 2,294 nodes.]**

**3. A lowercase public code is a dead link.** `/d/8en9ajca` → **404**, `/d/8EN9AJCA` → 200, and
`/api/public/drops/8en9ajca/count` → 404. `normalisePublicCode()` and `isWellFormedPublicCode()`
both exist in `src/lib/drops/public-code.ts`, both are fully tested, and **neither has a single
production caller** — `git log -S 'normalisePublicCode('` shows the name has never appeared
outside `__tests__` since it was written in `9280441`. The lookup
(`src/lib/public/public-drops.ts:141`) passes the raw path segment into `where`. This is not a
policy of not normalising: the sibling path **does** — `normaliseScannedCode()` is called at
`src/lib/redemption/redeem.ts:151`, on the same class of human-transcribed string. So the
asymmetry is the finding: the redemption code forgives a phone keyboard and the share link does
not, and a code is exactly what gets read aloud off a screenshot. Severity: **serious** —
iOS autocapitalises, and nothing warns.

**4. A 404 renders nothing without JavaScript.** `/d/NOPE123` with scripts disabled yields
`document.body.innerText === ''`; with JavaScript on the same URL renders the correct copy. The
public drop page itself is server-rendered (612 characters of text in the raw HTML), so this is
specific to the `notFound()` path, which streams a `NEXT_HTTP_ERROR_FALLBACK;404` template and
lets the client finish the job. Severity: **cosmetic-to-serious** — real users have JS, but
WhatsApp's and WeChat's unfurlers do not, and this is the route they fetch.

### Corrections to the record, including two of my own

- **PRD §10.1 is 8 events short, not 4.** `drop_created`, `drop_cancelled`,
  `capture_succeeded`, `capture_failed`, both `redemption_*`, `report_viewed` and
  `ai_draft_generated` are absent from `src/` entirely, including the `AnalyticsEventName` union.
  Measured against a live log of 50,087 lines. This is **already recorded** in the M9 section —
  search for *"Still absent from §10.1"*. Deliberately cited by name and not by line: my own
  insertion above moved that line by 17, which is exactly why this repository has a rule
  against hand-maintained numbers. The actual defect is one line of `AGENTS.md`
  (§ *Definition of done*) claiming *"Analytics events required by PRD §10.1 are emitted"*.
  That sentence is false; it is corrected there now.
  `capture_succeeded`/`capture_failed` are the money events, and their absence is consistent
  with M5's 🟡: nothing has ever been captured.
- **`deal_page_viewed` does not fire for curl, and that is correct.** My first measurement showed
  a delta of 0 and it looked like a broken emitter. It is `isHumanView`, which requires
  `sec-fetch-mode: navigate` and a non-bot user agent — so a browser UA produced a delta of 1.
  The filter is doing its job (unfurlers would otherwise measure sharing effort, not reach).
- **A bot-filtered request is why the log has 2,330 `deal_page_viewed` and both published drops
  look dead.** Not a defect.

### A harness trap worth writing down

My first login test reported success and proved nothing: I clicked `form button` and got
**"Create user"**, because the page already had a session and `/login` had redirected me into
`/admin/users`. The lesson is the same one this repo keeps relearning in new clothes —
**assert the precondition, not just the outcome.** `Network.clearBrowserCookies`, then verify
you are actually logged out, *then* act. A second trap: reusing a stale target let a navigation
race a script that expected a form, producing `Cannot read properties of undefined` — a harness
bug that reads like a page bug. Open a fresh target per scenario and confirm `location.href`
after every navigation.

### Reproducible recipe

```
# app + browser
~/.nvm/versions/node/v24.21.0/bin/node node_modules/next/dist/bin/next dev -p 3001 &
~/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  --headless --disable-gpu --no-first-run --remote-debugging-port=9333 --user-data-dir=$(mktemp -d) about:blank &
curl -s http://127.0.0.1:9333/json/version          # CDP is up when this answers

# assertions, no dependency: PUT /json/new?url=… then JSON frames over webSocketDebuggerUrl
# cookies:      Network.clearBrowserCookies → getCookies → assert length 0 → navigate
# head:         Runtime.evaluate `document.title` / `querySelector('meta[property="og:image"]').content`
# pixels:       curl -o card.png .../opengraph-image && file card.png   → "1200 x 630"
# no-JS:        Emulation.setScriptExecutionDisabled {value:true} before navigating
```

### Still unproven

- **A live join, capture and refund.** Needs a Stripe test-mode key that does not exist here;
  `real-charge-port.ts` keeps 141 of its 152 statements unexecuted. A green browser pass is not
  payment verification.
- **WhatsApp's and WeChat's actual cache behaviour** — the card URL is now known to be wrong in
  production, but the fetched-and-cached behaviour of a third-party unfurler is not testable
  from here.
- **Every page in the browser.** This pass covered `/login`, `/`, `/admin/users`, `/admin/drops`,
  `/d/[code]`, `/d/[code]/join` and the 404/403 paths. The ten `/merchant/*` pages and
  `/organiser` were not driven, so the impersonation banner's countdown is still unverified.
  Saying "the browser step is met" would overstate it; it is met for the paths above.
- **The 6.3 MB payload's user-visible effect** — measured as bytes and nodes, not as a
  browser-perceived render time on a slow connection.

### Found while closing: a third wall-clock flake, in the file that documents the second

The first full-suite run of this slice **failed one test** — `reports.test.ts:570`,
`expect(row2?.customerMix.newCustomers).toBe(1)`. Two subsequent full runs passed 2361/0, and
the file alone passed 5/5, so this is a flake and not a regression: the slice changed no source.

The mechanism is readable in the code, and it is the third instance of one class. `createdAt` is
`@default(now())` at **millisecond** precision (`datetime_precision: 3`, verified against the
information schema), and FR-702's classifier counts a prior capture with a
**strict** `instant < joinedAt` (`src/lib/db/reports.ts:313`) so that a diner's own charge is not
counted as their own previous order. The fixture creates Ada's drop-1 order and then Ada's drop-2
participant in two sequential `await`s **without an explicit `createdAt`**, so the classifier
depends on those two wall-clock reads landing in different milliseconds. When they tie, drop 1's
capture is not counted as prior, Ada is classified **new** on drop 2, and the assertion reads 2
instead of 1 — exactly the line that failed.

Not fixed here: setting explicit `createdAt` values in the fixture is a test change, and this
slice's contract was no source edits. Recorded with the mechanism named rather than a shrug —
`providerSeq` and `phoneSeq` were the two earlier fixes for the same root cause, and the fixture
still has one more place where a timestamp is standing in for a sequence.

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
· `role router` when three entry points must agree on an order (`page.tsx`, `middleware.ts`,`requireRoleOrRedirect`), the order **is** the security property and a single-role test cannot see
it — a gate that only fires for `ADMIN` passes any one case and fails the other two ·
a session read at module scope would serve one caller's role to everyone, and no single-call test
can see that either, so assert the **call count** · a docblock that names a destination its function
does not return is corrected in the comment when four suites and a route comment already pin the
departure deliberately — matching the PRD sideways would break a product decision to satisfy a
sentence · and a coverage claim needs every binding form (relative `from '../page'`, dynamic
`await import('@/app/.../page')`, destructured `const { default: Page } = await import('../page')`)
before it is a claim at all: three scans, three wrong answers, and a proposed slice that was already
written.
· `residue` a fixture that deletes the **child** of what it created reports success and leaves the
parent, and the survivor then impersonates a *different* defect — an `OrganiserProfile` deleted under
a surviving `User` is indistinguishable, to every consumer including `/admin/users`, from an account
whose profile was never created, which is why 1114 leaked accounts read as a missing backfill for six
slices · collect the row that **cascades**, not the row you were thinking about, and there is then no
ordering to get wrong · a counter that moves beside a counter that does not is a diagnosis rather than
two observations: `organiserProfiles` flat at 52 while `users` grew +5 named the parent immediately ·
and the deepest lesson is about the check, not the code — a residue script run in **dump** mode prints
counts that look like a result and are not a comparison, so a three-command ritual with a plausible-
looking half gets half-done indefinitely; make the correct invocation one word (`npm run verify`) or
the gate is documentation · a suite of any strength cannot see a leak, because no test that omits "and
afterwards the database is as it was" can fail on one — the reverted teardown passed all 12 tests while
writing 5 rows a run, so deletion is verified by counting and never by reading.
· `pickup-queue` an endpoint with no caller is not an endpoint that needs no test, it is the one that
drifts: the page is exercised by a large suite and nothing compares the route to the function behind
it, so the payload is asserted **against that function field by field** rather than against literals ·
two routes that disagree about a status filter can both be right, and the assertion that keeps them
right is the one that names both directions, because "tidy this up for consistency" is the natural
future edit · **a wall clock is not a sequence** — `pi_${PREFIX}_${Date.now()}_${phoneSeq}` collided
whenever two participants were made for one customer inside a millisecond, because the counter advanced
in a different function, and it failed one full run in three in a file and a test that named neither
ids nor this change · a fixture that satisfies **two** exclusion rules cannot say which one excluded it:
`DRAFT` and `FAILED` drops placed outside the window left the status filter completely unasserted, and
so did two single-merchant owners leave `merchantIds[0]` unasserted — only a caller who owns two
merchants can tell a membership test from a first-element test · a row ordering is only asserted when
the fixture makes the orderings **disagree**: a collected diner created first and named earlier has
`createdAt` order, name order and outstanding-first order all agreeing, so a sort added to the route
survives · and a probe that survives with no behavioural consequence is reported as what it is rather
than dressed up — an equivalent mutant, or a projection whose job is to stop a future `select` reaching
the wire, which the key-set assertion protects and a value comparison cannot.
· `auth` **a module that is only ever mocked has no tests however many files name it** — `credentials.ts`
appeared in two suites and both replaced it wholesale, so the login path's rate limit, its enumeration
guard and its password policy had never executed; a grep for the import counts mentions, and a
`vi.mock` is a mention · a security claim in a docblock is untested until something can fail on it, and
the dummy-hash equaliser was **proved by measurement** (~54 ms bcrypt vs ~1 ms `findUnique`, a 50×
gap, so a 20 ms floor has headroom) rather than asserted as a sentence · the load-bearing clause was
the one that looked redundant: `if (!user || !passwordMatches)` loses a **universal login** when
`!user ||` goes, because the dummy hash's plaintext is written in `password.ts`, so pin it from both
ends and let each assertion name the other · `Math.ceil` of a positive remainder is already ≥ 1, so
`Math.max(1, Math.ceil(…))` is an **equivalent mutant** — dead code with a defensive purpose, kept and
documented rather than dressed up as covered · a memo whose read-check-write straddles an `await` is
a cache for sequential callers only, and observing that needs `vi.resetModules()` because the module
is warm by the time a later test runs · `vi.spyOn` on a Prisma delegate **destroys** it (the getter is
a proxy; `mockRestore` does not put it back), so wrap the function with `vi.fn(actual.fn)` and use
`mockClear`, never `mockReset` · a header value is trimmed by the HTTP layer before your code sees it,
so a `.trim()` test written with surrounding spaces passes for the wrong reason and the whitespace has
to go *inside* the first element · and a single call with a defaulted parameter cannot tell the default
from `0`, because a fresh bucket looks identical whenever it was created — test the transition, not one
call, or the whole limiter can be permanently expired and nothing fails.
· `routes` **a PATCH that is given fewer keys than it expects must not write the missing ones** —
`pickupSchema` is `.nullish()` on both fields and `parsePickupInput` collapsed "absent" and "blank"
into the same `null`, so an update naming only the address erased the instructions and answered 200;
reproduced and pinned in this slice, **fixed in the next one** by testing key presence (`'k' in data`),
letting Prisma omit an `undefined` column, and answering 422 to a body naming no known field ·
**a route that echoes the request instead of reading back its own write is correct only while the
request is the whole row** — the moment the write became partial, echoing the patch asserted the
erasure in the response body too · **a relative import
hides a route from every path-based coverage count** — `from '../[id]/route'` is invisible to a grep
for `api/merchant/drops/[id]/route`, which is the third distinct way a coverage figure has lied here
(a mock is a mention; a relative import is not a string match; a walk that matches nothing passes
every assertion in it) · **a mutation sweep is only as wide as the suites it runs**, and a probe is
only as good as its pattern: three of this slice's probes mutated the admin `updatePickup` because
the text appears twice in `db/merchants.ts`, and one only *imported* the function it was supposed to
call — a probe that mutates nothing proves nothing · **the line that matters in an OAuth-ish route
is the URL it builds, not the call it makes** — `originOf` producing `localhost` in production would
pass every service assertion because the service is tested with literal URLs, so the spy has to
capture the arguments and not just the result · **a payload consumed by a client component has no
runtime test**, so the key set must be asserted with `toEqual` on the whole object and never
`objectContaining`, or the field a poller reads literally can vanish into `undefined` and refresh the
page every fifteen seconds for the life of a drop.
· `layouts` **all 30 page/layout files are now referenced by a suite**, and the sentence in
the M7 row and gap 12(e) that named fourteen untested pages is stale — a caller-based scan
resolving static `from`, dynamic `import()` and `vi.mock` specifiers finds 26/26 pages and 4/4
layouts · this is the **fourth** way a coverage count has lied here: a relative *dynamic*
`await import('../page')` is invisible to a path grep, and a docblock naming a path is also
just a mention · **a resolver that `path.resolve()`s some keys but not others reports zero
coverage**, because mixed absolute and relative keys can never compare equal — a count is only
as good as the join between what it searches for and what the runtime resolves · the second
gate behind middleware was unexecuted, so the no-leak invariant is pinned by the *absence* of
HTML for a refused caller, and the `await` on that gate is load-bearing · **a prop consumed
only inside a client `useEffect` never appears in server HTML**, so wrap the real component
with `vi.fn(real)` (never stub it), assert the whole prop object with `toEqual`, and use
`mockClear()` because the implementation is the real component · `toBe` identity, not deep
equality, is what pins "the same session object the gate returned", and it needs `getSession`
to yield a fresh object per call · **five of thirty-nine probes survived, all classified**:
three equivalent mutants on unobservable source form, one equivalent mutant for CSS under a
runner that stubs it, and one dead operand caught by `tsc` instead of vitest — the type
checker, not the render suite, is the real guard on a closed union.
· `coverage` **a file being referenced is not a file being executed** — every page, layout and
route was covered, yet 8 of 218 source files had zero statements executed, including the FR-308
OpenGraph card the PRD calls the P0 launch blocker; a caller-based count finds *references*, and
only a V8 run keyed by statements executed finds code that never ran · **the artifact you read is
part of the measurement** — a stale `coverage-final.json` from a run that wrote to a different
directory reported the freshly-tested files as still at zero, which reads exactly like a broken
test; name the output directory and confirm which run produced a report before believing it ·
**the preview card's two claims are frozen price and merchant zone**, not the numbers themselves:
the "was" price must come from the publish snapshot and not the live dish, and the pickup hour
must be formatted in the merchant's zone or it is an hour early on a Canadian host, so both need
a fixture where the two answers *differ* or the test passes for the wrong reason · **a public
endpoint that answers 200 on purpose must return byte-identical output for every refusal case**,
asserted with `toBe` on two full renders, or the response shape enumerates which codes exist ·
**a guard that refuses is testable with no credential; the credentialed half is not** — the charge
port's unconfigured throw runs keyless, but 141 of its 152 statements stay unexecuted and the live
test must keep skipping with its named reason rather than turning green · **`vi.resetModules()`
plus a re-`import()` creates a second copy of every class in that module**, so `toThrow(KnownError)`
fails against an instance that genuinely is `KnownError` — check whether the code reads its
environment at import or at call time before reaching for a module reset.
· `browser` **"cannot be proved by a render test" is not "cannot be proved"** — eight sections
recorded the browser step as unmet with five true reasons (`<head>` wiring, thrown-error
redirects, no `useEffect`, stubbed CSS, no `ImageResponse` pixels), and every one of those
reasons was about the *harness*, not the app; the step closed the moment a browser was pointed
at it · **no dependency was needed to do it** — Node 24 ships a global `WebSocket`, a Playwright
*browser download* was already on disk with no driver attached, and CDP is JSON frames, so
`package-lock.json` stayed untouched · **the highest-value defect it found was in metadata the
suite had pinned as objects**: `og:image`/`twitter:image` resolve to `http://localhost:3001`
because no `metadataBase` is declared, Next's fallback is `localhost` in *development and in
any self-hosted production without Vercel env vars* (measured by calling Next's own
`getSocialImageMetadataBaseFallback`, not inferred), and Next **suppresses its own warning**
for `opengraph-image` in dev — so the FR-308 distribution card, the whole funnel, would ship
pointing at a laptop with a green suite and a silent terminal · **a page's weight is a claim no
render test can make**: `/admin/users` returns 6,289,787 bytes and 12,518 nodes against
`/admin/drops`' 479,861 and 1,044, because `listUsers()` has no `take` — text-and-href
assertions are blind to payload · **an unwired helper is found by asking who calls it, not
whether it is tested**: `normalisePublicCode` and `isWellFormedPublicCode` are both fully
tested and neither has a production caller, so `/d/8en9ajca` is a 404 while the sibling
`normaliseScannedCode` **is** wired at `redeem.ts:151` — the defect is the asymmetry, not a
policy · **assert the precondition, not just the outcome**: a login test "passed" while
clicking *Create user* because an existing cookie had already redirected it off `/login`, so
clear cookies, prove the logged-out state, then act · and **a 404 body can be client-rendered
while the page it 404s from is server-rendered** — `/d/NOPE123` has an empty `innerText` with
scripts disabled and the right copy with them on, which matters because the clients that fetch
that URL to build a link preview do not run JavaScript.
· `admin-users-cap` **a cap does not break tests, it silently weakens them**: every negative
assertion against a truncated list becomes true for free, so `not.toContain(myFixture)` passed for
six slices' worth of "not in the first ten of ninety-nine" while asserting nothing — the repair is
to make the query narrow to one row (`?q=`) and assert a **count**, not a position · **truncation
without a way to narrow is data loss with a scrollbar**, so a `take` ships with the two filters
that make every row reachable, and the page says in words which lists they scope because a search
that visibly ignores two sections reads as a broken search · **an `orderBy` decides what is
visible once a cap exists**, so `[role asc, email asc]` goes from cosmetic to a regression that
shows a hundred admins and no merchants · **a database default is not a sequence either**: two
rows sharing a `createdAt` make "oldest first" whatever Postgres returns, and a capped list that
reshuffles between reloads is one an operator cannot work through — hence the `id` tiebreak, and
hence a probe that **survived** and was proved observable rather than declared equivalent, which
is the difference between *untested* and *unnecessary* · and **the gate does not pin its own
interpreter**: `npm run verify` runs the `node` on `PATH`, which here is 22.22.2 / tzdata 2025c
against a pinned 24.21.0 / 2026c, so two time-zone suites fail for a reason that has nothing to do
with the change — check the toolchain before the code.
· `public-code` **a tested function with no caller is not a tested behaviour**, and the shape check
that sat next to the normaliser in the same module was the wrong half of the pair to wire: 55 of 57
stored codes fail it and every one is a `FAILED` drop whose diner still needs the page, so
`isWellFormedPublicCode` stays a generator-side invariant while `normalisePublicCode` becomes the
lookup-side identity — and that is safe only because it is the identity on **every stored code**,
asserted against the table rather than reasoned from the generator · **`FOR UPDATE` locks the row
it matches**, so a lookup key that is not the stored form does not fail loudly, it locks nothing and
returns the same `NOT_FOUND` a mistyped code gets, which is a live offer reported as nonexistent ·
**normalising the *read* is only half the job** — a code is also read to *compose* links, and a
second URL for one order splits share counts silently while the join still succeeds · and **a
fixture must be able to exist**: `settlementFixtures` wrote `JOIN-SVC-…` with hyphens for as long as
nothing normalised, then broke 17 tests the moment something did, because the tests were right about
the product and wrong about the row — call the generator's contract, not a convenient string.

## The share card was correct, and still pointed at a laptop

D1 from the browser pass, closed. `docs/PROGRESS.md` called it *"blocker for launch, invisible to
every test"*; this is the slice that measured the fix instead of arguing it.

### The defect was not in the metadata object

`generateMetadata` built the right title, the right description and the right `robots`. What it
never said was **where the card lives**, and `d/[publicCode]/opengraph-image.tsx` is a *file
convention* — Next derives `og:image` itself and resolves it against `metadataBase`. There was no
`metadataBase` anywhere in `src/`. So Next fell back, and the fallback is not "omit the image":

| `NODE_ENV` | `metadataBase` | resolved card origin |
|---|---|---|
| development | none | `http://localhost:3000` |
| development | `https://groupeat.ca` | `http://localhost:3000` — **the argument is discarded** |
| production | none | `http://localhost:3000` |
| production | `https://groupeat.ca` | `https://groupeat.ca` |

Measured by importing Next's own `getSocialImageMetadataBaseFallback()` and `resolveImages()` and
calling them, not by reading the source and inferring. The third row is the defect; the second row
is why this slice is not a one-line change.

### Three states, because two of them need opposite behaviour

The tempting fix is `metadataBase: publicOrigin()` — reuse the notification origin and be done.
That is wrong twice, and both reasons are in the code now:

1. **Absent means different things downstream.** For a notification link, "no origin" means *no
   link*, which `public-origin.ts` documents as the safe answer. For `metadataBase`, "no origin"
   means **localhost** — a wrong answer delivered to a stranger. One validator, two opposite safe
   defaults, so they cannot share a return contract. `lib/metadata/social-card.ts` reuses
   `validatePublicOrigin` (one definition of "public origin", already unit-tested) and decides the
   absent case itself.
2. **Production with no `APP_URL` is a mistake that must be visible.** Notifications degrade
   silently and correctly; a card that cannot be built has no correct silent answer. So:
   **`unavailable`** → emit *no image at all* plus one `error` line per process
   (`metadata.public_origin_missing`, with the refusal reason). A preview with a title and no image
   is degraded; a preview whose image is `localhost:3000` is broken and reads as our bug, in the
   one place the PRD calls the funnel.

The third state, `local`, keeps a fresh checkout and `next dev` working without noise — the dev
server's card *should* point at the dev server.

### Suppression is `images: []`, and it is load-bearing that it is not `undefined`

Next auto-fills the file-convention image **unless the metadata object sets an `images` key
itself** (`hasOwnProperty('images')` in `resolve-metadata.js` — read, then measured). `images: []`
suppresses it, `images: undefined` also suppresses it, and *omitting the key* restores it. That
distinction decides the implementation: the suppression is spread in **conditionally**, because a
page that set `images: []` unconditionally would delete FR-308's card on every healthy deployment —
fixing a broken preview by removing all previews.

### Proof, on a production server, both directions

`next dev` **cannot** demonstrate this fix: row 2 of the table is Next discarding the argument
before it looks at it. So the verification was a real build served by `next start`:

```
APP_URL=https://groupeat.example next build && next start -p 3101
  og:image → https://groupeat.example/d/AUMW15YFOW1/opengraph-image?8e1835eeb3e6c72b   ✔

APP_URL= next start -p 3102          (same build)
  og:image / twitter:image → (absent, deliberately)                                   ✔
  og:title / og:description / twitter:card → intact                                   ✔
  metadata.public_origin_missing → exactly 1 line across 3 page views                 ✔

counterfactual: metadataBase deleted, APP_URL set, production
  og:image → http://localhost:3103/d/AUMW15YFOW1/opengraph-image                       ← the defect
```

The counterfactual is the important row. Without it, the green result above is compatible with a
Next version that ignores `metadataBase` entirely. Two details worth keeping: the
`metadataBase` warning **does** print in production (`shouldWarn` requires
`NODE_ENV === 'production' || !isStaticMetadataRouteFile` — it is suppressed only for the
file-convention case in *dev*), and the counterfactual build first failed on
`'cardOrigin' is assigned a value but never used`, which is a lint error rather than a behaviour
difference — a mutant that does not compile is not evidence.

### Seven probes, two of which were real gaps

Every new assertion was mutated before it was believed. Five died immediately; two **survived**:

- deleting the `metadataBase` spread from `layout.tsx` — survived, because nothing imported the
  layout's metadata under a stubbed `APP_URL`;
- replacing the page's suppression conditional with `{}` — survived, because every fixture runs
  under `NODE_ENV=test`, where the state is `local` and the branch is never taken.

Both were coverage gaps, not equivalent mutants, and both now have tests. The generalisable
finding is the **second** one: a branch keyed on `NODE_ENV=production` is unreachable from a suite
that runs under `test` unless the environment is stubbed *and the module graph re-imported*
(`config.ts` freezes `env` at load, so `vi.stubEnv` after import changes nothing). That is the same
constraint `confirmation-wiring.test.ts` documents for `APP_URL`.

A third lesson is about the harness rather than the code: probe D initially reported SURVIVED
because the sweep ran `src/lib/metadata src/app/d` and never `src/app/__tests__/layout.test.ts`.
**A sweep is only as wide as the suites it runs** — the fix is to widen the run, not to write a
second assertion.

### Still open, and now more visible

The `unavailable` state is a *behaviour*, not a repair: a production deployment that forgets
`APP_URL` now serves share links with no card. That is better than a card pointing at a laptop and
it is logged loudly, but it is still a misconfiguration, and `APP_URL` remains the one env var
whose absence has a user-visible consequence on the public page. ~~D2 (`/admin/users` at 6.3 MB)~~,
~~D3 (`normalisePublicCode` unwired)~~ and D4 (`notFound()` body empty without JS) are untouched.
[D2 is now closed — the next section, *The page that listed everything*. The figure in this
sentence was a dev-server reading; see that section for the production measurement.]
[D3 is now closed — see *The tested function nothing called*. D4 was investigated and
**re-classified rather than fixed**: it is Next's rendering model, not this repo's code, and the
investigation found a *different*, fixable defect underneath it. See the next section.]

· `share-card` **a metadata object can be entirely correct and still ship a broken card** — the
title, description and `robots` were right and `og:image` was a file convention Next resolves
against a `metadataBase` this repo never declared, so every share of every drop pointed at a laptop
while the suite stayed green · **`next dev` cannot test this and will report a false negative**:
`getSocialImageMetadataBaseFallback()` returns `createLocalMetadataBase()` before it reads its
argument when `NODE_ENV === 'development'`, so an explicit base is discarded and the dev server
shows `localhost` whether the fix is present or not — verify with `next build` + `next start` and
always build the **counterfactual**, because a green production result is otherwise compatible with
a Next version that ignores the field · **the same missing input has opposite safe defaults in two
consumers**: for a notification link "no origin" means *no link* (documented safe), for
`metadataBase` it means **localhost** (a wrong answer delivered to a stranger), so the two cannot
share a return contract even though they must share one validator — reuse `validatePublicOrigin`,
decide the absent case locally · **`images: []` is the only way to say "no card", and it must be
applied conditionally** — Next auto-fills the convention image unless the object sets `images`
itself (`hasOwnProperty`), so suppressing unconditionally fixes a broken preview by deleting every
preview, which is FR-308 · **a branch keyed on `NODE_ENV=production` is unreachable from a suite
running under `test`** unless the env is stubbed *and the module graph re-imported*, because
`config.ts` freezes `env` at load — the same trap `confirmation-wiring.test.ts` documents for
`APP_URL` · and **a sweep is only as wide as the suites it runs**: probe D reported SURVIVED only
because the run omitted `src/app/__tests__/layout.test.ts`, and the repair is to widen the run, not
to write another assertion.


## The page that listed everything, and the cap that would have lost rows

D2 was recorded as *"`/admin/users` returns 6.3 MB"*. It was, and the number was wrong in a way
that mattered: **it was measured on a dev server.** Re-measured on `next build` + `next start`
the same page is **1,856,483 bytes** — dev-mode RSC flight data is about 3.4× production, so the
recorded figure was 3.4× too large and the defect it described was real anyway. Both numbers are
in the record from here on, because "6.3 MB" would have been argued about and "1.86 MB at 1,040
rows" is a page that will not load at beta scale on a phone.

### What was actually wrong, and the second defect behind it

`listUsers()` was `findMany` with no `take`. Two consequences, and the second one was invisible
until the first was measured:

| | before | after | |
|---|---:|---:|---|
| bytes | **1,856,483** | **400,428** | −78.4% |
| markup | 792,795 | 165,808 | |
| flight | 1,063,688 (57.3%) | 234,620 (58.6%) | |
| element nodes | **11,205** | **2,294** | −79.5% |
| `<form>` elements | **98** | **10** | |
| `Temp password` badges | 662 | 110 | |

Measured with the same CDP harness, same login, cache disabled, one production build of each
tree. The flight share stayed almost constant, which is the interesting part: capping the rows did
not change the *ratio*, it removed 1.06 MB of markup and 829 KB of flight together. An App Router
page pays for its rows twice.

**The second defect.** 98 of those forms were not the deliberate ones. `listProfilelessOrganisers()`
returned every organiser with no profile, and each row renders a *complete repair form* — a hidden
`userId`, a labelled text input, a submit button and two sentences — because the display name is
the one value the repair cannot invent. 98 of them accounted for 98 of the page's 100 forms and
605 of its inputs. The query was correct and its use was not: a screen an operator works through
one account at a time was rendering the whole backlog because writing `findMany` is easier than
writing a `take`.

### The design tension the cap creates, and why `?role=` is not optional

A cap alone is **data loss with a scrollbar**. 1,040 accounts, 100 rows, and the 941st is
unreachable from the only screen that lists accounts — which is worse than the slow page it
replaces, because the slow page at least answered the question. So the cap ships with two ways to
name what you want:

- `?role=` — chips, as **links** mirroring `/admin/drops`: bookmarkable, shareable in a support
  thread, reload-surviving. The operator using it is usually on the phone describing their screen.
- `?q=` — a GET search form, carrying `role` in a hidden field and carrying `q` forward on every
  chip, so the two controls cannot silently cancel each other.

Both are the same `contains`/`insensitive` predicate, deliberately unindexed: this is an admin
screen with a thousand rows, not a query path a diner waits on.

### The ordering change, which was a regression I introduced and caught

The cap made `orderBy` decide *what is visible* rather than merely how rows are grouped. The
existing `[{ role: 'asc' }, { email: 'asc' }]` was harmless while the read was unbounded and is
actively harmful under a cap: this database holds ~760 ADMINs, so the default screen became 100
admins with no merchant and no organiser in sight. Changed to `{ email: 'asc' }` — a total order
on a `@unique` column, stable between reloads, so "scroll to where it should be" works. Grouping
by role is now the filter's job, which is a better tool for it than a sort order because it also
reports how many of each there are.

Six tests failed on the first run of the cap, and none of them was test breakage:

1. **The heading counted 99 while 10 forms rendered.** My own ambiguity, and the fix is the
   sentence "Showing the 10 oldest of 99" — the page states both numbers rather than printing the
   cap as if it were the backlog.
2. **Fixtures vanished from the render.** The repair list is capped and oldest-first, and the dev
   database has held ~99 profile-less organisers since before this suite existed, so a fixture
   created a millisecond ago is never in the first ten. `toContain(myFixture)` failed, and — far
   worse — `not.toContain(myFixture)` was **passing vacuously**, because the fixture was absent
   from a truncated list either way. The fix is `?q=`: searching a fixture's own address narrows
   the result to one row, so `total === 1` and `total === 0` become assertions about the predicate
   instead of about sort position.

That second one is the lesson worth keeping. **A cap does not break tests, it silently weakens
them**: every negative assertion against a truncated list becomes true for free.

### One search box has to mean one thing

`?q=` narrows the user list and the repair list, not just the user list. The bug this avoids: an
operator types a known-broken address, the user list shows one row, and above it a card still
reads "99 organisers missing a profile" as if the question had not been asked. The card now
counts matches and says so ("1 organiser matching "…" is missing a profile"), which also makes the
**singular** arm reachable for the first time — it was previously untestable on a database whose
count is 98, and probe K had recorded it as such.

The roster sections (`listOrganisers`, `listMerchants`) are deliberately **not** capped and do not
honour `q`. They are a fixed book of business — 5–15 organisers in beta by PRD §3.3 — not a log.
Capping a roster hides rows an operator is entitled to see. Because that looks like a broken
search on screen, the page says it in words: *"The user list and the missing-profile list are
narrowed; the organiser and merchant lists below always show everyone."*

### `verify` does not pin the interpreter, and that cost an hour

`npm run verify` runs whatever `node` is on `PATH`. On this machine that is **22.22.2 with tzdata
2025c**, not the pinned 24.21.0/2026c, and it failed two suites:

```
FAIL src/lib/organisers/__tests__/share-link.test.ts
  expected text to contain 'Thursday 5:00 PM'
FAIL src/app/(merchant)/merchant/pickup/__tests__/page.test.ts
  expected 'Western Window Wed 3:20 p.m. – Wed 5:20 p.m. …' not to contain 'Wed 5:20 p.m.'
```

Neither touches this slice. Both were reproduced on clean `e58f076`, and the mechanism is one
`Intl` call:

```
Intl.DateTimeFormat('en-CA', {…, timeZone: 'America/Edmonton'}).format('2026-11-05T23:00:00Z')
  Node 24.21.0 (tzdata 2026c) → Thursday 5:00 p.m.     ← Alberta is UTC−6 year-round after 2026-11-01
  Node 22.22.2 (tzdata 2025c) → Thursday 4:00 p.m.     ← the old DST rule
```

`AGENTS.md` already warned about this trap and said **one** test fails under Node 22. It is **two**;
the pickup suite was the missing witness, and the file is corrected. Re-run through the pinned
binary, the full suite is **2403 passed, 0 failed, 8 skipped** and the residue comparison is clean,
so the two failures were the toolchain and never the change.

### The mutation sweep: twelve probes, eleven killed, one that taught the most

Each probe was applied to the real tree and the three suites re-run:

| # | Mutation | Result |
|---|---|---|
| 1 | drop `take: limit` from `listUsers` | killed (3) |
| 2 | `count()` without the `where` | killed (2) |
| 3 | `orderBy` back to role-first | killed (5) |
| 4 | `q` no longer reaches the repair list | killed (2) |
| 5 | remove the "showing the first N of M" sentence | killed (1) |
| 6 | chip drops `q` | killed (1) |
| 7 | search form drops the hidden `role` | killed (1) |
| 8 | drop `take` from `listProfilelessOrganisers` | killed (2) |
| 9 | **drop the `{ id: 'asc' }` tiebreak** | **survived** → then killed |
| 10 | stop trimming `q` | killed (1) |
| 11 | drop the `role` predicate | killed (1) |
| 12 | drop `mode: 'insensitive'` | killed (1) |

**Probe 9 is the one worth writing down.** Deleting the `id` tiebreak left *every test green*,
which reads as "the tiebreak is unnecessary". It is not — the fixtures are created milliseconds
apart and their `createdAt` values differ, so the tiebreak was never exercised. Proven with a
throwaway script: six accounts sharing one timestamp, ordered by `createdAt` alone, came back in
**neither** id order; with the tiebreak they came back sorted. So the branch was **untested, not
unnecessary**, and the difference between those two readings is the whole value of running the
probe. The test now creates four fixtures with one shared `createdAt` and asserts the result
against sorted ids — "the same answer twice" would have passed against a stable-but-wrong order,
because Postgres is usually stable and the defect is that it is not *obliged* to be.

### Still open

- **The 6.3 MB figure is corrected in place, not deleted.** The D2 entry above still reads
  "6.3 MB" with a bracketed note, because a record that quietly changes its own measurements is
  how a team stops trusting the record. The production number is 1,856,483 and the dev number
  was 6,289,787; both are now attributed to the environment that produced them.
- **The repair form is still one form per row.** Bounding it to 10 fixed the page, but the right
  shape is a single form with a selector, or a bulk backfill for accounts whose name can be
  derived. Not attempted: 98 real accounts is a data condition, not a UI decision.
- **No pagination, only a cap.** `?role=` and `?q=` make every row *reachable*; they do not make
  the list browsable past 100. If the table reaches 10,000 this needs a cursor, and the honest
  statement today is that the cap is a stop-gap chosen over the slow page.
- **`listMerchants` and `listOrganisers` remain uncapped by decision, not omission** — recorded in
  the page's docblock so the next reader does not "fix" them.

## The tested function nothing called, and the 55 drops a gate would have hidden

D3 was recorded as *"`normalisePublicCode`/`isWellFormedPublicCode` are fully tested but have no
production caller, so `/d/8en9ajca` (lowercase) 404s."* The first half was exactly true — the
functions had unit tests, were exported, and were referenced by nothing outside their own test
file. The second half was true and understated, because a lowercase code is one of five shapes a
messaging app hands back and the other four 404'd too.

The repair is small; deciding *how* to repair it is where the slice actually happened.

### The measurement that ruled out the obvious fix

The obvious fix is to validate the code before the lookup — the module even ships
`isWellFormedPublicCode` for it, with a docblock explaining that it keeps arbitrary strings from
becoming database reads. Wiring it in would have been one line. Measured against the dev database
first:

```
             total drops        57
  well-formed (8 chars)         2
  failing the shape check      55   ← all FAILED, all 11 characters
  changed by normalisation      0
  normalised to empty           0
```

**55 of 57 stored codes fail the shape check, and every one of them is a `FAILED` drop.** Those
are precisely the drops `public-drops.ts` already documents as must-stay-reachable: a diner whose
drop did not reach its minimum taps the same link they joined with and needs to read "nobody was
charged". A shape gate would have converted 55 working explanations into `404`s, and every test in
the suite would have stayed green — a 404 for a wrong-shaped code is byte-identical to a 404 for a
mistyped one, which is the property the module claims and the reason the damage would have been
invisible.

So the design inverted: **normalise, do not gate.** Normalisation is the identity on all 57 stored
codes (0 changed, 0 emptied), so it cannot break a reachable drop. The shape check stays a
*generator-side* invariant — `createDraft` mints codes from the 30-symbol alphabet — rather than a
lookup-side rejection. That asymmetry is the whole finding, and it is recorded in the
`getPublicDrop` docblock so the next reader with a "validate your input" reflex meets the numbers
before the reflex.

### Where it had to go, and the one place that is not a lookup

Five surfaces read the code, and four of them read it through `getPublicDrop`, so normalising there
covered the deal page, the join page, the OpenGraph card and the count API in one edit. The rest
were not lookups at all:

| seam | what a raw code costs |
|---|---|
| `getPublicDrop` | all four diner surfaces 404 |
| `quoteJoin` | `NOT_FOUND` on the Payment Element |
| `joinDrop` | **`FOR UPDATE` locks nothing** |
| `loadOrderPage` | the SMS link 404s hours later |
| `mine/page.tsx` | mints a **second URL** for one order |

`joinDrop` is the one that would have been hardest to find. It reads the code once, and that once
is a raw `SELECT … FOR UPDATE` inside the transaction: `FOR UPDATE` locks the row it *matches*, so
a lowercased code matches nothing, falls through to `NOT_FOUND`, and reports a live drop as
nonexistent — the same refusal a mistyped code gets, which is why nobody would have reported it.
The code is then read **four more times** after the lookup, not for matching but to compose the
confirmation SMS's link; those failures are quieter still, because the join *succeeds* and simply
mints `/d/abc2345/mine` alongside `/d/ABC2345`.

I wrote the opposite in my first draft — that `joinDrop` looked the drop up twice — and it was
wrong. There is one lookup. The comment was corrected before the commit, because an inaccurate
reason for a change invites the next reader to delete the change for the right reason.

### The fixture that had been modelling an impossible row

Adding the join tests detonated **17 pre-existing tests**, all `NOT_FOUND`, against drops that
plainly existed. Not a regression: `settlementFixtures().drop()` built its code as
`` `${prefix}${codeSeq}`.toUpperCase().slice(0, 24) ``, which for a prefix of
`join-svc-1793829316998` produces **`JOIN-SVC-17938293169981`** — 21 characters, three hyphens.
That is a code no part of the product can mint; `createDraft` is the only writer of `publicCode`
and it writes `generatePublicCode()`.

The fixture had been harmless for as long as lookups used the raw segment. The moment the read
paths normalised, `normalisePublicCode` stripped the hyphens, so a stored `JOIN-SVC-…` was looked
up as `JOINSVC…` and every join answered `NOT_FOUND`. The tests were right about the product and
wrong about the row they had written, and nothing had ever asserted the difference.

The helper now hashes the whole prefix into the generator's alphabet and emits eight characters.
Two intermediate versions failed and both are recorded in its docblock, because they are the
obvious designs someone will reach for again:

1. **Trailing letters of the prefix, padded** — collapsed to `ZZZZ` for any all-digit prefix, and
   `qx1793834000000`/`qx1793834000001` both ended in `QX`, so two test files agreed on six of eight
   characters. Six tests died on a unique-constraint violation, which is how it was found.
2. **Digits allowed in the tag** — produced `485729`, which is its own lowercase form, making a
   test that asserts "the order link does not contain the lowercased segment" pass without
   measuring anything. The tag is letters-only for that reason.

### The six probes

| # | Mutation | Result |
|---|---|---|
| 1 | remove normalisation from `getPublicDrop` | killed (4) |
| 2 | **add** a shape gate to `getPublicDrop` | killed (5) |
| 3 | remove normalisation from `joinDrop` | killed (3) |
| 4 | remove normalisation from `joinDrop` and normalise the early read | killed (3, identical to 3) |
| 5 | remove normalisation from `quoteJoin` | killed (2) |
| 6 | `mine/page.tsx` href from the raw segment | killed (1) |

**Probe 4 is the informative one.** I designed it to show that normalising only the *first* read
would leave the `FOR UPDATE` locking nothing — and it killed exactly the same three tests as probe
3, because there is no first read to normalise. The probe did not fail; my model of the function
did, and chasing the discrepancy is what found the false comment. A probe that cannot be
distinguished from another probe is telling you the code is not shaped the way you think.

Probe 2 is the one worth keeping: it is the "harden it" change, it is a one-line addition a
well-meaning reviewer would suggest, and it is now the mutation that five tests defend against.

### What changed

- **`getPublicDrop`, `quoteJoin`, `joinDrop`, `loadOrderPage`** normalise the code before the read.
- **`joinDrop`** binds the normalised code once, before the transaction, so the lock and all four
  link compositions use it by construction rather than by each call site remembering.
- **`mine/page.tsx`** composes its "See this offer" link from a `canonicalCode`, so the page stops
  minting a second URL for a drop that already has one.
- **`settlementFixtures`** writes a code the product could actually produce.
- Tests: 19 new, and the suite moves from 2411 to 2430. On `getPublicDrop`: lowercase, pasted
  link, trailing slash, hyphenated, a genuine 404 still 404s, and a malformed `FAILED` code stays
  reachable. Plus a property test that normalisation is the identity on **every stored code**, one
  that the generator cannot produce a code normalisation would change, and one that normalisation is
  idempotent. On the join service: lowercase, pasted link, a nonexistent code still refused, and the
  order link minted from the canonical code. Three on the quote, two on the order page, one on the
  `mine` page.

Full suite **2422 passed, 0 failed, 8 skipped** (2430 total); `tsc --noEmit` and `eslint .` clean;
residue comparison clean (9 counts unchanged, `auditLogs` +71 as expected).

### Still open

- **The 55 legacy codes are not migrated.** They resolve because normalisation is the identity on
  them, not because they are good. A backfill would let `isWellFormedPublicCode` become a real gate
  one day, but it rewrites URLs that are already in group chats, so it is a decision with a
  migration plan attached rather than a tidy-up. Recorded, not attempted.
- **`/d/` still accepts a full pasted URL as a path segment.** `normalisePublicCode` handles it, and
  the resulting 404 for a genuinely wrong code is uniform. Harmless, and slightly odd to read in a
  server log.
- **`funnel.test.ts` and the analytics events are untouched.** `dealPageViewEvent` keys off
  `dropId`, never the code, so attribution needed no change — stated because it looks like it
  should have.


## The 404 that was ours to fix, and the one that was not

D4 was recorded as *"`notFound()` renders an empty body without JavaScript"*. Both halves of
that sentence turned out to matter, and the second half was the surprise: the empty body is
**Next's**, and the share card on top of it was **ours**.

### First: is it our bug at all?

The whole investigation rests on one measurement, so it was done first. A minimal Next app was
built in `/tmp` — one layout, one `not-found.tsx`, one dynamic route calling `notFound()`,
sharing nothing with this repo except the dependency version — and measured with the same
CDP harness, JavaScript disabled:

| path | minimal app | |
|---|---:|---|
| `/d/GOOD` (renders) | 9 chars | |
| `/d/NOPE123` (`notFound()` from a **dynamic** route) | **0 chars** | |
| `/nope` (no route matches → prerendered `_not-found`) | 48 chars | |

It reproduces with none of our code in the tree. Then the version sweep, because "framework
bug" is only actionable if a newer version fixed it:

| Next | `notFound()` body, JS disabled |
|---|---:|
| 15.5.28 (this repo) | 0 |
| 15.5.29 (latest 15.5) | 0 |
| 16.4.5 (latest) | 0 |

So it is not a regression we introduced and not an upgrade we can take. The mechanism is in
`app-render.js`: `getErrorRSCPayload()` seeds the payload with
`<html id="__next_error__"><head/><body/></html>` — an **empty** `<body>`, in production,
unconditionally. The 404 copy is streamed only inside the `self.__next_f` flight payload, and
`<template id="B:0">` / `<div hidden id="S:0">` are both empty, so a client with no JS has
nothing to render and no script to un-hide it.

**Callers affected in this app: 8.** `/d/:code`, `/d/:code/join`, and six admin/merchant
detail pages. Four user agents checked (Googlebot, facebookexternalhit, WhatsApp, curl) — all
four received zero visible bytes.

### What was tried, and what each attempt cost

Five structural fixes were measured on production builds and four were reverted. This is the
useful part of the record, because each failure rules out a hypothesis the docs imply should
work:

| attempt | result |
|---|---|
| `experimental.globalNotFound: true` + `app/global-not-found.tsx` | fixed the **static** `/_not-found` (97 chars) — not `notFound()` |
| `experimental.htmlLimitedBots` | dead end: `shouldServeStreamingMetadata()` gates **metadata** only, never the body |
| `dynamic = 'force-static'` + `generateStaticParams` | correct 404 status, still 0 chars |
| inline JSX instead of `notFound()` | **56 chars, but HTTP 200** — wrong status for a 404 |
| `notFound()` inside `generateMetadata` | swallowed entirely; status stayed 200 |
| middleware `rewrite(..., { status: 404 })` | **both** 404 and a real body — but needs a DB lookup in middleware |
| PPR (`shouldWaitOnAllReady`) | the one option that would flush the shell; `experimental.ppr` refuses to build on 15.5 (canary only) |

The two properties are mutually exclusive in Next 15/16: `notFound()` gives the right status and
no body; rendering the copy inline gives the body and a 200. Neither is acceptable, and a
framework-level fix (PPR, or an upstream change) is not ours to make. **D4 is therefore recorded
as a known framework limitation, not fixed.**

### The defect underneath it, which was ours

Stripping the `__next_error__` payload for analysis surfaced something else in the same
response. On a production build with no `APP_URL` — the exact state `social-card.ts` exists
for — the 404 was shipping a share card pointing at a laptop:

```
/d/8EN9AJCA        og:image → (absent, suppressed)                            ✔
/d/8EN9AJCA/join   og:image → http://localhost:3201/d/8EN9AJCA/opengraph-image  ✘
/d/NOPE123         og:image → http://localhost:3201/d/NOPE123/opengraph-image    ✘
/d/NOPE123/join    og:image → http://localhost:3201/d/NOPE123/opengraph-image    ✘
```

Three of four rows are the D1 defect D1 did not fix, on live shareable paths. The second row is
the worst: `/d/:code/join` on a **valid, healthy** drop — a URL a real person can be sent to —
was previewing itself with `localhost`.

The mechanism is the file convention, and it is directory-keyed rather than page-keyed:
`d/[publicCode]/opengraph-image.tsx` is collected by directory, so **any** page in that segment
gets `og:image` autofilled unless its metadata object owns an `images` key. The deal page owned
one and the join page did not, which is why D1's fix covered one page out of four.

### Four attempts again, and only the fourth worked

| suppression written in | `/d/NOPE123` |
|---|---|
| `page.tsx`, `!drop` branch | still localhost ✘ |
| `d/[publicCode]/layout.tsx` | twitter fixed, `og:image` not ✘ |
| root `app/layout.tsx` | still localhost ✘ |
| `d/[publicCode]/not-found.tsx` | **no card** ✔ |

The reason is in `resolve-metadata.js`: when `notFound()` is thrown Next discards the page's
metadata and re-resolves with `errorConvention: 'not-found'`, which walks each segment for a
`not-found` **component** and pushes that module's metadata as the **deepest** item.
`mergeStaticMetadata` autofills only when the item *at that level* has no `images` key — so the
suppression has to live on the last module read, which is a `not-found.tsx` the app did not
have. Creating one also fixed the title: the 404 had been serving the root layout's `GroupEat`
instead of `Drop not found — GroupEat`, which was the tell that the page module was never
consulted.

### The regression the fix caused, and the test that caught it

The first version wrote `openGraph: { ...cardSuppression }` unconditionally. With `APP_URL`
set that emits an `openGraph` object with no `images` key — which is *also* enough to stop the
autofill. The join page lost its card entirely on a healthy deployment:

```
APP_URL=https://groupeat.ca
  spread-in    → /d/8EN9AJCA/join  og:image=https://groupeat.ca/…  ✔
  always-emit  → /d/8EN9AJCA/join  og:image=(absent)               ✘
```

The deal page never hit this because its healthy branch sets `openGraph` with a title and
description and inherits the card through them. A page with no `openGraph` of its own has no
such cover, so for that page the key must be **absent, not empty** — and the test asserts
`toBeUndefined()` rather than `not.toHaveProperty('images')` for exactly that reason. That is
the difference between an assertion that pins the bug and one that pins a spelling of it.

### Verification, both configurations, four paths

Production build, `next start`, reading the rendered `<head>`:

```
                   APP_URL=https://groupeat.ca        APP_URL= (unset)
/d/8EN9AJCA        200  card → groupeat.ca            200  absent
/d/8EN9AJCA/join   200  card → groupeat.ca            200  absent
/d/NOPE123         404  card → groupeat.ca            404  absent
/d/NOPE123/join    404  card → groupeat.ca            404  absent
```

Every path correct in both directions — the healthy deployment keeps FR-308's card everywhere,
and the misconfigured one leaks no origin anywhere. Six probes were run against the new
assertions; all six were killed. Three are worth naming because they are the plausible
mistakes: reverting the `page.tsx` early return (2 tests fail), removing one channel's
suppression (`openGraph` only — 3 fail), and inverting the condition to always suppress (1
fails, the healthy arm).

### Still open

- **D4's empty body is not fixed, and this repo cannot fix it.** The options that remain are a
  Next canary with PPR, a middleware rewrite that duplicates the drop lookup, or rendering the
  404 copy inline and accepting HTTP 200. All three are worse than the defect. The honest
  position: a JS-less client gets a correct status code and no body, and unfurlers still get
  correct metadata (which is what makes a shared link work at all).
- **The 8 `notFound()` call sites** other than the two public ones are unmeasured. They are all
  behind auth, so an empty body there is a cosmetic problem rather than a distribution one, but
  the same mechanism applies and none of them has been looked at.

## The PATCH that erased what it omitted, and the three places the fix had to land

The previous section ended with a defect it deliberately did not fix: a `PATCH` to
`/api/merchant/pickup` naming one field erased the other and answered `200` describing the erasure
as the new state. Four tests asserted the damage and were named `erases …`. This is the slice that
turned those four into eight asserting the opposite.

### The defect, in one line of `clean()`

```ts
const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};
```

`undefined` and `''` both arrive, both leave as `null`. For a full write that is correct — a blank
pickup address and a missing one are the same thing to a form that sent both. For a `PATCH` it is
a lie about intent, because the protocol's whole vocabulary is built on a distinction the function
cannot make:

| body | what it means | what the old code wrote |
|---|---|---|
| `{}` | change nothing | both columns `NULL` |
| `{"pickupAddress": "1 New Rd"}` | set the address | address set, **instructions `NULL`** |
| `{"pickupInstructions": null}` | empty the instructions | instructions `NULL` (correct) |

The third row is why this could not be fixed by treating `null` as "absent": clearing a field is a
real operation the form performs (it sends `''` when the merchant empties the textarea), and a fix
that made clearing impossible would pass a suite that only checked for erasure.

### Three places, and why each had to move

**1. The parser tests presence, not value.** `pickupSchema.partial()` keeps the per-field rules in
one place — the trim, the 300-char cap, the `.nullish()` — so a change to one field's limit cannot
apply to the full write and miss the partial one. The result is built by asking the question the
protocol is asking:

```ts
const value: PickupPatch = {};
if ('pickupAddress' in parsed.data) {
  value.pickupAddress = clean(parsed.data.pickupAddress ?? null);
}
if ('pickupInstructions' in parsed.data) {
  value.pickupInstructions = clean(parsed.data.pickupInstructions ?? null);
}
```

`key in data` and not `data.key === undefined`. The two look equivalent and are not: `undefined`
is exactly what an absent key already looks like, so a value test cannot tell `{}` from
`{ pickupAddress: undefined }` — and with `strict` but **without** `exactOptionalPropertyTypes`
(which this repo does not set), TypeScript cannot either. `in` asks the question that has an
answer. The `?? null` inside is not the bug returning: it runs only after presence is established,
converting a present `undefined` into the `null` it must be written as.

**2. The writer passes `undefined` through.** In Prisma, `data: { col: undefined }` **omits the
column from the generated `UPDATE`**. That is precisely the semantics wanted, and it costs nothing
— no conditional query builder, no dynamic `where`. `updateOwnPickup` now takes
`string | null | undefined` per field and hands them straight to `prisma.merchant.update`. The
regression risk is a future `?? null`, which would be a one-character "tidy" that silently restores
the entire defect, so the docblock says so in those words.

**3. The response reads back what it stored.** The route used to answer with the parsed body. That
was correct only because the body was always the whole row — echo the input, get the same answer
as a table read. With a partial write, echoing `{ pickupAddress }` tells the client the
instructions are gone, which is the erasure reasserted in the response. `PickupForm` applies the
response object straight to its inputs, so it has to be the truth: one extra `getMerchant` on a
save the merchant pressed a button for.

The route also gained a guard the parser cannot express. Zod **strips** unknown keys rather than
failing on them, so `{"pickupAdress": "1 New Rd"}` parses to `{}` — a typo that would otherwise
become a silent no-op or, before this slice, a double erasure. A body naming no known field is a
client bug, and `422` is the only answer that makes it visible:

```
{ "error": "VALIDATION",
  "message": "Nothing to update. Send pickupAddress, pickupInstructions, or both." }
```

`200` for "changed nothing" was the alternative and is defensible on the letter of `PATCH`; it was
rejected because a request that had no effect and a request that was misaddressed would then be
indistinguishable to the caller, and only one of those is fine.

### Four probes, four kills

| mutation | result |
|---|---|
| presence test `'k' in data` → `data.k !== undefined` | **10 tests fail** |
| `updateOwnPickup` coalesces `undefined` → `null` | **4 fail** |
| response echoes `parsed.value` instead of the stored row | **1 fails** |
| the empty-patch `422` guard deleted | **2 fail** |

The second probe is the one worth keeping in mind: it reports a *single-line* difference from
correct code and reproduces the original bug exactly. A probe anchored on `db/merchants.ts` alone
would have needed care — that file contains `data: { pickupAddress: … }` **twice**, in the admin
`updatePickup` and in `updateOwnPickup`, which is the trap that produced three false survivors in
the slice before this one. Each probe here asserted its anchor matched exactly once before mutating.

### What the tests assert, and the one that has to be written carefully

Eight tests in the route suite, six in the parser suite. The parser's are `toEqual` on the **whole
object**, because the absence of a key is the claim:

```
expect(parsePickupInput({ pickupAddress: '1 New Rd' })).toEqual({ pickupAddress: '1 New Rd' })
```

and `toEqual({})` is checked alongside `Object.keys(...)` — an object with a key explicitly set to
`undefined` compares oddly in enough modes that the key count is worth asserting separately. The
`''`-clears case is the one that catches a presence test written with truthiness:
`{ pickupInstructions: '' }` must come back as `{ pickupInstructions: null }` and not vanish, or a
merchant could never clear their instructions at all.

### Verified

- `npm run verify` exits **0**: **2440 pass, 0 fail, 8 skip** (167 files, 166 running + 1 skipped),
  `no residue — 9 counts unchanged`, `auditLogs 11114 → 11185 (+71)` expected.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Real Postgres, real `requireMerchant`/`requireMerchantWrite`, real Zod schema, real
  `updateOwnPickup`, real `primaryMerchantId`. The only replacement is `getSession` (the seam
  `authorize.ts` already reads through) plus the analytics `emit`.
- The first full run failed on `reports.test.ts:570` — the documented flake, not this change.
  Confirmed by running that file alone three times (12/12 each) before re-running the full suite.
- Ten new tests; the suite moves from **2438 to 2448**.

### Not done, deliberately

- **`PickupInput` is gone.** It described "both fields always present", which is the contract this
  slice disproved, and after the parser stopped returning it, nothing referenced it. It is replaced
  by `PickupPatch`. Kept as a comment in the new type's docblock rather than as dead code.
- **`updatePickup` (the admin one) still takes both fields in full.** It is a full write over a
  form that submits both, and narrowing it would be the same change for no reason. The two
  functions stay separate for the reason the previous slice recorded — sharing them would make the
  governed floor write advisory.
- **`PickupForm` was not changed.** It already posts both keys, so its behaviour is identical
  under either parser, and the eight tests include one asserting exactly that (the "shipped form"
  case) so a future rewrite can tell whether it still holds.

## FR-704's weekly digest, and FR-803's live count

Two requirements that the status board had recorded as built while nothing could
exercise them. FR-704 was the one M9 item deliberately left out; FR-803 was inside a
milestone marked complete and had no poller, no endpoint had changed, and the badge was
a server-rendered number that never moved.

### FR-704 — the three subsystems the earlier slice said it would need

The M9 section was right about the shape and wrong about the conclusion. A digest does
need a sender, a consent record and a weekly schedule; it does **not** need a new
framework for any of them. This slice built the three in the places the codebase already
had seams for:

| Piece | Where | What it reuses |
|---|---|---|
| The email sender | `lib/notify/resend-sender.ts` | `EmailSender` in `lib/notify/email-sender.ts`, the same never-throws/`SendResult` contract as `twilio-sender.ts` |
| The consent | `MerchantUser.digestOptIn` + `/merchant/settings` | The existing role-checked server-action pattern, not a new account model |
| The schedule | `vercel.json` → `/api/jobs/digest` | The existing `CRON_SECRET` bearer check, copied rather than factored so the two routes cannot share a refusal by accident |

The composition is `lib/reports/digest.ts`; the query decisions are in
`lib/db/digest.ts`; the run is `lib/reports/digest-run.ts`. The route is a thin wrapper
over the last one, because every interesting decision needs a real Postgres and a clock.

### The week is local, and the email is sent only after the provider says yes

`digestWeekFor` returns `[Monday 00:00, next Monday 00:00)` in `America/Edmonton`, built
with the same two-pass local-midnight derivation `organisers/commission.ts` uses. The
test puts a drop on each boundary and one just outside each, because `>=` and `>` are
indistinguishable across the whole fixture set until a row sits on the edge.

`DigestDelivery` has a unique key on `(merchantId, userId, weekStart)`, and a row is
written **after** a successful send. A failure leaves no row, so the next invocation
retries; the cost is that a crash between acceptance and the insert can duplicate one
email. That is the right direction for a digest: a duplicate is annoying, a missing
Monday is invisible.

### The consent predicate is both words

`merchantsForDigest` filters `role: 'OWNER'` **and** `digestOptIn: true` in one query.
The DB fixture puts a consenting MANAGER beside a non-consenting OWNER, so a query that
filtered on one and forgot the other sends to the wrong person on its first run — the
failure a merchant cannot un-receive. The action re-reads the role rather than trusting
the form: a server action is a public endpoint, and "the button was only rendered for
owners" is not a gate.

### FR-803 — one poller, not one per card

`GET /api/organiser/drops` already returns every drop with `joinedQty`, so the page
wraps the list in one `LiveProgress` provider and every badge reads through a context.
Six cards would otherwise make six requests every fifteen seconds for one answer.
`mergeLiveCounts` is pure and tested: a drop not already on the page is ignored (its
card would not have a title or a link), and a malformed count is ignored rather than
rendered as `NaN`.

The provider does **not** refresh when a drop appears or closes. A `router.refresh()`
from a polling island can replace the share form while an organiser is copying a
message; the next visit is correct because the page is `force-dynamic`, and the counts
for the drops that are still open are always current. The limitation is stated in the
component rather than hidden.

`ShareLinkControl` reads the same live count, so a message copied after a poll quotes
the number the badge shows. A page with a live badge and a stale pasted message would
be worse than no live badge at all.

### Verified

- Full suite through the pinned arm64 Node 24.21.0: **2499 tests — 2491 pass, 0 fail,
  8 skip** (174 files, 173 running + 1 skipped). One pre-existing flake
  (`reports.test.ts:570`) was observed on
  the baseline run before any change and is documented in `AGENTS.md`; it passed here.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Residue gate: `no residue — 10 counts unchanged`; the new `digestDeliveries` counter
  is what would move if a digest test forgot to delete its merchant.
- Migration `20261104234436_weekly_digest` applied; `prisma migrate status` clean.
- 51 new tests: 10 composition, 6 orchestration, 7 database (consent, delivery key,
  week filter), 10 Resend request construction, 6 route auth/wiring, 3 settings render,
  4 consent action, 5 live-count merge.

### What is not claimed

- **No email has been sent.** There is no `RESEND_API_KEY` on this machine; the first
  real send is still the first evidence, exactly as with Twilio and Stripe. The route
  reports `notConfigured` and the delivery table stays empty, so a later keyed run sends
  the same week rather than losing it.
- **No browser has driven the consent checkbox or waited for a poll.** The render test
  proves the box is checked or absent for the right role; the action test proves a
  hand-built POST is refused for a manager. The interval itself is a client `useEffect`
  and this repo has no DOM runner — the same limitation recorded for `CountPoller`.
- **No live digest was reconciled against a merchant's own Stripe balance.** The email's
  contribution figure is the reporting module's, and that module already withholds a
  drop whose ledger does not reconcile.

## FR-206 — the preview is the real page

The requirement was one line and had no implementation anywhere:

> `FR-206 | Merchant previews the real deal page | Preview renders the actual public
> page with ?preview=1` — PRD-v1.md:459

The tempting shape is a `PreviewDealPage` component beside the real one. That is the
shape that guarantees the two drift, and the merchant ends up approving a page that does
not exist. So the preview is the **public page module**, called with `?preview=1`, and
the only thing that changes is which read supplies the drop and which pieces of diner UI
render.

### The privacy boundary did not move

`getPublicDrop` still excludes `DRAFT`, and the test that every guessed code gets the
same 404 still stands. The preview is a second function, `getPreviewDrop`, whose `where`
is narrower in two ways: `status: 'DRAFT'` and `merchantId: { in: merchantIds }`. The
scope is a query predicate, not a check applied to a mapped row, so a correct code for
another merchant's draft is `null` before any price is read.

The page reaches it through `getSession` → `requireMerchantScope` → `getPreviewDrop`, in
that order. A signed-out visitor who adds `?preview=1` gets the ordinary 404 and learns
nothing; an ADMIN or ORGANISER session gets the same 404, because preview is a merchant
tool. Only `DRAFT` is previewable — a published drop is already public, and a settled one
gives the merchant no extra information.

### What the preview deliberately does not do

- **It does not poll.** The count endpoint answers 404 for a draft, so a poller would
  leave a bar that never moves. A static "0 of {minQty} orders in" is the honest preview
  of a drop with no participants.
- **It does not count a view.** `deal_page_viewed` is the denominator of join conversion;
  a merchant checking their own copy is not a prospective diner, and counting it would
  make the funnel measure the merchant's proofreading.
- **It does not count a share click**, for the same reason, and because a preview URL
  should not carry an organiser token.
- **It does not emit an OG card or allow indexing.** `generateMetadata` returns
  `{ title: 'Preview — GroupEat', robots: { index: false, follow: false } }` before the
  drop is loaded, so a draft's price cannot leak through link-preview metadata.
- **It does not offer a join.** The CTA is a disabled button with "Preview only. Publish
  this drop to open joins." — the ordinary arm would say "Joining has closed", which is
  false: the drop has never opened.

### The draft page links to it

`/merchant/drops/:id` gains a "Preview" card with `Open preview` pointing at
`/d/{publicCode}?preview=1` in a new tab. The draft still has no share link; the test
that asserted "a draft has no `/d/` URL" was corrected to assert the *absence of the
public link* rather than the absence of the string, because the preview deliberately is
a `/d/` URL.

### Verified

- Targeted suites: 65 tests across `public-drops`, the public deal page and the merchant
  drop page, all green. The public page suite moves from 27 to 32 tests.
- Full suite through pinned arm64 Node: **2555 tests — 2547 pass, 0 fail, 8 skip**
  (187 files). Residue: `no residue — 10 counts unchanged`, `auditLogs` +71 expected.
- `tsc --noEmit`, `eslint .` and a production `next build` clean.
- No browser has driven the new-tab link; the render proves the href, the banner, the
  disabled CTA and the absence of a join href.

### What this still does not solve

The preview renders a draft with a **current** dish photo and fallback menu price; a
draft has no frozen snapshot by definition, so the "was" price is the dish's current one
until publish. That is the only number on the page that can change between preview and
go-live, and it is the correct one to show: there is no other price yet.

## FR-302 — the name the group recognises

`FR-302` lists the organiser's name among the facts the deal page must show, and the page
had no field that could carry it. The reason is not an oversight in the markup: a drop
can have **many** share links, one per organiser, so "the organiser" only exists on a
visit that arrived through one of them. A direct visitor was brought by nobody.

So `resolveShareToken` now returns `organiserName` alongside the id it already returned,
and the page prints "Shared by {displayName}" only when that token resolved. A direct
visit prints no name. Inventing "GroupEat" there would name a person the diner cannot
ask a question, and naming the merchant would duplicate the line above it.

`displayName` is public by design — it is the name the organiser chose for their share
links — so this is not an FR-805 leak. Participant names and phones still have no field
to travel through.

Verified: the page suite moves from 32 to 33 tests, with the shared arm asserting the
name and the direct arm asserting its absence; the loader suite asserts the value comes
from the `OrganiserProfile` row. Full suite and gates below.

## FR-101 — the invitation is a link, not a password

> `FR-101 | Ops creates a Merchant and invites an Owner by email | Owner receives a
> set-password link valid 72h` — PRD-v1.md:442

The old path created the account with a temporary password and told the operator to
pass it on. That is a credential in a chat message, and FR-101 asks for a link instead.

### What was built

- `PasswordInvite` stores **SHA-256 of a 32-byte token**, never the token. A database
  read is not enough to take over an account. A fast hash is right here because the
  input is already 256 bits of entropy; bcrypt would stretch a value with no dictionary
  to defend against.
- `issuePasswordInvite` invalidates every earlier unused link for that account in the
  same transaction as the insert. "Send again" cannot leave two working credentials in
  two inboxes.
- `acceptPasswordInvite` claims the row with a conditional `updateMany`
  (`usedAt IS NULL AND expiresAt > now`) and writes the password in one transaction.
  A double tap or a replay gets the same refusal as a stranger with a stale link.
- [`/set-password`](</Users/bujin/WorkBuddy AI/2026-10-28-10-33-31/groupeat/src/app/set-password/page.tsx>)
  is public because the token is the credential. It renders one refusal for unknown,
  used and expired alike, and the action consumes the token. `next.config.ts` sends
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store` for the path, because a
  bearer token in a query string must not travel in a `Referer` or sit in a proxy cache.
- The admin `createMerchantAction` issues the invitation and sends it after the
  merchant transaction commits. A mail failure is caught separately and reported as
  "use the temporary password"; it must never fall through to the outer catch that
  says "email already in use" for a merchant that was just created.

### The deliberate fallback, stated plainly

The admin form still asks for a temporary password. It is the fallback for a
deployment with no `APP_URL` or no Resend key, and the action says which case happened
in its notice. The invite is the primary path; the temporary password is not removed
because a beta operator on a keyless machine still has to be able to create an owner.
That is a compromise, not a claim that FR-101's original password prompt was right.

### What is not claimed

No invitation has been delivered: there is no `RESEND_API_KEY` here. The token
service, the page, the action, the email composition and the admin wiring are tested;
the first real delivery is still the first evidence. The 72-hour window is tested at
the millisecond boundary, and a replay is tested against the real unique row.

### Verified

- 16 new tests: 6 token lifecycle, 3 email composition, 4 set-password page/action,
  3 admin action (sent, provider-refused, no-origin).
- `tsc --noEmit`, `eslint .` and a production `next build` clean.

## FR-205 — the hero the server can actually make

> `FR-205 | System generates title, description, share message, hero image | All
> editable before publish` — PRD-v1.md:459

Title, description and the share message were already generated by `plan.ts` and
written by the seller. The hero image was `heroImageUrl: null` on both draft-creation
paths and no form field to change it — a page in the one place the PRD calls the
distribution surface, with a gap where the only visual belongs.

### What the server composes, and what it does not

There is no image model in this deployment. Adding one would put an unverifiable
visual claim in front of a diner on every drop, and the PRD's own ADR-002 principle
is that the server authors what it can verify. So the fallback is deterministic:
`generatedHeroDataUri` builds a 1200×630 SVG from the merchant, the dish, the
**frozen** deal and menu prices, and the pickup window, then encodes it as a data URI.
It is a branded card, not a photograph and not AI output; it is legible, it cannot be
a broken image, and it asks for no network, no route and no cache policy.

A merchant URL wins, then the dish photo, then the generated card. The draft form now
has an optional **Hero image URL** field, seeded from the draft, so the "all editable
before publish" half is real. A merchant who leaves it blank gets the generated card.

### Why the price in the card is the frozen one

On a published drop the page already prints the snapshot's prices; the card receives
the same values. A merchant who re-prices the dish after publishing must not see the
generated hero change what the drop is selling. On a draft there is no snapshot yet,
so the card uses the current dish price — the same caveat the draft preview carries.

### Verified

- 4 new tests: 3 for the generator (content, XML escaping, truncation) and 1 page test
  proving a generated `<img>` appears with no photo and a merchant URL wins over it.
- `tsc --noEmit`, `eslint .` and a production `next build` clean.

## L5 — the nightly reconciliation, and the account dimension that was not needed

ADR-004 splits §8.7's single unsatisfiable sum into four in-process identities and one
provider-backed pair:

> L5: `Σ CHARGE + Σ REFUND + Σ card fees == connected-account balance delta`; and
> `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ application_fee`

L1–L4 had been implemented for months. L5 was the remaining one, and the schema note
had said a field naming each entry's account must be added before the nightly job.
This slice decides that it must not: under ADR-001 the mapping is total and fixed by
type — `CHARGE`/`REFUND` move the connected account, `PLATFORM_FEE`/`ADJUSTMENT` move
the platform — so a column would duplicate a function and could disagree with it. The
job derives the account once, in `l5.ts`, and the tests pin the mapping.

### What was built

- `l5.ts` is pure: entries in, balance lines in, two checks out. The card fee is an
  **input** from the balance transaction, never `cardFeeAt()` recomputed; a fee that
  changes on both sides of the identity does not create a false mismatch, and an amount
  that disagrees with Stripe does.
- `l5-port.ts` is the provider seam; `l5-real-port.ts` is the Stripe implementation.
  It lists connected balance transactions by `source` (the charge/refund ids the ledger
  already stores) and finds application fees through `applicationFees.list({ charge })`
  on the platform client. **It has never executed against Stripe** — no key here — so
  the first real run is the first evidence, exactly like the Twilio and charge ports.
- `l5-run.ts` selects a drop if an **order** or a **ledger entry** was created in the
  window. The second half is load-bearing: a refund today on a drop settled last month
  is a balance movement now, and `Order.createdAt` alone would never see it. Once
  selected, the whole drop is read.
- `/api/jobs/reconcile` reuses `CRON_SECRET`, refuses without Stripe, accepts an
  optional `?since=` for a recovery run, and reports mismatches as findings (`ok: false`)
  rather than a 500. A provider failure on one drop is reported and the run continues.
- `vercel.json` runs it daily at `09:00 UTC` — 03:00 in Alberta (UTC−6 year-round).

### What a mismatch looks like

`reconciliation.mismatch` carries the drop id, the check name, and expected/actual/
difference in cents — no account id, no email, no participant. A missing connected
account is its own reason, because "we could not check" and "we checked and it agreed"
are different answers and only one is safe.

### Verified

- 13 new tests: 5 pure identities, 1 real-Postgres run (good drop passes, a provider
  error becomes a mismatch, a missing account is reported), 7 route auth/wiring.
- `tsc --noEmit`, `eslint .` and a production `next build` clean.

### What is not claimed

No balance transaction has been read from Stripe. The provider port is a transcription
and its tests are a fake; a green L5 run here means the arithmetic and the selection
work, not that the Stripe query is right. That is the same distinction the Stripe and
Twilio live suites already carry.

## §10.2 — the north-star board

The PRD's only V1 success metric is threshold hit rate, and §10.2 asked for the board
before feature polish. It did not exist; the definitions lived in prose and in
per-merchant reports that a merchant opens after one drop. `/admin/metrics` now answers
the platform-level question: **is the mechanic working**, including the drops no
merchant would show you.

### The definitions, in one pure module

`lib/metrics/north-star.ts` takes facts and returns eight `{numerator, denominator,
value}` ratios. The page cannot invent a denominator. The choices that matter:

- **Decided** excludes `PUBLISHED` (still filling) and `CANCELLED` (a merchant decision,
  not a demand outcome).
- **Fill rate** includes `VOIDED` and `EXPIRED` authorisations and excludes `FAILED`
  cards: a voided participant did join, a declined card never did.
- **Join conversion** is `join_authorised ÷ deal_page_viewed` from the analytics sink;
  the reader returns zeros for a missing file, and the page says "Not measured yet".
- **New-customer share** is first-capture-anywhere ÷ all captures, the same classifier
  FR-702 uses, so a customer's second order is not counted as new just because it is
  in a later drop.
- **Repeat participants** are customers with ≥2 captured orders ÷ customers with ≥1.

A zero denominator is `null`, not `0%`: "no drops decided yet" and "0% hit rate" are
different facts, and the page renders both the label and `0 / 0` so an operator can tell
which one they are looking at.

### What is deliberately not there

No period selector. A month scoped by cutoff, pickup or capture is a product decision
the reports and commission statement already answer differently; adding a third answer
to the dashboard before the beta asks would be worse than an honest all-time figure.

### Verified

- 7 new tests: 3 pure definitions (including the voided/declined branch and every
  empty denominator), 2 analytics-reader cases, 2 page-render cases.
- `tsc --noEmit`, `eslint .` and a production `next build` clean.
- The DB query layer is exercised by the page test through a mocked metrics loader; its
  Prisma shape is not asserted against populated data in this slice. That is the one
  honest gap: the definitions are tested, the query that feeds them is type-checked and
  simple, and a beta dataset has not been compared against a hand count.

## Merchant staff — the role that existed but could not be attached

PRD-v1 §3.1 defines a Merchant Staff role: email and password, can scan QR and mark
redeemed, **cannot edit drops**. The schema and the redemption path understood `STAFF`;
nothing created the membership, and `requireMerchantWrite` gated impersonation but not
role — so a staff account, once attached by hand, could reach every merchant write.

### Two halves

- **The gate.** `requireMerchantWrite` now checks the caller's `MerchantUser` rows and
  refuses a session whose membership is only `STAFF`. The redemption route opts in with
  `{ allowStaff: true }`, because scanning is the one mutating merchant action staff are
  for. The opt-in is explicit so a new write route inherits the safe default without
  anyone remembering this rule. The impersonation scan's gate string became a prefix
  (`requireMerchantWrite(`), since the redemption call now takes an argument.
- **The attachment.** `/admin/merchants/:id` gains a **People** list and an
  **Add to merchant** form: an existing MERCHANT account's email plus OWNER/MANAGER/
  STAFF. `addMerchantMember` resolves the email, refuses a non-MERCHANT account and a
  second attach, and translates the unique-constraint race to the same "already a
  member" sentence. The account itself is still created on `/admin/users`, so the
  operator sees the password rules before the membership decision.

A MANAGER can run the merchant surface; the gate only singles out STAFF because that is
the role the PRD says is read/scan-only. A mixed multi-merchant account is allowed to
write if any membership is non-STAFF, which is the V1 single-merchant assumption stated
rather than a hidden rule.

### Verified

- 7 new tests: 3 on the write gate against real membership rows (staff refused, staff
  allowed for redemption, owner allowed), 4 on `addMerchantMember` (role, duplicate,
  non-MERCHANT, unknown email).
- The admin merchant page suite was corrected: it used to assert the whole page contains
  no owner/staff email, which the new People list deliberately violates; the assertion
  is now scoped to the closed impersonation control, which is the thing it was written
  for.
- `tsc --noEmit`, `eslint .` and a production `next build` clean.

### What is not claimed

No browser has driven the add-member form; the action's server-side validation and the
service's refusals are tested, and the page render proves the form exists. Staff still
have no PIN option (the PRD calls it optional), and the UI does not let an owner manage
their own people — that remains an ops task.

## §10.1 — the eight events that were never there

PRD-v1 §10.1 lists sixteen events. Eight existed. The other eight — `drop_created`,
`drop_cancelled`, `capture_succeeded`, `capture_failed`, `redemption_scanned`,
`redemption_completed`, `report_viewed`, `ai_draft_generated` — were absent from `src/`
entirely, not even in the `AnalyticsEventName` union. This stopped being a spec footnote
last slice, when the §10.2 north-star board landed and started reading the analytics sink
for its join-conversion denominator.

Two earlier sentences in this file are **history, not current state**, and stay because this
is a log, not a spec: *"Still absent from §10.1"* in the M9 section, and *"PRD §10.1 is 8
events short, not 4"* in the corrections below the M-series review. The struck-through
claim in `AGENTS.md` (§ *Definition of done*) has been corrected in place, with the three
limits that survive the fix spelled out rather than buried.

**Why the gap survived this long:** a TypeScript string-literal union cannot be enumerated
at runtime, so nothing could diff "what §10.1 asks for" against "what the code can name".
It had to be found by grepping a live 50,087-line `var/analytics/events.jsonl`.
`PRD_10_1_EVENTS` is now a runtime value holding all sixteen names, and the guard test in
`lifecycle.test.ts` maps each name to the builder that is supposed to produce it: a
`satisfies Record<(typeof PRD_10_1_EVENTS)[number], () => FunnelEvent>` literal, then a
set-equality assertion against the PRD list in both directions, then a loop calling every
builder and asserting `event === key`. The three parts catch different things, which is why
all three are there — the `satisfies` alone is a compile error for a *missing* or *extra*
name, but the keys are author-declared, so a builder filed under the wrong name still
type-checks and only the loop sees it. Both halves were checked by breaking them on purpose
(a deleted key fails `tsc`; `drop_created: () => dropCancelled(...)` compiles and fails the
loop with `expected 'drop_cancelled' to be 'drop_created'`).

What that pair does **not** prove is that any builder is called at a seam — a `record(...)`
deleted from `createDraft` leaves both files green. That is `lifecycle-wiring.test.ts`, which
drives the real paths and reads the JSONL back; the two files are separate because they fail
for different reasons. **Nothing in production reads `PRD_10_1_EVENTS` or the builder map** —
it is not a router and not an emit allowlist, and `events.ts` says so; the first draft's
comment implied otherwise and was corrected.

### One honest seam per event

- **`drop_created`** — `createDraft()`, after `prisma.drop.create` succeeds *inside* the
  `publicCode` retry loop. A code collision writes no row and emits no event.
- **`drop_cancelled`** — `cancelDrop()`, after the CAS, status, audit and void sequence.
  A refused second cancellation emits nothing.
- **`capture_succeeded`** — two mutually exclusive places, not two definitions: the normal
  `recordCapture()` CAS winner and the `repairFromExistingOrder()` CAS winner, where an
  existing `Order` row is the durable evidence of a capture whose participant row was left
  at `NONE`. Both are gated on the winning `updateMany` count.
- **`capture_failed`** — terminal provider declines only, gated on `declined.count === 1`.
  A provider-unavailable retry is not a failed card.
- **`redemption_scanned`** — once per submitted code, after the first attempt resolves and
  **outside** the retry loop, so a lost-race retry is not a second scan. It names the
  participant's own `drop.merchantId`, not `merchantIds[0]`: the scope list is ordered by
  merchant id (`requireMerchantScope`), so the old `merchantIds[0]` reported every scan by a
  two-restaurant staff account against whichever merchant sorted first — including scans of
  the other restaurant's food. A code that resolves no participant at all (`BAD_CODE`,
  `UNKNOWN_PARTICIPANT`) still counts as a scan and falls back to `merchantIds[0]`, because
  the funnel's denominator is *codes submitted*, and the number that matters at a till is
  "staff are typing codes that do not work". The scanner screen's GET health check still
  emits nothing: it runs on every visit and every session re-check and would be the loudest
  number in the metric while saying nothing.
- **`redemption_completed`** — after `claimUnits()` returns `CLAIMED`. Ids, counts and
  `partial`; never the bearer code or the customer name.
- **`report_viewed`** — the merchant reports page, after `merchantReportQuery()` returns and
  before the empty-report early return. The weekly digest assembles the same figures through
  `reportSourcesFor` + `merchantReportFor` on a schedule; an email is not a screen.
- **`ai_draft_generated`** — after `persistAuditRow()` in the deal builder, whether or not
  the audit row got an id: the proposals were still generated. `guardrailPassed` is `true`
  today because a rejected draft is never persisted; that literal mirrors the stored row.

These are state-transition facts, so a duplicate is worse than a missing one: a rate over
100% looks like a numeracy bug and hides the real defect. The wiring suite exercises second
calls, double scans, retry-like paths, repair, and two overlapping-worker CAS losses.

### What inspection found

An independent read-only review found three real defects in my first implementation. Each
was fixed and then probed:

1. **Overlapping cutoff ticks could double-report.** Both capture emissions sat outside the
   compare-and-set. `capture_failed` now requires `declined.count === 1`, and the repair path
   returns early without emitting when its `updateMany` claims zero rows. Two deterministic
   tests inject a competing worker that wins the CAS first.
2. **Provider text could abort the money loop.** `assertNoPii()` runs while the builder is
   evaluated as an argument to `record()` — **outside** `emit()`'s `try/catch`. `declineCode`
   is a plain `string` from the provider, so one `@` would have thrown mid-settlement.
   `safeDeclineCode()` reduces it to `[A-Za-z0-9_.:-]`, bounds it to 64 characters and
   falls back to `unknown`. A test feeds it `declined for diner@example.test — call the bank`.
3. **Two comments lied** about the digest's query path and about `guardrailPassed`; corrected
   rather than left as plausible-sounding prose.

A fourth defect was mine, found by the gate: the new wiring test deleted its own `auditLog`
rows in teardown to stay repeatable, which is exactly what the FR-902/FR-904 append-only
scanner exists to catch (it scans `__tests__` too). Teardown now collects failures into an
`AggregateError` instead of swallowing them and deletes no audit rows. Separately, the
`report_viewed` probe failed with `ENOENT` rather than an assertion; `sinkRows()` returns
`[]` for a missing sink, so deleting the emitter now fails for the right reason.

### Verified

- 25 new tests: 16 pure builder/registry/PII/sink identities, 8 real-seam wiring tests
  against Postgres that read the JSONL back, 1 reports-page render test.
- **9/9 emission probes killed, then 12/12** once both CAS gates and the decline-code bound
  were added after the review. Each was neutralised one at a time, its targeted test had to
  fail with a real assertion (not `ENOENT`), and every file was restored byte-identical.
  Every probe asserted its anchor matched exactly once before mutating; the
  `db/merchants.ts` two-anchor trap from the pickup slice is why that check is not optional.
- `tsc --noEmit`, `eslint .`, a production `next build`, and `npm run verify` all clean.
  New baseline with the pinned arm64 Node: **2580 tests — 2572 pass, 0 fail, 8 skip** (189
  files); residue 10 counts unchanged, `auditLogs` +73 expected growth. The first full run of
  the gate hit the known `reports.test.ts:570` wall-clock flake; 3× isolated came back 12/12
  each and the next full `verify` was green.

### The browser pass, and the two things it changed

The bullet that used to sit here said no browser had opened the reports page. One has now:
headless Chrome (`chromium_headless_shell-1217`) driven over raw CDP by Node 24's global
`WebSocket`, no new dependency, against **`next build` + `next start -p 3001`** rather than
`next dev` — because a development server answers the wrong question about prefetching, as
below. To give the page real numbers, a throwaway script wrote two drops for Beef Bowl
through the application's own builders (`buildGuardrailSnapshot`, `platformFeeCentsForOrder`,
`captureEntries`, `refundEntries`) rather than hand-typed ledger rows. Every seeded id began
`PROBE1`, all of it was removed afterwards, and `Order` went back to its pre-existing count
of zero.

**The page renders, and the event fires for a human.** Signed in through the real form
(`bob@beefbowl.ca` → `/merchant/drops`, cookie `httpOnly; SameSite=Lax; Path=/`), then
`/merchant/reports`: 54 applied CSS rules, `body` background `rgb(246, 247, 249)`, headings
`Reports` / `Across all 2 drops` / `By drop` / `How "new" is counted`, **zero**
`Runtime.exceptionThrown` and zero console errors — listeners attached before the first
navigation, so a hydration exception could not have been missed. The JSONL gained **exactly
one** `report_viewed` line per opening, measured three separate ways at +1 each: an
address-bar navigation, a `Page.reload`, and a client-side click on the nav link. The payload
is `{ merchantId, dropCount: 2, withheldDropCount: 0 }` and nothing else — five keys unioned
across every line written, no email, name or phone — and `merchantId` is
`28104432-…-d1ba03`, which is the id `MerchantUser` resolves for that session's `sub`, not
merely the id in the URL.

The text read off the page, not inferred from the render test: `Total GMV $111.20`, `Total
platform fee $7.12`, `Total contribution $32.08`, `Overall contribution % 29%`; the sold-out
row at `$66.72 / $5.34 / $24.06 / 36%` ending `Sold out at 6. Try 16 units next time.`; the
mixed row at `$44.48 / $1.78 / $8.02 / 18%` with `$22.24 went back to diners, so this drop
kept $22.24.` and `Worked. 50% of buyers were new.` Both attribution blocks read `Alice Chen
— 3 units, $33.36` / `Direct link — 3 units`, which is the organiser-plus-remainder split,
not one number standing in for both.

Two more states, because one page can be three pages. A merchant with **no** drops
(`dropCount: 0`) emits one event and renders only `Nothing to report yet.` — so an empty
report is a view, as the seam's comment claims. Deleting one `PLATFORM_FEE` ledger row moved
the same page to `dropCount: 1, withheldDropCount: 1` and made it say so in words: *"1 drop
is not shown because its figures do not agree with our payment records."*

**No JavaScript, and the event still fires.** With `Emulation.setScriptExecutionDisabled`
set before navigating, the server HTML alone carried all thirteen money strings and the same
54 CSS rules, and the sink still gained exactly one line. `report_viewed` therefore counts a
**render of the report**, which is what it claims — not a hydration.

**Failure paths, with the precondition asserted rather than assumed.** `Network.clearBrowserCookies`
first, then `Network.getCookies` read back `0` cookies, then a raw request:
`307 → /login?next=%2Fmerchant%2Freports`, the browser landing on that URL, and **zero**
events. This is the trap AGENTS.md records — a previous pass "proved" a login test against a
session it did not know it still had. An `ORGANISER` session gets a `307` to
`/change-password` (that seeded account still carries `mustChangePassword`) and emits
nothing. A `MERCHANT` account with no `MerchantUser` row answers **500**, not the page's own
"No merchant is attached to this account" text, and emits nothing.

### Two things the browser showed that the tests could not

Both are about **what the event counts**, and neither is reachable from a render test,
because both are properties of the client router rather than of the Server Component.

1. **Going Forward back to a report does not emit.** Clicking `Reports` emits +1. Then
   `history.back()` to the drop list (0, correctly a different page) and `history.forward()`
   back to the report — money sentences visible on screen, and **0** new lines. The router
   serves the report from its own cache without asking the server again. Measured twice, same
   result. So a merchant who flicks back to the report they were just reading is a view the
   sink never sees, and the event's honest description is "the report was server-rendered",
   not "a merchant opened the report". Fixing it means a client-side beacon, which is a
   different slice and a different sink.
2. **Clicking `Reports` while already on it emits +1.** A no-op to a human, a view to the
   sink. The inverse error to (1), and the same cause: the unit of measurement is a server
   render, and the router decides when those happen.

**Production prefetching is real, and it does not inflate the count — settled, not assumed.**
In a `next build` the nav link to `/merchant/reports` *is* prefetched
(`/merchant/reports?_rsc=…` with `next-router-prefetch: 1`), which is exactly the shape of
false positive that would have made the event useless. Asked for directly, that URL answers a
216-byte router payload (`{"b":…,"f":[[["",{"children":…` and writes **no** event, because
the payload has no page content. Idling on `/merchant/drops` for 15 s produced 0 lines against
10 captured requests, with the positive control that requests *were* being captured.
`next dev` disables prefetching entirely, so the same measurement against a development
server would have proved nothing while looking identical — which is why this section exists
in this form.

One incidental defect found by running `next build`: **`tsconfig.json` includes `**/*.ts`, so
a scratch `.ts` file under `var/` breaks the production build even though `eslint` ignores
`var/**` and `.gitignore` excludes it.** It failed as a type error in a seed script, not as
anything resembling the change being built. Left as a note rather than fixed: narrowing the
`include` is a build-config change nobody has asked for, and the same trap will bite the next
person who leaves a probe behind.

### What is not claimed

- **This pass reached one merchant page.** `/merchant/reports` is now measured;
  `/merchant/pickup`, `/merchant/payouts`, `/merchant/items`, `/merchant/drops`,
  `/merchant/settings` and `/organiser` still have not been opened in a browser by this
  slice, and the earlier pass's unproven list stands as it was. A live join and capture also
  remain unproven: there is no `STRIPE_SECRET_KEY` here.
- **Nothing was measured through a CDN or a real device.** Everything above is loopback
  HTTP, desktop viewport, one browser build. NFR-02's 360px claim and any edge-cache
  behaviour of a `dynamic = 'force-dynamic'` page are untouched by it.
- **A capture committed but not reported stays unreported.** `recordCapture()` writes the
  `Order`, the ledger rows and `chargeStatus = 'CAPTURED'` in one transaction; the analytics
  append happens after it, outside. A worker dying in that window leaves `CAPTURED`, which
  the next tick skips, and a local file cannot replay the event. Closing it needs a durable
  "reported" flag written inside the same transaction — a storage change, not an analytics
  one. `repairFromExistingOrder()` is **not** a replay of this window; the test fixture builds
  §4.2's lost-write state directly, and its comment says so.
- **The sink is a local JSONL file** under gitignored `var/`. `vercel.json` schedules the
  cutoff and digest jobs; nothing in the deployment docs addresses where those events go on a
  serverless filesystem. A production deployment that needs these counts needs a durable sink
  first.
- **No live Stripe capture has happened here** (no `STRIPE_SECRET_KEY`, no `stripe-mock`), so
  `capture_*` are proven against a fake `ChargePort` only. A green suite is not payment
  verification.
- ~~`reports.test.ts:570` remains a wall-clock fixture flake~~ — **fixed**, in the fixture, and
  `reports.ts` was not touched. See *The flake that was a fixture telling time* below.

### The flake that was a fixture telling time

`reports.test.ts:570` (`expected 2 to be 1`) was observed failing on a full run **three times**
— once in the reports slice, once in the analytics slice, and once on an independent gate run
of `5b7d78a` — always passing when its file ran alone, and never reproducing on demand. A
failure you cannot summon is worse than a red test, because the habit it teaches is "run it
again".

The classifier is right and was left alone. `reports.ts:333` counts a prior purchase as one
captured **strictly** before `participant.createdAt`, and `<` is the only correct comparison: a
capture in the same millisecond as the join is that join's own charge, so including it would
report every first-time buyer as their own previous customer. What was wrong was the fixture
that fed it. `makeCapturedParticipant` omitted `createdAt` from both the `DropParticipant` and
the `Order`, so the database stamped them from the wall clock — and `createdAt` is
`TIMESTAMP(3)`, so two statements issued microseconds apart could land on one millisecond. When
drop 1's `Order.createdAt` tied with drop 2's `DropParticipant.createdAt`, a purchase that
genuinely happened first was not counted as prior, Ada read as **new** on drop 2, and the row
said 2 new instead of 1 new + 1 returning.

That tie was not rare. A probe replaying the fixture's exact insert sequence 200 times — the
same six statements per participant, `createdAt` left to the database — found the two compared
instants identical in **88 of 200 trials (44%)**, with the gap never exceeding 2 ms. The reason
the suite did not fail at anything like that rate is that the tied pair only matters for a
customer who appears on two drops, and only one test builds that shape.

Reproduced before touching the fix, by writing the tie by hand: two customers, Ada on both
drops, Bo on the second, every row at one instant, and `row2.customerMix` came back
`{"newCustomers":2,"returningCustomers":0}`. The same scenario with instants days apart came
back `{"newCustomers":1,"returningCustomers":1}`. That is the mechanism, confirmed rather than
inferred, and it also confirms the brief's description was exact.

The fix is `at?: Date` on `makeCapturedParticipant`, applied to **both** rows, with the
successive-drops test passing `2026-01-05`, `2026-01-12`, `2026-01-19` — the three drop windows
it was already using for `windowStart`, a week apart, which is the story the test was always
telling. Omitted, `at` falls back to the wall clock, so the other seven tests that use the
fixture are untouched: with `@@unique([dropId, customerId])` a customer appears once per drop,
so there is no second row to be ordered against.

Verified in the direction that matters — by breaking it again. Setting the three drops back to
one instant failed deterministically with the exact reported message,
`expected 2 to be 1 // Object.is equality`. Post-fix: **8/8 isolated runs** (12 passed each) and
**8/8 full-suite runs** at **2579 passed, 8 skipped**, zero failures, identical every time. The
count is the same as before this commit because the diff adds no assertions and no tests — it
changes only what time the fixture claims, which is the point: the fix is to the fact being fed
to the classifier, not to the assertion that reads it.

This is the third instance of one class in this repo, and the first one closed rather than
recorded. `providerSeq` and `phoneSeq` were the earlier two — ids built from `Date.now()` — and
`AGENTS.md` states the rule they produced: *a wall clock is not a sequence*. The reports fixture
had one more place where a timestamp was standing in for an ordering, and the reason it survived
so long is that the symptom appeared in a different file from its cause, on a test whose subject
was money rather than time.
