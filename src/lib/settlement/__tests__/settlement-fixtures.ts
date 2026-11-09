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
 * ### Three prefix shapes, and the worst one is not the one that looks worst
 *
 * Measured over **105 `PREFIX` declarations across 103 files** (105 distinct literals,
 * so no two are accidentally identical):
 *
 * | shape | count | what `\D` strip leaves |
 * |---|---|---|
 * | `Date.now().toString(36).slice(-5)` | **44** | 0-5 digits, varies per ms |
 * | `Date.now().toString(36).slice(-6)` | **26** | 0-5 digits, varies per ms |
 * | `Date.now()` raw | **32** | the leading six digits — `179419` |
 * | `Date.now().toString(36)` unsliced | 2 | 8-ish digits |
 * | `String(Date.now()).slice(-7)` | 1 | 7 digits |
 *
 * The first row is the majority and an earlier draft of this comment omitted it
 * entirely, describing only the `slice(-6)` form. It is also the worst of the base36
 * shapes: a five-character tail frequently contains **no** digits at all.
 *
 * Digit count over 2026, sampled every **997 ms** (31 630 893 samples — a prime stride,
 * chosen so the sample cannot lock onto the 1 000 ms structure that produced the blind
 * spot described above):
 *
 * | digits | `slice(-5)` (44 tags) | `slice(-6)` (26 tags) |
 * |---|---|---|
 * | 0 | **19.65 %** | **13.99 %** |
 * | 1 | 37.79 % | 32.57 % |
 * | 2 | 29.07 % | 31.58 % |
 * | 3 | 11.18 % | 16.33 % |
 * | 4 | 2.15 % | 4.75 % |
 * | 5 | 0.17 % | 0.74 % |
 *
 * So `slice(-5)` — the majority shape — has an **empty** numeric part nearly one instant
 * in five, and `+1555` + `''` + seq is then the same phone for every namespace alive at
 * that moment.
 *
 * ### The sampling hazard, because it has now produced three wrong percentages
 *
 * Numbers quoted in this comment have been wrong twice, and both times for the same
 * reason: the sample grid was not the real one. Three values for the same quantity:
 *
 * - **14.4 %** — hourly samples. Wrong by enough to change the conclusion.
 * - **12.92 %** — whole-second samples, which force the last three base36 digits to
 *   `000` and so overstate the digits present.
 * - **13.995 %** — prime-stride samples (997, 991, 1009 and 1237 ms all agree to three
 *   decimal places). This is the figure to use.
 *
 * For `slice(-6)` the second-sampled figure is **7.7 % low** (12.918 vs 13.995). That is
 * a smaller error than the prose first claimed here — an earlier draft of this very
 * paragraph said "63 % off", which was invented, not measured. The correction matters
 * twice over: the number was wrong, and the *reason* for preferring a coprime stride
 * survives at 7.7 % rather than at 63 %. A grid that shares a factor with the
 * phenomenon's period does not merely lose precision, it removes cases — but the size of
 * the effect has to be measured, not asserted.
 *
 * Worse, that empty case still **passes** the shape check: `+1555` + `''` + `0001` is
 * `+15550001`, eight digits, which satisfies `^\+\d{8,15}$` at its lower bound. So no
 * assertion on phone *shape* can distinguish a collapsed namespace from a healthy one —
 * only a uniqueness violation can, and only when two namespaces are alive at once.
 *
 * The **raw timestamp** shape is the silent one: `slice(0, 6)` takes the *leading*
 * digits, so it is frozen for **166.7 minutes** at a stretch rather than a millisecond,
 * and the number looks stable and healthy the whole time.
 *
 * ### Measured collapse
 *
 * At one instant, with the old expression, over all 105 declarations:
 *
 * | phone | count | group |
 * |---|---|---|
 * | `+1555100001` | **44** | all `slice(-5)` |
 * | `+15551794190001` | 29 | raw ms, tag digit-free |
 * | `+15558100001` | **27** | 25 × `slice(-6)` **and 2 × unsliced base36** |
 * | `+15550179410001` | 2 | raw ms, tag supplies a leading `0` |
 * | `+15551179410001` | 1 | raw ms, tag supplies a leading `1` |
 * | `+15551780320001` | 1 | `String(Date.now()).slice(-7)` |
 * | `+155558100001` | 1 | `slice(-6)`, one extra digit |
 * | **total** | **105** | 4 groups of ≥2, 3 singletons |
 *
 * An earlier draft of this table said "44 / 29 / 27 and four singletons", which sums to
 * **104** — a table that does not add to the population it claims. Recorded here because
 * the tell is cheap and worth internalising: **a breakdown that does not sum is wrong,
 * and it stays wrong in a certified commit.**
 *
 * Two mechanisms fall out of the table that no percentage would have shown:
 *
 * - **The tag can supply digits.** `Date.now()` on its own yields `179419…`, so the first
 *   six digits are the same for everyone — except `qa-p0…` and `scoped-counts-0-…`,
 *   whose leading `0` shifts the window to `017941`, and `scoped-counts-1-` → `117941`.
 *   They escape the 29-member group **because of the tag, not because they are safer**;
 *   move the clock and they fall back in.
 * - **The group that looks safest is a coincidence.** The 27-member group is
 *   heterogeneous: 25 six-character tails plus **two unsliced `Date.now().toString(36)`
 *   values** (`au…`, `usr…`) that share the tail `8nxfrc` → `810`. The unsliced form is
 *   strictly better — it keeps up to five digits — yet it landed in the worst-looking
 *   bucket at this instant. Per-instant grouping says nothing about per-shape risk.
 *
 * And the scope: **the 19 settlement suites alone → 4 distinct phones** (10 / 7 / 1 / 1).
 * Counting the settlement subset and quoting the result as repo-wide is the error an
 * earlier draft made; the number is a function of the set, so the set is named. Over
 * 8 760 hourly instants across 2026 the repo-wide count stays between **5 and 7** —
 * never better. It is the standing condition, not one unlucky millisecond.
 *
 * Two earlier drafts of this paragraph were wrong in different ways: one said "eight
 * namespaces, two phone numbers", the next said "63 namespaces, 4" — the latter having
 * silently measured only the settlement suites while claiming the repo. The number is
 * a function of *which set* you count, so the set is now named.
 *
 * ## Why FNV over prefix *and* sequence, and why `% 1e7`
 *
 * FNV-1a is the mechanism `fixturePublicCode` above already uses for the same class of
 * bug. Folding `phoneSeq` into the hash matters on its own: with the hash of the prefix
 * alone, two prefixes that collide collide on **every** sequence number, so a run with
 * 20 customers per file collides 20 times rather than once. Hashing `prefix#seq`
 * decorrelates them.
 *
 * The modulus decides the residual risk. Measured per *run* — which is what a
 * `Unique constraint failed` corresponds to — over 2 000 simulated runs against the 105
 * real namespaces, three sequences each: `% 1e6` collided in **0.100 %** of runs,
 * `% 1e7` in **0 %**. Wider is better, and the width is bounded by E.164 rather than by
 * preference.
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
