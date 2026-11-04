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
- Postgres must be running (`pg_isready`); the dev DB is `groupeat_dev`.
- No server runs by default. `npm run dev` serves on **:3001**.
- Full suite baseline: **1631 tests — 1623 pass, 0 fail, 8 skip.** Green on
  **Node 24.21.0 (`tzdata 2026c`) only.** This line used to claim it was green
  under PATH Node 22.22 (`tzdata 2025c`) as well; re-running it during gap 15
  showed that is false — exactly one test fails there (`shareMessageFor`,
  `Thursday 5:00 PM` vs the stale-rule `4:00 PM`). `.nvmrc` pins 24.21.0 and
  `engines` floors at `>=24.0.0` for that reason. If a time-related test starts
  failing, check the Node/tzdata version before touching the code under test:
  **Alberta adopted permanent DST on 2026-11-01** and is UTC−6 year-round, so any
  winter expectation hard-coded before that date is stale, not evidence of a bug.
  Do not "fix" `plan.ts` to match an old tzdata.
- The 8 skips are all Stripe-dependent: 1 in `fee-bearer.live.test.ts`, 2 in
  `real-charge-port.live.test.ts` (the whole file), and 5 in
  `real-payment-port.contract.test.ts` when `stripe-mock` is not running. No
  `STRIPE_SECRET_KEY` exists here, so **payments have never been verified against
  Stripe test mode**. A green suite is not payment verification.
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

- **`settlementFixtures.cleanup()` does not delete `User` rows, and five suites assumed it
  did.** It removes the drop, its participants and its customers. Every suite needing a
  real actor for `AuditLog.actorUserId` creates a `User` — the FK demands one — and then
  leaks it. 26 accounts per run across five files, all found by the check below. If a
  fixture creates a row and no `cleanup` names it, the suite owns deleting it.

**Verify teardown by counting, not by reading it.** `scripts/check-residue.mjs` does it:

```
node scripts/check-residue.mjs > /tmp/before.json
npx vitest run
node scripts/check-residue.mjs --compare /tmp/before.json   # exits 1 on any leak
```

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
- The happy path and one failure path are exercised in a browser on the running
  app, not inferred from unit tests. Read the rendered HTML for money sentences.
- No PII in logs. Analytics events required by PRD §10.1 are emitted.
- The commit message states the why and any defect found by inspection.
- `docs/PROGRESS.md` is updated in the same commit.

## Open product decisions — do not guess

| Decision | State | What to do |
|---|---|---|
| D-5 SMS provider | undecided | Build the `NotifyPort` seam; do not pick a vendor |
| SMS OTP for join | mentioned in PRD-sprint1 §9, specified by **no** FR | Do not build without explicit instruction |
| D-4 organiser commission payout | manual e-transfer, monthly | Never automate |
| Stripe test-mode keys | absent | Keep key-dependent code behind a port, flag and named skip |
