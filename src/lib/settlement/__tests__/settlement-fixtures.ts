import 'dotenv/config';

import { prisma } from '@/lib/db/prisma';
import { PUBLIC_CODE_ALPHABET } from '@/lib/drops/public-code';
import { DEFAULT_FEES, buildGuardrailSnapshot, readGuardrailSnapshot } from '@/lib/guardrail';
import type { FixtureScope } from '@/lib/testing/scoped-counts';

import { platformFeeCentsForOrder } from '../platform-fee';

/**
 * Fixtures for the settlement tests — real Postgres, created and torn down per
 * file, following `src/lib/drops/__tests__/draft-validation.test.ts`.
 *
 * Every test file gets its own `settlementFixtures(prefix)` and calls
 * `cleanup()` in `afterAll`. Ids are tracked as they are created rather than
 * discovered by pattern at teardown, so a test that fails half way still leaves
 * the database as it found it.
 *
 * ## Why the drop is created directly rather than through `createDraft`
 *
 * These tests are about what happens to a drop *after* it is published, and half
 * of them need a drop in a state `publishDrop` refuses to produce (`LOCKED`,
 * `FAILED`, a missing `stripeAccountId`). Going through the publish path would
 * need Stripe and a frozen snapshot for every case, and would test the publish
 * gate instead of settlement.
 */

/**
 * Every value of `DropStatus`, transcribed from `prisma/schema.prisma` in the
 * order the enum declares them.
 *
 * Exists so a test can iterate all of them and still have TypeScript check each
 * one — a hardcoded `['FAILED', 'CAPTURED']` inside a test is how a status gets
 * forgotten when the enum grows. `void-status.registry.test.ts` is the consumer
 * that matters: it fails if this list and the enum ever disagree.
 *
 * Kept in the fixtures rather than in one test file because two tests now need it.
 */
export const ALL_DROP_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type DropStatusLiteral = (typeof ALL_DROP_STATUSES)[number];

export type DropSpec = {
  merchantId: string;
  menuItemId: string;
  dealPriceCents: number;
  minQty: number;
  maxQty?: number;
  /**
   * Default `PUBLISHED`.
   *
   * Widened from four literals to the whole enum so the status-list tests can
   * create a drop in any state. These fixtures bypass `publishDrop` on purpose
   * (see the module docblock), so no state is off-limits here.
   */
  status?: DropStatusLiteral;
  /** Default: one hour ago — i.e. already due. */
  cutoffAt?: Date;
  lockedAt?: Date | null;
  windowStart?: Date;
  windowEnd?: Date;
};

export type ParticipantSpec = {
  dropId: string;
  qty: number;
  /** Default: `qty × dealPriceCents` of the drop this participant belongs to. */
  amountCents?: number;
  /**
   * Default: `platformFeeCentsForOrder()` against the drop's **frozen** snapshot.
   *
   * It used to default to `0`, which quietly made every test that omitted it
   * describe a row the join path must never write: a participant with `qty: 10`
   * and a fee of nothing. Settlement reads the stored fee verbatim and never
   * recomputes it (design §11.1), so those tests still passed — they were simply
   * not describing reality, and the one number in the system that depends on a
   * rounding rule nobody had implemented was the one nobody had to supply.
   *
   * Now the default *is* the obligation. A test that wants a wrong fee to see what
   * happens still passes one explicitly, which is the only case where `0` belongs.
   */
  platformFeeCents?: number;
  authStatus?: 'PENDING' | 'AUTHORIZED' | 'FAILED' | 'VOIDED' | 'EXPIRED';
  chargeStatus?: 'NONE' | 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
  /** Default: a generated, unique `pi_…`. Pass `null` to model the data error. */
  paymentIntentId?: string | null;
  redemptionCode?: string | null;
  /**
   * Default: `SENTINEL_CUSTOMER_NAME_PREFIX` plus this fixture's prefix and
   * sequence. `null` models a diner who never gave a name, which the counter
   * screen has to render.
   */
  customerName?: string | null;
};

/**
 * The `Customer.name` the fixture writes when a test does not care what it is.
 *
 * ## Why this is not just `null` any more
 *
 * It was `null` — the column is nullable and no assertion in the suite read it,
 * so leaving it empty looked harmless. That made one specific claim untestable:
 * `lifecycle-wiring.test.ts` asserts that a diner's name never reaches the
 * analytics sink, and it cannot assert the absence of a value that was never
 * there. The assertion passed for the wrong reason and would have kept passing
 * if `redeem.ts` started sending the whole customer name to the sink tomorrow.
 *
 * So the default is a value that is (a) unmistakable when it turns up somewhere
 * it should not, and (b) impossible to produce by accident — the prefix keeps it
 * unique per test file, and the surrounding words are not a shape any id, code
 * or event name in this system takes.
 *
 * Tests that need a specific human name (the manifest's "renders the name it was
 * given") still pass one, and tests that need the empty state pass `null`.
 */
export const SENTINEL_CUSTOMER_NAME_PREFIX = 'SENTINEL-CUSTOMER-NAME';

const HOUR = 60 * 60 * 1000;

/**
 * A fixture `Drop.publicCode` in the shape the product actually produces.
 *
 * ## What this used to write, and why it broke a slice
 *
 * It was `` `${prefix}${codeSeq}`.toUpperCase().slice(0, 24) `` — so a file prefix of
 * `join-svc-1793829316998` produced **`JOIN-SVC-17938293169981`**: 21 characters,
 * three hyphens. That is a code no part of the product can mint. `createDraft` is the
 * only writer of `publicCode` and it writes `generatePublicCode()`, which emits exactly
 * eight uppercase characters from `PUBLIC_CODE_ALPHABET` — no separators, ever.
 *
 * The fixture was harmless while lookups used the raw segment. It stopped being
 * harmless when the diner-facing read paths began **normalising** the code before the
 * query, because `normalisePublicCode` strips hyphens: `JOIN-SVC-1793…` was stored but
 * `JOINSVC1793…` was looked up. Every join test in the repo failed with `NOT_FOUND`,
 * against a drop that plainly existed — 17 tests, none of them wrong about the
 * product and all of them wrong about the row they had written.
 *
 * ## The shape, and why the tag is a hash
 *
 * Eight characters, uppercase, no separators — the generator's contract, which is also
 * the property that makes normalising a lookup key safe (normalisation is the identity
 * on a generated code; see `public-drops.test.ts`).
 *
 * The first six characters are a hash of the whole `prefix`, the last two count drops
 * within a file. The counter alone is not enough: `publicCode` is globally unique, and
 * test files run against one database, so two files must not agree on the other six.
 *
 * The first attempt at this used the prefix's trailing *letters*, and it collided
 * immediately — `qx1793834000000` and `qx1793834000001` are different prefixes that both
 * end in `QX`, and any all-digit prefix ends in no letters at all and collapsed to
 * `ZZZZ`. Six tests failed on a unique-constraint violation. Hashing the entire prefix
 * is what makes the tag depend on all of it: two prefixes that differ only in a
 * millisecond still separate.
 *
 * Six characters over the 30-symbol alphabet is 7.3 × 10⁸ values; against the ~30 files
 * that use this helper, a collision is a rounding error rather than a plan.
 *
 * The characters are letters on purpose. A digits-only code is its own lowercase form,
 * which makes any assertion about lowercasing silently vacuous — the first draft
 * produced `485729` and a test asserting "the order link does not contain the lowercased
 * segment" passed without testing anything at all.
 *
 * `createDraft`'s own generator would be better still, but it uses `randomInt`, and a
 * fixture that is not reproducible is worse than an unreadable code — a deterministic
 * tag means a failing assertion prints the same code twice.
 */
function fixturePublicCode(prefix: string, codeSeq: number): string {
  // FNV-1a over the whole prefix. Cheap, deterministic, and it mixes in every
  // character — which is the property the trailing-letters version lacked.
  let hash = 0x811c9dc5;
  for (let index = 0; index < prefix.length; index += 1) {
    hash ^= prefix.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  // Six characters, drawn from the generator's alphabet so the result is a code the
  // product could have minted.
  let tag = '';
  let remaining = hash;
  for (let index = 0; index < 6; index += 1) {
    tag += PUBLIC_CODE_ALPHABET[remaining % PUBLIC_CODE_ALPHABET.length];
    remaining = Math.floor(remaining / PUBLIC_CODE_ALPHABET.length);
  }

  /**
   * Ensure the tag carries a letter, which the docblock above promises and this
   * function did not actually guarantee.
   *
   * The alphabet's first eight symbols are digits (`23456789`), so a base-30 digit is a
   * number with probability 8/30 and a *six*-digit tag with probability (8/30)^6 ≈ 1 in
   * 3,500 by that arithmetic. Worse in practice, measured over 400,000 prefixes: about
   * **1 in 3,100**, because the low base-30 digits of an FNV hash are biased towards
   * small values. The all-digit tail is then free to be digits too.
   *
   * That is frequent enough to fail white-box randomly and unfixably. It surfaced as
   * `service.test.ts:450` — `expect(drop.publicCode.toLowerCase()).not.toBe(drop.publicCode)`
   * — failing with `expected '44395729' not to be '44395729'` on the second of three
   * consecutive `npm run verify` runs, with nothing changed between them. Three guards
   * rely on the same property (this file, `quote.test.ts:244`, and
   * `d/[publicCode]/mine/page.test.ts:753`): a digits-only code is its own lowercase
   * form, so each of them silently passes without testing anything in that case, or —
   * as here — fails for a reason that has nothing to do with the code under test.
   *
   * Substituting rather than re-rolling keeps the function deterministic, which the
   * docblock above requires. It costs the tag 8 of its 30 symbols in one position:
   * 22 × 30⁵ ≈ 5.3 × 10⁸ instead of 7.3 × 10⁸, which against ~30 files is still a
   * rounding error, and the substitution is derived from the hash so two different
   * prefixes still separate.
   */
  if (!/[A-Z]/.test(tag)) {
    const letters = PUBLIC_CODE_ALPHABET.replace(/[0-9]/g, '');
    tag = letters[hash % letters.length] + tag.slice(1);
  }

  // Base-30 counter, two characters, unique per drop within a file and also drawn from
  // the alphabet (a `0` or `1` here would make the code fail the shape check).
  const radix = PUBLIC_CODE_ALPHABET.length;
  const low = PUBLIC_CODE_ALPHABET[codeSeq % radix];
  const high = PUBLIC_CODE_ALPHABET[Math.floor(codeSeq / radix) % radix];

  return `${tag}${high}${low}`;
}

/**
 * The customer phone for a fixture namespace — `+1`, seven digits derived from the whole
 * prefix *and* the sequence, then the sequence again as a four-digit tail.
 *
 * ## The defect this replaces
 *
 * The previous expression was `+1555${prefix.replace(/\D/g, '').slice(0, 6)}…`. It reads
 * as "take the numeric part of the prefix" and is, on every prefix this repo uses,
 * "take almost nothing", because the tag letters are not digits. `Customer.phone` is
 * `@unique`, so the only thing keeping the suite green was teardown finishing between
 * files.
 *
 * ### The worked example, which is exact
 *
 * At **2026-11-09T02:49:25.512Z**, `Date.now().toString(36)` is `mw8nxfrc` and the old
 * expression produces `+155580001`:
 *
 * ```
 * mw8nxfrc  --slice(-6)-->  8nxfrc  --replace(/\D/g,'')-->  "8"  -->  +1555 8 0001
 * ```
 *
 * `parseInt('mw8nxfrc', 36) === 1794192565512`, which round-trips to that instant, so
 * every step above is checkable in one line of `node -e`. Two earlier drafts of this
 * comment claimed the example was invented; both were wrong, and both were wrong the
 * same way — they scanned in whole seconds, and this value carries a `.512` offset.
 * `Math.floor(ms/1000)*1000` gives `mw8nxfd4`, a different tail. **A scan that excludes
 * the value is not evidence of absence.**
 *
 * The correction the example does *not* support is the old prose around it, which said
 * "one leading digit and six letters". Two things are wrong there: `mw8nxfrc` is eight
 * characters (one digit, **seven** letters), and the surviving digit is at index 2, not
 * at the front. How many digits survive at all is a distribution, not a constant — see
 * below.
 *
 * ### Two populations, and only one of them mints phones
 *
 * This distinction has now invalidated two versions of this comment, so it is stated
 * before any number:
 *
 * - **105 `PREFIX` declarations in 103 files.** This is what `grep` returns. It is the
 *   wrong denominator: most of those files never call `settlementFixtures()`, and a
 *   namespace that is never passed to the fixture never produces a phone.
 * - **60 namespaces from the 59 files that do call it.** This is the population whose
 *   phones can collide, and every risk claim below uses it. (60 rather than 59 because
 *   `scoped-counts.test.ts` declares `PREFIX` and `STRANGER_PREFIX` and uses both.)
 *
 * One apparent extra shape is **not** a fixture namespace at all:
 * `l5-run.test.ts:27`'s `PHONE_PREFIX = \`+1780${String(Date.now()).slice(-7)}\`` is a
 * literal phone number in a file that never calls the fixture. An earlier draft of this
 * comment listed it as a prefix shape; it is a false positive of the grep.
 *
 * ### Shape split, on the population that matters
 *
 * | shape | all 105 decls | **60 callers** | what `\D` strip leaves |
 * |---|---|---|---|
 * | `${Date.now()}` raw | 32 | **24** | the leading six digits — `179419` |
 * | `.toString(36).slice(-6)` | 26 | 19 | 0-5 digits |
 * | `.toString(36).slice(-5)` | 44 | **16** | 0-5 digits |
 * | `.toString(36)` unsliced | 2 | 1 | up to 8 digits |
 * | **sum of rows** | **104** | **60** | |
 *
 * The declaration column sums to **104, not 105**, and the missing one is the point of
 * the paragraph above: `l5-run.test.ts`'s `PHONE_PREFIX` is a phone number, not a
 * fixture prefix, so it is counted in the grep total and excluded from every shape. An
 * earlier version of this table printed "all 105 decls" over four rows adding to 104 and
 * left the reader to find the discrepancy. A table whose rows do not sum to its own
 * header is the same defect as the prose it replaced, one level down.
 *
 * **The raw timestamp is the majority among callers, not `slice(-5)`.** Two earlier
 * drafts of this comment asserted the opposite — `slice(-5)` is 44 of 105 declarations,
 * **41.9 %**, but only 16 of 60 callers, **26.7 %**, and the third-largest group. (An
 * earlier version of this line said "41.5 %". That is 44/106, and 106 is the number of
 * files `grep` touches, not the number of declarations inside them — so the percentage
 * was computed on a file count and printed as a share of declarations. Both numbers were
 * real; the sentence paired them.) Counting declarations and calling it the population
 * is the same mistake as counting a subset and calling it the repo; it has now been made
 * twice in this one paragraph, in both directions.
 *
 * ### Digit rates, and why the sampling grid is not a detail
 *
 * | digits | `slice(-5)` (16 callers) | `slice(-6)` (19 callers) |
 * |---|---|---|
 * | 0 | **19.646 %** | **13.995 %** |
 * | 1 | 37.79 % | 32.57 % |
 * | 2 | 29.07 % | 31.58 % |
 * | 3 | 11.18 % | 16.33 % |
 * | 4 | 2.15 % | 4.75 % |
 * | 5 | 0.17 % | 0.74 % |
 *
 * Measured over 2026 at a **997 ms stride** (31 630 893 samples) and corroborated at 991,
 * 1009 and 1237 ms, all four agreeing to three decimals.
 *
 * Whole-second sampling gives 12.92 % / 18.13 %, i.e. **7.7 % low** for both widths. The
 * earlier explanation for that gap — "the last three base36 digits are forced to `000`" —
 * is **wrong**: only 5 407 of 31 536 000 second-aligned instants end in `000`, which is
 * 0.017 % and cannot move a rate by 7.7 %. The real mechanism is arithmetic:
 *
 * - `gcd(1000, 36⁶) = 8`, so a 1 000 ms stride reaches only **1/8** of the residue
 *   classes modulo `36⁶`.
 * - `gcd(3 600 000, 36⁶) = 1152`, so an hourly stride reaches only **1/1152**.
 *
 * A restricted residue set does not sample the phenomenon, it samples a coset. And the
 * consequence is decisive for one figure that used to appear here: **hourly sampling can
 * never produce a zero-digit `slice(-6)` at all** — measured, **0 of 96 432** hourly
 * instants across 2020-2030. So the "14.4 %" quoted in an earlier draft was not a noisy
 * measurement of this quantity; it was not a measurement of this quantity. It is
 * unreproducible on any grid tried, and the honest statement is that its origin is
 * unknown.
 *
 * Sample coprime to the structure and say what the grid was.
 *
 * ### Measured collapse, on the 60 caller namespaces
 *
 * At **2026-11-09T03:00:00Z** the old expression yields **5 distinct phones**:
 *
 * | phone | count | group |
 * |---|---|---|
 * | `+15551794190001` | 21 | raw ms, digit-free tag |
 * | `+15558100001` | 20 | 19 × `slice(-6)` **and 1 unsliced base36** |
 * | `+1555100001` | 16 | all `slice(-5)` |
 * | `+15550179410001` | 2 | raw ms, tag supplies a leading `0` |
 * | `+15551179410001` | 1 | raw ms, tag supplies a leading `1` |
 * | **total** | **60** | |
 *
 * Hourly across all of 2026 that count stays **4-5** — never better. It is the standing
 * condition, not one unlucky millisecond.
 *
 * The exact phone values are instant-dependent and an earlier draft quoted them as
 * fixtures of the repo, which they are not: at 12:00Z the `slice(-5)` group is
 * `+1555500001`, not `+1555100001`. Only the *count* and the *mechanism* are stable.
 *
 * Two mechanisms the table shows that no percentage would:
 *
 * - **A tag can supply digits.** `Date.now()` alone gives `179419…`, identical for
 *   everybody — except `qa-p0…` / `scoped-counts-0-…`, whose leading `0` shifts the window
 *   to `017941`, and `scoped-counts-1-` → `117941`. They escape the 21-member group
 *   **because of their tag, not because they are safer**; move the clock and they rejoin.
 * - **The group that looks safest is a coincidence.** The 20-member group is
 *   heterogeneous: 19 six-character tails plus **one unsliced `.toString(36)`** value
 *   that happened to share the tail. The unsliced form is strictly better — it keeps up to
 *   eight digits — yet it landed in the worst-looking bucket at this instant. Per-instant
 *   grouping says nothing about per-shape risk.
 *
 * ### Raw milliseconds: stride versus dwell
 *
 * `slice(0, 6)` takes the *leading* digits, so a given phone value is frozen for
 * **166.7 minutes** (`10⁷` ms) — that is the full stretch. Measured from a random instant,
 * the expected time until the next change is **half** that, 83.3 minutes, because a random
 * arrival lands mid-window. Both numbers are correct; quoting one as "the" duration
 * without saying which is resumed life and which is window length is how this paragraph
 * got its first version wrong.
 *
 * ## Why FNV over prefix *and* sequence, and why `% 1e7`
 *
 * FNV-1a is the mechanism `fixturePublicCode` above already uses for the same class of
 * bug. Folding `phoneSeq` into the hash matters on its own: with the hash of the prefix
 * alone, two prefixes that collide collide on **every** sequence number, so a run with
 * 20 customers per file collides 20 times rather than once. Hashing `prefix#seq`
 * decorrelates them.
 *
 * The modulus decides the residual risk. Harness-measured per-run rates were unstable
 * (0.0 % to 5.4 % across six harnesses) and are not quoted here, because **the birthday
 * bound needs no harness**: 60 namespaces x 3 sequences = 180 items into `1e7` gives
 *
 * ```
 * P(collision) ≈ 1 - exp(-k(k-1) / 2N),  k = 180, N = 1e7  ->  0.161 %
 * ```
 *
 * and at 315 items (105 declarations x 3) it is **0.493 %**. An earlier version of this
 * line paired the *number* 318 with the *derivation* "105 declarations x 3", which do not
 * agree: 105 x 3 is 315, and 318 is 106 x 3 — 106 being the count of files the grep
 * touches, not the count of declarations inside them. Two populations, silently mixed in
 * one parenthetical, in the very sentence warning about mixed populations. So an earlier
 * draft's "`% 1e7` in 0 %" was a harness artifact, not a property: a 0 % rate is
 * unfalsifiable unless the harness is known to exercise enough runs. `% 1e6` at 14 digits
 * roughly *tenfolds* that. Wider is better, and the width is bounded by E.164 rather than
 * by preference.
 *
 * ### The digit budget, which has less headroom than it looks
 *
 * `^\+\d{8,15}$` allows 15 digits after the `+`, and `+1555` is four of them:
 *
 * | hash width | phone digits | valid? |
 * |---|---|---|
 * | 6 | 14 | yes, one spare |
 * | **7 (shipped)** | **15** | yes, exactly at the ceiling |
 * | 8 | 16 | **no** |
 * | 9 | 17 | **no** |
 *
 * A 9-digit hash was tried first and produces 17 digits, i.e. not a phone number. The
 * arithmetic has to be checked, not assumed — and note that `% 1e7` with a 4-digit
 * sequence leaves **zero** headroom, so the sequence width is now load-bearing too.
 * `phoneSeq` is a per-fixture counter, and `padStart(4, '0')` truncates nothing only
 * while a single fixture mints fewer than 10 000 customers.
 *
 * Deterministic on purpose, like everything else in this fixture: a failing assertion
 * must print the same phone twice.
 */
function fixturePhone(prefix: string, phoneSeq: number): string {
  const key = `${prefix}#${phoneSeq}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const digits = String(hash % 10_000_000).padStart(7, '0');
  return `+1555${digits}${String(phoneSeq).padStart(4, '0')}`;
}

export function settlementFixtures(prefix: string) {
  const merchantIds: string[] = [];
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const dropIds: string[] = [];
  /**
   * Participant ids are tracked for the scoped-count helper's `AuditLog.targetId`
   * namespace. Cleanup does not need them (`Drop` cascades to participants), but a
   * `participant.refund` audit row names a participant id, not its drop id, so a count
   * scoped only by `dropIds` would miss exactly the row these suites watch for.
   */
  const participantIds: string[] = [];
  const itemIds: string[] = [];

  let phoneSeq = 0;
  let codeSeq = 0;
  let piSeq = 0;

  /**
   * A per-namespace default account id, so two fixtures in one process do not collide.
   *
   * `Merchant.stripeAccountId` is `@unique` (`schema.prisma:79`), and this parameter
   * used to default to the literal `'acct_test_settlement'`. Twenty-seven call sites
   * take the default, so any two of them alive at once — two fixture instances in one
   * file, or two suites under a concurrent `vitest` — raced for one row and the loser
   * got `Unique constraint failed on the fields: (stripeAccountId)`. Measured: two
   * fixtures constructed in a single process, both calling `merchant()`, the second
   * throws.
   *
   * Derived from the prefix the same way `fixturePhone` derives the phone, and for the
   * same reason. An explicit argument is still honoured **verbatim**, because two tests
   * assert on exact account ids: `cutoff-decision.test.ts:94` expects
   * `'acct_test_settlement'`, and the suites that pass `'acct_test_join_route'` and
   * friends depend on their own values. Only the omitted case changes.
   */
  const defaultStripeAccountId = `acct_test_${prefix}`;

  return {
    nextPaymentIntentId(): string {
      piSeq += 1;
      return `pi_${prefix}_${piSeq}`;
    },

    async merchant(stripeAccountId: string | null = defaultStripeAccountId): Promise<string> {
      const user = await prisma.user.create({
        data: {
          email: `${prefix}-${Date.now()}-${userIds.length}@example.test`,
          passwordHash: 'not-a-real-hash',
          role: 'MERCHANT',
          mustChangePassword: true,
        },
        select: { id: true },
      });
      userIds.push(user.id);

      const merchant = await prisma.merchant.create({
        data: {
          name: `${prefix} merchant`,
          slug: `${prefix}-${Date.now()}-${merchantIds.length}`,
          status: 'ACTIVE',
          stripeAccountId,
          floorPctOfMenu: 0.25,
          users: { create: { userId: user.id, role: 'OWNER' } },
        },
        select: { id: true },
      });
      merchantIds.push(merchant.id);
      return merchant.id;
    },

    async item(merchantId: string): Promise<string> {
      const item = await prisma.menuItem.create({
        data: {
          merchantId,
          name: `${prefix} bowl`,
          menuPriceCents: 1600,
          foodCostCents: 480,
          packagingCents: 80,
          batchYield: 60,
          prepMinutes: 6,
          isBatchable: true,
          containsAlcohol: false,
          category: 'Bowls',
        },
        select: { id: true },
      });
      itemIds.push(item.id);
      return item.id;
    },

    async drop(spec: DropSpec): Promise<string> {
      const now = Date.now();
      codeSeq += 1;
      const snapshot = buildGuardrailSnapshot(
        {
          ...DEFAULT_FEES,
          menuPriceCents: 1600,
          foodCostCents: 480,
          packagingCents: 80,
          floorPctOfMenu: 0.25,
        },
        spec.dealPriceCents,
        new Date(now).toISOString(),
      );

      const drop = await prisma.drop.create({
        data: {
          merchantId: spec.merchantId,
          menuItemId: spec.menuItemId,
          publicCode: fixturePublicCode(prefix, codeSeq),
          title: `${prefix} drop ${codeSeq}`,
          dealPriceCents: spec.dealPriceCents,
          minQty: spec.minQty,
          maxQty: spec.maxQty ?? Math.max(spec.minQty * 2, spec.minQty + 1),
          maxPerCustomer: 4,
          cutoffAt: spec.cutoffAt ?? new Date(now - HOUR),
          windowStart: spec.windowStart ?? new Date(now + HOUR),
          windowEnd: spec.windowEnd ?? new Date(now + 2 * HOUR),
          status: spec.status ?? 'PUBLISHED',
          guardrailSnapshot: snapshot,
          publishedAt: new Date(now - 2 * HOUR),
          lockedAt: spec.lockedAt ?? null,
        },
        select: { id: true },
      });
      dropIds.push(drop.id);
      return drop.id;
    },

    async participant(spec: ParticipantSpec): Promise<string> {
      const drop = await prisma.drop.findUniqueOrThrow({
        where: { id: spec.dropId },
        select: { dealPriceCents: true, guardrailSnapshot: true },
      });
      phoneSeq += 1;

      // `phoneSeq` is per-fixture and restarts at 1, so uniqueness across *runs* depends
      // on teardown having deleted the previous run's customers. That was false in
      // `share-links.test.ts` for a while — its `afterAll` deleted the organiser profile
      // before the drop, hit `ShareLink_organiserId_fkey` on every delete, swallowed it
      // with `.catch(() => undefined)`, and left both customers and organisers behind.
      // The leftover customers then collided here on the second run in the same
      // wall-clock window, which is how a teardown bug surfaced as a duplicate-phone
      // error in an unrelated suite.
      //
      // Uniqueness across *files* used to be accidental and is now via `fixturePhone`,
      // which hashes the whole prefix. Before that, every `run-tick*` suite produced the
      // identical phone number — see the docblock there for the measurement. So a
      // `Unique constraint failed on the fields: (phone)` from here has two causes, not
      // one: check teardown first, then check whether a new suite's prefix collides.
      const customer = await prisma.customer.create({
        data: {
          phone: fixturePhone(prefix, phoneSeq),
          // Never `null` unless a test asks for it — see
          // `SENTINEL_CUSTOMER_NAME_PREFIX`. A name the sink must not contain is
          // only assertable if the row actually has one.
          name:
            spec.customerName === undefined
              ? `${SENTINEL_CUSTOMER_NAME_PREFIX}-${prefix}-${phoneSeq}`
              : spec.customerName,
        },
        select: { id: true },
      });
      customerIds.push(customer.id);

      const participant = await prisma.dropParticipant.create({
        data: {
          dropId: spec.dropId,
          customerId: customer.id,
          qty: spec.qty,
          amountCents: spec.amountCents ?? spec.qty * drop.dealPriceCents,
          platformFeeCents:
            spec.platformFeeCents ??
            platformFeeCentsForOrder({
              qty: spec.qty,
              // The stored price, not a constant: a fixture drop can be created at
              // any price and the fee must follow it.
              dealPriceCents: drop.dealPriceCents,
              // The frozen constants, read through the validating reader — so this
              // default fails loudly if a snapshot is unreadable rather than
              // silently producing `NaN` money.
              fees: readGuardrailSnapshot(drop.guardrailSnapshot).input,
            }),
          authStatus: spec.authStatus ?? 'AUTHORIZED',
          chargeStatus: spec.chargeStatus ?? 'NONE',
          paymentIntentId:
            spec.paymentIntentId === null
              ? null
              : (spec.paymentIntentId ?? `pi_${prefix}_${++piSeq}`),
          redemptionCode: spec.redemptionCode ?? null,
        },
        select: { id: true },
      });
      participantIds.push(participant.id);
      return participant.id;
    },

    async cleanup(): Promise<void> {
      // Collect teardown errors rather than swallowing them. This fixture is inherited by
      // every settlement-backed suite, so one `.catch(() => undefined)` here hid FK
      // failures across dozens of files at once. Run every delete even after one fails —
      // a red run must not leak more than a green one — then throw once, after
      // disconnecting, so the failure names the teardown that actually broke.
      const failures: unknown[] = [];
      const step = async (run: () => Promise<unknown>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          failures.push(error);
        }
      };

      // Ledger rows have no foreign key (design §5), so nothing cascades to them.
      if (dropIds.length > 0) {
        await step(() => prisma.ledgerEntry.deleteMany({ where: { dropId: { in: dropIds } } }));
        // Cascades participants and orders.
        await step(() => prisma.drop.deleteMany({ where: { id: { in: dropIds } } }));
      }
      if (customerIds.length > 0) {
        await step(() => prisma.customer.deleteMany({ where: { id: { in: customerIds } } }));
      }
      if (itemIds.length > 0) {
        await step(() => prisma.menuItem.deleteMany({ where: { id: { in: itemIds } } }));
      }
      if (merchantIds.length > 0) {
        await step(() => prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }));
      }
      if (userIds.length > 0) {
        await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
      }
      await prisma.$disconnect();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `settlementFixtures.cleanup(): ${failures.length} delete(s) failed`,
        );
      }
    },

    /**
     * The ids this fixture instance owns, read live at each call (drops are created
     * inside `it()` blocks, so a snapshot taken in `beforeAll` would be empty).
     * Feeds `scopedCounts` in `src/lib/testing/scoped-counts.ts` so the "nothing
     * writes" suites can count only their own namespace.
     */
    scope(): FixtureScope {
      return {
        dropIds,
        merchantIds,
        customerIds,
        userIds,
        participantIds,
      };
    },
  };
}

export type SettlementFixtures = ReturnType<typeof settlementFixtures>;
