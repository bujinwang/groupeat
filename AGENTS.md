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
- Full suite baseline: **697 tests — 694 pass, 0 fail, 3 skip.** Green, and
  green under **both** Node 24.21 (`tzdata 2026c`) and PATH Node 22.22
  (`tzdata 2025c`). If a time-related test starts failing, check the Node/tzdata
  version before touching the code under test: **Alberta adopted permanent DST
  on 2026-11-01** and is UTC−6 year-round, so any winter expectation hard-coded
  before that date is stale, not evidence of a bug. Do not "fix" `plan.ts` to
  match an old tzdata.
- The 3 skips are the live Stripe suites (`fee-bearer.live.test.ts`,
  `real-charge-port.live.test.ts`). No `STRIPE_SECRET_KEY` exists here, so
  **payments have never been verified against Stripe test mode**. A green suite
  is not payment verification.

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
