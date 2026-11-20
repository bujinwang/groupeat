# Verification: scoped global-count hardening

**Date:** 2026-11-06
**Program:** remove flakiness from the global-count hazard tests in the `groupeat` suite
**Status:** complete for the whole-table unscoped class; one related class left out of scope (see §6)

---

## 1. What a "global-count hazard" is

A test becomes fragile when it reads a **whole-table** row count from the shared
test database and uses that number to assert something — either

- **Class 1 ("nothing writes"):** read `prisma.X.count()` *before* an action and
  *after* it, and assert the two are equal, or
- **B-site ("global-contract read"):** the page under test prints a whole-table
  count, and the test asserts the rendered figure equals the live `prisma.X.count()`.

Both are torn reads against a database that other test files also write to. Under
parallel or leaked-row conditions a stranger's row can slip between the two reads
and make a perfectly good page fail the test. The fix is to scope the count to the
fixture's own namespace, or (where the page genuinely prints a whole-table number)
to bracket the rendered figure between the before/after reads.

---

## 2. The fix — scope by namespace, not by id-list

The shared helper `src/lib/testing/scoped-counts.ts` scopes "nothing writes"
counts to a **namespace predicate** a newly written row would also satisfy
(`merchantId` / `dropId` / `customerId` / participant / customer relations):

- `scopedCounts(db, scope, keys)` — counts `orders`, `drops`, `participants`,
  `shareLinks`, `audits`, `ledger`, `customers` limited to the fixture's
  namespace.
- `observedBracket(before, after)` — returns `{ min, max }` for B-sites where the
  page legitimately prints a whole-table count; the rendered figure is asserted
  `toBeGreaterThanOrEqual(min)` and `toBeLessThanOrEqual(max)`.
- `scopedShareLinkClicks(db, scope)` — the click counter.

**Why namespace and not an id-list?** Scoping by `id in [...]` would make the
Class-1 "nothing writes" assertion *vacuous*: a freshly written row has a brand-new
id and would never be counted in the first place, so the test would pass even if
the code wrote a row. The namespace predicate a real write would also match is what
keeps the assertion meaningful — proven by the in-situ mutation probe (§4).

The fixture `src/lib/settlement/__tests__/settlement-fixtures.ts` gained a
`scope()` method returning a **live** snapshot (`dropIds`, `merchantIds`,
`userIds`, `customerIds`, `participantIds`). It must be live because drops are
built inside `it()` blocks, so a `beforeAll` capture would be stale.

---

## 3. Inventory — 15 hazard test files

### Class 1 — "nothing writes" reads converted to `scopedCounts` (12 files)

| # | File | Scoped keys |
|---|------|-------------|
| 1 | `src/app/(admin)/admin/commission/__tests__/page.test.ts` | orders, drops, participants, shareLinks, audits |
| 2 | `src/app/(admin)/admin/drops/[id]/__tests__/page.test.ts` | orders, participants, audits, ledger |
| 3 | `src/app/(admin)/admin/drops/__tests__/page.test.ts` | orders, drops, participants, audits |
| 4 | `src/app/(organiser)/commission/__tests__/page.test.ts` | orders, drops, participants, shareLinks, audits |
| 5 | `src/lib/db/__tests__/commission.test.ts` | orders, ledger, drops, audits, participants |
| 6 | `src/app/api/merchant/pickup-queue/__tests__/route.test.ts` | drops, participants, customers, shareLinks, audits |
| 7 | `src/app/api/organiser/drops/__tests__/route.test.ts` | shareLinks, participants, audits |
| 8 | `src/app/api/organiser/commission/__tests__/route.test.ts` | orders, ledger, drops, audits |
| 9 | `src/lib/db/__tests__/commission-verification.test.ts` | orders, ledger, drops, audits (+ `scopedShareLinkClicks`) |
| 10 | `src/app/api/admin/commission/__tests__/route.test.ts` | orders, participants, audits (`toEqual`) |
| 11 | `src/app/api/organiser/drops/[id]/share/__tests__/route.test.ts` | `shareLinkCount()` / `auditCount()` helpers |
| 12 | `src/lib/join/__tests__/quote.test.ts` | `customerCount()` |

### B-site — whole-table global-contract reads bracketed with `observedBracket` (3 files)

| # | File | Whole-table read |
|---|------|------------------|
| B1 | `src/app/(admin)/admin/commission/__tests__/page.test.ts` | `prisma.organiserProfile.count()` |
| B2 | `src/app/(admin)/admin/drops/__tests__/page.test.ts` | `prisma.drop.count()` × 4 locations (All chip, unfiltered list, unparseable filter, DRAFT-empty) |
| B3 | `src/app/(admin)/admin/users/__tests__/page.test.ts` | `prisma.user.count()` — found by a residual sweep *after* the original 14-file claim; see §5 |

### Supporting changes (outside the test files)

- `src/lib/testing/scoped-counts.ts` (new, ~241 lines) — the helper + its docblock.
- `src/lib/testing/__tests__/scoped-counts.test.ts` (new) — zero-residue proof via
  rollback-only transactions; `observedBracket(3,5)` and `observedBracket(5,3)` both
  yield `{ min: 3, max: 5 }`.
- `src/lib/settlement/__tests__/settlement-fixtures.ts` — `participantIds` tracking
  + `scope()` method.
- `src/lib/db/__tests__/global-count-drift.test.ts` — doc comment corrected to note
  the shipped helper uses namespace scoping (the in-file `tx.*.count()` calls are the
  *old* naive pattern the drift-checker test demonstrates; they are intentional).

### Documentation corrections (6 locations)

`AGENTS.md`, `docs/PROGRESS.md` (3 spots), the helper docblock, and
`global-count-drift.test.ts` all carry dated (2026-11-06) notes stating the rewrite
is complete and that the feared "scoping makes us blind to writes" trade-off applies
only to the *id-list* shape, not the shipped *namespace* shape. The original
misclassification of `admin/users` as "a different shape, kept out of scope" was
corrected to "the 6th B-site."

---

## 4. Verification methodology

**Clean-tree residue gate** (`npm run verify`, pinned Node v24.21.0):

```
node scripts/check-interpreter.mjs
&& node scripts/check-residue.mjs --require-clean > .residue-before.json
&& vitest run
&& node scripts/check-residue.mjs --compare .residue-before.json
```

Success requires `REAL_EXIT=0`, `no residue — VERIFIED`, and the 12 counted tables
starting and ending at 0. `auditLogs` is the only expected-growth table and is
excluded from the fail decision; its historical per-run growth is `+73`.

The gate **refuses to certify a dirty tree** (`UNCOMMITTED WORK`) because `vitest`
reads the working tree, not `HEAD` — so every change is committed before the gate
runs.

**In-situ mutation probe (task #121):** a temporary `AuditLog.create` was injected
between the `before`/`after` reads of `api/admin/commission/route.test.ts`'s
"writes no rows" block, then removed byte-identically:

- writing to a **fixture** `dropId` → `audits 0 → 1`, assertion **failed** (scope
  detects the write);
- writing to a **stranger** `targetId` → ignored, assertion **passed** (scope immune
  to a stranger).

This is the empirical proof that namespace scoping still catches real writes.

**Independent certification:** a second full gate run, read-only against the same
committed tree, reproduces the result.

> The exact gate and certification figures (run counts, `auditLogs` growth) are
> recorded in the workspace daily log
> `.workbuddy-ai/memory/2026-11-06.md`, per the project discipline that live cert
> numbers live outside the repo. Both runs returned `VERIFIED` with all 12 counted
> tables at 0 → 0 and the expected `+73` growth.

---

## 5. How the 15th hazard was found

The original program claimed "14 files." A residual sweep after the fact grepped
every `prisma.X.count()` across `*.test.ts` (~90 reads). The overwhelming majority
carry a `where` pinned to the test's own fixture id (`dropId`, `merchantId`,
`orderId`, `email`, `phone`, `targetId`) and are therefore scoped *by construction*,
not hazards. Exactly **one** genuine whole-table read had escaped the inventory:

- `src/app/(admin)/admin/users/__tests__/page.test.ts:582` —
  `const liveTotal = await prisma.user.count()` (no `where`), then
  `expect(admission[2]).toBe(liveTotal)`.

It had been waved off as "a different shape," but it is the same B-site shape (the
page prints the whole-table user count and the test asserts equality). Treated as
B-site B3 with `observedBracket` and committed; the inventory is **15**.

---

## 6. Out of scope — predicate-scoped global-contract reads (flagged, not fixed)

The program targeted **whole-table** unscoped reads. Two reads are *predicate-scoped*
but still read a **global** predicate over the whole database (not pinned to the
test's own fixture id). They are outside the original scope and are disclosed here
rather than silently expanded:

| File | Read | Risk |
|------|------|------|
| `src/app/(organiser)/organiser/__tests__/page.test.ts:418` | `prisma.drop.count({ where: { status: 'PUBLISHED', cutoffAt: { gt: now } } })` then `expect(live).toBe(3)` | **Genuine cross-file leakage hazard.** Asserts an *exact* global predicate count; an earlier suite that leaks a `PUBLISHED` drop with a future cutoff shifts it. The in-code comment already acknowledges this ("another suite has leaked one"). |
| `src/app/(admin)/admin/users/__tests__/page.test.ts:807` | `prisma.user.count({ where: { role: 'ORGANISER', organiser: { is: null } } })` then `expect(total).toBe(liveProfileless)` | **Lower risk.** Both the assertion target (`liveProfileless`, line 807) and the page's `total` (line 812) are live reads of the same DB, sequentially, so within the sequential gate they agree; only a write in the ~5-line gap could split them (cannot happen under `fileParallelism: false`). |

**Not a hazard (verified):** every other `.count({ where: ... })` in the suite is
pinned to the test's own fixture id. The `tx.*.count()` calls in
`global-count-drift.test.ts` are inside the meta-test that demonstrates the old
pattern and run inside their own transaction.

**Recommendation:** if the user wants full closure, B3's `:807` can stay as-is
(low risk) and `organiser/page.test.ts:418` should be anchored to the test's own
fixture set (e.g. count only the drops this file creates) so it no longer depends on
the global `PUBLISHED` population. That is a separate, smaller slice.

---

## 7. How to re-verify

```bash
cd groupeat
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # pinned interpreter
npm run verify                                              # clean-tree gate
# re-run for independent certification:
npm run verify
```

Both runs should print `REAL_EXIT=0` / `CERT_EXIT=0`, `no residue — VERIFIED`, all
12 counted tables 0 → 0, and the expected `+73` `auditLogs` growth.
