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
 * The customer phone for a fixture namespace — `+1`, nine digits derived from the whole
 * prefix *and* the sequence, then the sequence again as a four-digit tail.
 *
 * ## The defect this replaces
 *
 * The previous expression was `+1555${prefix.replace(/\D/g, '').slice(0, 6)}…`. It reads
 * as "take the numeric part of the prefix" and is, on every prefix this repo uses,
 * "take almost nothing", because the tag letters are not digits. `Customer.phone` is
 * `@unique`, so the only thing keeping the suite green was teardown finishing between
 * files. The two prefix shapes in this repo fail in different ways, and the second is
 * worse:
 *
 *   - **Base36 tail**, `'rce' + Date.now().toString(36).slice(-6)` — the majority shape
 *     (70 of 104 `PREFIX` declarations). `Date.now().toString(36)` of a 2026 value is
 *     `mw2abc3`-ish: a varying number of leading digits then letters. After stripping
 *     non-digits only the leading character survives, so every tag sharing one
 *     millisecond collapses to the same phone. How many digits survive is not
 *     predictable: measured uniform over milliseconds across 2026, 14.4 % of instants
 *     yield **zero** digits (every namespace in the repo, one phone), 32.3 % yield one,
 *     32.0 % two, 15.7 % three, 4.8 % four, 0.7 % five.
 *   - **Raw millisecond timestamp**, `'settle' + Date.now()` — 32 of 104. `slice(0, 6)`
 *     takes the **leading** digits (`179419`), so this one is frozen for **166.7
 *     minutes** at a stretch, not a millisecond. It is the silent half: the number is
 *     stable for hours, which looks like a working namespace right up until two runs
 *     land in the same window.
 *
 * Measured on the old expression with the repo's real tags at one instant: **63
 * namespaces, 4 distinct phone numbers** — 35 sharing `+15551794190001`, 26 sharing
 * `+155580001`. So the collision is not one unlucky millisecond, it is the standing
 * condition, and `qa-par`/`join-svc` were never a separate "second number" — they were
 * part of the same 4.
 *
 * ## Why FNV over prefix *and* sequence, and why `% 1e9`
 *
 * FNV-1a is the mechanism `fixturePublicCode` above already uses for the same class of
 * bug. Folding `phoneSeq` into the hash matters on its own: with the hash of the prefix
 * alone, two prefixes that collide collide on **every** sequence number, so a run with
 * 20 customers per file collides 20 times rather than once. Hashing `prefix#seq`
 * decorrelates them.
 *
 * The modulus decides the residual risk, and it was measured per *run* (which is what a
 * `Unique constraint failed` corresponds to), not per instant: over 5 000 simulated runs
 * of the repo's 55 real prefixes, `% 1e6` collided in **0.04 %** of runs and `% 1e7` in
 * **0** %. The width is constrained by E.164 rather than by preference — `+1555` plus a
 * 7-digit hash plus a 4-digit sequence is 15 digits after the `+`, which is the maximum
 * the standard allows and the maximum `^\+\d{8,15}$` accepts. A 9-digit hash was tried
 * first and is 17 digits, i.e. not a phone number; the arithmetic has to be checked, not
 * assumed.
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
