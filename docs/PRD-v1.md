# GroupEat — Product Requirements Document (V1)

**Version:** 1.0 · **SPEC_VERSION:** 1
**Date:** 2026-10-28
**Owner:** Bujin
**Author:** Tally
**Status:** Ready for estimation
**Supersedes:** `GROUPEAT-2.0-STRATEGY.md` §6.3 (build sequence) and any consumer-marketplace assumptions elsewhere in that document.

---

## 0. Document control

### 0.1 What this document is

A buildable specification for V1 of GroupEat. Every requirement has an ID, an acceptance criterion, and (where it involves money) a test vector. If a developer has to guess, this document has failed — file a gap against it.

### 0.2 What changed from the strategy doc

The strategy document was written before field research and still carries marketplace assumptions. This PRD reflects the decision in §0.5 of that document:

| Strategy doc said | This PRD says |
|---|---|
| Keep Express API + add Next.js | **Retire Express.** Single Next.js app + Prisma + one cron worker. See §13.1 |
| 15 merchants, one corridor, consumer feed | **No feed, no discovery.** Organisers onboarded manually. See §2.2 |
| V1.5 adds "customer deal feed by neighbourhood" | **Deleted.** Never build it |
| $1.50 flat per redemption | **8% of deal price, floor $0.60, cap $2.00.** Flat $1.50 kills low-ticket items — see §7.5 |
| AI portal = merchant only | **Two AI surfaces:** merchant guardrail + organiser assistant. See §9 |

---

## 1. Product summary

### 1.1 One sentence

GroupEat lets a restaurant sell a **guaranteed batch** of one dish at a fixed pickup window to a group that has already committed — organised by someone who already has an audience.

### 1.2 The problem being solved

A restaurant cannot safely discount. A 30% discount on a $16 dish drops contribution from $9.64 to $4.01 (see §7.4). The discount only pays for itself if ≥70% of orders are genuinely incremental — and a public coupon page cannot guarantee that.

A batch order can. Twenty identical units in one window cost the kitchen less per unit, need no courier, and are provably new revenue if the group has never eaten there.

### 1.3 The unit of the product

> **One merchant · one item · one pickup window · one organiser.**

That is a **Drop**. V1 has no other unit. There is no browse page, no ranking, no feed, no recommendations between drops.

### 1.4 Who the customer is

Not the diner. **The organiser** — the person who can produce 20 commitments by Thursday. Office floor admin, WeChat group leader, community association volunteer, site foreman, church coordinator.

The merchant is the supplier. The diner is the participant.

---

## 2. Goals and non-goals

### 2.1 Goals (V1)

| ID | Goal | Measure |
|---|---|---|
| G-1 | A merchant can publish a margin-safe drop without help | ≥90% of merchants publish their first drop unassisted within 20 min |
| G-2 | An organiser can fill a drop | **Threshold hit rate ≥70%** |
| G-3 | Money moves correctly | Zero reconciliation breaks between Stripe and ledger in beta |
| G-4 | Merchants can tell whether it worked | 100% of completed drops produce a contribution report |
| G-5 | Redemption is frictionless | Scan-to-redeemed < 3 seconds per participant |

### 2.2 Non-goals (explicitly out of scope for V1)

Do not build, do not stub, do not "just add a table for it":

- Consumer app (iOS/Android) — web only
- Discovery feed, browse, search, category pages
- Ratings, reviews, comments, photos from diners
- Social graph, friends, follows
- Delivery or courier integration — pickup only
- Multi-item carts — one item per drop
- Loyalty, points, referrals beyond the organiser link
- Merchant self-serve signup without an ops call (beta is white-glove)
- Alcohol in any deal (AGLC — see §15.3)
- Multi-currency, multi-language (English only in V1; Chinese copy is a V1.1 item)

### 2.3 Success gate

**Threshold hit rate is the only V1 success metric.** Tracked from drop #1.

- ≥70% → proceed to corridor 2
- 60–70% → fix item selection and minimum sizes; do not spend on growth
- <60% after 20 drops → **stop the project.** The mechanic is wrong, not the marketing.

---

## 3. Personas and roles

### 3.1 Roles

| Role | Auth | Can do |
|---|---|---|
| **Participant** | **No account.** Phone + card only | Join a drop, get QR, redeem |
| **Organiser** | Email + password | Share a drop link, see their group's progress, see commission |
| **Merchant Owner** | Email + password | Manage merchant, items, drops, staff, payouts |
| **Merchant Staff** | Email + password (PIN optional) | Scan QR, mark redeemed. Cannot edit drops |
| **Admin** | Email + password | Everything, plus refunds, overrides, impersonation |

### 3.2 Participant has no account — this is a hard requirement

Every join must work from a cold link in WhatsApp/WeChat with **zero signup**. Requiring an account is the single largest funnel killer and is a **P0 defect** if it ships.

Participants are identified by **phone number** (E.164, verified by SMS OTP only when needed for dedupe — see §6.4). A `Customer` record is created on first join, keyed by phone. No password, ever.

### 3.3 Organiser is the buyer

The organiser is onboarded **manually by ops** in V1 — no self-serve. There are 5–15 of them in beta and you will know their names.

The organiser's incentive is a **commission of 5% of captured GMV** on their link, paid monthly by e-transfer in V1 (manual). Do not build automated organiser payouts in V1.

---

## 4. Core user journeys

### 4.1 Journey A — Merchant publishes a drop (the critical path)

```
Login → Merchant dashboard
  → "New drop"
  → AI interview: 5 questions (§9.2)
  → AI returns 3 proposals, each with contribution maths
  → Merchant picks one, adjusts price with slider (clamped at floor)
  → Merchant sets: pickup window, cutoff, min qty, max qty
  → Preview (deal page + share message + poster)
  → Publish
  → Drop is LIVE, share link copied
```

**Acceptance:** a first-time merchant completes this in <20 minutes without contacting support. Instrument time-to-first-publish.

**Blocking rules:**
- Cannot publish if any `MenuItem` cost field is missing → force completion first
- Cannot set a price below `minViablePrice` → slider physically stops (§7.2)
- Cannot set cutoff later than `publishedAt + 5 days` → validation error (auth expiry, §8.3)
- Cannot set `maxQty > item.batchYield` → validation error

### 4.2 Journey B — Organiser fills a drop

```
Organiser opens their dashboard (or receives a link from ops)
  → Sees available drops from their merchants, ranked by likely fill
  → "Get share link" → unique link + pre-written message (editable)
  → Shares to their group (WhatsApp / WeChat — outside the app)
  → Dashboard shows: X joined / Y needed, live
  → At threshold: "Your drop is locked in — 24 units"
  → After pickup: commission statement
```

**Acceptance:** organiser can go from login to a shareable link in ≤2 taps.

### 4.3 Journey C — Participant joins and redeems

```
Tap link in group chat
  → Deal page (no login): item, photo, price, saving, window, address, "8 of 20 joined"
  → "Join this drop"
  → Pick quantity (1–4)
  → Phone + card (Stripe Payment Element)
  → AUTHORISE (not charged)
  → Confirmation: "You're in. You'll only be charged if 20 people join by Thu 2pm."
  → [cutoff] → "Your drop is confirmed. Show this code."
  → QR code
  → At pickup: staff scans → "Redeemed"
```

**Acceptance:** cold-tap to authorised in **≤45 seconds** on a mid-range Android on 4G. Measure p50 and p90.

**Critical:** the deal page must unfurl correctly in WhatsApp and WeChat (title, description, image). If the preview is a bare URL, the drop is dead. See §13.4.

---

## 5. Domain model

### 5.1 Prisma schema (V1 draft)

```prisma
// ---------- Auth accounts (staff, organisers, admin). NOT diners. ----------
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String
  name          String?
  role          UserRole @default(ORGANISER)
  createdAt     DateTime @default(now())
  merchantUsers MerchantUser[]
  organiser     OrganiserProfile?
}

enum UserRole { ADMIN MERCHANT ORGANISER }

// ---------- Diners. Phone-keyed, no login. ----------
model Customer {
  id          String   @id @default(uuid())
  phone       String   @unique          // E.164, normalised
  email       String?
  name        String?
  firstSeenAt DateTime @default(now())
  participants DropParticipant[]
}

// ---------- Merchant ----------
model Merchant {
  id                 String   @id @default(uuid())
  name               String
  slug               String   @unique
  legalName          String?
  timezone           String   @default("America/Edmonton")
  stripeAccountId    String?  @unique
  onboardingComplete Boolean  @default(false)
  status             MerchantStatus @default(PENDING)
  pickupAddress      String?
  pickupInstructions String?
  createdAt          DateTime @default(now())
  users    MerchantUser[]
  items    MenuItem[]
  drops    Drop[]
  shareLinks ShareLink[]
}

enum MerchantStatus { PENDING ACTIVE SUSPENDED }

model MerchantUser {
  id         String @id @default(uuid())
  merchantId String
  userId     String
  role       MerchantRole
  merchant   Merchant @relation(fields: [merchantId], references: [id])
  user       User     @relation(fields: [userId], references: [id])
  @@unique([merchantId, userId])
}

enum MerchantRole { OWNER MANAGER STAFF }

// ---------- Menu item with cost data (the guardrail's input) ----------
model MenuItem {
  id              String  @id @default(uuid())
  merchantId      String
  name            String
  description     String?
  photoUrl        String?
  menuPriceCents  Int                    // what it sells for normally
  foodCostCents   Int                    // ingredients only
  packagingCents  Int     @default(0)
  batchYield      Int                    // max units in one batch
  prepMinutes     Int?
  isBatchable     Boolean @default(true)
  archivedAt      DateTime?
  merchant        Merchant @relation(fields: [merchantId], references: [id])
  drops           Drop[]
  @@index([merchantId])
}

// ---------- Organiser ----------
model OrganiserProfile {
  id            String  @id @default(uuid())
  userId        String  @unique
  displayName   String
  phone         String?
  commissionPct Decimal @default(5.0) @db.Decimal(5,2)
  user          User    @relation(fields: [userId], references: [id])
  shareLinks    ShareLink[]
}

// ---------- The Drop ----------
model Drop {
  id              String   @id @default(uuid())
  merchantId      String
  menuItemId      String
  publicCode      String   @unique       // short code for URL: /d/{publicCode}
  title           String
  description     String?
  heroImageUrl    String?

  dealPriceCents  Int                    // per unit, what the diner pays
  minQty          Int
  maxQty          Int
  maxPerCustomer  Int      @default(4)

  windowStart     DateTime               // pickup window open
  windowEnd       DateTime               // pickup window close
  cutoffAt        DateTime               // join deadline == capture trigger

  status          DropStatus @default(DRAFT)

  // Frozen snapshot of the guardrail maths at publish time. NEVER recompute later.
  guardrailSnapshot Json

  aiRationale     String?
  createdAt       DateTime @default(now())
  publishedAt     DateTime?
  lockedAt        DateTime?
  completedAt     DateTime?

  merchant   Merchant  @relation(fields: [merchantId], references: [id])
  menuItem   MenuItem  @relation(fields: [menuItemId], references: [id])
  participants DropParticipant[]
  shareLinks ShareLink[]
  orders     Order[]

  @@index([merchantId, status])
  @@index([status, cutoffAt])
}

enum DropStatus {
  DRAFT
  PUBLISHED        // accepting joins
  LOCKED           // cutoff passed, threshold met, capture in progress
  CAPTURED         // all captures settled
  PICKUP_OPEN      // window open
  COMPLETED
  FAILED           // threshold not met — all auths voided
  CANCELLED        // merchant or admin cancelled
}

// ---------- Participants ----------
model DropParticipant {
  id            String   @id @default(uuid())
  dropId        String
  customerId    String
  qty           Int
  shareLinkId   String?                  // which organiser brought them

  // money
  paymentIntentId String? @unique
  amountCents     Int
  platformFeeCents Int
  authStatus      AuthStatus @default(PENDING)
  chargeStatus    ChargeStatus @default(NONE)

  redemptionCode  String? @unique        // signed token, generated on capture
  redeemedQty     Int     @default(0)
  redeemedAt      DateTime?
  redeemedByUserId String?

  createdAt     DateTime @default(now())
  drop          Drop     @relation(fields: [dropId], references: [id])
  customer      Customer @relation(fields: [customerId], references: [id])
  shareLink     ShareLink? @relation(fields: [shareLinkId], references: [id])

  @@unique([dropId, customerId])          // one join per person per drop
  @@index([dropId, authStatus])
}

enum AuthStatus   { PENDING AUTHORIZED FAILED VOIDED EXPIRED }
enum ChargeStatus { NONE CAPTURED REFUNDED PARTIALLY_REFUNDED FAILED }

// ---------- Organiser share links (attribution) ----------
model ShareLink {
  id          String @id @default(uuid())
  token       String @unique             // /d/{publicCode}?o={token}
  dropId      String
  merchantId  String
  organiserId String
  clicks      Int    @default(0)
  createdAt   DateTime @default(now())
  drop        Drop   @relation(fields: [dropId], references: [id])
  merchant    Merchant @relation(fields: [merchantId], references: [id])
  organiser   OrganiserProfile @relation(fields: [organiserId], references: [id])
  participants DropParticipant[]
  @@index([dropId])
  @@index([organiserId])
}

// ---------- Orders & ledger ----------
model Order {
  id              String @id @default(uuid())
  dropId          String
  participantId   String @unique
  qty             Int
  unitPriceCents  Int
  subtotalCents   Int
  platformFeeCents Int
  stripeChargeId  String?
  createdAt       DateTime @default(now())
  drop            Drop @relation(fields: [dropId], references: [id])
}

model LedgerEntry {
  id          String   @id @default(uuid())
  orderId     String?
  dropId      String?
  type        LedgerType
  amountCents Int                        // signed: +credit to platform, -debit
  stripeRef   String?
  note        String?
  createdAt   DateTime @default(now())
  @@index([dropId])
}

enum LedgerType { CHARGE REFUND PLATFORM_FEE ORGANISER_COMMISSION ADJUSTMENT }

// ---------- AI audit ----------
model AiDraft {
  id            String   @id @default(uuid())
  merchantId    String
  surface       String                   // "merchant_builder" | "organiser_assistant"
  promptVersion String
  inputJson     Json
  outputJson    Json
  guardrailPassed Boolean
  accepted      Boolean?
  createdAt     DateTime @default(now())
}

// ---------- CASL consent trail ----------
model ConsentRecord {
  id          String   @id @default(uuid())
  phone       String?
  email       String?
  basis       ConsentBasis               // EXPRESS | IMPLIED_TRANSACTION
  source      String                     // "drop_join" | "organiser_invite"
  grantedAt   DateTime @default(now())
  withdrawnAt DateTime?
  ipAddress   String?
}

enum ConsentBasis { EXPRESS IMPLIED_TRANSACTION }
```

### 5.2 Deletions from the existing repo

Drop these models and all their routes: `DiningGroup`, `GroupMember`, `GroupInvitation`, `Review`, `DishPost`, `DishPostLike`, `DishPostComment`, `UserPreference`.

Keep the *concept* of `GroupInvitation`'s signed short-lived token — it is reimplemented as `ShareLink.token` and `DropParticipant.redemptionCode`.

---

## 6. Functional requirements

### 6.1 Merchant onboarding

| ID | Requirement | Acceptance |
|---|---|---|
| FR-101 | Ops creates a Merchant and invites an Owner by email | Owner receives a set-password link valid 72h |
| FR-102 | Owner completes Stripe Connect Express onboarding | `onboardingComplete=true` only after Stripe reports `charges_enabled && payouts_enabled` |
| FR-103 | Merchant sets pickup address + instructions | Both persist; shown on every deal page |
| FR-104 | Merchant creates MenuItems with cost data | All of `menuPriceCents`, `foodCostCents`, `packagingCents`, `batchYield` required. Missing → cannot be used in a drop |
| FR-105 | Merchant can mark an item non-batchable | Excluded from drop creation picker |

**P0:** a MenuItem with `foodCostCents >= menuPriceCents` must be rejected at save with a clear message. Do not allow nonsense inputs to reach the guardrail.

### 6.2 Drop creation (merchant)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-201 | Merchant selects a batchable item and starts the AI interview | 5 questions, ≤1 screen each (§9.2) |
| FR-202 | System returns exactly 3 proposals | Each shows: price, saving %, contribution $, contribution % of menu price, break-even incrementality |
| FR-203 | Merchant can adjust price via slider | Slider `min` = `minViablePriceCents` (§7.2). **Hard clamp — no keyboard entry below it** |
| FR-204 | Merchant sets window, cutoff, min/max qty | Validations per §4.1 |
| FR-205 | System generates title, description, share message, hero image | All editable before publish |
| FR-206 | Merchant previews the real deal page | Preview renders the actual public page with `?preview=1` |
| FR-207 | Publish transitions DRAFT → PUBLISHED and freezes `guardrailSnapshot` | Snapshot is immutable; later edits to MenuItem do not alter it |
| FR-208 | Merchant can cancel a PUBLISHED drop | All auths voided; participants notified. Reason required |

### 6.3 Public deal page

| ID | Requirement | Acceptance |
|---|---|---|
| FR-301 | Renders with no login, server-side | LCP <1.5s on 4G; works with JS disabled for core content |
| FR-302 | Shows: hero image, item name, deal price, menu price, saving, window, address, organiser name, "X of Y joined" | All present |
| FR-303 | Shows social proof live | Count updates ≤30s; server-sent or polled |
| FR-304 | Shows an honest scarcity state | If `maxQty - joinedQty < 20%` show "only N left". Never fake it |
| FR-305 | When threshold met, shows "Confirmed — N units" and stops accepting joins | Join button disabled with explanation |
| FR-306 | When drop FAILED, shows "This drop didn't reach 20 — nobody was charged" | Must be explicit that no money moved |
| FR-307 | When window has passed, shows closed state | No join possible |
| FR-308 | Correct OG/Twitter meta tags + generated 1200×630 image | Verified against WhatsApp and WeChat preview |

**FR-308 is a P0 launch blocker.** A broken link preview kills distribution.

### 6.4 Join flow

| ID | Requirement | Acceptance |
|---|---|---|
| FR-401 | Quantity selector 1..`maxPerCustomer` | Server re-validates; client cannot exceed |
| FR-402 | Collect phone (E.164) + name (optional) + card via Stripe Payment Element | Phone normalised server-side |
| FR-403 | Create PaymentIntent with `capture_method: manual` | `authStatus=AUTHORIZED` only on `requires_capture` |
| FR-404 | Do not charge at join | Stripe shows authorisation only; ledger has no CHARGE entry |
| FR-405 | Idempotency key on join = `dropId:customerId` | Double-submit creates one participant |
| FR-406 | If drop already at `maxQty`, reject with "sold out" | Race-safe: enforce in DB transaction |
| FR-407 | Confirmation page states clearly: "You will only be charged if N people join by {cutoff}" | Verified by copy review |
| FR-408 | Send confirmation SMS with link to their code page | Only if consent captured (FR-901) |

**P0:** a participant must never be charged before cutoff. Test this explicitly.

### 6.5 Cutoff and capture

See §8.4 for the job spec. Requirements:

| ID | Requirement | Acceptance |
|---|---|---|
| FR-501 | At `cutoffAt`, compute `joinedQty` from AUTHORIZED participants | Excludes FAILED/EXPIRED |
| FR-502 | If `joinedQty >= minQty` → status LOCKED, capture all | Capture is idempotent |
| FR-503 | If `joinedQty < minQty` → status FAILED, void all | Every auth voided; zero charges |
| FR-504 | Partial capture failure handling | If `capturedQty >= ceil(minQty*0.9)` → proceed; else cancel + refund all (§8.5) |
| FR-505 | Generate `redemptionCode` per captured participant | Signed HMAC token, verifiable offline |
| FR-506 | Notify all participants of outcome | SMS/push within 60s of transition |
| FR-507 | Write ledger entries for every charge | Ledger sum reconciles to Stripe to the cent |

### 6.6 Redemption

| ID | Requirement | Acceptance |
|---|---|---|
| FR-601 | Staff opens scan screen, camera scans QR | Works on iOS Safari + Android Chrome |
| FR-602 | Scanner validates code signature + drop + status | Invalid/expired/wrong-drop → clear error |
| FR-603 | Redeem whole order or per-unit | `redeemedQty` increments; cannot exceed `qty` |
| FR-604 | Show participant name + qty + remaining | Large text, glanceable in a queue |
| FR-605 | Double-scan is idempotent | Second scan shows "already redeemed at {time}" |
| FR-606 | Works offline for up to 20 minutes | Queue locally, sync on reconnect; server reconciles |

**FR-606 is optional for V1** — mark as V1.1 unless beta merchants report bad signal in their pickup area.

### 6.7 Merchant reporting

| ID | Requirement | Acceptance |
|---|---|---|
| FR-701 | Per-drop report: units sold, GMV, platform fee, contribution $, contribution % | Numbers reconcile with ledger |
| FR-702 | New vs returning customers | Based on `Customer.firstSeenAt` vs drop date |
| FR-703 | Organiser attribution: which organiser drove which units | From `shareLinkId` |
| FR-704 | Weekly email digest (Monday 08:00 MT) | Sent only to consenting owners |
| FR-705 | Suggested next action | Rule-based in V1: "your Tuesday 3pm sold out — try 30 units" |

**FR-702 is the retention feature.** Merchants stay when they can see incrementality. Do not ship reporting without it.

### 6.8 Organiser surface

| ID | Requirement | Acceptance |
|---|---|---|
| FR-801 | Organiser sees available drops from their merchants | Ranked by `likelyFill` (§9.4) |
| FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable pre-written message |
| FR-803 | Live progress: joined / needed | Updates ≤30s |
| FR-804 | Commission statement: units × 5% of captured GMV | Monthly, exportable |
| FR-805 | Organiser cannot see participant phone numbers | P0 privacy requirement |

**FR-805:** organisers get aggregate counts only. Never PII of their group members.

### 6.9 Admin

| ID | Requirement | Acceptance |
|---|---|---|
| FR-901 | List/filter all drops by status | |
| FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry |
| FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe refund created |
| FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log |
| FR-905 | View raw AI drafts and guardrail results | For debugging merchant complaints |
| FR-906 | Manually create organiser accounts | V1 has no self-serve |

---

## 7. The guardrail — core algorithm

This is the most important code in the product. It must be a **pure, unit-tested function**. No database calls, no AI, no I/O.

### 7.1 Inputs

```ts
type GuardrailInput = {
  menuPriceCents: number
  foodCostCents: number
  packagingCents: number
  floorPctOfMenu: number      // merchant setting, default 0.25
  platformFeePct: number      // default 0.08
  platformFeeFloorCents: number // default 60
  platformFeeCapCents: number   // default 200
  stripePct: number           // default 0.029
  stripeFixedCents: number    // default 30
}
```

### 7.2 `minViablePrice(input): number | null`

The lowest deal price at which the merchant still clears the floor. Iterate ascending in 1-cent steps; return the first price that satisfies the floor. Return `null` if no price in `[50% of menuPrice, menuPrice]` qualifies.

```
floorCents = floorPctOfMenu * menuPriceCents

for P = ceil(menuPriceCents * 0.5) .. menuPriceCents:
    fee      = clamp(platformFeePct * P, platformFeeFloorCents, platformFeeCapCents)
    stripe   = stripePct * P + stripeFixedCents
    contrib  = P - foodCostCents - packagingCents - stripe - fee
    if contrib >= floorCents: return P

return null
```

### 7.3 `evaluateDeal(input, dealPriceCents)`

```ts
{
  netContributionCents,          // deal price − food − packaging − stripe − platform fee
  contributionPctOfMenu,      // contribution / menuPrice
  walkInContributionCents, // menuPrice − food − packaging − stripe(menuPrice)
  breakEvenIncrementality,    // fullPrice / (fullPrice + contribution)
  platformFeeCents,
  isBelowFloor: boolean,
  minViablePriceCents: number | null
}
```

> **Erratum (Sprint 1).** The two result identifiers were renamed to
> `netContributionCents` / `walkInContributionCents` during the zero-snapshot
> period. The formulas, constants, and the four test vectors (§7.4) are unchanged.
> The rename fixes the root cause of a copy bug: the old names did not encode
> whether the platform fee was included, and that ambiguity produced two defects
> in two days.

### 7.4 Test vectors (must pass exactly)

Constants: `stripePct=0.029`, `stripeFixed=30`, `platformFeePct=0.08`, `feeFloor=60`, `feeCap=200`, `floorPct=0.25`

| # | Menu | Food | Pack | Expected `minViablePrice` | Fee | Contribution | Break-even incrementality |
|---|---|---|---|---|---|---|---|
| A | $16.00 | $4.80 | $0.80 | **$11.12** (30.5% off) | $0.89 | $4.01 | **70.6%** |
| B | $6.50 | $1.10 | $0.35 | **$4.10** (36.9% off) | $0.60 | $1.63 | 73.7% |
| C | $12.00 | $6.60 | $0.50 | **$11.68** (2.7% off) | $0.93 | $3.01 | 58.6% |
| D | $9.00 | $8.50 | $0.30 | **`null`** (no viable price) | — | — | — |
| E | $16.00 | — (missing) | — | **throws `INCOMPLETE_COST_DATA`** | — | — | — |

**Case C is the important one.** A 55% food-cost item can only be discounted 2.7%. That is correct behaviour — it tells the merchant this dish is not a deal item. **Do not soften the floor to make C look better.**

Note the subtlety in C: its break-even incrementality (58.6%) is *lower* than A's (70.6%), because there is less full-price margin to cannibalise. So C is not unprofitable — it is merely **unattractive**: 2.7% off will not move anyone. A low break-even number is not permission to run a bad deal. The UI must show both figures and the AI must not recommend C.

**Case D** must return `null` and the UI must say: "This item can't support a deal at your floor. Try a lower food-cost item, or lower your floor."

### 7.5 Why the platform fee is not a flat $1.50

At a flat $1.50, test case B (a $6.50 latte) bottoms out at $5.03 — only a 22.6% discount, because the flat fee is 23% of the ticket. Worse, case C becomes **completely unviable**: no price clears the floor at all.

| Item | Flat $1.50 | 8% clamped [$0.60, $2.00] |
|---|---|---|
| $6.50 latte (food $1.10) | $5.03 — 22.6% off | **$4.10 — 36.9% off** |
| $16 bowl (food $4.80) | $11.75 — 26.6% off | **$11.12 — 30.5% off** |
| $12 dish (food $6.60) | **no viable price** | $11.68 — 2.7% off |

Coffee shops are a target segment, and the flat fee makes them unsellable while killing mid-margin dishes outright. **This is why the strategy doc's flat $1.50 per redemption was replaced with a clamped percentage.**

### 7.6 What the merchant sees

Never a bare number. Always:

```
You sell 1 unit for $11.12 (normally $16.00 — 31% off)
You keep $4.01 per unit after food, packaging, card fees and our fee.
That's 25% of your menu price — at your floor.
To break even, 71% of these orders must be people who wouldn't have come.
   → So this drop must run at a time you're usually empty.
```

That last line is generated by the AI but the numbers come from the function. **Never let the model compute money.**

---

## 8. Payments and money movement

### 8.1 Provider

Stripe Connect Express. Destination charges with `on_behalf_of` = connected account so **card processing fees land on the merchant**, not on the platform.

> **Verify in test mode before launch.** If Stripe fees land on the platform instead, net revenue per unit on a $11.12 order falls from $0.89 to about **$0.27** ($0.89 − $0.62 of processing), and the model breaks. This is the first integration test to write.

### 8.2 Fee model

- Participant pays `dealPriceCents × qty`
- `application_fee_amount` = `platformFeeCents` (§7.2)
- Merchant receives the remainder, minus Stripe processing
- No other fees. **No surcharges, ever** (strategy §3.1② — the 拼好饭 hidden-fee lesson)

### 8.3 Authorisation window

Stripe authorisations expire in ~7 days. Therefore:

- `cutoffAt - publishedAt` **must be ≤ 5 days**. Enforced at publish.
- If a drop is extended (not supported in V1), it must re-authorise.
- Participants joining on day 5 have ~2 days of auth life. Acceptable.

### 8.4 The cutoff job

**Runs every 60 seconds as a separate process.** Must be safe to run concurrently.

```
for each drop in (status=PUBLISHED and cutoffAt <= now()):
  BEGIN TRANSACTION
    SELECT * FROM "Drop" WHERE id = :id FOR UPDATE
    if drop.status != 'PUBLISHED': CONTINUE      -- already handled
    joinedQty = SUM(qty) WHERE authStatus='AUTHORIZED'
    if joinedQty >= minQty:
       UPDATE status='LOCKED', lockedAt=now()
       enqueue CaptureJob(drop.id)
    else:
       UPDATE status='FAILED'
       enqueue VoidJob(drop.id)
  COMMIT
```

**Idempotency rules:**
- The `FOR UPDATE` lock plus the status check makes double-processing impossible
- CaptureJob and VoidJob are keyed by `dropId` in the job table with a unique constraint
- Every Stripe call carries an idempotency key: `capture:{participantId}`, `void:{participantId}`
- Job failures retry with exponential backoff (5 attempts), then raise an admin alert

**Alerting:** if any drop stays in LOCKED for >10 minutes, page the on-call. This is the one job where silence is dangerous.

### 8.5 Partial capture failure

Cards can expire or hit limits between auth and capture (expect 2–5%).

- If `capturedQty >= ceil(minQty * 0.9)` → proceed to CAPTURED. Merchant is told the actual count.
- Else → cancel the drop, refund all successful captures, mark FAILED.

Log every occurrence. If it exceeds 5% of drops, revisit the authorisation strategy.

### 8.6 Refunds

- Drop failed → void auths (no refund needed — nothing was captured)
- Merchant cancels after capture → full refund + platform fee reversed + organiser commission reversed
- Participant no-show → **no refund** in V1. Merchant keeps the money. Documented in the join terms.

### 8.7 Ledger invariant

For every drop: `SUM(LedgerEntry.amountCents) == Stripe net balance change for that drop`.

A nightly reconciliation job asserts this and alerts on mismatch. **Non-negotiable.** This is the thing that will embarrass you six months in if it's not built now.

---

## 9. AI requirements

### 9.1 Principles

1. **The model never computes money.** All prices, fees and contributions come from §7.
2. **The model never sets a price.** It proposes; the deterministic slider enforces.
3. **Every AI output is stored** in `AiDraft` with prompt version, for audit and for the merchant-complaint conversation.
4. **The feature must degrade gracefully.** If the AI is down, the merchant can still publish a drop using a form. AI failure must never block a sale.

### 9.2 Surface 1 — Merchant deal builder

**Flow:** 5 questions, one per screen.

| # | Question | Maps to |
|---|---|---|
| 1 | "Which day and time are you quietest?" | `windowStart/End` proposal |
| 2 | "Which dish can you make 20 of without it hurting?" | `menuItemId` |
| 3 | "What does that dish cost you in ingredients?" | `foodCostCents` (pre-filled if known) |
| 4 | "Do you want new customers, or to fill a quiet hour?" | archetype → minQty + window logic |
| 5 | "How many can you commit to making?" | `maxQty` / `batchYield` check |

**Output contract (JSON, schema-validated):**

```json
{
  "proposals": [
    {
      "menuItemId": "uuid",
      "dealPriceCents": 1112,
      "minQty": 20,
      "maxQty": 30,
      "windowStart": "2026-11-05T15:00:00-07:00",
      "windowEnd": "2026-11-05T16:00:00-07:00",
      "rationale": "one sentence, plain language, no marketing adjectives",
      "title": "string ≤60 chars",
      "description": "string ≤200 chars",
      "shareMessage": "string ≤140 chars, written for a WhatsApp group"
    }
  ]
}
```

**Post-validation (server, mandatory):**
- `dealPriceCents >= minViablePrice(input)` — if not, **clamp up and log a guardrail violation**
- `minQty <= maxQty <= batchYield`
- `windowEnd > windowStart`, `cutoffAt < windowStart`
- Reject any proposal with `dealPriceCents` above `menuPriceCents`

A guardrail violation in the AI output is a **P1 bug**, not a normal event. Log it, alert if the rate exceeds 1%.

### 9.3 Surface 2 — Organiser assistant

**Question:** "What should I run this week?"

**Inputs:** organiser's past drops (fill rate, cuisine), their group size (self-reported or inferred from last drop), available live drops from their merchants.

**Output:** top 3 recommended drops with a one-line reason and a pre-written group message.

V1 implementation may be **rules-first, LLM-second**: rank deterministically by `likelyFill`, then use the model only to write the message. This is cheaper, more predictable, and good enough.

`likelyFill(drop) = f(historical fill rate for this merchant+item, group size vs minQty, days until cutoff, organiser's past success with this cuisine)`

Start with a simple logistic or even a weighted heuristic. **Do not build an ML model in V1.**

### 9.4 Prompt management

- Prompts live in versioned files, not in the database
- `promptVersion` recorded on every `AiDraft`
- Changing a prompt requires a test run against 10 stored fixtures before deploy

### 9.5 Failure modes

| Failure | Behaviour |
|---|---|
| Model returns invalid JSON | Retry once; then fall back to rule-based proposals |
| Model returns price below floor | Clamp up, log violation, continue |
| Model returns a non-existent `menuItemId` | Reject proposal, fall back |
| Model timeout (>8s) | Fall back to form-based creation |
| Model produces medical/health claims in copy | Copy linter blocks: banned terms list (see §15.3) |

---

## 10. Analytics and instrumentation

### 10.1 Events (all with `dropId`, `merchantId`, `organiserId` where applicable)

```
drop_created, drop_published, drop_cancelled
deal_page_viewed { source: organiser_link | direct | preview }
join_started, join_authorised, join_failed { reason }
threshold_reached, drop_locked, drop_failed
capture_succeeded, capture_failed
redemption_scanned, redemption_completed
report_viewed
ai_draft_generated { surface, guardrail_passed }
```

### 10.2 The north-star dashboard (build this first, before any feature polish)

| Metric | Definition | Target |
|---|---|---|
| **Threshold hit rate** | drops reaching minQty ÷ drops published | **≥70%** |
| Median fill rate | joinedQty ÷ minQty at cutoff | ≥1.15 |
| Time to first publish | publish − merchant created | <20 min |
| Join conversion | authorised ÷ deal page views | ≥25% |
| Organiser share rate | drops shared ÷ drops available | ≥80% |
| Redemption rate | redeemed ÷ captured | ≥90% |
| Repeat participant rate | customers with ≥2 drops ÷ total customers | ≥20% |
| **New-customer share** | first-time customers ÷ participants | **≥50%** |

The last two together are the merchant's proof. If new-customer share is low, the drops are cannibalising and the business is a mirage.

---

## 11. API surface (V1)

```
POST   /api/auth/login
POST   /api/auth/set-password

# Merchant
GET    /api/merchant/me
POST   /api/merchant/onboarding/link
GET    /api/merchant/items
POST   /api/merchant/items
PATCH  /api/merchant/items/:id
POST   /api/merchant/items/:id/guardrail      → evaluateDeal preview
GET    /api/merchant/drops
POST   /api/merchant/drops                    → AI proposals
POST   /api/merchant/drops/:id/publish
POST   /api/merchant/drops/:id/cancel
GET    /api/merchant/drops/:id/report

# Public (no auth)
GET    /d/:publicCode                          → SSR deal page
GET    /api/public/drops/:publicCode
POST   /api/public/drops/:publicCode/join
GET    /api/public/participants/:code          → code page

# Organiser
GET    /api/organiser/drops
POST   /api/organiser/drops/:id/share
GET    /api/organiser/commission

# Staff
POST   /api/staff/redeem                       → { code, qty }
GET    /api/staff/drops/:id/manifest           → batch sheet

# Admin
GET    /api/admin/drops
POST   /api/admin/drops/:id/force-fail
POST   /api/admin/participants/:id/refund
```

All mutating endpoints require idempotency keys. All money fields are integer cents. All timestamps ISO-8601 with offset.

---

## 12. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | Deal page LCP <1.5s on 4G; TTFB <400ms |
| NFR-02 | Mobile-first; 360px minimum width; no horizontal scroll |
| NFR-03 | All money in integer cents, CAD only |
| NFR-04 | Timezone `America/Edmonton` for all display and cutoff logic |
| NFR-05 | Cutoff job p99 <30s for 50 concurrent drops |
| NFR-06 | 99.5% monthly availability (excluding Stripe) |
| NFR-07 | Rate limit join endpoint: 10/min per IP, 5/min per phone |
| NFR-08 | No PII in logs. Phone numbers hashed in analytics |
| NFR-09 | Admin actions fully audit-logged with actor + before/after |
| NFR-10 | Database backups daily, 30-day retention, restore tested once before launch |
| NFR-11 | All secrets in env, never in repo |
| NFR-12 | Accessibility: WCAG 2.1 AA on deal page and join flow |

---

## 13. Technical architecture

### 13.1 Stack decision

**Single Next.js 15 app (App Router) + Prisma + Postgres + one cron worker.**

Retire the Express layer. Rationale: 70% of the existing routes are being deleted anyway; two services for a two-person team is unnecessary ops burden. Keep the Prisma schema (adapted) and the JWT/bcrypt utilities.

```
Next.js (web + API routes)  →  Prisma  →  Postgres
        ↑
  Cron worker (separate process, 60s tick)
        ↓
     Stripe API
```

**Scaling note:** Next.js API routes have execution time limits on serverless hosts. The cutoff job is short at V1 scale (<30s for 50 drops) but will not scale to 300+ merchants on serverless. When that day comes, move the worker to a long-running container. **Do not prematurely solve this.**

### 13.2 Hosting

- App: Vercel (or Railway for a Canadian region)
- DB: Neon or Supabase Postgres
- **Open item:** Alberta PIPA does not mandate data residency, but a Canadian region is cleaner for a business handling customer phone numbers. Decide before launch and disclose the location in the privacy policy.

### 13.3 Environments

`local` → `staging` (Stripe test mode, seeded data) → `production`. Staging must have a working Stripe test account with at least 3 merchants and 10 historical drops so the AI and reporting can be exercised.

### 13.4 Link unfurling — a launch blocker

The deal page must produce a correct preview card in:
- WhatsApp (uses OG tags; needs absolute URLs, `og:image` 1200×630, `og:title` ≤60 chars)
- WeChat (uses OG tags but caches aggressively; add `?v=` cache-buster on the image)

Test on real devices with real WhatsApp and WeChat before launch. This is not a "nice to have" — a bare URL in a group chat converts near zero.

---

## 14. Build plan

| Milestone | Scope | Definition of done |
|---|---|---|
| **M0 — Foundations** (wk 1) | Strip repo, new schema + migrations, auth, admin shell, env setup | `prisma migrate` clean from zero; login works; deleted models gone |
| **M1 — Guardrail** (wk 2) | §7 as a pure module + full test suite incl. all test vectors | 100% of §7.4 vectors pass; `minViablePrice` fuzz-tested against 1,000 random inputs |
| **M2 — Merchant + items** (wk 3) | Merchant CRUD, MenuItem CRUD with validation, Stripe Connect onboarding | A test merchant reaches `charges_enabled` |
| **M3 — Drop creation + AI** (wk 4) | AI interview, 3 proposals, clamped slider, publish, freeze snapshot | Merchant publishes a drop; guardrail violations logged |
| **M4 — Public page + join** (wk 5) | SSR deal page, OG tags, quantity, phone, manual-capture PaymentIntent | Cold-tap to authorised in <45s; **no charge occurs** |
| **M5 — Cutoff + capture** (wk 6) | Cron worker, LOCKED/FAILED, capture, void, ledger, alerts | 50 simulated drops processed correctly; ledger reconciles to Stripe |
| **M6 — Redemption** (wk 7) | QR generation, scan screen, redeem, batch manifest | Scan-to-redeemed <3s; double-scan idempotent |
| **M7 — Reporting + organiser** (wk 8) | Drop report, new-vs-returning, organiser dashboard + share links | Numbers reconcile; organiser sees no PII |
| **M8 — Beta hardening** (wk 9–10) | Admin tooling, refunds, monitoring, 5 merchants live | 10 real drops run end to end with real money |

**M1 before M3 is not negotiable.** The guardrail is the product; if it ships after the UI, the UI will be designed around a wrong number.

---

## 15. Risks and compliance requirements

### 15.1 Technical risks

| Risk | Mitigation |
|---|---|
| Stripe fees land on platform, killing margin | Verify in test mode at M2; block launch if wrong |
| Authorisation expiry | 5-day max window, enforced |
| Cutoff job double-fires | Row lock + status guard + idempotency keys |
| Partial capture below minQty | 90% tolerance rule; alert on rate >5% |
| AI proposes unsafe price | Server-side clamp + violation logging |
| Broken link preview | Manual device test at M4 |

### 15.2 Compliance requirements

| Area | Requirement | Owner |
|---|---|---|
| **CASL** | Consent record per phone/email with basis + timestamp before any marketing SMS. Transactional messages (your drop is confirmed) are separate. Never send on behalf of a participant | Build in M4; legal review before launch |
| **PIPEDA / Alberta PIPA** | Privacy policy, purpose limitation, retention schedule, deletion on request | Before launch |
| **Competition Act** | "31% off" must reference the real `menuPriceCents` recorded in the DB, with genuine sales volume. No merchant-typed "was" price. Show all fees before payment | Design constraint, M3 |
| **Prepaid / gift card rules** | Deal is tied to a specific dated pickup window, not a floating voucher. Windows ≤7 days | Design constraint |
| **AGLC** | No alcohol in any drop in V1 | Hard block in MenuItem validation |
| **Food safety / seller of record** | Terms state merchant is the seller; Stripe destination charge supports this | Terms review |

### 15.3 Copy lint (build in M3)

Block AI-generated copy containing: medical or health claims, "cure", "healthy", "detox", "best in Calgary", "guaranteed weight loss", or any superlative that cannot be substantiated. A simple banned-term list is sufficient for V1.

---

## 16. Out of scope — do not build

Repeating §2.2 because it will be tested: no feed, no discovery, no reviews, no social graph, no delivery, no native app, no multi-item cart, no loyalty, no self-serve merchant signup, no alcohol, no organiser self-serve payouts.

If a developer finds themselves building any of these, the PRD has been misread.

---

## 17. Open decisions (need an answer before M1)

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| D-1 | Stripe fee bearer: platform or merchant | M2 | Merchant, via `on_behalf_of`. Verify in test |
| D-2 | Hosting region: US or Canada | Launch | Canada if available at reasonable cost |
| D-3 | Ops onboarding: how many merchants in beta | M8 | 5. No more |
| D-4 | Organiser commission paid how | M7 | Manual e-transfer, monthly. Do not automate |
| D-5 | SMS provider (Twilio vs local) | M4 | Twilio; verify Canadian sender ID |
| D-6 | Floor default: 25% of menu price | M1 | 25%. Make it per-merchant configurable |
| D-7 | Partial-capture tolerance: 90% | M5 | 90%, revisit after 20 drops |

---

## Appendix A — Definition of Done (global)

A milestone is done when:

1. All its FRs have passing automated tests
2. Money-touching code has an integration test against Stripe test mode
3. The happy path is demonstrated on a real mobile device, not just a desktop browser
4. The failure path is demonstrated (drop fails, card declines, merchant cancels)
5. Any new analytics event appears in the dashboard
6. No PII appears in application logs

## Appendix B — The five sentences that matter

If the team remembers nothing else:

1. **The organiser is the customer.** Not the diner.
2. **The guardrail is the product.** Ship it before the UI.
3. **Never charge before cutoff.** Authorise, then capture.
4. **Threshold hit rate is the only metric.** Not GMV, not users.
5. **The link preview must work in WhatsApp and WeChat** or nothing else matters.

---

*Prepared by Tally. Test vectors in §7.4 are computed and verified; if the implementation disagrees with them, the implementation is wrong until proven otherwise. Every open decision in §17 has a recommendation — take it or overrule it explicitly, but don't leave it blank.*
