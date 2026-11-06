# GroupEat — standing instructions for agents

GroupEat is a batch-order engine with a margin guardrail: a merchant publishes a
dated drop, diners join by authorising a card, capture happens only at the cutoff
and only if the minimum is met. One Next.js 15 app, Prisma/Postgres, Stripe
Connect direct charges.

## Start every session here

1. Read `docs/PROGRESS.md`. It is the only status board; the next unchecked slice
   is the work.
2. Read `git log --oneline -15`. Each commit message is a design note that says
   **why**, including the defects that were found by looking at rendered output.
3. Work on `sprint-2/payments-fee-bearer`, which is 20 commits ahead of `master`.
   Do not branch from `master`; it predates M3–M6.
4. Read before writing money or copy code: `CONTRIBUTING.md`,
   `docs/ADR-001…005`, `docs/PRD-v1.md` §6/§8/§15, and `docs/M5-cutoff-design.md`
   where it applies. ADRs supersede the PRD where they say so, and that is not
   up for re-litigation in a feature slice.

## Environment facts that cost hours

The shell runs under Rosetta and `node` on PATH is an **x64** build, while
`node_modules` contains **arm64** native binaries. The documented trap:

- `npm test` → `Cannot find module '@rollup/rollup-darwin-x64'`.
- Working command, arm64 Node 24.21:
  `~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run`
- `npx tsc --noEmit` and `npx eslint .` are clean at HEAD.
- **`npx next build` is the same trap as `npm test`.** Under the PATH x64 Node it
  fails in the CSS pipeline with `Cannot find module
  '../lightningcss.darwin-x64.node'`, because `node_modules` has the arm64 native
  binary. Build with the pinned interpreter:
  `~/.nvm/versions/node/v24.21.0/bin/node node_modules/next/dist/bin/next build`.
  The failure looks like a missing dependency and is not one; do not `npm install`
  to "fix" it.
- Postgres must be running (`pg_isready`); the dev DB is `groupeat_dev`.
- No server runs by default. `npm run dev` serves on **:3001**.
- Full suite baseline: **2555 tests — 2547 pass, 0 fail, 8 skip** (187 files, 186
  running + 1 skipped). **One known
  flake, mechanism identified:** `reports.test.ts:570` can fail about one full run in several,
  because the fixture relies on two wall-clock `createdAt` reads landing in different
  milliseconds and FR-702's classifier uses a strict `instant < joinedAt`. It passes alone
  (12/12, three consecutive runs) and passed two consecutive full runs. If it fails, re-run
  before believing it; the fix is
  explicit `createdAt` values in the fixture, not a change to `reports.ts`. This is the third
  instance of the class that produced `providerSeq` and `phoneSeq`. Green on
  **Node 24.21.0 (`tzdata 2026c`) only.** This line used to claim it was green
  under PATH Node 22.22 (`tzdata 2025c`) as well; re-running it during gap 15
  showed that is false — exactly one test fails there (`shareMessageFor`,
  `Thursday 5:00 PM` vs the stale-rule `4:00 PM`). `.nvmrc` pins 24.21.0 and
  `engines` floors at `>=24.0.0` for that reason. If a time-related test starts
  failing, check the Node/tzdata version before touching the code under test:
  **Alberta adopted permanent DST on 2026-11-01** and is UTC−6 year-round, so any
  winter expectation hard-coded before that date is stale, not evidence of a bug.
  Do not "fix" `plan.ts` to match an old tzdata.
  **Corrected in the `admin-users-cap` slice: it is two tests, not one.** Running
  `npm run verify` under PATH `node` (22.22.2, tzdata 2025c) failed
  `share-link.test.ts` **and** `merchant/pickup/__tests__/page.test.ts`
  (`formats the window in the merchant's zone`, which reads Edmonton as UTC−7 and
  so finds a collision that does not exist). Both were reproduced on clean `e58f076`,
  so both are the tzdata difference and neither is the D2 change. Measured directly:
  `Intl.DateTimeFormat(...{timeZone:'America/Edmonton'}).format('2026-11-05T23:00Z')`
  is `Thursday 5:00 p.m.` on 24.21.0/2026c and `Thursday 4:00 p.m.` on 22.22.2/2025c.
  The lesson is the one this file already states, with a second witness: **`npm run
  verify` does not pin the interpreter.** It runs whatever `node` is on `PATH`, so
  the gate can fail for a reason that has nothing to do with the change. Invoke the
  suite through the nvm binary directly, and treat a time-shaped failure as a
  toolchain question first.
  **Enforced since the `check-interpreter` slice: `npm run verify` now self-checks
  before it runs a test.** The gate is the **offset**, not the version string. It
  asserts the behaviour the suite depends on: `TZ=America/Edmonton` and
  `2026-11-02T12:00:00Z` must resolve to UTC−6 (`getTimezoneOffset() === 360`, six
  hours behind). On a stale interpreter the gate stops at the preflight with the
  runtime, its `tzdata`, the observed offset and the fix, instead of spending an hour
  on five red tests that are all correct — which is what happened to two of us.
  `v24.15.0` is the case a version check would miss: it satisfies `engines` and still
  ships `tzdata 2026a`, which fails the offset assertion.
  **Fatal:** a wrong offset by either probe; a version below `engines.node`
  (`>=24.0.0`, a real Prisma 6 / Next 15 compatibility claim the offset probe cannot
  see). **Advisory only:** a version that differs from `.nvmrc` while the offset is
  correct — it prints a drift note on stdout and exits 0, so a newer correct
  interpreter such as `24.22.1` (tzdata `2026e`) passes and invites a `.nvmrc` update
  rather than blocking. An exact pin would refuse a correct interpreter, which trades
  one false answer for another. `scripts/check-interpreter.mjs` explains both choices.
  `npm test` is deliberately *not* gated — a fast run with no preflight is useful, and
  the asymmetry is a choice, not an oversight.
  `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" npm run verify` is the gate.
- The 8 skips are all Stripe-dependent: 1 in `fee-bearer.live.test.ts`, 2 in
  `real-charge-port.live.test.ts` (the whole file), and 5 in
  `real-payment-port.contract.test.ts` when `stripe-mock` is not running. No
  `STRIPE_SECRET_KEY` exists here, so **payments have never been verified against
  Stripe test mode**. A green suite is not payment verification.
- **Test fixtures must write values the product can actually produce.** The
  `public-code-normalisation` slice found `settlementFixtures().drop()` writing
  `JOIN-SVC-17938293169981` — hyphens, 21 characters — because it just uppercased the
  file prefix. Harmless while lookups used the raw segment; it broke **17 join tests**
  the moment the diner-facing reads began normalising the code, because
  `normalisePublicCode` strips hyphens, so a stored `JOIN-SVC-…` was looked up as
  `JOINSVC…` and every join answered `NOT_FOUND` for a drop that plainly existed. The
  fixture now hashes the whole prefix into the generator's alphabet and emits 8
  characters (`fixturePublicCode`). If you add a fixture for a column the product
  writes through one generator, **call the generator's contract**, not a convenient
  string — a fixture that cannot exist is a test that cannot fail for the right reason.
- **A file-convention metadata route is keyed on the DIRECTORY, not the page.** The
  `notFound-card` slice found `/d/:code/join` shipping
  `og:image: http://localhost:3000/…` on a *healthy* drop, months after the deal page's
  card was fixed. `d/[publicCode]/opengraph-image.tsx` is collected per segment, so
  **every** page in that segment gets `og:image` autofilled unless its own metadata
  object owns an `images` key. D1 fixed the one page it was looking at. When you touch
  metadata in a route segment, check every page under that folder, and check the
  `not-found` path too — it is a different module (see the next line).
- **`notFound()` discards the page's metadata.** Next re-resolves with
  `errorConvention: 'not-found'` and reads a segment's `not-found.tsx` as the *deepest*
  metadata item. Suppression written in `page.tsx`, in a segment `layout.tsx`, or in the
  root `layout.tsx` does **not** reach the 404 — all three were measured and reverted
  before `d/[publicCode]/not-found.tsx` worked. The tell that the page module was never
  consulted: the 404's `<title>` was the root layout's `GroupEat`.
- **`openGraph: {}` and `openGraph: { images: [] }` are different bugs.** `mergeStaticMetadata`
  autofills the convention card only when the metadata item has no `openGraph` object at
  all *or* one with `images`. So an empty object **suppresses** the card. When the fix is
  "suppress on misconfiguration", spread the key in conditionally; when the fix is "leave
  it alone", the key must be absent. Assert `toBeUndefined()`, not
  `not.toHaveProperty('images')` — the latter passes for an empty object, which is the
  regression that deleted FR-308's card on a healthy deployment for one build.
- **`notFound()` renders an EMPTY BODY with JavaScript disabled, and that is Next's
  behaviour, not a bug here.** Reproduced in a minimal app on 15.5.28, 15.5.29 and
  16.4.5; `getErrorRSCPayload()` seeds `<html id="__next_error__"><body/></html>`
  unconditionally in production and the copy exists only in the `self.__next_f` flight
  payload. Do not spend another session trying to fix it: `experimental.globalNotFound`,
  `htmlLimitedBots`, `force-static`, inline JSX (returns HTTP 200), `notFound()` inside
  `generateMetadata` (swallowed), and middleware rewrite (needs a DB call) were all
  measured. PPR would work and is canary-only on 15.5. Correct status, no body — accepted
  and recorded in `docs/PROGRESS.md`.
- `real-payment-port.contract.test.ts` **does** execute the real join port, against
  `stripe-mock`, through the real SDK. Run it with
  `stripe-mock -http-port 12111 &` first; it skips 5 tests with a reason without it.
  It proves the request is one Stripe would accept. It cannot prove a successful
  authorisation: stripe-mock always returns `requires_payment_method`, so the
  `requires_capture` branch stays unexercised. Do not cite it as "join works".
- `__setStripeClientForTests` takes a **`Stripe.StripeConfig`**, not a client. It
  previously replaced only `platform()`, leaving `forMerchant()` to reach the live
  API; that is fixed, and the seam now applies to both paths.

## Rendering a page in the suite

`src/lib/testing/render.ts` renders a **server component** without a browser:
`renderToHtml(await page({ searchParams }))`, then assert with `textOf` / `hrefsOf`.
It needs `esbuild: { jsx: 'automatic' }` in `vitest.config.ts`, and it still runs
under `environment: 'node'` with no `.tsx` test files — the page is an async
function returning an element tree, so calling and serialising it executes every
branch. `/commission` (15 tests), `/admin/commission` (20), `/admin/drops` (16),
`/admin/drops/[id]` (20), `/admin/ai-drafts` and its detail page (20 — one suite, because
its central claim spans both), `/admin/users` (17), `/organiser` (20) are covered this way
against real Postgres.

**As of gap 12(n), every one of the app's twenty-four pages is rendered by a suite.** Do not
take that sentence on trust — it was written wrongly three times before it became true — count
it:

```
find src/app -name page.tsx | sed 's#/page.tsx##' | grep -v '^src/app$' | sort > /tmp/have
find src/app -name 'page.test.ts' | sed 's#/__tests__/page.test.ts##' | sort > /tmp/done
comm -23 /tmp/have /tmp/done
```

That reported **sixteen** paths before gap 12(n) and reports **four** now, every one of them
covered inside a parent's suite because the claim spans both pages:

| Reported path | Actually rendered by |
|---|---|
| `(admin)/admin/ai-drafts/[id]` | `(admin)/admin/ai-drafts/__tests__/page.test.ts` |
| `(merchant)/merchant/drops/new/ai` | `(merchant)/merchant/drops/new/__tests__/page.test.ts` |
| `(merchant)/merchant/items/[id]` | `(merchant)/merchant/items/__tests__/edit-page.test.ts` |
| `(merchant)/merchant/items/new` | same file — it renders both modes |

A path-to-file comparison cannot see a dynamic `await import('…/page')`, so **read the output
rather than trusting the count.** Zero is the number that would mean a page is untested; four
is the number that means the naming is inconsistent. (This paragraph first said "ten" and
"eight `(merchant)/*` pages"; both were guesses. Then it said "the other sixteen", then "the
remaining five" for four consecutive slices, and just now I wrote "should report one" without
running it. The command is two lines long. Run it, then read it.)

The admin/organiser set went first because the deferred UI obligations named it. "The ones
that mattered" then quietly became "every page" in three separate sentences before I
checked, which is the same shape of unchecked claim as gap 12(d)'s `useState` note.

**`/admin/users` was recorded here as browser-only, and that was wrong.** It is a plain
server component; the three forms it mounts are `'use client'` and use `useActionState`,
which renders — only `useRouter` blocks a render, because it throws without a context.
The correction matters beyond one page: "genuinely needs a browser" had been written down
as a reason to skip it in four places, and it was never checked. Check the component for
`useRouter` before declaring a page unrenderable; `useState` alone is not a blocker, it
just means the render shows the initial branch.

**A client component using `useActionState()` needs a `Suspense` boundary, and the boundary
changes the failure mode of every other suite.** `renderToHtml` now wraps the element in
`<Suspense fallback={null}>` because a bare `useActionState` throws `Cannot read properties of
null (reading 'useActionState')` — probed on `/change-password`. But a boundary turns a
*recoverable* error into **markup**: React emits `<!--$!--><template data-msg="Switched to
client rendering because the server rendering errored: …">` and the stream completes normally.
So `rejects.toThrow(…)` stops rejecting and `expect(html).not.toContain(…)` starts passing on a
page that rendered nothing. `renderToHtml` therefore collects `onError` and **rethrows after
the drain**; if you ever "simplify" that away, the whole suite stays green while measuring
nothing. Caught once, by `/admin/drops`' guard test. Also: call a client-component page with
`createElement(Page)`, not `Page()` — the eager call runs the hook body before any boundary
exists.

**If the page reads `useSearchParams()`, use `renderWithSearchParams`, and mock
`next/navigation` with `importOriginal`.** Without `SearchParamsContext` the hook *suspends*
and the output is the nearest `<Suspense>` fallback — a `<template data-msg="Switched to client
rendering">` where the form should be. And a `vi.mock('next/navigation', () => ({ redirect }))`
replaces the **whole module**, so `useSearchParams` ceases to exist and the same fallback
appears with a different message. Both were hit on `/login`; both failures read like a broken
page rather than a broken harness.

**If the page mounts a client component that calls `useRouter()`, you must use
`renderWithRouter`, not `renderToHtml`.** `next/navigation` throws *"expected app
router to be mounted"* when `AppRouterContext` is absent, and the throw happens inside
the client component, so the page renders nothing at all. `renderWithRouter` supplies
the real context Next supplies (the stub is an `AppRouterInstance`, the component is
not stubbed) and returns `{ html, router }`, where `router.refreshes` counts
`refresh()` calls. A test in the `/admin/drops` suite asserts the invariant, so
"simplifying" back to `renderToHtml` fails loudly rather than mysteriously.

Eight rules, each learned by breaking them:

- **Use `renderWithRouter` for any page mounting a router-using client component.**
  `ForceFailControl`, `ParticipantRefundControl`, `CancelDropButton` and `CountPoller`
  all call `useRouter()`, which throws `expected app router to be mounted` without a
  context — inside the component, so the page writes nothing. The failure reads like a
  broken page rather than a missing test fixture.
- **Assert words, not JSX.** `textOf` strips comments before tags because React
  emits `<!-- -->` between adjacent text nodes; without that, `(nonsense)` reads as
  `( nonsense)` and `5.00%` as `5.00 %`. `hrefsOf` decodes `&amp;`, because React
  escapes `&` in attributes and a two-parameter URL otherwise comes back escaped.
- **`toContain` cannot tell you which cell it found.** A figure that appears in a
  row *and* a footer passes a `toContain` assertion even when the footer computes it
  differently. Count occurrences when the assertion is about a total.
- **`toContain` also cannot tell you which row it found.** A table with the right
  names against the wrong figures renders perfectly and pays the wrong person. Use
  `cellsOf(html, name)` (in the `/admin/commission` test) to assert a name and a
  figure *on the same row or not at all* — and read each cell through `textOf`,
  because the row's raw HTML contains `5.00<!-- -->%`.
- **`colSpan` changes the footer's cell count.** `Total` spanning Organiser + Rate
  leaves four cells, not five. Assert `toHaveLength(n)` so the next markup change
  fails loudly instead of shifting every index by one.

- **It proves what renders, not what responds.** Client components are not
  hydrated: `onClick` is inert and a `useState` branch shows its initial value. Do
  not cite these tests as covering interaction, and do not write one for a form
  whose behaviour is entirely in `useState` and expect it to mean anything.
- **`useActionState` is always at its initial state in a render**, which is subtler than
  the `useState` case above and bites in a different place. `/organiser` renders
  `state.token ?? existingToken`; probe M deleted the `state.token` half and eighteen
  tests stayed green, because nothing that renders can set it — the token only arrives
  through a submitted action. Any code on the *far* side of an action's return value is
  unreachable from a render, including the error sentence after a refusal. Recognise the
  shape: a value that is `INITIAL` until an event, consumed by a `??` or a ternary.
- **A fixture the schema permits is not a state the code writes.** `PUBLISHED` with a
  `CAPTURED` participant seeds fine and renders — but capture happens after the cutoff,
  so that pair never occurs in production and the page will print nonsense for a drop
  that has not begun to capture. Before seeding a state, find the writer: `settle.ts`,
  `forceFailDrop`, `cancelDrop`. If none of them produces your row, you are testing a
  system that does not exist. This cost six wrong assertions in gap 12(b).
- **Assert both arms of a ternary.** A `?:` where only the taken arm is exercised has
  had half its line tested. Probe J in gap 12(b) deleted the `: 'none refundable'`
  branch and nineteen tests stayed green.
- **`not.toBe(x)` is not an assertion about what happened.** It is satisfied by every
  other wrong answer, including the one you are hunting. In gap 16, three tests guarded a
  history-mapping switch with `expect(reason.kind).not.toBe('merchant-record')`; deleting
  the `category === null` guard and mapping `PUBLISHED` to a miss both left the suite
  green, because in each case the *score* moved while the *reason* fell through to the
  arm the assertion allowed. The repair is always the same: compare against a control
  that differs in exactly one input (`expect(nullCategory.score).toBe(noHistory.score)`)
  rather than asserting a negative about a proxy.
- **A comment in a test claiming coverage is not coverage.** The same gap-16 test said
  "plus PUBLISHED" in its docblock and its loop only created `CANCELLED` rows. The
  mutation probe is what found it; reading the test would not have. When a docblock lists
  cases, count them against the fixture.
- **Your assertion is as capable of being wrong as the code.** Two gap-16 assertions were
  mine: I expected a 75% fill rate for a 3-of-4 record (the blend makes it 63%) and
  expected an `organiser-record` reason where only a `merchant-record` was reachable.
  Both were corrected by the failure, and both corrections are in the comments. Record
  the wrong expectation — it is evidence about how easy the right one is to guess.

When you write page fixtures, **pick prices at which two plausible implementations
disagree** — 1250 cents at 5% is 62.5, so two lines give 126 while the rate applied
to their sum gives 125. With round prices every "the two screens agree" assertion
becomes a coincidence, and the mutation you write to check it will pass. This has
now been got wrong twice in a row; see gap 12(g) in `docs/PROGRESS.md`.

And **never write a test with an early return when the fixture is wrong.** Three
tests in this milestone passed while asserting nothing, all with the same shape: a
guard (`if (!empty) return`, `catch(() => null)`, `.catch(() => undefined)`) that
turned the case where the fixture did not hold into a green test. If a test cannot
reach its assertion, that is a failure — assert the fixture's premise first (`expect
(counts.DRAFT).toBe(0)`) so the precondition is checked rather than assumed.

### Probing an assertion

Every slice mutates the production code to confirm each new assertion is load-bearing.
Two ways that goes wrong, both of which produce a green probe that means nothing:

- **The mutation has to change something the assertion can see.** Swapping
  `className="foo"` for `className="hidden"` was tried twice in gap 12(c) and passed
  both times: `hidden` is a visual affordance, the text is still in the HTML, and the
  suite reads text. Change the *copy* or delete the element, not its styling. Before
  calling a probe green, reread the mutation and ask what the assertion observes.
- **A pattern that does not match applies nothing and reports PASSES.** Two probes in
  this milestone silently no-opped: one from wrong indentation, one from a
  type-invalid shape Prisma rejects. Assert the file actually changed before running
  the suite, and treat "no tests failed" as suspicious until you have seen the diff.
- **A pattern that matches *twice* mutates both sites, so the kill proves nothing about
  either.** Probe G in gap 12(h) targeted
  `where: { merchantId: { in: [...merchantIds] }, archivedAt: null },`, which appears in
  `listItems` and again in `highestMenuPriceCents`. Had the suite gone red, it would not
  have told me which function the assertion guards — the same defect as an assertion that
  cannot distinguish the cases it claims, one step earlier in the process. Anchor the
  mutation on a line unique to the target, here by including the `findMany` opening. Count
  the matches before you run: `grep -c` the pattern, and if the number is greater than one,
  widen the anchor until it is not.

When a probe genuinely passes, the finding is about the suite, not the code — but it
is only a finding if you can name the case that nothing renders. Probe O in gap 12(c)
passed because `/admin/ai-drafts/[id]` was never rendered for an *orphaned* draft;
probes H and J passed because the mutation was invisible. Reporting the second kind as
"the assertion is weak" would have been wrong.

- **Before sharpening an assertion, check the mutation is reachable at all.** Probe B in
  gap 14 survived because the mutated `??` arm was dead: `item.merchantId` is a foreign
  key, so the "merchant is missing" branch could not run from any fixture. No assertion
  can observe a branch no test can enter, and the fix was to delete the redundant
  variable rather than add another `expect`. This is the third failure mode and the most
  expensive one to spot, because the instinct — write a tighter assertion — is right
  everywhere else. Ask first: *can any fixture make this code produce a different value?*
  If not, the defect is the unreachable code, not the test.
- **Before concluding an assertion is weak, count the states your fixtures cover.** Probe E
  in gap 12(i) changed `{review.refusals.length > 0 ? (` to `{true ? (` and 14/14 stayed
  green. Nothing was wrong with the assertion — every draft fixture refused something, so the
  "a draft that passes review" branch had never been rendered at all. One clean fixture made
  the probe kill the new test on its first run. This is cheaper to check than the
  reachability question above and catches the same shape of defect: list the branches the
  render can take, then list the fixtures, and see which branches have no row. A page whose
  fixtures are all the sad path is a page whose happy path is unverified.
- **An assertion comparing two rendered cards compares their names, not their meaning.**
  Gap 12(h) asserted `textFor(html, dish.alcohol)` was `not.toBe`
  `textFor(html, dish.notBatchable)` to prove the two `Blocked` dishes were blocked for
  different reasons. It could not fail:
  each card prints its own dish name, so the texts differ whatever the badge says, and a
  page printing one fixed sentence for every blocked dish passes it. The claim was about a
  reason sentence the page does not contain. Two rules follow. Compare the *fragment* that
  carries the claim, not the whole card — and if there is no such fragment, the claim
  belongs to the module that produces it, not to the render test. Before deleting a
  "redundant" assertion like this, re-run the probe it was supposed to catch and confirm
  something else still dies; here probe A still failed the same test on the two
  `toContain('Blocked')` lines.
- **`text` cannot see an href, so a claim about a button is a claim about its destination.**
  Gap 12(j) had a test named "…instead of a dead new-drop button" that asserted only the
  label: `Add a dish first` present, `New drop` absent. A page that reworded the button but
  left the `href` on `/merchant/drops/new` passes that and is still the dead end the branch
  exists to prevent. **A destructured `html` that no assertion uses is the tell** — `eslint`'s
  `no-unused-vars` caught it here. When a render test asserts what a link *says*, write the
  second half: assert its `href`, and assert the *other* branch's `href` is absent, in both
  tests. Swapping two destinations should fail twice.
- **When the claim is "this must not write", assert the call, not the output.** Gap 12(l)'s
  page reads on an ordinary GET and syncs only on `?state=return|refresh`, because "a page
  that flips `Merchant.status` on every anonymous GET makes a status change impossible to
  attribute later". Both paths render **byte-identical HTML** for a ready merchant, so an
  output assertion passes on the page that writes every time — the exact regression the rule
  exists to prevent. Mock the I/O boundary, record the calls, and assert the sequence. This
  is not a weaker kind of test; it is the only reachable form of that claim. Keep the layer
  *behind* the mock real (here: `assessOnboarding` and `onboardingMessage`), or the suite ends
  up asserting its own fixtures. `vi.mock` is hoisted, so closure state must come from
  `vi.hoisted`.
- **A `toContain` on a sorted list asserts membership, not order.** Deleting `.sort()` from
  `collectOutstanding` left all 20 payouts tests green, because both names were present
  either way. Same for deduplication — count the occurrences rather than asserting one is
  there. If the claim is that the order is stable across polls, compare indexes and write the
  fixture in the *opposite* order to the sort.
- **A fixture that cannot tell two queries apart is not evidence that either one is right.**
  Gap 12(m)'s probe swapped `highestMenuPriceCents` for `items[0]` and **survived**: the
  `pricier` fixture's expensive dish happened to sort first, so "the first row" and "the
  highest price" were the same dish. Renaming the cheap dish so it sorted first made the same
  probe kill. Two corollaries. First, when a page has a documented fallback constant, no
  fixture whose value *equals* that constant can test the lookup — `ids.full`'s four dishes
  were all $16.00, which is the no-dishes default, so a hardcoded `1600` printed the same
  sentence. Second, **a guard written twice** is decided by branch order, and the unreachable
  copy is dead code that reads like protection: `ImpersonateControl` had `if (!open)` above
  `if (owners.length === 0)`, so a manager-only merchant got a live button whose only outcome
  was the message the guard existed to show instead. If a docblock says a component "renders a
  sentence rather than a control that would fail", render the fixture that should show it.
- **A guard that only rejects the tricks you thought of is not a guard.** `safeNext`, the login
  open-redirect check, tested `startsWith('//')` and forwarded `/\evil.example` — one leading
  slash, so "a path" — which `new URL()` resolves to `https://evil.example`, because the URL
  spec normalises `\` to `/`. It had **no test anywhere in the repo**, which is why it looked
  fine for four months. Any value that becomes a `redirect()` target must be checked by asking
  the **URL parser** what it resolves to and comparing origins, never by matching characters.
  Corollary: a security function with no test is a function nobody has seen work, and the
  absence does not show up in coverage numbers because the branch is executed — just never
  with a hostile input.
- **A shared component that renders an id without wiring it is a bug at every call site.** `Field`
  emitted `<p id="{id}-error">` and `<p id="{id}-helper">` and left the caller's `<input>`
  untouched, so on 51 of 52 usages the error sentence sat in the DOM, adjacent and unread by a
  screen reader. Found by a probe surviving, not by reading. Fix accessibility wiring in the
  component with `cloneElement` and **extend** any caller-supplied `aria-describedby` rather
  than replacing it — 52 call sites is 52 chances to forget.
- **A surviving probe is either a fixture gap or an equivalent mutant, and you must decide
  which.** Three genuine gaps this slice: no fixture with `qty: 1` (so the `plate`/`plates`
  ternary was never read), a label printed twice (document-wide `toContain` satisfied by
  whichever copy was right — fourth time in this repo), and a forged token malformed in three
  ways at once (so skipping signature verification changed nothing). Two equivalent mutants:
  `next.startsWith('//')` is redundant against the URL check that follows, and
  `change-password`'s `state.field === null` branch is unreachable because the only no-field
  failure implies a user row that `getSession` already proved exists. **Write the reason next
  to the code**; a survivor and an untested line are indistinguishable to the next reader.
- **"Does nothing" is a claim about the whole table, not about the rows your suite owns.** Two
  `did-nothing` tests in gap 19 asserted that `port.calls` was empty and that *their* merchant
  had not moved. Both passed a mutant that wrote `prisma.merchant.update({ data: { status:
  'SUSPENDED' } })` in the `default:` arm — no port call at all, and `prisma.merchant.findFirst()`
  has no ORDER BY, so the write landed on a merchant the suite had never looked at. Snapshot
  every row and diff it (96 rows, ~2 ms — cheaper than the argument about scoping), and add a
  **log assertion** as the second net, because a sync that changes no state leaves the diff
  empty and still cannot be allowed to be silent.
- **A prefix mutant needs a prefix collision, and the collision must name a row the mutant can
  resolve.** Gap 19's first fixture for "an event type we do not handle" used
  `capability.updated`; a `switch (true)` on `event.type.startsWith('account.')` survived it,
  because `capability.updated` does not start with `account.` — the mutant took the *unhandled*
  arm and behaved exactly like production. And once the fixture used
  `account.external_account.updated`, the mutant still survived, because the handled branch
  reads `event.data.object.id` and the fixture stored the account id in the top-level `account`
  field: no merchant resolved, same `break`. **A mutant that cannot reach the code under test
  is indistinguishable from one that was caught**, and this was the third time in one slice.
- **A mutation harness that can write to shared fixtures will manufacture false survivors.** Gap
  19's sweep wrote `SUSPENDED` onto a real seeded merchant (`sl1793738360169`), then ran the
  next mutant without restoring it — so the following probe took its baseline from an
  already-changed row and a **load-bearing** mutation reported clean. Restore what each mutant
  changed, from a snapshot taken before it ran, in the harness. A survivor is the one signal a
  sweep exists to produce; a harness that can invent them is worse than no sweep.
- **`vi.hoisted` for anything a `vi.mock` factory closes over.** Mutable shared state read on
  both sides — here a fake port's `snapshots` map and its `calls` log — must be declared with
  `vi.hoisted`, because `vi.mock` is lifted above the plain `const`s in the file and a factory
  closing over one throws "Cannot access before initialization" while the graph is built.
- **When a guard duplicates a rule one layer down, only its *ordering* is testable.** The
  `/intent` route checks `qty` and then `quoteJoin` checks it again. Deleting the route's copy
  changes nothing on its own: `quoteJoin` runs `checkQty` **before** `refusalFromBlocked`, so
  even "bad quantity on a cancelled drop" answers `422 BAD_QTY` either way, and two fixtures
  died on that. The only observable difference is the route's **configuration gate**, which
  sits between the two guards — so `qty: 0` on an unconfigured deployment is `422 BAD_QTY` with
  the guard and `503 PAYMENTS_NOT_CONFIGURED` without it. Find the neighbouring branch, then
  put the fixture on the boundary. Expect to be wrong twice before you find it.
- **A query filtered narrower than the page's visibility set makes everything below it dead.**
  `quoteJoin` selected `status: { in: ['PUBLISHED'] }` while `/d/:code` and the join page both
  load through `getPublicDrop`, which accepts `CANCELLED`, `FAILED` and `LOCKED` too. So a
  cancelled drop answered `404` — "check the link, it may have been mistyped" — and the
  `CANCELLED` refusal arm, complete with a five-line comment justifying its own reason, was
  unreachable. Two layers, each individually reasonable, disagreeing. **Reuse the constant**
  (`PUBLIC_VISIBLE_STATUSES`) instead of restating the list, and assert the one status that must
  still be hidden, because widening a filter is how a privacy rule gets lost.
- **An anonymous endpoint that mints a `PaymentIntent` is tested on the arguments, not the
  response.** The `/intent` route returns a `clientSecret` that looks identical whether the
  intent was created for the right amount, on the right account, with a manual capture. Only a
  recorder on `paymentIntents.create` can see those, and `capture_method: 'manual'` is FR-404 —
  an `'automatic'` here charges a diner the moment they open the page.

### Teardown

A suite that writes to the shared dev database owns cleaning it up, and teardown is the
one place where a swallowed error has no other symptom. Four rules, each bought:

- **Never `.catch(() => undefined)` a delete.** One silent `ShareLink_organiserId_fkey`
  violation in `share-links.test.ts` left 93 profile-less organisers in the database,
  which the admin screen then listed as broken accounts, *and* leaked customers, *and*
  surfaced two runs later as `Unique constraint failed on (phone)` in an unrelated file.
  One swallowed catch, three symptoms, none of them pointing at the catch.
  `settlementFixtures.cleanup()` still had six of these in the fixture that every
  settlement-backed suite inherits; it now collects them with `step()` and throws an
  `AggregateError`. Un-swallowing all six exposed **no** hidden FK failure across the full
  suite — so the rule was being broken without a live symptom, which is not evidence that
  breaking it was harmless.
- **Delete in foreign-key order: the cascading child first.** `ShareLink` reaches
  `Drop` by cascade but `OrganiserProfile` by a plain FK, so deleting the profile while
  links still exist raises. Reproduced a second time in the `/admin/users` suite. Drop
  the rows that reference before the rows they reference.
- **A `SetNull` FK turns an ordering mistake into an invisible leak.** Deleting a
  merchant now *blanks* its `AiDraft` rows instead of failing on them, so a teardown that
  deletes the merchant first leaves drafts no `deleteMany({ merchantId })` can find any
  more. Nothing errors and no other counter moves, which is why `scripts/check-residue.mjs`
  counts `aiDrafts` since gap 14. The general rule: when a FK is `SetNull`, the child rows
  become unreachable by the parent's id, so delete children *before* parents — the
  database will not remind you.
- **A throw in `afterAll` skips every later delete, so a *failing* run leaks more than a
  passing one.** Run every step and rethrow the collected errors:

  ```ts
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try { await run(); } catch (error) { failures.push(error); }
  };
  ```
  …then `throw new AggregateError(failures, …)` at the end if any failed. Loud *and*
  complete. The `/admin/users` suite leaked 46 accounts before this, because each red run
  aborted teardown at the FK error.

- **Measured, not a fifth rule: the `RESTRICT` edge is real, but no teardown here reaches
  it.** `src/lib/db/__tests__/restrict-fk.test.ts` deletes a `Merchant` that a `Drop`
  still references inside an interactive transaction that *always* rolls back, so it
  leaves zero residue: `P2003` on `Drop_merchantId_fkey`, and the same delete with
  `.catch(() => undefined)` returns normally. Auditing all 191 `src/**/*.test.ts` files
  against the six `RESTRICT` edges found **0** parent-before-child teardowns; the six
  file-order candidates are per-test `finally` blocks that delete children first. So no
  fifth rule was added and the remaining swallows were not swept. If you quote a count,
  quote its shape: at `def744e` there are 76 `deleteMany(...).catch(...)` one-liners plus
  10 scalar `.delete(...).catch(...)` one-liners — **86**, not 76. `docs/PROGRESS.md`'s
  last section has the full reconciliation.

- **`settlementFixtures.cleanup()` does not delete `User` rows, and five suites assumed it
  did.** It removes the drop, its participants and its customers. Every suite needing a
  real actor for `AuditLog.actorUserId` creates a `User` — the FK demands one — and then
  leaks it. 26 accounts per run across five files, all found by the check below. If a
  fixture creates a row and no `cleanup` names it, the suite owns deleting it.

- **"Suite" is the wrong unit. Anything that writes owns a teardown, including a script that
  is not a test.** An untracked `repro-globalcount.mjs` in the repository root — a throwaway
  probe written to prove a counting bug, 825 bytes, `create` and no `delete` — leaked five
  `repro-*` users into `groupeat_dev` and failed somebody else's certification run with
  `users 0 → 1` while all 2592 of that run's tests passed. It was never imported by a test, so
  no fixture, no `afterAll` and no counter owned it; `vitest.config.ts` includes only
  `src/**/*.test.ts`, so it was also not a file anyone would ever read again. **A probe is a
  writer.** Give it a teardown in the same commit that gives it a `create`, delete it when it
  has answered the question, and prefer a scratch database. A later revision of that same
  probe added cleanup, which is the right instinct arrived at one certification run too late.

- **A teardown that deletes `ConsentRecord` by phone prefix and never deletes `Customer`
  at all will read as clean, because a leak saturates.** `funnel-wiring`,
  `confirmation-wiring`, `quote`, `attribution`, `order-link` and `threshold-notify-wiring`
  all did exactly this. Measured from a **wiped** database, the suite goes
  `customers 0 → 27` on the first run and `27 → 27` on the second: those 27 rows are
  created every run and deleted never, so every subsequent run sees an unchanged count and
  the gate reports `no residue`. The baseline is what makes the leak invisible, which is
  the same shape as the `users` mistake above and the reason the counter exists. **When
  you touch a teardown, check it against a wiped database at least once** —
  `node scripts/check-residue.mjs` after a `deleteMany` of the test phone blocks shows the
  true figure. The fix is a registry:
  `phone()` adds the E.164 form to a `Set`, and the teardown deletes `in: [...issuedPhones]`
  from both `Customer` and `ConsentRecord`. A set cannot drift from itself. A prefix can,
  and a prefix also deletes the neighbours' rows: `Customer.phone` is `@unique`, so two
  files sharing a block were *sharing* diners, which silently capped one file's visible
  contribution and hid the leak on both sides.

- **A comparison cannot detect a leak that has already saturated, so the gate now requires
  a clean baseline.** This is the general form of the bullet above, and it is the reason
  to distrust any `no residue` printed before the `--require-clean` slice. `check-residue`
  compares counts around one run; if the leak writes N rows every run and deletes none,
  then after the first run the before-count is N and the after-count is N, the delta is
  zero, and the gate reports success — truthfully about the delta, and completely
  misleadingly about the cleanup. The number that made the gate look green was a symptom
  of the leak being total.

  So `npm run verify` now runs `check-residue.mjs --require-clean` as its preflight. A
  non-empty counted table stops the run before a single test executes, names the table and
  the count, and points at the fix; it does not compare, and it does not print `no
  residue`. The success line distinguishes the two cases it can find itself in:

  ```
  no residue — VERIFIED from a clean baseline: all 12 counted tables started at 0 and ended at 0
  no residue — UNVERIFIED BASELINE. customers started at 27. This proves the counts did not
               move; it does not prove the suite cleans up...
  ```

  The second still exits 0, because the run genuinely did not leak relative to where it
  started — but it must never be quoted as a clean gate, and a baseline file with no clean
  marker is reported this way too, since an unknown baseline is exactly as uninformative as
  a dirty one.

  To get a clean baseline: `npm run residue:wipe` (dry run) then `npm run residue:wipe --
  --apply`. It deletes the residue-prone tables in foreign-key order — **15 models, not
  just the 10 counted ones**. `order`, `dropParticipant`, `menuItem`, `merchantUser` and
  `passwordInvite` are uncounted cascade children that the wipe deletes explicitly,
  children-first, rather than relying on cascades to reach them. It never deletes
  `auditLogs`, which *is* counted but is the one known-growth table. It is deliberately
  **not** `migrate reset` — that drops the schema and
  destroys every `User` and `Merchant`, which is far too destructive for a preflight and
  needs a re-seed afterwards.

- **`npm run verify` reads the working tree, not `HEAD`. This is not enforced, and you have
  to enforce it yourself by committing first.** Every certification in this repository — all
  of them, over 124 commits — is a claim about a tree that was clean *at the time it ran*, not
  a claim that the committed tree is what the tests saw. Nothing checks it. Two people were
  burned by exactly this in one session: one measured the other's uncommitted edits and
  reported the numbers as a property of a commit, and the other spent an hour chasing a count
  that belonged to a worktree mid-edit. Both numbers were real; both were about a tree that
  existed only on somebody's disk.

  So: **commit before you certify, and require `git status --porcelain` to be empty before
  you believe a green line.** A gate can be perfectly honest about its baseline and still be
  reporting on code nobody has committed. If you need to know what ran, print the hash:
  `echo "HEAD=$(git rev-parse --short HEAD) dirty=$(git status --porcelain | wc -l)"`.
  It is deliberately not a check in `check-residue.mjs` yet — it belongs there, and until it
  is, this paragraph is the only thing standing between a green gate and a wrong hash.

- **One run at a time per database. This is now enforced, and it was not before.** The gate
  has two shared mutable artifacts and never serialised either: the `groupeat_dev` database,
  and the baseline file at a *fixed* path. `fileParallelism: false` only orders test files
  inside one process; it says nothing about two `npm run verify` invocations, let alone two
  people.

  What it looked like when it was not enforced, measured at the start of a session: a dry run
  of `residue:wipe` reported two `user` rows, which were not residue. Querying them showed
  `authmeyeml7-*` fixture accounts, six of them, created **four seconds earlier** — and `ps`
  showed `npm run verify` alive at that moment, 1:51 elapsed, parented to the same session.
  The operator was reading the database through somebody else's live test run and nothing in
  the output said so. Every figure was real and none of it was about the state the reader
  thought it was about. The cost was an hour of two people's time and a set of numbers that
  had to be discarded, and the same session also produced a commit that swept up another
  teammate's in-progress edit — one layer up, the identical failure: **two operators writing
  one tree with no mutual exclusion.**

  So `--require-clean` now takes an exclusive lock at `node_modules/.residue.lock`
  (`scripts/residue-lock.mjs`) **before it counts anything**, and holds it until `--compare`
  releases it on both the pass and the fail path. `residue:wipe` refuses while a lock is held,
  on the dry run too, because its numbers are exactly the believable ones. `npm run residue`
  is deliberately *not* locked: it is the read-only diagnostic you reach for during a
  concurrent run, and its output is still a count from an unknown mixture.

  Two things about the lock are worth knowing before you trust it. The recorded `pid` is not
  the preflight — that process exits in under a second, so a lock keyed on it is dead four
  lines into a two-minute run and every steal rule would disarm the guard; liveness is decided
  on `ownerPid`, the parent whose lifetime spans the run. And a lock whose owner is gone is
  **stolen with a printed line**, because a lock that can wedge the gate is worse than no lock.
  Waiting is still cheaper than killing: a killed run leaves the fixture rows it had not yet
  cleaned, and those are real residue that the next preflight will correctly refuse.

  **And it only guards the gate's own entry points.** Measured with a live lock in place:
  `npx vitest run <file>` runs to completion and prints `1 passed` — no refusal, because the
  lock is taken by `check-residue.mjs`, not by the runner. `vitest.config.ts` has no
  `globalSetup`, so a bare test run is outside the mechanism entirely. The same is true of
  `prisma studio`, a scratch script, or the dev server. So the lock converts "two operators
  cannot tell" into "two *gate* runs cannot collide", which is the case that actually cost
  someone an hour — it does not make `groupeat_dev` single-writer.

  **The remainder is not hypothetical, and it was observed rather than argued.** Four minutes
  after this paragraph was committed (`fd15497`, 20:16:58Z), a certification run failed like
  this, with every one of its 2592 tests passing:

  ```
  RESIDUE — the suite left rows behind (baseline was clean, so this is new leakage):
    users                  0 → 1  (+1)
  ```

  The row was `repro-1793910098056@e.test`, role `MERCHANT`, created 20:21:38Z — three seconds
  before that run ended. It came from an untracked `repro-globalcount.mjs` sitting in the
  repository root: a scratch probe that counted `drops` and slept eight seconds, with no
  teardown at all. Five `repro-*` users leaked in total; the other four were written *after*
  the gate had already reported. The probe took no lock, met no refusal, and was invisible to
  the operator of the run it broke. Nothing was wrong with the suite, and the gate was right
  about the number: `users` really did go `0 → 1`.

  So treat a probe as an operator. Point it at a scratch database, or take the lock
  deliberately, or simply do not start one while a certification is in flight — and note that
  none of those is enforced. If you run the suite by hand against shared data while somebody
  else's `verify` is live, nothing stops you and nothing will tell you afterwards; the person
  it tells is whoever reads the `+1` and has to work out whose rows those were.

- **The counters are a list, and a list is only as good as its last audit.** `check-residue`
  counts thirteen keys covering **eleven** tables: `organisers` and `profilelessOrganisers` are
  two further views of `User`, not two more tables. (Its success line says "all 12 counted
  tables", which is `mustBeClean.length` — thirteen keys minus the `auditLogs` exemption. A
  *key* count, not a table count. Read the list, not the number.) It does **not** measure
  `dropParticipant`, `order`, `menuItem`, `passwordInvite` or `merchantUser`. It did not measure
  `consentRecord` until a residue audit noticed that every teardown it polices deletes both
  `Customer` and `ConsentRecord` — so half of six fixes had been certified by a number that
  would not have moved — and it did not measure `ledgerEntry` until the next audit found a row
  its teardowns could not even see. `auditLogs` is counted but excluded from the must-be-clean
  precondition, because it is never empty and a precondition it can never satisfy is not a
  precondition.

  Those five uncounted tables all measure **0**, which is reassuring and is not evidence — and,
  measured against `schema.prisma`, they are at zero for one reason: all five are covered by a
  cascade onto a counted parent: `MerchantUser`→`Merchant`/`User`, `MenuItem`→`Merchant`,
  `DropParticipant`→`Drop`, `Order`→`Drop`, `PasswordInvite`→`User`, each `onDelete: Cascade`.

  **`LedgerEntry` is now counted, and the counter is deliberately unscoped.** It has no relation
  field at all — `orderId String?` and `dropId String?` are bare nullable strings, and the
  model's own docblock says so deliberately ("Deliberately NOT added: foreign keys"). Nothing
  cascades to it, so nothing can cover it. All 26 `ledgerEntry` write sites in `src/` currently
  produce a non-null `dropId`, and all seven teardowns select by `dropId` — six with
  `where: { dropId: { in: dropIds } }` and one with a scalar `where: { dropId: id }` — neither
  of which **can match NULL**. One row written without a `dropId` would survive every teardown
  in this repository, and `@@unique([orderId, type])` sits
  on a *nullable* `orderId`, so Postgres treats NULLs as distinct and does not stop duplicates
  either. Both facts were measured before the counter was added: two `dropId: null` rows of the
  same `type` inserted, and the teardown filter over the whole table returned **0** for both.

  `src/lib/scripts/__tests__/residue-ledger-entry.test.ts` pins this closed by writing exactly
  those rows and asking the gate whether its count moves. A *scoped*
  `ledgerEntry.count({ where: { dropId: { not: null } } })` makes that test fail with
  `expected +0 to be 2` — the plausible wrong fix, proved red before the real one was kept. All
  16 models are now either watched (11) or cascade-covered (5); none is unwatched.

  The clauses this bullet used to carry were wrong in the direction the rest of this document
  warns about: an argument that read like a measurement. It said "`DropParticipant.drop` is
  `onDelete: Cascade` and `Order` and `LedgerEntry` hang off it". `Order` reaches `Drop` by its
  own `onDelete: Cascade`, and reaches `DropParticipant` by `Order_participantId_fkey`, which is
  **`RESTRICT`** — so it hangs off `Drop`, not off the participant. `LedgerEntry` hangs off
  nothing. And "their parents cascade" was true for five of the six, not six.

  The same audit turned up one more `SetNull` on a nullable FK, the shape that strands a row:
  `DropParticipant.shareLinkId` is `String?` with no `onDelete` written, so Prisma's default for
  an optional relation applies, and the initial migration renders it `ON DELETE SET NULL`. That
  is the third such shape in the schema after `AiDraft.merchantId` and `AuditLog.actorUserId`,
  and the only one on an uncounted table. It is **not** a residue risk, for a specific reason:
  participant teardowns delete by `dropId`, not by `shareLinkId`, so a blanked link does not
  strand the participant. The loss is organiser attribution on a surviving participant — a
  data-integrity gap in commission, not a leak, and one no counter would show either.

  When you add a teardown or a fixture, ask what it writes and whether that table is in the
  list. Adding a counter is cheap and it is the only way the gate learns to see.

- **A prefix in one file can delete another file's rows, and `fileParallelism: false`
  makes that look like nothing at all.** Two suites minting `+17805558001` do not collide
  loudly; they take turns deleting each other's diner, and the only evidence is a count
  that moves when the files run in a particular order. Grep every builder before choosing
  a phone block, and record the allocation next to the builder.

  **Pad width is part of the allocation.** `attribution` mints `+17805559` + four digits
  and `threshold-notify-wiring` mints `+17805559` + three, so both match
  `startsWith('+17805559')` and only the tail tells them apart. A shared prefix is
  therefore not enough information to attribute a residue count: when the gate reported
  sixteen leftover customers in that block, the pad width was the only thing that said
  which file owned them. Check the tail of a sample row before deciding who to fix.

- **A gate is only as honest as its table list, and that list drifts.** `check-residue`
  counted ten tables and not `consentRecord` — while every join-path teardown it polices
  deletes `Customer` *and* `ConsentRecord`. So the counter certified half of each fix: had
  the `ConsentRecord` half been left undone, `customers` would still have read 0 and the
  gate would still have gone green. It now counts 12. The general lesson is the one worth
  keeping: **when a mechanism asserts "the suite is clean", check what the mechanism can
  see.** An uncounted table is not a clean table, and the row that proves a fix was needed
  is often in the table nobody added to the list. Ask, of any gate, "what could leak past
  this?" — and then measure that, rather than assuming the answer is nothing.

- **A test may delete by a prefix it does not own, and the victim is a different suite.**
  `pickup-queue`'s teardown swept `customer` with `phone: { startsWith: '+1555' }`, but
  `+1555` is `settlement-fixtures`' own block — `+1555${prefix digits}${phoneSeq}` — so
  every fixture-backed suite's customers matched it. The symptom was not a residue count:
  it was `pickup-queue`'s own scope test failing with "expected […] to not include
  <another merchant's id>", because a concurrent suite's teardown had deleted the row the
  list had already read. **Before writing a `startsWith` filter, grep for the prefix and
  ask who else mints into it.** Prefer deleting ids you created, or a registry; the
  fixtures' own `cleanup()` already owns everything `fx.participant()` makes.

- **`findFirstOrThrow` with no `orderBy`, on a predicate more than one row matches, makes
  a correct route look broken.** `pickup-queue` looked up "a user with a membership in
  merchant B" and then asserted the response excluded merchant A's drop. The setup also
  created a user owning *both* merchants, which matched too; Postgres was free to return
  it, and roughly one run in three it did. The fix is to name who the test means
  (`id: { not: dualMemberUserId }`) rather than to add `orderBy`, which would only make
  the wrong answer deterministic.

- **A fixture that promises letters in a generated code must enforce it.** The fixture
  `publicCode` docblock said "the characters are letters on purpose", because a digits-only
  code is its own lowercase form and makes every `toLowerCase()` assertion vacuous. The
  generator drew from the full 30-symbol alphabet, whose first eight symbols are digits, so
  about **1 in 3,100** prefixes produced an all-digit code — measured, not estimated. It
  failed `service.test.ts` on the second of three consecutive `verify` runs with
  `expected '44395729' not to be '44395729'`. Any property a fixture's comment claims is a
  property the fixture has to guarantee, or the comment is a lie the tests cannot see.

**Verify teardown by counting, not by reading it.** `scripts/check-residue.mjs` does it, and
`npm run verify` runs the whole thing in one command:

```
npm run verify                # interpreter → clean-baseline preflight → vitest → --compare
npm run residue               # the counts alone, for diagnosis — works even mid-run
npm run residue:wipe          # dry run: what residue would be deleted
npm run residue:wipe -- --apply   # delete it, then the gate can certify a run
```

`verify` and `residue:wipe` both refuse while another run holds `node_modules/.residue.lock`,
and name the pid that holds it. If you see that message, somebody is working: wait, or stop
them. A lock left by a process that has exited is stolen automatically.

The three-command form, if you need it by hand. Pass `--baseline` whenever you redirect
somewhere other than `node_modules/.residue-before.json` — the comparison checks the path it
is given against the one the lock recorded, and a mismatch is refused rather than guessed at:

```
node scripts/check-residue.mjs --require-clean --baseline /tmp/before.json > /tmp/before.json
npx vitest run
node scripts/check-residue.mjs --compare /tmp/before.json   # exits 1 on any leak
```

**Dump mode is not a check.** It prints counts and exits 0 whatever they are, and that output looks
enough like a result that I ran it for several sessions without ever comparing — while five
organiser accounts leaked per run. The gate is `--compare`; the dump is a diagnostic. If a count
looks large, that is not information until you know what it was before.

**A green gate from a dirty baseline is not a green gate.** This is worth its own line
because it cost three separate reports to the user that had to be withdrawn. The three
"consecutive green runs" certified after `5ad9756` were three samples of a steady state,
not three proofs, and `2579 passed, no residue` was true and worthless at the same time.
When you quote a green run, quote which baseline it came from; if you cannot say, it was
`UNVERIFIED` and does not count as evidence.

**Count `users`.** The obvious row type is the one your visible bug was about, and watching
only that one hides the rest: the `/admin/users` residue check counted *profile-less
organisers*, passed before and after, and 26 user accounts a run were slipping past it.
`User` is the table every fixture writes and no fixture owns, so it is the count that moves.
The script reports `auditLogs` growth without failing on it — those rows are *meant* to
outlive their targets (`onDelete: SetNull`) — because a gate that fails every run is a gate
nobody reads. Run the count after a deliberately red suite too; that is the case that used
to leak.

- **A PRD rule can be unimplementable as written, and you must check before you test it.** M9's
  FR-702 says a customer is new if `Customer.firstSeenAt` falls inside the drop's own window.
  `rules.ts:91` enforces `cutoffAt < windowStart`; `joinDrop` upserts the customer row at join
  time, before the cutoff; so `firstSeenAt < cutoffAt < windowStart` for every customer alive.
  The rule classifies **nobody** as new, on every drop, by construction — and a test of it
  cannot fail, which is worse than no test. Three measured facts, not an opinion. When a
  requirement's subject is a timestamp, check what the schema guarantees about that timestamp
  *before* writing the assertion, and check whether the two columns you want to compare are
  written by **separate statements**: `firstSeenAt` and `DropParticipant.createdAt` differ by
  1–13 ms in five samples, so an equality test on them is flaky by construction. Then state the
  replacement definition and its limitation, rather than quietly implementing something else.
- **A net figure is not a gross figure minus a refund.** M9 reported **−$21.33** for a
  fully-refunded 3-plate order, because contribution was `Σ contribution − refundedCents` and
  the food cost lives inside contribution: the diners got their money back and the merchant was
  charged for food twice. Scale pro rata instead — `roundHalfUp(gross × (subtotal − refunded) ÷
  subtotal)` — which is exact at both endpoints and an approximation only in between, and say
  so, because the schema records refunded *cents* and not refunded *units*. Corollary: when a
  fast path and a general path agree at every input, the fast path is dead code; delete it
  rather than defend it when a sweep reports it as surviving.
- **A module with a withholding policy must have exactly one error type.** `merchantReportFor`
  withholds a drop whose figures do not reconcile, and delegates the check to
  `assertLedgerReconciles`, which throws `SettlementIntegrityError`. The `catch` matched on
  `ReportIntegrityError`. So one unreconciled drop escaped the withholding and **500'd the whole
  page** — the failure mode the policy exists to prevent, caused by two modules each having a
  reasonable private error type. Wrap the delegation and rewrap, carrying the message verbatim,
  and assert the conversion with a test that names both types.
- **A count for a past period must be bounded at the moment the row was created, never "total
  minus one".** M9's first `priorCapturedOrderCount` counted every capture and subtracted the
  current order, which counts **future** purchases: January's report changed every time a
  customer bought again in March. A report is a function of the past alone. The cutoff is
  `participant.createdAt` with a strict `<` — not the drop's `windowStart`, which loses the
  ordering when two drops share an evening, and not `<=`, which lets a customer's own charge
  count as their prior purchase.
- **`qty: 1` everywhere cannot tell a per-unit sum from a head count.** M9's attribution
  fixtures were all one plate, so `units + 1` survived `units + qty`. The repair is not one
  `qty: 2` — the mutant hits **both arms** of `existing ? … : …`, so the *second* participant
  through the same organiser needs a quantity above one too. Two fixtures of the same bug are
  not redundancy when they exercise different branches.
- **A whole-portfolio query needs a per-test tenant, and that still is not enough.** A report
  aggregates every drop a merchant has, so a test that adds a drop changes every later test's
  answer — `beforeAll` made M9's page suite pass only in file order. But a per-test tenant
  isolates *data*, not *time*: creating an organiser `User` and its `OrganiserProfile` in two
  statements leaves a window in which the row is profile-less, and `/admin/users` counts exactly
  those and asserts its heading matches its repair forms. The full suite failed once on
  `"1 organisers missing a"` inside another suite's `not.toContain`. Create related rows
  **nested in one statement** when another suite can observe the intermediate state.
- **A fallback that cannot run is not a survivor, and a survivor is not always a fallback.** M9's
  sweep reported `?? [...linksById.values()][0]` as surviving for a while before anyone asked
  whether it could execute — it cannot, because the share-link read spans every drop in the
  report, so a non-null id always resolves. That is dead code. The *real* `dropId`-join bug —
  ignoring `shareLinkId` entirely — is killed twice. Before writing up a survivor, say which of
  the three it is: fixture gap, equivalent mutant, or dead code. They look identical in a sweep
  table and only one of them is about the tests.
- **A mutation harness that silently applies nothing produces a false clean, and it happened
  here.** M9's first sweep printed `survivors: 0` across **forty probes that never ran**: `cp`
  to a backup path containing `(merchant)/` needed quoting on the destination, the backup tree
  was never created, `perl` edited nothing, and `md5` compared two identical hashes. A harness
  must fail loudly when a mutation does not change the file, and must self-test its own
  backup/restore — the same harness's `restore()` used a global `f` that shadowed the caller's
  and reported a lossless backup as lossy.
- **A Zod transform runs *after* the checks on its chain, so `.trim()` must come first.** Both
  `itemInputSchema` and `draftInputSchema` had `.min(1)` before a `.trim()` done later in the
  mapper: `'   '` passed the length check and was stored as `''`. Probed on the real parser before
  fixing. The same ordering also measured padded values untrimmed, so 80 characters padded with
  spaces were rejected as 84. `.trim()` returns a `ZodEffects`, which is why it goes at the front
  of the chain rather than after `.min()`.
- **"This policy deliberately ignores field X" is not "anything may be stored in X".** A draft is
  allowed to be unprofitable, which is why `collectDraftFieldErrors` skips `dealPriceCents` — and
  that reasoning let `-5000` be written to an `Int` column with no check anywhere. Separate the
  *policy* question (is this price good?) from the *well-formedness* question (is this a price?),
  and bound the second even where the first is deliberately absent.
- **`.min(0)` and not `.positive()` when the form initialises the field to `0` and the edit path
  sends the whole body.** `DropForm` starts an untouched price at `0`, so a positive bound would
  422 a merchant on a field they never edited. The line the schema draws is placeholder versus
  corruption — a placement rule, decided by the form's initial state, not by taste.
- **A 409 is for a valid body against a resource in the wrong state; a 422 invites a retry that
  cannot succeed.** Republishing a drop returned `422 VALIDATION` with `fieldErrors: {}` — nothing
  to highlight, on a body that was valid and empty. A client correcting fields against a 422 loops
  forever. The existing unit test passed for months because it asserted the *message*
  (`rejects.toThrow(/already been published/)`) and not the status.
- **A required `Json` column makes `not.toBeNull()` vacuous.** `Drop.guardrailSnapshot` is `Json`
  and non-nullable, so a draft holds `{}`, not `null` — and a published drop holds `{...}`, which
  is also not null. "Nothing has been frozen yet" is `Object.keys(snapshot).length === 0`. Check
  what the schema permits before writing an absence assertion against it.
- **A mutation that needs two edits must be given two edits, or the sweep reports coverage it does
  not have.** Moving `getItem` below the body parse also deleted the `previous` binding the route
  later reads, so all four failing tests died of `ReferenceError` rather than of the reordering. A
  *faithful* mutant — call moved, binding preserved — **survives all 20 tests**. Only the two-edit
  version is killed, by the one test that asks about ordering specifically. When a mutant dies
  loudly, check *why* before crediting the test.
- **A test that expects a write to be refused registers no id, so cleanup cannot key on ids.**
  Worse, it is correct to write nothing on a good implementation — which means the leak only
  appears under mutation, when the refusal stops refusing. 16 mutants left 14 `DRAFT` drops in the
  dev database, and an unrelated `/admin/drops` guard failed with "leaked data from another
  suite", which was true and about the new file. Delete by **tenant** (`merchantId: { in: ... }`),
  which holds regardless of which assertions passed.
- **A coverage claim is only a claim when every import form has been checked.** Three scans gave
  three different wrong answers about which pages had tests: an alias-only grep missed
  `await import('../page')`; a colocated-`__tests__`-directory scan missed pages tested from a
  parent directory and cleared one that had no tests at all; and a "literal alias" scan requiring a
  trailing quote missed both the relative form and the destructured
  `const { default: Page } = await import('../page')`. The cost was not a wrong number — it was
  proposing to close a gap that did not exist, on a page (`/login`) that already had a dedicated
  11-test suite for the exact risk named. Check every binding form before saying "untested", and
  verify a specific proposed file rather than trusting the scan that produced it.
- **When three entry points must agree on an order, the order is the property.** `page.tsx`,
  `middleware.ts` and `requireRoleOrRedirect` all sequence no-session → `mustChangePassword` → role.
  A gate that fired only for `ADMIN` passes a single-role test and fails the other two, so a
  gate-order test must be per-role. Same shape for "read per request": a module-scope cache serves
  one caller's session to everyone and is invisible to any test that calls once — assert the call
  count.
- **A docblock that names a destination its function does not return gets the comment fixed, not
  the code** — when other suites and a route comment already pin the departure deliberately.
  `page.tsx` promised `MERCHANT → /merchant/items` from PRD §6.1 while `roleHome` returns
  `/merchant/drops` since M3. Correcting the code to match the PRD would have broken four suites
  and an intentional product decision to satisfy one stale sentence.
- **Collect the row that cascades, not the row you were thinking about.** `makeOrganiser()` in
  `reports.test.ts` nested a `User` and its `OrganiserProfile` in one statement (correctly — see
  the per-test-tenant rule above) and then registered the **profile** id for teardown. The profile
  was deleted every run. The account was not. Five per run, since M9. Deleting the parent is the
  smaller delete *and* the complete one: `OrganiserProfile.user` is `onDelete: Cascade`, so there
  is no ordering to get wrong and no child to forget. Whenever a fixture creates a parent and a
  child, the collector names the parent.
- **A deleted child under a surviving parent impersonates a different defect.** Because the profile
  really was removed, the leak presented as `profilelessOrganisers` — an `ORGANISER` account with
  no profile — which is precisely the state FR-906 exists to repair. So 1114 leaked test accounts
  read as "a backfill was never run" for six slices, and the honest-looking next task was to write
  a backfill that would have repaired rows which should not have existed. Before diagnosing a data
  state as a missing process, check whether a fixture can produce the same state by deleting half
  of it.
- **A counter that moves beside a counter that does not is a diagnosis, not two facts.**
  `organiserProfiles` flat at **52** while `users`, `organisers` and `profilelessOrganisers` each
  moved **+5** said "the profiles are handled; the accounts are the leak" before I read a line of
  the file. Two counters exist so that one can explain the other; read the difference, not the
  numbers.
- **`scripts/check-residue.mjs` in dump mode is not a check, and it looks exactly like one.** Dump
  mode prints ten counts and is diagnostic; `--compare` exits non-zero on growth and is the gate. I
  ran the dump form for several sessions, saw `1114` each time, read it as "large but stable", and
  never compared. The script's own docblock documents the three-command ritual; a ritual that
  nothing enforces gets half-done, and the half that gets done looks like a result. Run
  **`npm run verify`** (baseline → `vitest run` → compare, one command, no temp path to
  transcribe). `npm run residue` remains for diagnosis.
- **Deletion is verified by counting, never by reading, and no assertion strength substitutes.**
  Reverting the fixed teardown to delete the profile again leaves **all 12 tests passing** while
  writing 5 rows a run. A test cannot fail on a leak unless it says "and afterwards the database is
  as it was", which no behavioural test does. This is the general case of the `### Teardown` rule:
  the reason to count is not that reading is careless, it is that the property being violated is
  invisible to every test the file contains.
- **A fixture that leaves rows behind can also be the reason a *different* suite is flaky.** The
  five accounts per run accumulated into `/admin/users`' heading, which counts profile-less
  organisers and asserts the count matches its repair forms. That suite was intermittently red in a
  way that pointed at itself. When an unrelated suite fails on a global count, suspect every
  fixture that writes that row type before changing the suite that noticed.
- **A wall clock is not a sequence.** `reports.test.ts` built provider ids as
  `` `pi_${PREFIX}_${Date.now()}_${phoneSeq}` `` with `phoneSeq` advancing only inside
  `makeCustomer()`. Two participants for the same customer inside the same millisecond got the same
  `paymentIntentId` on a `@unique` column, and one full run in three died with
  `Unique constraint failed on the fields: (paymentIntentId)` — in a test named for organiser
  attribution, in a file unrelated to the change. `Date.now()` repeats; that is what it does when
  called twice in a loop. If an id must be unique, it needs a counter **beside** the timestamp, not
  a timestamp plus a counter that advances somewhere else. Found by running the full suite five
  times, which is the only way a 1-in-3 flake is a fact rather than a suspicion.
- **An endpoint with no caller is the endpoint that drifts.** `GET /api/merchant/pickup-queue` and
  its `[id]` sibling have no client: `/merchant/pickup` is a server component that calls
  `listCounterDrops` and `loadManifest` directly. So the page is exercised by a large suite, the
  route by nothing, and nothing compares them. Assert the payload **against the function, field by
  field**, never against literals — a literal passes while the route and the page disagree, which is
  the whole risk of a second entry point to one capability.
- **A route may legitimately disagree with its neighbour about a filter, and both be right.**
  `listCounterDrops` excludes `FAILED` and `DRAFT` because they are not work at a counter;
  `loadManifest` refuses to over-restrict because a diner may ring about a failed drop and a read
  that answers "not found" gets worked around with a spreadsheet. Asserting *both directions* is
  what stops the natural future edit — "make these consistent" — which would look like a fix.
- **A fixture that satisfies two exclusion rules cannot say which one excluded it.** Two failures of
  exactly this shape in one slice: (1) `DRAFT` and `FAILED` drops placed thirteen hours back were
  excluded by the *window*, so the status filter was completely unasserted and widening it to
  include both left every test green; (2) two single-merchant owners made `merchantIds[0]`
  indistinguishable from `merchantId: { in: merchantIds }`, because each owner has exactly one id.
  Fixes: put the excluded row **inside** the other rule's pass region with a control that gets
  included, and build a caller who **owns two merchants** — a membership test and a first-element
  test differ for nobody else. Before trusting a negative assertion, ask which rule you violated and
  whether the fixture violates anything else.
- **A row ordering is only asserted when the fixture makes the orderings disagree.** A collected
  diner created first *and* named earlier has `createdAt` order, name order and
  outstanding-first order all agreeing, so a `sort(byName)` added to the route survived every test.
  Name the rows so each candidate ordering gives a different answer (`Aaa…` collected, `Zzz…`
  waiting), and then the one assertion distinguishes all of them.
- **A survivor with no behavioural consequence is reported as what it is.** Of 27 probes on the
  pickup-queue slice, 22 were killed, 4 were **measured** equivalent mutants (Prisma returns 0 rows
  for `in: []`; `JSON.stringify(Date)` is byte-identical to `.toISOString()`; every fixture window
  is hours from the edge) and 1 was a **projection whose job is to stop a future `select` reaching
  the wire** — replacing `drops.map(...)` with a bare `drops` changes nothing a client can observe
  today. A key-set assertion protects the map; a value comparison cannot, because the values are
  already identical. Dressing that up as a killed mutant would be a false claim about coverage, so
  the write-up says "not currently load-bearing" and explains why the code stays.
- **A period-bounded query needs its constant tested from both sides.** The 12-hour pickup window is
  bracketed by two fixtures ending 11 and 13 hours ago. Without that pair the constant could be
  changed to anything from 3 to 100 hours and every other assertion would still pass. Note what that
  proves: the range, not the literal — and the write-up says so rather than implying 12 is pinned.
- **A module that is only ever *mocked* has no tests, however many files name it.**
  `src/lib/auth/credentials.ts` appeared in two suites and both replaced it with
  `vi.mock('@/lib/auth/credentials', () => ({ authenticate }))`. The suites were about the *pages*,
  so mocking was right there — but the consequence was that the login path's rate limit, its
  enumeration guard and its password policy had never executed under test. Before claiming an area
  is covered, grep for `vi.mock` as well as for the import: a mock is a mention, not coverage.
- **A security claim written in prose is an untested claim until something can fail on it.** The
  dummy-hash timing equaliser, the shared error message for both failure modes, and the 10-attempt
  limit were each asserted in a docblock and nowhere else. Two of the three were true. The
  measurement that settled it was a probe: bcrypt at cost 10 is ~54 ms and a bare `findUnique` is
  ~1 ms, a 50× gap, so a floor at 20 ms tells "hashed" from "did not hash" with headroom. Assert
  timing only where the mutant changes the *order of magnitude*, and say which mutant the bound
  kills.
- **`Math.ceil` of a positive remainder is already ≥ 1, so `Math.max(1, Math.ceil(ms / 1000))` on a
  positive remainder is dead code.** Probed: every input the refusal branch can reach returns
  `Math.ceil(x) === Math.max(1, Math.ceil(x))`. The clamp states an invariant (`Retry-After` is
  never 0) that the caller depends on, so it stays — but the probe **survives**, and calling that a
  coverage gap would be wrong. This is the second kind of survivor after "equivalent mutant": dead
  code with a defensive purpose. Say so, and assert the invariant (`>= 1` across the window) rather
  than pretending a kill.
- **A single call with a defaulted parameter cannot distinguish the default from a wrong one.**
  `hit(key)` returning `{ allowed: true, remaining: 9 }` is the same object whether `now` defaults to
  `Date.now()` or to `0` — a fresh bucket looks identical whenever it was created. Probed by setting
  `now = 0`, which survived. The distinguisher is a **second** call with an explicit real-time value:
  under the real default it is attempt 2 (8 remaining), under `now = 0` the bucket was created at
  epoch 900 s and is long expired (9 remaining). If a defaulted clock matters, test the transition,
  not one call.
- **A header value is trimmed by the HTTP layer before your code sees it, so a whitespace test can
  pass for the wrong reason.** `'   10.0.0.1   '` reaches `request.headers.get()` as `'10.0.0.1'`,
  so a `.trim()` removed from the route survived — the surrounding whitespace was already gone.
  What reaches the trim is whitespace *inside* the first element: `'10.0.0.1 , 10.0.0.2'` splits to
  `'10.0.0.1 '`. Probe the framework's normalisation before asserting on your own.
- **`vi.spyOn` on a Prisma delegate destroys it.** `prisma.user.findUnique` resolves through a proxy
  getter; `spyOn` defines an own property over it and `mockRestore()` does not restore the proxy, so
  every later test in the file dies with `TypeError: … is not a function`. To count calls, wrap the
  *function* in `vi.fn(actual.fn)` via `vi.mock(…, importOriginal)` — and use `mockClear()`, never
  `mockReset()`, which drops the implementation.
- **A random value is not a sequence, whether it is a clock or a die.** `paymentIntentId` collided
  through `Date.now()` (AGENTS.md, M9) and `Customer.phone` collided through
  `Math.floor(Math.random() * 9000 + 1000)` — 9,000 values against ~20 draws a run is a ~2%
  birthday collision, which failed one full run of 153 files while the file passed 8 isolated runs
  in a row. Any `@unique` fixture id needs a monotonic counter. A per-file `let seq = 0` costs
  nothing and cannot collide.

- **A `PATCH` must distinguish "absent" from "blank", or it will erase what the caller did not
  mention.** `pickupSchema` is `.nullish()` on both fields, and `parsePickupInput` used to funnel
  `undefined` and `''` into the same `null`, so `{"pickupAddress": "1 New Rd"}` wrote
  `pickupInstructions: null` and answered 200 with the erasure as the new state. The shipped client
  sends both keys, which is why nobody noticed — **a defect whose only barrier is a property of the
  current caller is one refactor from live.** Fixed in three places that had to move together: the
  parser tests key **presence** (`'pickupAddress' in data`) and returns `PickupPatch`, whose
  optional properties carry all three states; `updateOwnPickup` takes `string | null | undefined`
  and lets Prisma **omit an `undefined` column from the `UPDATE`** (never `?? null` it — that
  reintroduces the erasure); and the route answers 422 to a body naming no known field instead of
  writing nothing and saying 200. When a schema uses `.nullish()`, ask what `undefined` is supposed
  to mean and whether the write path can tell it from an explicit clear.
- **A route that echoes the request instead of reading back what it stored is only correct while
  the request is the whole row.** The pickup `PATCH` replied with the parsed body. That was true
  when every field was always written; the moment the write became partial, echoing
  `{ pickupAddress }` told the client the instructions were gone — the same lie as the erasure, in
  a new place. `PickupForm` applies the response straight to its inputs, so the response has to be
  the stored row. **When a write becomes partial, every read of it in the same handler becomes
  suspect.**
- **A relative import hides a route from every path-based coverage count.** `from '../[id]/route'`
  names `src/app/api/merchant/drops/[id]/route.ts` to a human and to Node, and to nothing else — a
  grep for the absolute path reported two fully-tested routes as untested. This is the third
  distinct way a coverage figure has lied in this repo: a `vi.mock` is a mention and not coverage; a
  relative import is not a string match; and a walk that matches nothing passes every assertion in
  it (which is why `impersonation-readonly.test.ts` asserts its own file count first). Before
  claiming a file is untested, grep for the **callers**, not the path.
- **A mutation sweep is only as wide as the suites it runs, and a probe is only as good as its
  pattern.** Three of this slice's probes reported `SURVIVED` because the code they mutated appears
  **twice** in `db/merchants.ts` — `replace` hit the admin `updatePickup` and left `updateOwnPickup`
  untouched, so they were probing a function the test never touches. A fourth only *imported* the
  function it was meant to call. Both classes read as a coverage gap and are not. Anchor a probe on
  text unique to the target (a comment it owns, the full surrounding block), assert the pattern was
  found before running, and include **every** suite that tests the file.
- **In an OAuth-ish route, the line that matters is the URL you build, not the call you make.** The
  onboarding service is tested with literal `return_url`s, so `originOf` returning `localhost` in
  production would pass every service assertion while sending every merchant to a host that does not
  resolve — after they believed they had finished. A spy that captures only the result cannot see
  it; capture the **arguments**. Same shape as the header-trim lesson: probe what your code
  contributes, not what the framework already did.
- **A payload consumed only by a client component has no runtime test here.** `CountPoller` reads
  nine properties literally and compares `offerPhase` to decide whether to refresh, so a field that
  is computed correctly and then omitted from the response is `undefined` on every poll and the page
  refreshes twice a minute for the life of the drop — with the whole suite green. Assert the key set
  with `toEqual` on the **whole object**, never `objectContaining`, which passes when the response
  also carries a participant list. On a public endpoint that key-set assertion is a privacy
  control, not a style preference.

- **A relative *dynamic* import is invisible to every path-based coverage count.** All 26
  pages in this app are reached by tests through `await import('../page')`; a grep for the
  path reports them untested. This is the fourth distinct way a count has lied here — a
  `vi.mock` is a mention and not coverage; a relative static import is not a string match; a
  walk matching nothing passes every assertion in it; and now the dynamic binding form. A
  **docblock naming a path is also just a mention** (the new layout docblocks bumped a naive
  grep from 4 to 7). Resolve static `from`, dynamic `import()` and `vi.mock` specifiers back
  to real files, and check for mock-only references separately.
- **`path.resolve()` on only some keys reports zero coverage.** A resolver that stores
  absolute real paths for `@/` aliases but literal relative strings for `./` imports can
  never compare the two sets, so every relative import silently fails to match. Keep every
  key in the same coordinate system. The general form: a coverage count is only as good as
  the **join between what it searches for and what the runtime resolves** — when a count is
  suspect, stop counting and read the callers.
- **A prop consumed only inside a client component's `useEffect` never appears in server
  HTML.** `ImpersonationBanner.expiresAt` is the third instance of this shape after the count
  route's `CountPoller` payload. Wrap the real component with `vi.fn(real)` — never stub it —
  so React still renders its markup, capture the whole props object with `toEqual` (a value
  comparison cannot see an omitted prop), and use `mockClear()` rather than `mockReset()`
  because the probe's implementation IS the real component.
- **`toBe` identity, not deep equality, pins "the same object the gate returned".** Make
  `getSession` yield a fresh object per call; then a layout that re-reads the session,
  reconstructs one, or reaches for a module-scope cache fails both `issued.length === 1`
  and `toBe`. Deep equality lets a clone through. Under `noUncheckedIndexedAccess`, read
  `vi.fn().mock.calls[0]?.[0]`.
- **A closed union is guarded by `tsc`, not by a render suite.** Adding `'GHOST'` to a role
  array survives every behavioural test because `verifySession` rejects unknown roles, so the
  extra `includes()` operand is unreachable by construction. The typechecker catches it
  (`TS2322`). Classify that survivor as dead code with no purpose, and do not claim the
  render suite proves "the exact role list". Same class as `Math.max(1, Math.ceil(x))`.

- **A file being referenced is not a file being executed.** Every page, layout and route here
  was covered while 8 of 218 source files had **zero statements executed** — including
  `opengraph-image.tsx`, which the PRD calls the P0 launch blocker. A caller-based scan finds
  *references*; only a statement-level V8 run finds code that never ran:
  `npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=json
  --coverage.reportsDirectory=<named dir> --coverage.include='src/**/*.{ts,tsx}'`. Do this before
  claiming a slice is "the last untested code", and treat a file that is only ever `vi.mock`ed
  as unexecuted.
- **The report you read is part of the measurement.** A stale `coverage-final.json` from a run
  that wrote to a *different* directory reported freshly-tested files as still at zero, which
  looks exactly like a broken test and nearly sent a slice hunting a phantom bug. Always pass an
  explicit `--coverage.reportsDirectory`, and confirm which run produced a report before
  believing a number in it.
- **A fixture must make the rival answers differ, or the test passes for the wrong reason.** The
  OpenGraph card's "was" price is frozen at publish (`$20.00`) while the dish's current price is
  `$16.00`; the merchant's zone is `America/Toronto` while the host is `America/Edmonton`. A
  fixture where both agree cannot tell a correct implementation from one that reads the live row
  or formats in the host zone. Assert against the shared function **and** a literal.
- **A public endpoint that answers 200 on purpose must be byte-identical across refusal cases.**
  The missing-drop card is `toBe` on two full renders, not a spot-check of strings — otherwise
  the response shape distinguishes "unpublished" from "never existed" on an enumerable endpoint.
- **A refusing guard is testable without a credential; the credentialed half is not.** The charge
  port's unconfigured throw runs keyless (and proves `sk_`/`rk_` *prefix*, so `changeme` still
  refuses), while 141 of its 152 statements stay unexecuted behind the skipping live test. Do not
  let the guard suite's green imply capture is verified; keep the live test's named skip reason.
- **`vi.resetModules()` + a re-`import()` creates a second copy of every class in that module.**
  `toThrow(KnownError)` then fails against an instance that genuinely *is* `KnownError` from the
  other module instance. Before reaching for a reset, check whether the code reads its environment
  at **import** time or at **call** time — `realChargePort()` reads `process.env` at call time, so
  no reset was needed at all.

## Driving the running app in a browser

The Definition-of-Done browser step, with no new dependency. Node 24 has a global
`WebSocket`, Headless Chrome already exists on this machine as a Playwright *browser
download* with no driver, and CDP is plain JSON frames. Do not `npm install` Playwright
to answer a one-off question — `package-lock.json` is a deliverable.

```sh
# app on :3001, browser on :9333
~/.nvm/versions/node/v24.21.0/bin/node node_modules/next/dist/bin/next dev -p 3001 &
~/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  --headless --disable-gpu --no-first-run --remote-debugging-port=9333 --user-data-dir=$(mktemp -d) about:blank &
curl -s http://127.0.0.1:9333/json/version     # CDP is up when this answers
```

Then `PUT /json/new?url=about:blank` for a target and send `{id, method, params}` over
its `webSocketDebuggerUrl`. The verbs that answer each of the questions a render test
cannot:

| Question | Protocol |
|---|---|
| Does metadata reach a real `<head>`? | `Runtime.evaluate` on `document.title` / `querySelector('meta[property="og:image"]').content` |
| Is the OG card right *as pixels*? | `curl -o c.png …/opengraph-image && file c.png` → `1200 x 630` |
| Is CSS applied? | `getComputedStyle(document.body)` + count `document.styleSheets` rules |
| Does hydration throw? | `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`, listen **before** navigating |
| Is a redirect a real 307? | `Page.navigate` to `location.pathname`, or `curl -o /dev/null -w "%{http_code} %{redirect_url}"` |
| Is the form actually interactive? | click via `Runtime.evaluate`, then read `location.pathname` |
| What does a no-JS client see? | `Emulation.setScriptExecutionDisabled {value:true}` **before** navigating |

Four traps, all hit:

- **Clear cookies and prove you are logged out before testing a login form.** The first
  attempt "passed" because an existing session had redirected `/login` to `/admin/users`,
  and the button it clicked was *Create user*. Assert the precondition, then act.
- **Open a fresh target per scenario.** A reused target lets a navigation race a script
  that expected a form, producing `Cannot read properties of undefined` — which reads
  like a page bug and is a harness bug.
- **Set native values through the prototype setter and dispatch `input` + `change`.**
  Assigning `.value` alone does not update React's state, so the form submits empty.
- **`Runtime.evaluate` cannot run while scripts are disabled.** Toggle the emulation off
  first; the DOM persists, so read it after re-enabling.

What this pass measured, so it is not re-litigated: title/og/twitter/robots in a real
`<head>`, `image/png` at 1200×630, 59 applied CSS rules, zero hydration warnings, a real
`307 → /login?next=…`, an `httpOnly` `SameSite=Lax` cookie on login, a visible
wrong-password message, and a sign-out that clears the cookie and keeps `/admin/users`
shut. **Still unproven and should stay described that way:** a live join/capture (no
Stripe key), a third-party unfurler's cache, and the ten `/merchant/*` pages plus
`/organiser`, which this pass never visited.

**`next dev` is the wrong instrument for metadata.** Next's
`getSocialImageMetadataBaseFallback()` returns `createLocalMetadataBase()` *before* it reads
its argument when `NODE_ENV === 'development'`, so an explicit `metadataBase` is **discarded**
and the dev server shows `http://localhost:3000` whether the metadata is wired or not. A browser
pointed at `:3001` therefore cannot confirm or refute a `metadataBase` fix, and reading its
`localhost` as "still broken" is a false negative. Verify this class of change with a real
`next build` + `next start` (production), and include the **counterfactual** — the same build with
the fix removed — because a green result is otherwise compatible with a Next version that ignores
the field entirely. `next build` followed by `next start` on another port is also how the
`og:image` origin was proved on 2026-11-04; see *The share card was correct, and still pointed at
a laptop* in `docs/PROGRESS.md`.

## Non-negotiables

1. **Never charge before cutoff.** Authorise at join (`capture_method: manual`),
   capture at the cutoff. No `CHARGE` ledger entry may exist before then.
2. **The server authors every number; the model only words** (ADR-002).
3. **A sentence containing a money figure is a type signature** — read
   `CONTRIBUTING.md` before changing a label or a figure.
4. **Direct charges on the merchant's connected account** (ADR-001). A Stripe
   client is constructed only in `src/lib/payments/stripe.ts`; use
   `forMerchant(accountId)` for anything money-touching.
5. **A confirmed drop keeps taking joins to `maxQty`** (ADR-003). Do not
   reintroduce `THRESHOLD_MET`.
6. **Ledger identities L1–L5 hold** (ADR-004). Fee arithmetic lives in
   `platform-fee.ts`; never inline a rounding.
7. **Organisers never see participant phone numbers** (FR-805).
8. **Never build** the PRD §16 list: feed, discovery, reviews, social graph,
   delivery, native app, multi-item cart, loyalty, self-serve merchant signup,
   alcohol, organiser self-serve payouts.

## Definition of done for a slice

- Every FR in the slice has an automated test. Money paths get a fake-port test
  **and** a `describe.skipIf` live test with a named reason.
- Typecheck and lint clean.
- **`npm run verify` exits 0** — the suite plus a residue comparison against a baseline taken
  before it. `npx vitest run` alone is not this check: it reports green while rows accumulate. A
  slice whose teardown leaks is not done, and the leak will be blamed on whichever suite notices it
  next.
- The happy path and one failure path are exercised in a browser on the running
  app, not inferred from unit tests. Read the rendered HTML for money sentences.
  **This is possible now — see "Driving the running app in a browser" above.** It had been
  recorded as unmet in eight places across `docs/PROGRESS.md` because it cannot be done by a
  render test, which is true and is not the same as impossible.
- No PII in logs. ~~Analytics events required by PRD §10.1 are emitted.~~ **That sentence was
  false for the whole of M9** — eight §10.1 events were absent from `src/` entirely, not even in
  the `AnalyticsEventName` union. **Closed now:** all 16 §10.1 names exist and are emitted at the
  seams recorded in `docs/PROGRESS.md` (search *"§10.1 — the eight"* — not by line number,
  which moves). Three limits survive the fix, and this line is not evidence against any of them:
  `capture_*` fire only when something is actually captured, and no live Stripe capture has run
  here; the append happens **outside** the capture transaction, so a worker dying between the two
  leaves that capture unreported with no way to replay it from a local file; and a local JSONL
  sink is not durable on a serverless deploy. A new §10.1 name needs a builder in `funnel.ts`,
  an entry in `PRD_10_1_EVENTS`, and a wiring test that reads the JSONL back — a TS union cannot
  be enumerated at runtime, which is why the original gap went unnoticed.
- The commit message states the why and any defect found by inspection.
- `docs/PROGRESS.md` is updated in the same commit.

## Open product decisions — do not guess

| Decision | State | What to do |
|---|---|---|
| D-5 SMS provider | undecided | Build the `NotifyPort` seam; do not pick a vendor |
| SMS OTP for join | mentioned in PRD-sprint1 §9, specified by **no** FR | Do not build without explicit instruction |
| D-4 organiser commission payout | manual e-transfer, monthly | Never automate |
| Stripe test-mode keys | absent | Keep key-dependent code behind a port, flag and named skip |
