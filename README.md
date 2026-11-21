# GroupEat

GroupEat is a batch-order engine with a margin guardrail. A merchant publishes a
dated drop with a minimum quantity and a deadline; diners join by authorising a
card, and capture happens only at the cutoff and only if the minimum is met.
Money moves through Stripe Connect as direct charges on the merchant's connected
account, so the platform never holds the funds.

## Stack

- Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4
- Prisma 6 with PostgreSQL
- Vitest for tests; Stripe Connect for onboarding, holds and capture
- Optional integrations with defined fallbacks: Resend email and Twilio SMS both
  run in **logging mode** (compose and log, send nothing) when credentials are absent

## Prerequisites

- **Node 24.21.0** via nvm (`.nvmrc`; `engines` requires `>=24.0.0`). Use the
  nvm-pinned interpreter for build and test commands: native modules in
  `node_modules` are arm64, so running them under an x64 `node` on `PATH` fails
  with misleading "module not found" errors.
- npm
- A running PostgreSQL server with a `groupeat_dev` database.

## Quick start

```sh
cp .env.example .env
# Fill in DATABASE_URL (point it at groupeat_dev) and JWT_SECRET (>= 32 random chars)
npm ci
npm run db:migrate
npm run db:seed
npm run dev            # http://localhost:3001
```

Seeded accounts get a temporary password from `SEED_PASSWORD` (see
`.env.example`) with `mustChangePassword` set, so change the password on first
login. No server runs by default; the dev server binds to port **3001**.

## Scripts

| Script | Purpose |
|---|---|
| `dev` | Start the Next.js dev server on port 3001. |
| `build` | Production build. |
| `start` | Serve a production build. |
| `lint` | ESLint across the repo. |
| `typecheck` | `tsc --noEmit`. |
| `test` | Run Vitest once (deliberately ungated — no preflight). |
| `test:watch` | Run Vitest in watch mode. |
| `residue` | Print residue table counts for diagnosis. |
| `census:fixtures` | Re-derive the test-fixture census. |
| `residue:wipe` | Dry-run what residue cleanup would delete (add `-- --apply` to delete). |
| `interpreter` | Run the interpreter/tzdata offset preflight on its own. |
| `verify` | The gate: interpreter preflight, clean-residue baseline, full Vitest run, residue comparison. |
| `db:migrate` | Apply Prisma migrations (`prisma migrate dev`). |
| `db:reset` | Reset the database with `prisma migrate reset --force`. |
| `db:seed` | Run `prisma/seed.ts`. |
| `db:studio` | Open Prisma Studio. |
| `sms:verify` | Opt-in live Twilio SMS verification script. |
| `stripe:verify` | Opt-in live Stripe money-seam verification script. |
| `join:verify` | Opt-in live in-app `/join` route verification script. |

### The `verify` gate and the interpreter preflight

`npm run verify` is the gate for a change. Before running any test it checks the
Node interpreter's timezone data: Alberta adopted permanent DST on 2026-11-01
and is UTC−6 year-round, so a stale `tzdata` resolves a winter Edmonton time an
hour off and produces time-shaped test failures that have nothing to do with the
code under test. The preflight asserts the *offset* (not just a version string):
`TZ=America/Edmonton` at `2026-11-02T12:00:00Z` must be UTC−6. On a stale
interpreter it stops with the runtime, its `tzdata`, the observed offset and the
fix instead of running a red suite. Run it with the pinned interpreter:

```sh
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" npm run verify
```

`npm test` is deliberately ungated: a fast run without the preflight is useful,
and the asymmetry is a choice, not an oversight. `verify` also refuses to run
while another verification holds `node_modules/.residue.lock`.

**Current certified baseline (combined Gates 32-34 baseline at merged HEAD `9c16157` on pinned Node 24.21.0):** 232 test files passed / 1 skipped, 2998 tests passed / 8 skipped; of the 8 skips, 3 are Stripe/live opt-in (`RUN_STRIPE_LIVE_TESTS=1`) and 5 are the stripe-mock request-construction contract (skipped because stripe-mock is not running on `127.0.0.1:12111`); 13 residue tables measured 0 → 0. A green suite is **not** evidence that live payments work — the live money seam is proven only by the opt-in scripts above.

## Environment

`.env.example` is the environment contract; copy it to `.env` (git-ignored) and
fill in the required values. The app fails fast at boot with a readable message
if a required key is missing.

- **Required:** `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`. Set a real
  `JWT_SECRET` (at least 32 characters) before using the app.
- **Optional with defaults or fallbacks:** `ANALYTICS_LOG_PATH`, `SEED_PASSWORD`,
  `APP_URL`, and every integration key listed below. Empty values count as unset.

Optional integrations and their absence behaviour:

- **AI copy model** (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`): with no model, the
  planner writes the proposal copy itself and the API reports `source: "planner"`;
  nothing fails.
- **Stripe** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`): without a secret key, Connect onboarding
  answers `503 STRIPE_NOT_CONFIGURED` and the join route refuses before writing
  a row. Use test-mode keys in development; never put live keys in `.env`.
- **Cron secret** (`CRON_SECRET`): unset means the cutoff and reconcile routes
  answer `503 NOT_CONFIGURED`. Vercel Cron sends a `GET` with the bearer token;
  other runners should use `POST`.
- **Redemption / participant access secrets** (`REDEMPTION_SECRET`,
  `PARTICIPANT_ACCESS_SECRET`): unset, each is derived from `JWT_SECRET` via
  HKDF-SHA256 under a different info string, so a leaked order link cannot be
  used as a redemption code. Set them in production.
- **Twilio SMS** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER`): with any value absent, notifications are composed and
  logged (`{ kind, count }`) and nothing is sent.
- **Resend email** (`RESEND_API_KEY`, `DIGEST_FROM_EMAIL`): with either absent,
  the digest email is composed, the job reports how many would have been sent,
  and nothing leaves the building.

Never commit real secrets.

## Architecture / code map

- `src/app` — App Router pages and route handlers (merchant, organiser, admin,
  public diner pages, and the API routes under `api/`).
- `src/lib` — domain logic, including `auth` (session/credentials), `db`
  (Prisma access), `drops`, `join`, `settlement` (cutoff tick and capture),
  `payments` (Stripe Connect), `notify`, and `analytics` (including the protected
  metrics that produce the PRD's north-star figures).
- `prisma/` — schema, migrations and the seed script (PostgreSQL).
- `scripts/` — residue and interpreter gates plus the opt-in live verification
  scripts (`verify-stripe.ts`, `verify-sms.ts`, `verify-join-app.ts`).
- `docs/` — PRDs, ADRs, architecture notes and the status board.

Scheduled jobs are declared in `vercel.json`: the cutoff job runs every minute
(`/api/jobs/cutoff`, `* * * * *`), the digest weekly, and reconciliation daily.
The cutoff route exports **both GET and POST** through one handler, so Vercel
Cron and manual `curl` runners cannot diverge.

## Docs

The status board is [`docs/PROGRESS.md`](docs/PROGRESS.md) — read it first; it
tracks slices and gates, not a hand-maintained ahead-count (PR #2 merged all
sprint-2 work into `master`).

- [Product requirements (PRD v1)](docs/PRD-v1.md)
- [Sprint 1 architecture](docs/ARCHITECTURE-sprint1.md)
- Decisions: [ADR-001 Stripe fee bearer](docs/ADR-001-stripe-fee-bearer.md),
  [ADR-002 AI price authorship](docs/ADR-002-ai-price-authorship.md),
  [ADR-003 joins continue to max qty](docs/ADR-003-joins-continue-to-max-qty.md),
  [ADR-004 ledger invariant](docs/ADR-004-ledger-invariant-two-identities.md),
  [ADR-005 void sweep status list](docs/ADR-005-void-sweep-status-list.md)
- [M5 cutoff design](docs/M5-cutoff-design.md)
- [Contributing](CONTRIBUTING.md)
- [Agent standing instructions](AGENTS.md)

## Known limits

- The live browser diner tap is not yet proven end-to-end:
  `JOIN_FLOW_PROVEN_LIVE` remains `false` in the diner page; proving it needs a
  human at a browser. The server-layer join flow is proven by an opt-in script.
- Legacy `CAPTURED` rows with `redemptionCode = null` exist and need one-off data
  remediation; new captures and the repair path assign a code.
- Live Stripe, SMS and in-app join verification are opt-in scripts requiring real
  credentials; they are not part of the default test run.
