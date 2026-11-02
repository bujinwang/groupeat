# GroupEat — progress

> **Audited:** 2026-11-02 09:38 CST · **Branch:** `sprint-2/payments-fee-bearer` (22 ahead of `master`, 0 behind) · **HEAD:** `f3982ed` · **Tree:** clean.
> This file is the status board. Update it in the same commit as the slice it describes.

## Status at a glance

| Milestone | Status | Evidence / gap |
|---|---|---|
| **M0 — Foundations** | ✅ | Auth, roles, admin shell, schema, seed, env validation. |
| **M1 — Guardrail** | ✅ | Pure module, test vectors, fuzz, snapshot, purity guards. |
| **M2 — Merchant + items + Connect** | 🟡 | CRUD and the Connect onboarding state machine exist (`src/lib/payments/`). Live `charges_enabled` **never verified** — no Stripe key. |
| **M3 — Drop creation + AI** | ✅ | `plan.ts`, ADR-002, interview, copy lint, publish gate, frozen snapshot. |
| **M4 — Public page + join** | 🟡 | Slice 1 (FR-301…308) shipped at `fe47cbf`. **Slice 2a (FR-401…407 domain + API) shipped** — a participant can now exist, with a card hold. Slice 2b (the join page) and 2c (diner code page) remain. |
| **M5 — Cutoff + capture** | 🟡 | Code and tests for FR-501…505, 507 at `9f3ea4f`. FR-506 is a no-op seam. Live capture never run against Stripe. |
| **M6 — Redemption** | 🟡 | Scanner, manifest, idempotent redeem (FR-601…605). No diner-facing code page; FR-606 deferred (optional V1.1). |
| **M7 — Reporting + organiser** | ⬜ | `/organiser` is still the Sprint 1 placeholder. |
| **M8 — Beta hardening** | ⬜ | Admin refunds, force-fail, impersonation absent. |

## Verified in this audit

- Full suite: **697 tests — 694 pass, 0 fail, 3 skip** (62 files; 61 pass, 1 skips).
  Run with arm64 Node:
  `~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run`
  Verified identical under PATH Node 22.22 (`tzdata 2025c`) and Node 24.21
  (`tzdata 2026c`); see gap 6 for why that matters.
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
| FR-402 phone E.164 + Payment Element | 🟡 | normalisation + storage ✅ (`normalisePhone`); **the Element is slice 2b** |
| FR-403 manual-capture PaymentIntent | 🟡 | `join/real-payment-port.ts` written and asserted at source; **never executed against Stripe** — live test skips |
| FR-404 no charge at join | ✅ | `JOIN_CAPTURE_METHOD = 'manual'` is a constant, not a parameter; tests assert no `CHARGE` ledger row and `chargeStatus = NONE` |
| FR-405 idempotency `dropId:customerId` | ✅ | `(dropId, customerId)` unique index + service behaviour; double submit and 3-way concurrent tap both produce one row and one hold |
| FR-406 race-safe sold out | ✅ | `SELECT … FOR UPDATE` on the drop row; proven — removing the lock makes one plate sell twice and a 4-plate drop sell 6 |
| FR-407 confirmation copy | ✅ | `joinConfirmationCopy`; the pre-cutoff disclosure is asserted, not assumed |
| FR-408 confirmation SMS with consent | 🟡 | consent ✅ (`ConsentRecord`, `EXPRESS`, `drop_join`, written in the same transaction); **no sender** — D-5 |

Hard evidence that the join flow now exists:

- `joinDrop()` writes `DropParticipant` rows: `PENDING` under the lock, then
  `AUTHORIZED` or `FAILED` after the provider answers.
- `POST /api/public/drops/[code]/join` answers 200/402/404/409/422/503 with
  finished copy; 12 route tests.
- 91 join tests (6 files), all green. Counted with
  `vitest run src/lib/join 'src/app/api/public/drops/[code]/join'` rather than
  estimated: 47 rules, 17 service, 12 route, 7 fake port, 4 purity, 4 boundary.

Still absent, and deliberately:

- `JOIN_FLOW_READY = false` in the page. The route works; the **UI does not**, and
  flipping the flag before the Payment Element exists would give a diner a form
  that cannot take a card.
- No `pm_…` ever reaches the service, because no page produces one.

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

1. **The join UI is missing (P0 for the flow).** The domain and API exist;
   `/d/[publicCode]/join` has no page and `JOIN_FLOW_READY` is still `false`, so a
   diner cannot reach the endpoint from the deal page. That is slice 2b.
2. **No diner-facing code page (P0 once join ships).** Redemption codes are minted
   at capture (`settle.ts`) but only appear in the merchant manifest. FR-601
   scanning works on codes a diner never receives. No QR is generated. Slice 2c.
3. **SMS is a seam only.** No provider (D-5), no sender, no link to a code page.
   FR-408 and FR-506 cannot be called done. Consent *is* now recorded at join.
4. **Stripe is named in config but unkeyed in practice.** `.env.example` and
   `src/lib/config.ts` declare `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, but no key exists here. `stripe` (server)
   is installed; **`@stripe/stripe-js` and `@stripe/react-stripe-js` are not**, so
   a Payment Element cannot render even with a key. Both are 2b work.
5. **Analytics covers five merchant events only.** PRD §10.1's funnel events
   (`drop_viewed`, join events, settlement outcomes) are absent, so Appendix A
   item 5 is unmet for M4.
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
9. **The join's real port has never run against Stripe.**
   `join/real-payment-port.ts` is transcribed from documentation, like
   `real-charge-port.ts` before it, and its live test skips by name. Treat the
   first failure against Stripe as a bug in that file before a bug in a diner's
   card — ADR-001 §4 is the precedent for documentation being wrong here.

## Next slice — M4 slice 2b/2c

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

### 2b — the join page

- `/d/[publicCode]/join`: quantity (1..`maxPerCustomer`), phone, optional name,
  consent checkbox, Stripe Payment Element when
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` exists; otherwise a readable
  "payments not configured" state.
- Confirmation state with FR-407 copy: "You will only be charged if {minQty}
  people join by {cutoff}".
- Add `@stripe/stripe-js` + `@stripe/react-stripe-js` (the only missing deps —
  `stripe` server-side, the three env vars, `config.ts` entries and
  `.env.example` documentation already landed in 2a).

### 2c — code page + notification seam

- Participant code page (token in URL or a signed cookie set at join) showing the
  redemption code, quantity, pickup window and address. This is the page FR-408's
  SMS links to.
- Wire `NotifyPort` at join confirmation and settlement; keep it no-op until D-5.
- Flip `JOIN_FLOW_READY = true` only after a live run with test-mode keys:
  join → `AUTHORIZED` → no `CHARGE` row → page shows confirmation.

**Acceptance (M4 DoD):** cold tap to authorised in <45s on a real phone, no
charge before cutoff, the page's count and the join's capacity check agree, and
a double submit produces one participant.

**Blocked by:** test-mode keys (`sk_test_…`, `pk_test_…`) and a webhook secret;
D-5 for actual SMS; the OTP decision. Keyless work (2a) can land now.

## Commands

```bash
# tests (arm64 node — see AGENTS.md for why)
~/.nvm/versions/node/v24.21.0/bin/node node_modules/vitest/vitest.mjs run
npx tsc --noEmit && npx eslint .

# app
npm run dev            # http://localhost:3001
npx prisma migrate status
npx prisma db seed
```

## Decision log

`docs/ADR-001` direct charges, merchant bears Stripe fee ·
`docs/ADR-002` server authors money, model authors words ·
`docs/ADR-003` joins continue to `maxQty` ·
`docs/ADR-004` ledger identities L1–L5 ·
`docs/ADR-005` void-sweep status list.
