# GroupEat — Sprint 1 PRD (M0 + M1)

**Version:** 1.0
**Date:** 2026-10-28
**Sprint:** 1 of 9 (weeks 1–2)
**Milestones covered:** M0 — Foundations · M1 — Margin Guardrail
**Derived from:** `groupeat-strategy/PRD-v1.md` (v1.0). This document **narrows** it; it never redefines it.
**Status:** Ready for architecture. Open questions in §10 need an answer before M1 code lands.

---

## 0. Document control

### 0.1 What this document is

A two-week slice of PRD-v1. It answers one question for the architect and the engineer: **what exactly ships at the end of week 2, and what is deliberately left out.**

### 0.2 Rules of precedence

| Conflict | Winner |
|---|---|
| Algorithm, formulas, test vectors | **PRD-v1 §7** — frozen. This doc never overrides it. |
| Sprint scope, product copy, UI behaviour, data field meaning | **This doc** |
| Anything not mentioned in either | Ask; do not invent |

### 0.3 The one thing that must be true on day 14

> The guardrail is a pure function with a passing test suite, and a merchant can see its output in plain language on a real screen.

Everything else in this sprint exists to make that sentence demonstrable.

---

## 1. Sprint goal and exit criteria

### 1.1 Goal (one sentence)

**A merchant with a seeded account can log in, record a dish with its real costs, and immediately see the lowest price they can charge for a batch deal and exactly what they keep per plate — produced by a pure, fully-tested function that refuses to return a losing price.**

No deal is created, no money moves, no customer exists. The number is the deliverable.

### 1.2 Exit criteria (all must pass — these are the sprint's definition of done)

| # | Criterion | How it is proven |
|---|---|---|
| AC-1 | `prisma migrate reset --force` from an empty database completes with zero errors and zero manual steps | Run it in CI from scratch |
| AC-2 | The 8 legacy models are gone from schema, code and routes, plus the now-orphaned `Restaurant` | `grep -ri` for `DiningGroup\|GroupMember\|GroupInvitation\|Review\|DishPost\|DishPostLike\|DishPostComment\|UserPreference\|Restaurant` returns 0 hits outside git history |
| AC-3 | Express is gone; one Next.js app serves web and API | Repo has one `package.json`, one dev server |
| AC-4 | Login works for ADMIN, MERCHANT and ORGANISER; unauthenticated access to a protected route redirects to `/login` | Manual + e2e |
| AC-5 | **All 5 test vectors in PRD-v1 §7.4 pass exactly** — A, B, C, D, E | Unit test, hard-coded expected values |
| AC-6 | Fuzz: 1,000 random valid inputs produce no `NaN`, no `Infinity`, no negative-price result, no exception other than `INCOMPLETE_COST_DATA` | Property test |
| AC-7 | Invariant holds on every fuzz case: `minViablePrice === null` **iff** the **fee-inclusive** `contributionCents` at menu price is below the floor | Property test (see §5.7 — this is provable, not just observable) |
| AC-8 | The guardrail module imports nothing from Prisma, `fs`, `fetch`, any AI SDK, or `Date.now()` | A test that asserts the module's import graph |
| AC-9 | Saving a dish with `foodCostCents >= menuPriceCents` is rejected server-side **and** client-side, with the exact copy in §5.5 | Integration test |
| AC-10 | All 7 guardrail panel states (§5.4) render with the specified copy | Snapshot tests |
| AC-11 | Test vector A, entered through the UI, renders the exact copy block in §5.3 | Manual on a real phone, screenshot kept |
| AC-12 | No PII (email, phone, name) appears in application logs | Log review + linter rule |

### 1.3 Non-criteria (do not gold-plate)

- No visual polish beyond "a merchant can read it on a phone without squinting".
- No loading skeletons, no optimistic UI, no animations.
- No i18n. English only.
- No mobile app, no PWA manifest, no service worker.

---

## 2. Scope map — every PRD-v1 FR, decided

**Legend:** ✅ in Sprint 1 · 🟡 partial (subset specified below) · ⛔ deferred to the milestone shown

### 2.1 §6.1 Merchant onboarding

| FR | Decision | Sprint note |
|---|---|---|
| FR-101 Ops creates Merchant + invites Owner by email (72h link) | 🟡 **S1-006** | Sprint 1 has no email delivery. Admin creates the account with a temporary password and `mustChangePassword=true`. The 72h invite link is M2. |
| FR-102 Stripe Connect Express onboarding | ⛔ M2 | No Stripe anywhere in Sprint 1. `Merchant.stripeAccountId` stays null. |
| FR-103 Pickup address + instructions | 🟡 **S1-006** | Fields editable on the merchant profile so the schema is exercised. Not displayed publicly (no public page yet). |
| FR-104 MenuItem with cost data | 🟡 **S1-012** | Full form for `name`, `menuPriceCents`, `foodCostCents`, `packagingCents`, `batchYield`, `prepMinutes`, `isBatchable`. No photo upload (M3). |
| FR-105 Mark item non-batchable | ✅ **S1-012** | Toggle. Non-batchable items show a disabled guardrail panel with explanation. |
| §6.1 P0 — reject `foodCost >= menuPrice` at save | ✅ **S1-012** | Copy in §5.5. This is the highest-value validation in the sprint. |

### 2.2 §6.2 Drop creation

| FR | Decision |
|---|---|
| FR-201…FR-208 (AI interview, 3 proposals, slider, window, publish, preview, snapshot freeze, cancel) | ⛔ **All M3.** Zero drop-creation UI in Sprint 1. |

> **Exception, deliberate:** S1-015 ships a **read-only price explorer** on the item screen. It reuses the FR-203 clamp rule so the clamp is proven before the slider exists, but it creates nothing and persists nothing. It is not FR-203.

### 2.3 §6.3 Public deal page

| FR | Decision |
|---|---|
| FR-301…FR-308 (SSR page, live count, scarcity, OG tags) | ⛔ **All M4.** No public route exists in Sprint 1. |

### 2.4 §6.4 Join flow · §6.5 Cutoff/capture

| FR | Decision |
|---|---|
| FR-401…FR-408, FR-501…FR-507 | ⛔ **M4 / M5.** No PaymentIntent, no cron worker, no ledger writes in Sprint 1. |

### 2.5 §6.6 Redemption · §6.7 Reporting

| FR | Decision |
|---|---|
| FR-601…FR-606 | ⛔ **M6** |
| FR-701…FR-705 | ⛔ **M7** |

### 2.6 §6.8 Organiser surface

| FR | Decision |
|---|---|
| FR-801…FR-805 | ⛔ **M7.** Sprint 1 creates `OrganiserProfile` records (schema + admin create) so the table is not empty, but there is no organiser UI. Login lands on a "no drops yet" placeholder. |

### 2.7 §6.9 Admin

| FR | Decision | Sprint note |
|---|---|---|
| FR-906 Manually create organiser accounts | ✅ **S1-006** | |
| FR-901 List/filter drops | ⛔ M8 | No drops exist yet |
| FR-902, FR-903, FR-904, FR-905 | ⛔ M8 | |

### 2.8 §9 AI · §10 Analytics

| Item | Decision |
|---|---|
| All of §9 (AI interview, organiser assistant, AiDraft, prompts) | ⛔ **M3 / M7.** `AiDraft` table is created by the migration but never written. |
| §10.1 events | 🟡 **S1-017** — only `guardrail_evaluated` and `guardrail_violation` emit. The rest arrive with their features. |
| §10.2 north-star dashboard | ⛔ M7. Nothing to measure yet. |

### 2.9 NFRs in scope for Sprint 1

| NFR | In Sprint 1 | Note |
|---|---|---|
| NFR-02 Mobile-first, 360px, no horizontal scroll | ✅ | The item form is the test case |
| NFR-03 Integer cents, CAD only | ✅ | Enforced by type + a lint rule; no float money anywhere |
| NFR-04 `America/Edmonton` | ✅ | Set as `Merchant.timezone` default and app display default |
| NFR-08 No PII in logs | ✅ | AC-12 |
| NFR-09 Admin actions audit-logged | 🟡 | Sprint 1 admin actions (create user, create merchant) write a structured log line. Full audit table is M8. |
| NFR-11 Secrets in env, never in repo | ✅ | `.env.example` committed, `.env` ignored, boot-time validation |
| NFR-01, 05, 06, 07, 10, 12 | ⛔ | No public page, no jobs, no launch surface yet |

---

## 3. User stories

Format: **As a [role], I want [capability] so that [outcome].** Each carries Given/When/Then acceptance conditions. Stories marked ⛔ are listed only to record what Sprint 1 deliberately does *not* give that role.

### 3.1 Merchant owner (the primary Sprint 1 user)

**US-M1 — Log in and land on my dishes**
As a merchant owner, I want to sign in and see my own dishes so that I never see another restaurant's data.

- **Given** an active MERCHANT user with a known password
- **When** I submit valid credentials at `/login`
- **Then** I am redirected to `/merchant/items`, and I see only items whose `merchantId` matches my `MerchantUser` record
- **And given** I am signed in as merchant A, **when** I request `/merchant/items/{itemOfMerchantB}`, **then** I get 404, not 403 (do not confirm existence of another merchant's data)

**US-M2 — Record a dish honestly, including its cost**
As a merchant owner, I want to enter what a dish sells for and what its ingredients cost so that the system can tell me whether a deal is even possible.

- **Given** I am on `/merchant/items/new`
- **When** I leave "Ingredient cost per plate" empty and press Save
- **Then** the form blocks with: *"We need this. Without it we can't tell you whether a deal makes money."*
- **And given** I enter menu price $9.00 and ingredient cost $8.50, **when** I press Save, **then** the form blocks with the copy in §5.5 (INVALID_COST_DATA) and the field is marked
- **And given** I enter valid values, **when** I press Save, **then** the item is persisted and the guardrail panel appears without a page reload

**US-M3 — See the lowest price I can charge, in my language**
As a merchant owner, I want to be told the lowest price I can put on a batch deal and what I keep per plate so that I never accidentally run a losing promotion.

- **Given** a saved dish priced $16.00 with ingredient cost $4.80 and packaging $0.80, and my minimum margin at the default 25%
- **When** the guardrail panel renders
- **Then** it shows exactly: lowest viable price **$11.12**, saving **$4.88 (31% off)**, **$4.01 kept per plate**, **25% of menu price**, break-even **71 of every 100 plates**
- **And** it shows the guidance line: *"So run this drop in a slot you're normally empty in."*
- **And** no number on screen was computed by the browser — all figures come from the server response

**US-M4 — Be told when a dish simply cannot be a deal**
As a merchant owner, I want a clear refusal instead of a bad price so that I don't learn this the hard way at month end.

- **Given** a dish priced $9.00 with ingredient cost $8.50
- **When** the guardrail evaluates
- **Then** no price is offered, and the panel shows the INFEASIBLE copy in §5.5 with the actual full-price contribution figure
- **And** I am offered two actions: "Try another dish" and "Change my minimum margin"
- **And** the panel never suggests a price "just to make the numbers work"

**US-M5 — Understand what "minimum margin" means before I change it**
As a merchant owner, I want the minimum-margin setting explained in money, not percentages, so that I don't lower it by accident.

- **Given** I open the minimum-margin setting
- **When** the field renders
- **Then** it shows the percentage **and** a live example at my own menu price: *"At 25%, a $16.00 dish must leave you at least $4.00 per plate."*
- **And** lowering it below `FLOOR_WARN_THRESHOLD` (0.15) shows the frozen warning below — **it states the consequence, and it does not block the save**
- **And** it cannot be set to 0 or negative (hard reject, server-side too)

**Frozen copy — the floor warning (`floorPctOfMenu < 0.15`)**

```
A 10% minimum is very thin.
At that rate you'd keep $1.60 on a $16.00 dish. That still has to
cover labour and rent — the lower this goes, the more likely a batch
ends up costing you money.
```

Template: `A {pct}% minimum is very thin.` / `At that rate you'd keep {amount} on a {menuPrice} dish. That still has to cover labour and rent — the lower this goes, the more likely a batch ends up costing you money.`

`{pct}` is substituted **once**, in the headline; the body says "at that rate" rather than repeating it. Fewer substitutions, and it reads like a person wrote it.

| Placeholder | Value |
|---|---|
| `{pct}` | the value being set, as an integer (`10`, not `10.00`) |
| `{amount}` | `menuPrice × pct`, formatted as money — the floor expressed in dollars, e.g. `$1.60` |
| `{menuPrice}` | the merchant's own highest-priced dish; falls back to `$16.00` only if they have no dishes yet |

**Why the wording is "that still has to cover labour and rent" rather than a statistic.** The guardrail protects *contribution* only — it deliberately excludes labour and rent, because those are fixed and the batch is meant to absorb them. So a floor of 10% is not "a 10% profit"; it is 10% of menu price left to pay for everything else. Saying that plainly is the honest warning. **Do not put a number like "most restaurants need 20%" in this copy** — it is not derivable from the model and it would be an invented statistic on a screen the merchant is meant to trust.

**Placement rule — this is a requirement, not a styling note.** The warning appears **only after the merchant has opened the settings page**, on exactly two triggers:

| # | Trigger | Behaviour |
|---|---|---|
| a | The merchant drags or types a value below 15% | Warning appears inline, immediately, under the field. Save still works. |
| b | The saved value is already below 15% (e.g. ops set it) and the merchant opens the page | Warning is shown in place under the current value, so the state is not invisible |

**It must never appear** on first login, on the dish screen, in the guardrail panel, as a modal or interstitial, as a toast, or by email. A merchant who has not gone looking for this setting has not made a decision about it yet — warning them before they have a reason to care teaches them to dismiss our warnings, which is the one thing we cannot afford on the screen that is supposed to stop them losing money.


**US-M6 — Change a cost later without the old numbers haunting me**
As a merchant owner, I want editing an ingredient cost to immediately re-price the dish so that I'm never looking at a stale recommendation.

- **Given** a saved dish showing a $11.12 lowest price
- **When** I raise the ingredient cost from $4.80 to $6.00 and save
- **Then** the panel re-evaluates and shows the new (higher) lowest price
- **And** the response is marked with the evaluation timestamp so I can tell it is fresh
- **Note:** Sprint 1 has no drops, so there is no frozen snapshot to protect. Snapshot immutability is M3 (FR-207).

**US-M7 — Not be able to lie about my price**
As the business, I want the server to recompute every price so that a tampered client cannot publish a margin-destroying deal.

- **Given** a client that POSTs `{ dealPriceCents: 500 }` for a dish whose `minViablePriceCents` is 1112
- **When** the server handles it
- **Then** the server recomputes and responds with `isBelowFloor: true` and the corrected `minViablePriceCents`
- **And** the submitted value is **never** echoed back as accepted
- **And** a `guardrail_violation` event is emitted (S1-017)

### 3.2 Organiser

**US-O1 — Have an account that exists but does nothing yet**
As an organiser, I want to log in and be told the product isn't ready for me yet, so that I don't think the system is broken.

- **Given** an ORGANISER user
- **When** I log in
- **Then** I land on a page stating: *"No drops available yet. Your first drop will appear here. Nothing for you to do."*
- **And** I cannot reach `/merchant/*` or `/admin/*` (redirect, not error page)
- **And** I see no participant data of any kind — the table is empty and stays empty

**⛔ Not in Sprint 1:** share links, group progress, commission statement, drop ranking (FR-801…FR-805, M7).

### 3.3 Admin

**US-A1 — Create the accounts the beta needs**
As an admin, I want to create a merchant with its owner, and an organiser, so that the guardrail can be demonstrated against real merchant records.

- **Given** I am signed in as ADMIN
- **When** I create a merchant with name, slug and timezone
- **Then** the merchant exists with `status=PENDING` and `floorPctOfMenu=0.25`
- **And when** I attach an owner by email with a temporary password, **then** a MERCHANT user is created with `mustChangePassword=true` and a `MerchantUser` link with role OWNER
- **And given** I submit a duplicate email, **then** I get a field-level error, not a 500
- **And** every create action writes one structured log line with actor id, entity and id

**US-A2 — See what the guardrail said**
As an admin, I want to see the guardrail evaluation for any merchant's dish so that I can answer a merchant's complaint with facts.

- **Given** I am ADMIN
- **When** I open any merchant's dish
- **Then** I see the same guardrail panel the merchant sees, plus the raw input/output object
- **And** I cannot change the merchant's floor from this view (read-only, FR-904 is M8)

### 3.4 Merchant staff

**⛔ Entirely out of scope for Sprint 1.** `MerchantRole.STAFF` exists in the enum and `MerchantUser` supports it, so no migration is needed later. No staff UI, no QR, no redeem screen (M6).

### 3.5 Participant (diner)

**⛔ No interface in Sprint 1 — but the data model must be ready.**

This is a real requirement, not a placeholder. The `Customer` and `DropParticipant` tables are created by this sprint's migration, with these properties already correct:

- `Customer` is keyed by `phone` (unique, E.164), has no password field, and has no relation to `User`. A diner is never an account.
- `DropParticipant` has `@@unique([dropId, customerId])` — one join per person per drop, enforced by the database, not by application code.
- `DropParticipant.amountCents` and `platformFeeCents` are non-nullable `Int` — a participant cannot exist without a priced order.
- Money columns are integer cents; there is no `Float` or `Decimal` money column anywhere in the schema except `OrganiserProfile.commissionPct` and `Merchant.floorPctOfMenu`, which are rates, not money.

**Why this belongs in Sprint 1:** if `Customer` ships with a `passwordHash`, or `DropParticipant` ships without the unique constraint, the join flow in M4 has to fight the schema. Getting this right costs nothing now and costs a migration later.

**US-P1 (data-level acceptance):** Given the migration has run, when a developer inspects the `Customer` table, then there is no credential column and no foreign key to `User`.

---

## 4. Requirement pool

### 4.1 P0 — must ship, sprint fails without it

| ID | Requirement | Traces to | Acceptance |
|---|---|---|---|
| **S1-001** | Single Next.js 15 App Router application at repo root. Express server, `src/routes/*`, `src/index.ts`, `authMiddleware` and the backend `package.json` are deleted. `bcryptjs` + `jsonwebtoken` logic is ported, not rewritten from scratch. | M0, PRD-v1 §13.1 | One `package.json`, one `next dev`, `npm run build` succeeds |
| **S1-002** | Prisma schema = PRD-v1 §5.1 in full, **plus the Sprint 1 deltas in §8 of this doc**. Every model in §5.1 is created, including ones Sprint 1 does not use. | M0, §5.1 | `prisma validate` passes; model count matches §5.1 + deltas |
| **S1-003** | Delete `DiningGroup`, `GroupMember`, `GroupInvitation`, `Review`, `DishPost`, `DishPostLike`, `DishPostComment`, `UserPreference` and every route that served them. Delete `Restaurant` too — after `Review` and `DishPost` go it has no referent, and `Merchant` replaces it. **If geo data is ever needed, `latitude`/`longitude`/`googlePlaceId` go on `Merchant` — not on a resurrected `Restaurant`.** | M0, §5.2 | AC-2 grep is clean |
| **S1-004** | Fresh migration history. Old 4 migrations are removed from the working tree (kept in git history). `prisma migrate reset` runs clean from zero. | M0 | AC-1 |
| **S1-005** | Email + password auth. `bcryptjs` (cost 10), JWT in an **httpOnly, SameSite=Lax, Secure-in-prod cookie** (not localStorage). Session 60 min sliding, 7-day absolute. Roles `ADMIN` / `MERCHANT` / `ORGANISER` enforced in middleware, not only in the UI. `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. | M0, §3.1 | AC-4 |
| **S1-006** | Admin bootstrap surface at `/admin/users`: create user with role, create merchant, attach owner, edit merchant pickup address/instructions, set `floorPctOfMenu`. Plus a `prisma/seed.ts` that creates one admin, three merchants and the five vector dishes. | M0, FR-101🟡, FR-103, FR-906 | A fresh DB + seed yields a login that works, first try |
| **S1-007** | Env config validated at boot: missing `DATABASE_URL` or `JWT_SECRET` fails fast with a readable message. `.env.example` committed with every key and a comment. | M0, NFR-11 | Delete `JWT_SECRET` → app refuses to start with a clear error |
| **S1-010** | Pure guardrail module. Zero I/O, zero DB, zero AI, no `Date.now()`, no `Math.random()`. Exports `minViablePrice(input)` and `evaluateDeal(input, dealPriceCents)`. Throws `GuardrailError('INCOMPLETE_COST_DATA')` when `foodCostCents` is null/undefined/NaN. **Behaviour is exactly PRD-v1 §7.2–§7.3.** | M1, §7 | AC-8 |
| **S1-011** | Test suite: the 5 §7.4 vectors with hard-coded expectations, plus a 1,000-case fuzz, plus the null-iff invariant (§5.7). `minViablePrice` must be exact, not "close". | M1, §7.4 | AC-5, AC-6, AC-7 |
| **S1-012** | Merchant dish form (create + edit) with all cost fields, client-side and server-side validation, and the FR-104/FR-105 behaviours. | FR-104🟡, FR-105 | AC-9 |
| **S1-013** | `POST /api/merchant/items/:id/guardrail` — read-only evaluation. Body `{ dealPriceCents? }`. Returns the object in §5.2. Never persists. Recomputes server-side from DB values; **ignores any cost or floor value sent by the client.** | M1 | AC-11 |
| **S1-014** | Guardrail panel component covering all 7 states in §5.4, with the exact copy in §5.3 and §5.5. | M1 | AC-10 |
| **S1-016** | Server-side re-validation on every write path that touches a price: recompute, never trust the client. In Sprint 1 the only such path is the item form (cost sanity) — the drop path arrives in M3 and must reuse this function. | M1, §9.2 post-validation | US-M7 |
| **S1-018** | `floorPctOfMenu` lives on `Merchant` (per-merchant, default 0.25), editable by the owner, hard-rejected at ≤ 0 or > 1. The guardrail reads it from the merchant record, never from the request body. | §7.1, D-6 | Change it and every dish on that account re-prices |
| **S1-025** | `containsAlcohol` is **merchant-editable** on the dish form. Flipping `true → false` requires a **factual confirmation** with the frozen copy in §5.5a, and every change emits `item_alcohol_flag_changed` (S1-017). The block itself is unaffected: while the flag is `true`, the item is deal-ineligible, permanently, with no override. | D-2, §15.2, §5.5a | Flag on → no price, ever. Flag off → normal evaluation. Every transition is auditable. |

### 4.2 P1 — should ship, cut first if time runs short

| ID | Requirement | Note |
|---|---|---|
| **S1-008** | App shell: role-aware nav, layout, 404/403 pages, sign-out | Without it the demo is ugly, not wrong |
| **S1-015** | Read-only price explorer on the dish screen: a stepper/slider from `minViablePriceCents` to `menuPriceCents` that re-renders the panel. **Hard clamp at the bottom; no text entry below it.** Creates and persists nothing. | Proves the FR-203 clamp before M3 builds the real one |
| **S1-017** | Analytics: emit `guardrail_evaluated { itemId, minViablePriceCents, isBelowFloor }`, `guardrail_violation { itemId, submittedPriceCents, floorPriceCents }` and `item_alcohol_flag_changed { itemId, merchantId, actorUserId, from, to, changedAt }` to a local append-only log file (no vendor SDK yet). Append-only event stream — **no new table in Sprint 1.** | The violation counter is how M3's 1% alert gets its baseline. The alcohol event is how we answer an AGLC question about who changed what, when — the licence liability sits with the merchant, so the trail has to exist before the first edit, not after the first incident. |
| **S1-019** | `mustChangePassword` forced redirect: a user with the flag set can only reach the change-password screen until it is cleared | Makes the temp-password bootstrap honest |
| **S1-020** | Dish list shows each item's lowest viable price as a column, so the merchant can compare dishes at a glance | Cheap, high value — this is the screen that answers "which dish should I deal?" |

### 4.3 P2 — nice to have, do not start before P0+P1 are green

| ID | Requirement |
|---|---|
| S1-021 | Merchant-level "compare dishes" view sorted by achievable discount depth (the real answer to "which dish is a deal item") |
| S1-022 | Copy-to-clipboard on the guardrail summary block |
| S1-023 | Guardrail evaluation cached per `(itemId, updatedAt)` to avoid recompute on every render |
| S1-024 | A `/admin/guardrail-lab` page where an admin types any numbers and sees the raw function output — a debugging tool for merchant complaints |

---

## 5. Product specification — the margin guardrail

> **Read this first:** the algorithm is frozen in PRD-v1 §7. This section defines **what the merchant sees, what the fields mean, and what happens when it goes wrong.** If any sentence here appears to change a formula, this document is wrong and PRD-v1 §7 wins.

### 5.1 Input fields, in merchant language

These are the labels the merchant reads. The technical names are for the engineer only and must never appear on screen.

| Technical field | Merchant-facing label | Helper text (shown under the field) | Required | Validation |
|---|---|---|---|---|
| `menuPriceCents` | **What you normally charge** | "The price on your menu today. This is the 'was' price customers will compare against, so it has to be your real price." | Yes | > 0, ≤ $500.00 |
| `foodCostCents` | **Ingredient cost per plate** | "Just the food. Not labour, not rent, not the gas bill. A rough number is fine — you can fix it later." | Yes | ≥ 0, and **< menu price** |
| `packagingCents` | **Container cost per order** | "Box, lid, bag, cutlery. Put 0 if it leaves the counter on a tray." | Yes (defaults to 0) | ≥ 0, < menu price |
| `batchYield` | **How many can you make in one batch** | "Without slowing down normal service. This caps the batch size, so be honest — 20 is a good batch, 60 is a different kitchen." | Yes | integer ≥ 1, ≤ 200 |
| `prepMinutes` | **Minutes to make one plate** | "Optional. Helps us sanity-check the batch size." | No | 1–240 |
| `isBatchable` | **Can this dish be batched?** | "Turn this off for anything you can't make 20 of at once — steaks, fried-to-order, anything plated by hand." | Yes (default true) | boolean |
| `Merchant.floorPctOfMenu` | **Your minimum margin** | "The least you'll accept per plate on a batch order, as a share of your menu price. Default is 25%." | Yes (default 0.25) | 0 < x ≤ 1; warn under 0.15 |

**On the word "floor":** the merchant never sees it. Internally and in code, `floor` / `floorPctOfMenu` is fine. On screen the concept is called **"your minimum margin"**, and it is always shown with a dollar example at the merchant's own menu price so the abstraction has a number attached.

**On `packagingCents` and pickup:** because GroupEat is pickup-only, packaging is often the only variable cost besides food. Do not let the merchant skip it — but default to 0 and say why, rather than blocking on it.

### 5.2 Output fields, and what each one means to the merchant

| Technical field | Merchant-facing phrase | Meaning the merchant must be able to take away |
|---|---|---|
| `minViablePriceCents` | "Lowest price that still works" | The floor of the price control. Not a suggestion — a limit. |
| `dealPriceCents` | "Deal price" | What the diner pays per plate |
| `menuPriceCents − dealPriceCents` | "They save $X" | The honest saving. Never a merchant-typed "was" price (Competition Act, PRD-v1 §15.2). |
| `contributionCents` | "You keep $X per plate" | After ingredients, packaging, card fees **and** our fee. Not "profit" — it still has to pay for labour and rent. |
| `contributionPctOfMenu` | "That's N% of your menu price" | Comparable across dishes, which dollars are not |
| `platformFeeCents` | "our fee ($X)" | Always disclosed as a line item. No surcharges, ever. |
| `fullPriceContributionCents` | "At full price you keep $Y per plate" | The number the discount is measured against. Only shown in the INFEASIBLE state (§5.5) and in the expanded detail. |
| `breakEvenIncrementality` | "N of every 100 plates must be new customers" | **The single most important number on the screen.** Expressed as a count out of 100, never as a bare percentage. |
| `isBelowFloor` | — | Internal. Drives the red state. Never rendered as a raw boolean. |

**Rounding rules (display only — the stored values stay exact):**

- Money: 2 decimals, always with `$`. `1112` → `$11.12`.
- Saving percentage: nearest whole percent, half up. `30.5%` → `31%`. The exact dollar figures are always shown alongside, so the percentage is never the only evidence.
- Break-even: nearest whole integer out of 100. `0.7062` → `71`.
- `contributionPctOfMenu`: nearest whole percent. `0.2505` → `25%`.
- Never display a money figure that has been recomputed in the browser. Formatting is client-side; arithmetic is not.

### 5.3 The copy block — frozen strings

This is the template the merchant sees when a price is viable. **Vector A must produce this exactly.**

```
┌────────────────────────────────────────────────────────┐
│  $11.12 per plate   ·   normally $16.00                │
│  They save $4.88  (31% off)                            │
│                                                        │
│  You keep $4.01 per plate after ingredients,           │
│  packaging, card fees and our fee ($0.89).             │
│                                                        │
│  That's 25% of your menu price — exactly your          │
│  minimum.                                              │
│                                                        │
│  To break even, 71 of every 100 plates must go to      │
│  people who would not have eaten here otherwise.       │
│                                                        │
│  → So run this drop in a slot you're normally empty    │
│    in. If it fills a busy hour, you lose money.        │
└────────────────────────────────────────────────────────┘
```

**Line 5 (the "that's N% …" clause) has three variants:**

| Condition | Line 5 text |
|---|---|
| `dealPriceCents === minViablePriceCents` | "That's 25% of your menu price — exactly your minimum." |
| `dealPriceCents > minViablePriceCents` | "That's 28% of your menu price — 3 points above your minimum." |
| `isBelowFloor` | "That's 18% of your menu price — below your minimum." (only in the blocked state) |

**Line 7 (the guidance sentence) is chosen by a rule, not generated.** In Sprint 1 there is no AI. The rule is a lookup on `breakEvenIncrementality`, and the strings are fixed:

| `breakEvenIncrementality` | Guidance line |
|---|---|
| < 0.50 | "→ So run this drop in a slot you're normally empty in. This one is cheap to run — you have some room." |
| 0.50 – 0.649 | "→ So run this drop in a slot you're normally empty in, and start with 20 units." |
| **0.65 – 0.799** | **"→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money."** |
| ≥ 0.80 | "→ Most of these plates must be people who would not have come. Only run this at a time you're normally empty — and consider a cheaper dish instead." |

All four vectors land in 0.50–0.799 except C (0.586). Vector A (0.706) and B (0.737) use the **bolded** line — which is the sentence in PRD-v1 §7.6, preserved verbatim. When M3 adds the AI, the AI may reword this line but **may not change the bucket** — the bucket is a function of the number, and the number comes from the guardrail.

### 5.4 The seven states

The panel is a state machine. Exactly one state renders at a time. The state is decided by the **server response**, not by client logic.

| # | State | Decided by | Colour | Headline | Primary action |
|---|---|---|---|---|---|
| 1 | `OK` | viable **and** discount ≥ 10% | green | "This works." | "Use this price" |
| 2 | `FLOOR` | viable and `dealPrice === minViablePrice` | green | "This is the lowest price that still works." | "Use this price" |
| 3 | `THIN` | viable and discount < 10% | amber | "Profitable, but nobody will bite." | "Try a cheaper dish" |
| 4 | `BELOW_FLOOR` | `isBelowFloor === true` | red | "That price loses you money." | "Jump to $11.12" |
| 5 | `INFEASIBLE` | `minViablePriceCents === null` | red | "This dish can't be a deal at your minimum margin." | "Try another dish" |
| 6 | `INCOMPLETE_COST_DATA` | function threw | red | "We need your ingredient cost first." | "Add ingredient cost" |
| 7 | `INVALID_COST_DATA` | form validation (never reaches the function) | red | "Check your numbers." | "Fix the numbers" |

**State precedence — evaluate top to bottom, first match wins.** Without an explicit order, case C (at the floor *and* a 2.7% discount) is ambiguous.

| Order | State | Test |
|---|---|---|
| 1 | `INVALID_COST_DATA` | form validation failed, or `foodCost + packaging >= menuPrice` |
| 2 | `INCOMPLETE_COST_DATA` | `foodCostCents` is null / undefined / NaN |
| 3 | `INFEASIBLE` | `minViablePriceCents === null` |
| 4 | `BELOW_FLOOR` | `isBelowFloor === true` |
| 5 | `THIN` | discount < 10% |
| 6 | `FLOOR` | `dealPriceCents === minViablePriceCents` |
| 7 | `OK` | otherwise |

So case C renders as `THIN`, not `FLOOR` — the "won't sell" problem is the more actionable of its two properties, and the `THIN` copy still shows the contribution figure, so nothing is hidden.

**Why `THIN` is a separate state and not just "OK with a small discount":** PRD-v1 §7.4 case C is the reason. A $12.00 dish with $6.60 of ingredients is *profitable* at $11.68 — and completely useless, because 2.7% off moves nobody. The panel must say both things at once: it makes money, and it won't sell. The merchant who sees only "This works" will run a dead drop and conclude the platform doesn't work.

**The 10% threshold is a product judgement, not arithmetic.** It is a config constant (`THIN_DISCOUNT_THRESHOLD = 0.10`), not a magic number in a component. See §10, Q-2.

### 5.5 Error and edge-case copy — frozen strings

**`INCOMPLETE_COST_DATA`** — `foodCostCents` is null / undefined / NaN

```
We need your ingredient cost first.
We can't tell you whether a deal makes money without knowing what the
food costs you. A rough number is fine — you can correct it later.

[ Add ingredient cost ]
```

**`INVALID_COST_DATA`** — `foodCostCents >= menuPriceCents`, or any cost < 0, or `menuPriceCents <= 0`

```
Check your numbers.
You charge $9.00 but the ingredients cost you $8.50. A discount can't fix
a dish that barely makes money at full price — it would only make it worse.
Fix the two numbers, or pick a different dish.

[ Fix the numbers ]
```

> This is the FR-104 P0 and it is the highest-value validation in the sprint. It is enforced **at save**, in the form **and** on the server. Nonsense must never reach the guardrail.

**`INFEASIBLE`** — `minViablePriceCents === null`

```
This dish can't be a deal at your minimum margin.
At full price ($9.00) you keep $X per plate after ingredients, packaging,
card fees and our fee. Your minimum is $2.25 per plate. There is no price
that clears both, so we won't suggest one.

Two ways out:
  · Pick a dish with cheaper ingredients — that's usually the right answer.
  · Lower your minimum margin, if you're willing to earn less per plate.

[ Try another dish ]   [ Change my minimum margin ]
```

Where `$X` is **`evaluateDeal(input, menuPriceCents).contributionCents`** — the fee-inclusive figure, because the sentence says "and our fee" and must match the number it quotes. **Not** `fullPriceContributionCents`, which excludes the platform fee (PRD-v1 §7.7); quoting it here would understate the deduction by exactly the fee and the copy would be lying to the merchant. Using the fee-inclusive figure also makes the copy consistent with the predicate in §5.7 — the same quantity is compared against the floor and shown to the merchant.

It may be negative; format negatives as `-$1.08` and add the sentence: *"At full price this dish already loses money."* (Vector D: `900 − 850 − 30 − 56.10 − 72 = −$1.08`.)

**`BELOW_FLOOR`** — a price below the floor was submitted (tampered client, or a stale page after a cost edit)

```
That price loses you money.
$5.00 is below the lowest price that still clears your minimum margin.
The lowest price that works is $11.12.

[ Use $11.12 instead ]
```

**`THIN`** — viable, but the discount is under 10%

```
Profitable, but nobody will bite.
At $11.68 you'd keep $3.01 per plate — that part is fine.
But it's only 3% off your $12.00 menu price. A 3% saving won't make
anyone change their lunch plans.

This dish has expensive ingredients, so there's very little room. It is
a fine dish to sell normally; it is a poor dish to discount.

[ Pick another dish ]
```

> **Do not soften this.** PRD-v1 §7.4 is explicit: do not lower the floor to make case C look better. The honest answer is "this isn't a deal item", and saying so is the product working.

**Non-batchable item**

```
This dish is marked as not batchable.
You've told us you can't make 20 of these at once, so there's no batch
to price. Turn batching back on if that's changed.

[ Edit this dish ]
```

**Alcohol — `containsAlcohol = true`** (AGLC hard block, PRD-v1 §15.2, D-2)

```
This dish contains alcohol, so it can't be part of a deal.
Alcohol can't be sold through a GroupEat drop under Alberta's AGLC
liquor rules — that's regulation, not something we can switch off.
There's no exception for this dish.

[ Edit this dish ]
```

Frozen string. Three things this copy must do, and the third is the one that is easy to miss:

1. **State the outcome** — this dish cannot be a deal. Not "is discouraged", not "needs review".
2. **Close the door** — "no exception", so no merchant spends a week asking ops to enable it.
3. **Name the regulator, not us.** The sentence must attribute the block to *Alberta's AGLC liquor rules*, and must say plainly that it is not a GroupEat setting. Without this, the merchant reads a platform policy and concludes we are punishing them — and a merchant who thinks a rule is arbitrary will route around it (mislabel the dish, rename it, take the order off-platform). A merchant who understands it is regulation complies, and stops asking.

**Do not** add "we're sorry", "unfortunately", or any apology. Apologising implies we could fix it and chose not to, which is both untrue and an invitation to escalate. State it and move on — same voice as the non-batchable block above.

`[ Edit this dish ]` is the only correct action, even though it cannot remove the block: the flag may be on the wrong dish, and checking that is the only useful thing the merchant can do here.

### 5.5a The alcohol flag is editable — confirmation copy

**Decision (S1-025): the merchant may edit `containsAlcohol` themselves.** The block is not a lock on the field; it is a rule that applies *while* the field is `true`. A merchant who mislabelled a dish must be able to correct it — otherwise they create a duplicate dish and file a bug, and we have taught them that the form lies.

Flipping `true → false` requires a confirmation. Flipping `false → true` requires none.

**Frozen copy — confirmation on `true → false`**

```
Confirm this dish contains no alcohol.
If it does, it can't be sold through a drop.

[ Yes, this dish has no alcohol ]   [ Cancel ]
```

| Rule | Why |
|---|---|
| **Ask about the fact, not the intention** | "Are you sure?" asks the merchant to confirm a decision, and gets a reflex click. This asks them to assert a fact about the dish — which is the thing that is actually true or false, and the thing the AGLC cares about. |
| Default focus on **Cancel** | The confirm button is the only way through; it must not be the default that a double-tap hits. |
| One dialog, two buttons | No checkbox-plus-button double confirmation. Two gates on a correction teaches the merchant to click through both. |
| `false → true` needs no confirmation | Adding the flag only makes the item safer to exclude. Friction there would discourage correct labelling, which is the opposite of what we want. |

Every transition emits `item_alcohol_flag_changed { itemId, merchantId, actorUserId, from, to, changedAt }` (S1-017). Append-only, no table. **Rationale:** liquor licence liability sits with the merchant, not with us — so when an AGLC question arrives, we must be able to say who changed the flag and when. That trail has to exist before the first edit, not after the first incident.

**Copy lock.** Every string in §5.5 and §5.5a is **final**. `panelCopy`, `ineligibleCopy` and any confirmation dialog must render them verbatim from this document — no paraphrase, no "improvement", no extra sentences, no apology clauses. If a state needs wording this document does not cover, **that is a gap in this document: report it to the PM, do not fill it in code.** A self-authored string becomes a frozen string the moment a test snapshots it, and nobody will remember it was invented.

### 5.6 Where the guardrail is enforced

| Layer | What it does | What it must never do |
|---|---|---|
| **Pure module** | Computes. Only computes. | Touch the DB, the network, the clock, or a random source |
| **API endpoint** | Loads the item + merchant floor from the DB, calls the module, returns the result with a `computedAt` timestamp | Accept a cost or floor value from the request body |
| **Client** | Renders. Formats cents to dollars. Shows the state. | Perform arithmetic on money; decide the state; allow a price below the floor |
| **Future write paths (M3)** | Re-run the module, clamp up, log a violation | Trust a client-submitted price |

The rule in one line: **the browser formats, the server computes, the function decides.**

### 5.7 An observation for the architect (not a change)

Because contribution is strictly increasing in price — `d(contrib)/dP = 1 − 0.029 − 0.08 = 0.891` in the proportional-fee regime, and `0.971` in the fee-floor regime — the following holds:

> `minViablePrice(input) === null` **iff** contribution at `menuPriceCents` is below the floor.

Consequence: the search's lower bound of `ceil(menuPrice × 0.5)` never *causes* a null result. It only bounds the returned price. This gives the test suite a much stronger assertion than "the 5 vectors pass":

```ts
// AC-7, on all 1,000 fuzz cases
// corrected: predicate uses contributionCents, which includes the platform fee.
// Do NOT use fullPriceContributionCents — per PRD-v1 §7.7 that figure excludes the
// platform fee, so comparing it against the floor tests a different quantity.
expect(minViablePrice(input) === null)
  .toBe(evaluateDeal(input, input.menuPriceCents).contributionCents < floorOf(input));
```

**Why `contributionCents` and not `fullPriceContributionCents`** — these are two different quantities and the distinction is easy to get wrong:

| Field | Platform fee included? | Example: `menu=1000, food=715, pack=0, floor=0.15` |
|---|---|---|
| `fullPriceContributionCents` | **No** (PRD-v1 §7.7) | `1000 − 715 − 0 − 59 = 226` |
| `contributionCents` at `menuPriceCents` | **Yes** | `226 − 80 = 146` |
| Floor (`0.15 × 1000`) | — | `150` |

`minViablePrice` decides using the fee-inclusive figure, so it correctly returns `null` here (146 < 150). An assertion built on `226 < 150` evaluates to `false` and would demand a non-null price — a red test against correct code. That is exactly the failure mode that gets someone to "fix" the frozen algorithm.

It also means `INFEASIBLE` has exactly one honest explanation — *"this dish doesn't clear your margin even at full price, after our fee"* — and the UI copy above is correct rather than a guess. **Do not change the algorithm to exploit this.** Use it as a test.

---

## 6. UI specification

Three screens and one component. Text wireframes only; no visual design in this sprint. All layouts must work at 360px with no horizontal scroll (NFR-02).

### 6.1 `/login`

```
┌─────────────────────────────────────┐
│                                     │
│            GroupEat                 │
│                                     │
│  Email                              │
│  ┌───────────────────────────────┐  │
│  │                               │  │
│  └───────────────────────────────┘  │
│                                     │
│  Password                           │
│  ┌───────────────────────────────┐  │
│  │                               │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌───────────────────────────────┐  │
│  │           Sign in             │  │
│  └───────────────────────────────┘  │
│                                     │
│  ⚠ Email or password is incorrect.  │
│                                     │
└─────────────────────────────────────┘
```

- One error message for both wrong-email and wrong-password. Never reveal whether an account exists.
- Submit disabled while in flight; the button shows "Signing in…".
- Rate limit: 10 attempts / 15 min / IP (a Sprint 1 courtesy, not NFR-07 which is the join endpoint).
- Post-login redirect by role: `ADMIN → /admin/users`, `MERCHANT → /merchant/items`, `ORGANISER → /organiser`.
- If `mustChangePassword`, redirect to `/change-password` and allow no other route (S1-019).

### 6.2 `/merchant/items` — the dish list

```
┌──────────────────────────────────────────────────┐
│ GroupEat        Dishes    Settings      Sign out │
├──────────────────────────────────────────────────┤
│ Your dishes                    [ + New dish ]    │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ Beef Bowl                          $16.00    │ │
│ │ Lowest deal price: $11.12  (31% off)         │ │
│ │ You keep $4.01/plate                         │ │
│ ├──────────────────────────────────────────────┤ │
│ │ Latte                               $6.50    │ │
│ │ Lowest deal price: $4.10  (37% off)          │ │
│ │ You keep $1.63/plate                         │ │
│ ├──────────────────────────────────────────────┤ │
│ │ Duck Confit                        $12.00    │ │
│ │ Lowest deal price: $11.68  (3% off)  ⚠ Thin  │ │
│ │ You keep $3.01/plate                         │ │
│ ├──────────────────────────────────────────────┤ │
│ │ Steak Sandwich                       $9.00   │ │
│ │ ⛔ Can't be a deal at your minimum margin     │ │
│ ├──────────────────────────────────────────────┤ │
│ │ Hand-cut Fries                       $5.00   │ │
│ │ Not batchable — excluded from deals           │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Why this screen matters more than it looks:** it is the only screen in the sprint that answers *"which of my dishes should I deal?"* — the question a merchant actually has. Sorting by achievable discount depth (S1-021) makes it a decision tool rather than a list. If time is short, cut S1-021 but not the per-row lowest price (S1-020).

### 6.3 `/merchant/items/new` and `/merchant/items/:id` — dish form + guardrail panel

```
┌──────────────────────────────────────────────────┐
│ ← Dishes                              Beef Bowl  │
├──────────────────────────────────────────────────┤
│ Dish name                                        │
│ ┌──────────────────────────────────────────────┐ │
│ │ Beef Bowl                                    │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ What you normally charge                         │
│ ┌──────────────────────────────────────────────┐ │
│ │ $ 16.00                                      │ │
│ └──────────────────────────────────────────────┘ │
│ The price on your menu today. This is the "was"  │
│ price customers will compare against.            │
│                                                  │
│ Ingredient cost per plate                        │
│ ┌──────────────────────────────────────────────┐ │
│ │ $ 4.80                                       │ │
│ └──────────────────────────────────────────────┘ │
│ Just the food. Not labour, not rent.             │
│                                                  │
│ Container cost per order                         │
│ ┌──────────────────────────────────────────────┐ │
│ │ $ 0.80                                       │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ How many can you make in one batch               │
│ ┌──────────────────────────────────────────────┐ │
│ │ 30                                           │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ Minutes to make one plate (optional)             │
│ ┌──────────────────────────────────────────────┐ │
│ │ 6                                            │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ☑ Can this dish be batched?                      │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │                 Save dish                    │ │
│ └──────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────┤
│  GUARDRAIL PANEL  (see 6.4)                      │
└──────────────────────────────────────────────────┘
```

**Form behaviour:**

- Money fields accept `16`, `16.0`, `16.00`, `$16.00`. They are stored as integer cents. Parsing happens once, at the boundary; there is no float arithmetic downstream.
- Validation fires **on blur**, not on every keystroke. Keystroke validation is how you get a red field while the merchant is still typing.
- The guardrail panel is **empty until the dish is saved once**, then evaluates on save and on any change to a cost field (debounced 600ms).
- `foodCostCents` and `menuPriceCents` are compared live and the panel switches to `INVALID_COST_DATA` as soon as the relationship breaks — before save. The save button also blocks.
- Unsaved changes → navigating away prompts.

### 6.4 The guardrail panel component

One component, seven states (§5.4). This is the artifact the whole sprint is judged on.

```
┌──────────────────────────────────────────────────────┐
│  LOWEST PRICE THAT STILL WORKS                       │
│                                                      │
│            $11.12                                    │
│                                                      │
│  normally $16.00 · they save $4.88 (31% off)         │
│                                                      │
│  ────────────────────────────────────────────────    │
│                                                      │
│  You keep                 $4.01  per plate           │
│  Our fee                  $0.89  per plate           │
│  Card fees                $0.62  per plate           │
│  Ingredients + container  $5.60  per plate           │
│  ────────────────────────────────────────────────    │
│  Share of your menu price        25%                 │
│  Your minimum                    25%                 │
│                                                      │
│  ────────────────────────────────────────────────    │
│                                                      │
│  To break even, 71 of every 100 plates must go to    │
│  people who would not have eaten here otherwise.     │
│                                                      │
│  → So run this drop in a slot you're normally empty  │
│    in. If it fills a busy hour, you lose money.      │
│                                                      │
│  ────────────────────────────────────────────────    │
│                                                      │
│  Try a different price          ⌄                    │
│  $11.12  ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  $16.00      │
│  ▲ cannot go lower                                   │
│                                                      │
│                          [ Use this price ]          │
└──────────────────────────────────────────────────────┘
```

**Rules for this component:**

1. **The breakdown always reconciles visibly.** `deal price = you keep + our fee + card fees + ingredients + container`. A merchant who adds the column up must get the price back. If it doesn't reconcile, the merchant will not trust any other number on the screen. This is the single highest-leverage trust device in the product.
2. The slider's left end **is** `minViablePriceCents`. It is not a suggestion, and there is no text input on the slider row. (FR-203's hard clamp, proven early — S1-015.)
3. Break-even is a **count out of 100**, not a percentage. "71 of every 100" is understood in a glance; "70.6%" is not.
4. The guidance line is the last thing before the action. It is the only sentence on the panel that tells the merchant what to *do*.
5. The "card fees" row shows `stripePct × price + stripeFixedCents` as one number. Do not itemise the percentage and the fixed amount — the merchant does not care, and two rows invite an argument about rates instead of a decision about the drop.
6. Nothing on this panel is clickable except the slider and the primary action. No tooltips-on-tooltips.

### 6.5 `/admin/users` — minimal admin

```
┌──────────────────────────────────────────────────┐
│ GroupEat                    Admin        Sign out│
├──────────────────────────────────────────────────┤
│ Users                              [ + New user ]│
│ ┌──────────────────────────────────────────────┐ │
│ │ bob@beefbowl.ca      MERCHANT   Beef Bowl    │ │
│ │ alice@example.com    ORGANISER  —            │ │
│ │ ops@groupeat.ca      ADMIN      —            │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ Merchants                     [ + New merchant ] │
│ ┌──────────────────────────────────────────────┐ │
│ │ Beef Bowl      PENDING   min margin 25%      │ │
│ │ Latte Bar      PENDING   min margin 25%      │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

Plus a merchant detail view with pickup address, instructions and the `floorPctOfMenu` editor (which uses the same dollar-example helper text as §5.1).

---

## 7. Data dictionary — Sprint 1 tables

Only the tables Sprint 1 reads or writes. Tables created but unused are listed in §7.5.

### 7.1 `User`

| Field | Type | Required | Business meaning | Validation |
|---|---|---|---|---|
| `id` | uuid | yes | Internal identity | Generated |
| `email` | string | yes | Login identity. Staff, organisers, admin only — **never a diner** | Valid email, unique, lowercased before store, ≤ 254 chars |
| `passwordHash` | string | yes | bcrypt hash, cost 10 | Never returned by any API; never logged |
| `name` | string | no | Display name | ≤ 100 chars |
| `role` | enum | yes | `ADMIN` \| `MERCHANT` \| `ORGANISER` | Immutable by the user; admin-only change |
| `mustChangePassword` | boolean | yes (S1 delta) | Temp-password bootstrap flag | Default `false`; set `true` on admin-created users |
| `lastLoginAt` | datetime | no (S1 delta) | For support and dormancy | Set on successful login |
| `createdAt` | datetime | yes | | |

### 7.2 `Merchant`

| Field | Type | Required | Business meaning | Validation |
|---|---|---|---|---|
| `id` | uuid | yes | | |
| `name` | string | yes | Trading name, shown to diners | ≤ 100 chars |
| `slug` | string | yes | URL-safe handle | lowercase a-z0-9-, unique, 3–40 chars |
| `legalName` | string | no | For Stripe Connect later | ≤ 200 |
| `timezone` | string | yes | All windows and cutoffs are in this zone | Valid IANA; default `America/Edmonton` |
| `floorPctOfMenu` | decimal(5,2) | yes (S1 delta) | **The merchant's minimum margin**, as a share of menu price. The guardrail's floor. | 0 < x ≤ 1; default 0.25; UI warns < 0.15 |
| `pickupAddress` | string | no | Where diners collect | ≤ 300 |
| `pickupInstructions` | string | no | "Ring the bell, side door" | ≤ 300 |
| `status` | enum | yes | `PENDING` \| `ACTIVE` \| `SUSPENDED` | Default `PENDING`; only ADMIN sets ACTIVE |
| `stripeAccountId` | string | no | Unused in Sprint 1 | unique when present |
| `onboardingComplete` | boolean | yes | Unused in Sprint 1 | default false |
| `createdAt` | datetime | yes | | |

### 7.3 `MerchantUser`

| Field | Type | Required | Business meaning | Validation |
|---|---|---|---|---|
| `id` | uuid | yes | | |
| `merchantId` | uuid | yes | | FK |
| `userId` | uuid | yes | | FK |
| `role` | enum | yes | `OWNER` \| `MANAGER` \| `STAFF`. Sprint 1 only creates `OWNER`. | `@@unique([merchantId, userId])` |

**Access rule (P0):** every merchant-scoped query filters by the `merchantId` values reachable from the signed-in user's `MerchantUser` rows. A user with no `MerchantUser` row gets 404 on every merchant route. There is no "merchant id from the URL" trust anywhere.

### 7.4 `MenuItem` — the guardrail's input table

| Field | Type | Required | Business meaning | Validation |
|---|---|---|---|---|
| `id` | uuid | yes | | |
| `merchantId` | uuid | yes | Owner | FK, indexed |
| `name` | string | yes | Dish name, shown to diners | 1–80 chars |
| `description` | string | no | | ≤ 300 |
| `photoUrl` | string | no | Unused in Sprint 1 (no upload UI) | — |
| `menuPriceCents` | int | yes | **What you normally charge.** The "was" price. Must be the real price (Competition Act). | > 0, ≤ 50000 |
| `foodCostCents` | int | yes | **Ingredient cost per plate.** Food only. | ≥ 0, **< menuPriceCents** |
| `packagingCents` | int | yes | **Container cost per order.** | ≥ 0, default 0, < menuPriceCents |
| `batchYield` | int | yes | **How many can you make in one batch.** Caps `Drop.maxQty`. | 1–200 |
| `prepMinutes` | int | no | Minutes per plate | 1–240 |
| `isBatchable` | boolean | yes | If false, no deal can be built | default true |
| `containsAlcohol` | boolean | yes (S1 delta) | **AGLC hard block** (PRD-v1 §15.2). Alcohol may never appear in a drop. | default false. The field itself is **merchant-editable** (S1-025); `true → false` needs the confirmation in §5.5a. While `true`, the item is deal-ineligible permanently, with no override. |
| `category` | string | no (S1 delta) | Cuisine/category. Needed later by `likelyFill` (§9.3), which references "organiser's past success with this cuisine" — with no such field that feature has no input. | ≤ 40 chars, free text in V1 |
| `archivedAt` | datetime | no | Soft delete | Archived items are hidden but never deleted (they may be referenced by historical drops) |

**The cost-validation invariant, stated once and enforced in three places:** `foodCostCents + packagingCents < menuPriceCents`. In the form (on blur), in the API (on write), and implicitly by the guardrail (which will simply return `null` if it is violated in legacy data). Violation at write time is a hard reject, never a warning.

### 7.5 `OrganiserProfile`

| Field | Type | Required | Business meaning | Validation |
|---|---|---|---|---|
| `id` | uuid | yes | | |
| `userId` | uuid | yes | | unique, FK |
| `displayName` | string | yes | Shown on the deal page later | 1–80 |
| `phone` | string | no | For ops contact only | E.164 |
| `commissionPct` | decimal(5,2) | yes | 5% of captured GMV (PRD-v1 §3.3) | 0–100, default 5.00 |

### 7.6 Created but not exercised in Sprint 1

Created by the S1-002 migration so no future migration has to restructure anything. **No Sprint 1 code may read or write these:**

`Customer`, `Drop`, `DropParticipant`, `ShareLink`, `Order`, `LedgerEntry`, `AiDraft`, `ConsentRecord`, and the enums `DropStatus`, `AuthStatus`, `ChargeStatus`, `LedgerType`, `ConsentBasis`.

The one exception is `Drop.guardrailSnapshot`, whose **JSON shape** is defined here (§7.7) because the guardrail output contract is a Sprint 1 deliverable even though the column stays empty.

### 7.7 `guardrailSnapshot` JSON shape (contract, frozen)

```jsonc
{
  "version": 1,
  "computedAt": "2026-10-28T18:22:04.311-06:00",
  "input": {
    "menuPriceCents": 1600,
    "foodCostCents": 480,
    "packagingCents": 80,
    "floorPctOfMenu": 0.25,
    "platformFeePct": 0.08,
    "platformFeeFloorCents": 60,
    "platformFeeCapCents": 200,
    "stripePct": 0.029,
    "stripeFixedCents": 30
  },
  "result": {
    "dealPriceCents": 1112,
    "contributionCents": 400.79,
    "contributionPctOfMenu": 0.2505,
    "fullPriceContributionCents": 963.60,
    "breakEvenIncrementality": 0.7062,
    "platformFeeCents": 88.96,
    "isBelowFloor": false,
    "minViablePriceCents": 1112
  }
}
```

**Contract notes for the architect:**

- **All inputs are stored with the snapshot.** Without them the number cannot be re-derived in six months when Stripe changes its rate, and a merchant complaint becomes unanswerable.
- `version` exists so a future formula change can be detected rather than silently misread.
- Money that is the result of a percentage (`contributionCents`, `platformFeeCents`) is **not** rounded before storage. Rounding is a display concern. `minViablePriceCents` and `dealPriceCents` are integers because they are prices, not derived amounts.
- Once a drop is published, this object is immutable (FR-207, M3).

---

## 8. Schema deltas — recommended changes to PRD-v1 §5.1

PRD-v1 asks for confirmation that the business fields are complete. They are not quite. Five additions, in priority order. **D-1 is a blocker for Sprint 1** — the guardrail cannot run without it.

| # | Delta | Why | Priority |
|---|---|---|---|
| **D-1** | `Merchant.floorPctOfMenu Decimal @default(0.25) @db.Decimal(5,2)` | The guardrail's `floorPctOfMenu` input exists in §7.1 and §17 D-6 says "make it per-merchant configurable" — but §5.1 has no column for it. **Without this, the guardrail has no floor and cannot produce any of the §7.4 vectors.** | **P0 — blocks M1** |
| **D-2** | `MenuItem.containsAlcohol Boolean @default(false)` | §15.2 requires an AGLC hard block on alcohol in `MenuItem` validation, but no field records it. A banned-term regex on the dish name is not a compliance control. | **P0** |
| **D-3** | `MenuItem.category String?` | §9.3's `likelyFill` weights "organiser's past success with this cuisine". There is no cuisine field to weight. Cheap now, a migration later. | P1 |
| **D-4** | `User.mustChangePassword Boolean @default(false)`, `User.lastLoginAt DateTime?` | Sprint 1 bootstraps accounts with temp passwords because there is no email delivery (FR-101 is M2). The flag is what makes that safe. `lastLoginAt` is free support leverage. | P1 |
| **D-5** | `Order.participantId` should be a relation to `DropParticipant`, not a bare `String @unique` | As written, nothing stops an `Order` pointing at a non-existent participant. Prisma will not enforce it. | P1 (harmless to fix now, painful later) |

**Two things I deliberately do *not* propose changing:**

- `foodCostCents Int` (non-nullable) stays non-nullable, **even though §7.4 vector E expects `INCOMPLETE_COST_DATA`**. The database should refuse incomplete cost data. The function must still handle the case, because it will receive partial input from the API, from seeds, and from future AI proposals. The throw is a guard, not a data state.
- `Merchant.timezone` stays a string, not an enum. Merchants may be outside Alberta in corridor 2.

---

## 9. Out of scope for Sprint 1 — explicit

If a developer finds themselves building any of the following, this document has been misread.

| Area | Not in Sprint 1 | Arrives |
|---|---|---|
| Stripe — Connect, PaymentIntent, manual capture, refunds, webhooks | All of it. No Stripe SDK in `package.json`. | M2 / M4 / M5 |
| AI — the 5-question interview, 3 proposals, copy generation, `AiDraft` writes | All of it. No model calls. The guidance sentence in §5.3 is a lookup table, not a generation. | M3 |
| Drop creation, draft state, publish, guardrail snapshot freeze | Nothing. `Drop` rows are never written. | M3 |
| Public deal page, OG/Twitter tags, link unfurling in WhatsApp/WeChat | Nothing. No public route. | M4 |
| Join flow, phone capture, SMS OTP, Payment Element | Nothing. | M4 |
| Cutoff cron worker, LOCKED/FAILED, capture, void, ledger | Nothing. | M5 |
| QR codes, scan screen, redemption | Nothing. | M6 |
| Reporting, new-vs-returning, weekly digest, organiser commission | Nothing. | M7 |
| Organiser dashboard, share links, drop ranking | Nothing. Organiser logs in and sees a placeholder. | M7 |
| Admin refunds, impersonation, force-fail, audit table | Nothing beyond create-user/create-merchant. | M8 |
| Email delivery of any kind (invites, receipts, digests) | Nothing. No mail provider. | M2 onward |
| SMS of any kind, CASL consent flow | Nothing. `ConsentRecord` exists, unused. | M4 |
| Photo upload, image processing | Nothing. `photoUrl` is a nullable string, unset. | M3 |
| Merchant self-serve signup | Nothing. Admin creates every account. | Never in V1 |
| Consumer app, feed, discovery, reviews, social graph, delivery, loyalty | Nothing, ever. | Never |

---

## 10. Open questions — need a decision

Only items that need a human with authority. Technical choices belong to the architect and are not listed here.

| # | Question | Why it blocks | My recommendation |
|---|---|---|---|
| **Q-1** | **Do we accept schema deltas D-1…D-5?** D-1 in particular: `floorPctOfMenu` must live on `Merchant`. | D-1 blocks the entire sprint. The guardrail cannot produce vector A without a floor value. | Accept D-1 and D-2 as P0 now. Accept D-3/D-4/D-5 as P1 — they are one-line additions to the same migration and cost nothing today. |
| **Q-2** | **What discount depth counts as "attractive enough to run"?** I proposed 10% as the `THIN` threshold (§5.4). Below it, the panel says "profitable but nobody will bite." | Without a number, case C either shows as green (merchant runs a dead drop) or as red (merchant thinks the product is broken). Both are worse than a threshold. | **10%.** It is a judgement, not arithmetic, so make it a config constant and revisit after the first 20 drops. Do not let it drift per-merchant in V1. |
| **Q-3** | **Does the merchant see `THIN` items at all, or does the product simply not offer them?** | If a merchant has only high-food-cost dishes, hiding them means the product has nothing to say. Showing them means the product tells a merchant "your menu is undiscountable", which is true but commercially awkward. | **Show, honestly.** The whole business rests on telling merchants the truth about their margins before they lose money. A product that hides inconvenient arithmetic is the product this one is trying to replace. |
| **Q-4** | **Default `floorPctOfMenu` of 25% — confirm, or set per-merchant at onboarding?** PRD-v1 §17 D-6 recommends 25% with per-merchant override. | Every merchant's first guardrail result depends on this number, and it is the number most likely to be wrong for a specific restaurant. | **25% default, ops-adjustable during the onboarding call.** Do not expose it to the merchant in the first session — a merchant who lowers their floor to "make the deal work" has defeated the guardrail. Expose it only after they have seen one honest result. |
| **Q-5** | **Sprint 1 has no email delivery, so admin creates accounts with a temp password. Acceptable for a white-glove beta?** | It is the only way to demo login in week 2 without an email provider. | **Yes.** 5 merchants, all onboarded on a call. FR-101's 72h invite link arrives in M2 with Stripe onboarding, where email is needed anyway. |
| **Q-6** | **When the guardrail says INFEASIBLE, is "lower your minimum margin" an acceptable escape hatch to show the merchant?** | It is the honest second option, but it is also the exact behaviour that turns a guardrail into a suggestion. | **Show it, but behind a confirmation that names the consequence:** *"Lowering this means you earn less per plate on every deal you run, not just this one."* The floor must be hard to move, not impossible to move — a merchant who genuinely wants to trade margin for trial should be able to, knowingly. |

---

## Appendix A — Sprint 1 checklist for the engineer

Ordered. Do not reorder 5 and 6.

1. Strip the repo; single Next.js app; `npm run dev` and `npm run build` both work
2. Prisma schema with deltas D-1…D-5; one fresh migration; `prisma migrate reset` clean
3. Seed: 1 admin, 3 merchants, 5 dishes = vectors A, B, C, D, E
4. Auth: login, logout, me, middleware, role guards, `mustChangePassword`
5. **Guardrail module — pure, no imports outside the folder**
6. **Guardrail tests — 5 vectors, fuzz 1,000, the null-iff invariant, the import-graph test**
7. `POST /api/merchant/items/:id/guardrail`
8. Dish form with cost validation, client + server
9. Guardrail panel, all 7 states, exact copy
10. Dish list with per-item lowest price
11. Admin: create user / merchant, edit pickup + floor
12. Analytics events, violation logging
13. Demonstrate vector A on a real phone at 360px

## Appendix B — The four sentences this sprint exists to prove

1. **The guardrail is the product.** It ships before any UI, and its tests are the only tests in the sprint that can fail the sprint on their own.
2. **A merchant must be told the truth about a dish that can't be discounted.** Case C is not a bug to be smoothed over; it is the product working.
3. **The browser formats, the server computes, the function decides.** No money arithmetic in a component, ever.
4. **If the breakdown doesn't add up on screen, nothing else on the page is believed.**

---

*Prepared by 许清楚 (Xu). Algorithm and test vectors are PRD-v1 §7 and are frozen; if this document and PRD-v1 §7 disagree about arithmetic, PRD-v1 §7 is right and this document has a defect.*
