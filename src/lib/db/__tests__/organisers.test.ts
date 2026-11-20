import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import {
  MAX_COMMISSION_PCT,
  backfillOrganiserProfile,
  commissionRefusal,
  createOrganiser,
  listOrganisers,
  listProfilelessOrganisers,
} from '../organisers';

/**
 * FR-906 — creating an organiser creates its profile, or creates nothing.
 *
 * ## What these tests protect
 *
 *   1. **The account is not half-built.** `role: 'ORGANISER'` is what the layout gate
 *      reads, so a `User` without an `OrganiserProfile` signs in successfully and lands
 *      on a page with nothing to show them. The transaction test forces the profile
 *      insert to fail and asserts the `User` is gone — the property, not the code path.
 *   2. **The list and the gap are complements.** `listOrganisers()` returns organisers
 *      with a profile; `listProfilelessOrganisers()` returns those without. If they
 *      ever overlapped or left a hole, an operator would see a count that does not
 *      explain itself.
 *   3. **The commission default is the schema's, not a second copy in TypeScript.**
 *      `null` must produce 5.0 because that is what `Decimal @default(5.0)` says. A
 *      literal `5` in the service would drift the day the default changed.
 *   4. **Repair refuses to touch a healthy row.** A backfill that silently succeeds on
 *      an account that already has a profile hides the fact that whatever found it was
 *      wrong.
 */

const PREFIX = `org${Date.now()}`;
const userIds: string[] = [];

function uniqueEmail(tag: string): string {
  return `${PREFIX}-${tag}@example.test`;
}

async function create(args: {
  tag: string;
  displayName?: string;
  phone?: string | null;
  commissionPct?: number | null;
}) {
  const created = await createOrganiser({
    email: uniqueEmail(args.tag),
    displayName: args.displayName ?? `Name ${args.tag}`,
    phone: args.phone ?? null,
    commissionPct: args.commissionPct ?? null,
    passwordHash: 'not-a-real-hash',
  });
  userIds.push(created.userId);
  return created;
}

afterAll(async () => {
  // `OrganiserProfile` cascades from `User`, so one delete covers both.
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('createOrganiser', () => {
  it('creates the profile in the same breath as the account', async () => {
    const created = await create({ tag: 'happy', displayName: 'Alice Chen' });

    const user = await prisma.user.findUnique({
      where: { id: created.userId },
      select: { role: true, mustChangePassword: true, name: true, organiser: { select: { displayName: true, commissionPct: true } } },
    });

    expect(user?.role).toBe('ORGANISER');
    expect(user?.mustChangePassword).toBe(true);
    // The profile is the thing that was missing before this slice. Asserting the user
    // exists and stopping there is exactly the mistake the admin action made.
    expect(user?.organiser).not.toBeNull();
    expect(user?.organiser?.displayName).toBe('Alice Chen');
    // `User.name` mirrors the display name, so the two cannot diverge at creation.
    expect(user?.name).toBe('Alice Chen');
  });

  it('takes the commission default from the schema rather than restating it', async () => {
    const created = await create({ tag: 'default-commission' });

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: created.userId },
      select: { commissionPct: true },
    });

    // 5.0 is `@default(5.0)` in `schema.prisma`. This assertion fails if the schema
    // default changes without a decision, which is the point of asserting it at all.
    expect(Number(profile.commissionPct)).toBe(5);
  });

  it('records a supplied commission and phone verbatim', async () => {
    const created = await create({ tag: 'explicit', commissionPct: 7.25, phone: '+17805551234' });

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: created.userId },
      select: { commissionPct: true, phone: true },
    });

    expect(Number(profile.commissionPct)).toBe(7.25);
    expect(profile.phone).toBe('+17805551234');
  });

  it('stores zero as zero, rather than falling through to the default', async () => {
    // The trap in `...(x === null ? {} : { x })` style code: `0` is falsy, so a
    // `commissionPct || default` or an `if (commissionPct)` would silently grant 5% to
    // an organiser who was agreed at nothing. Zero is a real, deliberate value here.
    const created = await create({ tag: 'zero', commissionPct: 0 });

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: created.userId },
      select: { commissionPct: true },
    });

    expect(Number(profile.commissionPct)).toBe(0);
  });

  it('normalises the email, so the account can be found by what was typed', async () => {
    const created = await createOrganiser({
      email: `  ${PREFIX}-CASED@Example.Test `,
      displayName: 'Cased Email',
      phone: null,
      commissionPct: null,
      passwordHash: 'not-a-real-hash',
    });
    userIds.push(created.userId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: created.userId },
      select: { email: true },
    });
    expect(user.email).toBe(`${PREFIX}-cased@example.test`);
  });

  it('refuses an empty display name instead of storing an empty one', async () => {
    // `displayName` is non-null in the schema but `''` satisfies that. An organiser
    // whose name renders as nothing is the same defect as a missing profile, quieter.
    await expect(
      createOrganiser({
        email: uniqueEmail('blank'),
        displayName: '   ',
        phone: null,
        commissionPct: null,
        passwordHash: 'not-a-real-hash',
      }),
    ).rejects.toThrow(/display name/i);

    const orphans = await prisma.user.count({ where: { email: uniqueEmail('blank') } });
    expect(orphans).toBe(0);
  });

  it('leaves no User behind when the profile insert fails', async () => {
    // The transaction is the whole guarantee and it is not visible from the happy
    // path. This fails the profile insert with a *real* constraint violation rather
    // than a mock: `Decimal(5,2)` cannot hold 1234.56, so Postgres rejects the row
    // after the `User` insert has already succeeded inside the transaction. That is
    // the only sequence that can produce a half-built account, and 1234.56 also
    // documents why `commissionRefusal` exists — the form is the friendly check, not
    // the only one.
    const email = uniqueEmail('rollback');

    await expect(
      createOrganiser({
        email,
        displayName: 'Rollback Test',
        phone: null,
        commissionPct: 1234.56,
        passwordHash: 'not-a-real-hash',
      }),
    ).rejects.toThrow();

    const survivors = await prisma.user.count({ where: { email } });
    // Zero, not one: a `User` with role ORGANISER and no profile is the exact bug
    // this module was written to close, and a failed profile write is how it would
    // reappear.
    expect(survivors).toBe(0);
  });
});

describe('listOrganisers', () => {
  it('lists the profile, not just the account, with the commission as a number', async () => {
    const created = await create({ tag: 'listed', displayName: 'Zed Listed', commissionPct: 6.5 });

    const rows = await listOrganisers();
    const row = rows.find((candidate) => candidate.userId === created.userId);

    expect(row).toBeDefined();
    expect(row?.displayName).toBe('Zed Listed');
    // `Decimal` must not reach the UI as a Decimal-like object; the floor does the
    // same conversion in `MerchantRepo.toPct`.
    expect(row?.commissionPct).toBe(6.5);
    expect(typeof row?.commissionPct).toBe('number');
    expect(row?.email).toBe(uniqueEmail('listed'));
  });

  it('counts share links per organiser, because zero is the current honest answer', async () => {
    const created = await create({ tag: 'no-links' });
    const rows = await listOrganisers();
    const row = rows.find((candidate) => candidate.userId === created.userId);

    // Nothing in V1 creates a `ShareLink` yet, so this is 0 for everyone. The count is
    // here because the day it is not 0 is the day an operator needs it.
    expect(row?.shareLinkCount).toBe(0);
  });

  it('never lists an account that has no profile, because that is the other query', async () => {
    const broken = await prisma.user.create({
      data: {
        email: uniqueEmail('broken'),
        role: 'ORGANISER',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });
    userIds.push(broken.id);

    const rows = await listOrganisers();
    expect(rows.map((row) => row.userId)).not.toContain(broken.id);
  });
});

describe('listProfilelessOrganisers', () => {
  /*
   * Every assertion here is scoped with `q` to the email this file created.
   *
   * That is not tidiness. The query is now capped and sorted oldest-first, so an
   * unscoped list is the *oldest* ten rows in the table, and a fixture created a
   * millisecond ago is never among them. "The returned rows contain my fixture" would
   * then fail for a reason that has nothing to do with the code under test. Worse is the
   * other direction: `not.toContain(myFixture)` passed *vacuously*, because the fixture
   * was absent from a truncated list whether the predicate worked or not.
   *
   * Searching for the fixture's own address makes both directions mean something. One
   * address narrows the result set to one row, so `total` is 1 when the account is
   * broken and 0 when it is healthy — a count, not a position.
   *
   * This reasoning used to be justified by a different fact: that the dev database held
   * ~99 profile-less organisers predating the suite, so global ordering was someone
   * else's to decide. That number came from accumulated residue and is gone. The scoping
   * rule survives because of what it makes `total` *mean* — matches, not position — which
   * holds on an empty database as much as a populated one. The one test that needs a real
   * population creates one (`'caps the rows but not the total'`), rather than reading one.
   */

  it('finds exactly the organisers the other list cannot show', async () => {
    const broken = await prisma.user.create({
      data: {
        email: uniqueEmail('gap'),
        role: 'ORGANISER',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });
    userIds.push(broken.id);

    const healthy = await create({ tag: 'healthy' });

    const missing = await listProfilelessOrganisers({ q: uniqueEmail('gap') });
    const ids = missing.rows.map((row) => row.userId);

    expect(ids).toContain(broken.id);
    expect(ids).not.toContain(healthy.userId);
    // The search narrowed to exactly one row, which is what makes the `not.toContain`
    // above an assertion about the `role`/`organiser: { is: null }` predicate rather than
    // about where the fixture happened to sort.
    expect(missing.total).toBe(1);

    // And every one of them names the account, so the operator can act on it.
    const row = missing.rows.find((candidate) => candidate.userId === broken.id);
    expect(row?.email).toBe(uniqueEmail('gap'));
  });

  it('does not confuse a MERCHANT account with a broken organiser', async () => {
    // The `role` filter is load-bearing: a `where: { organiser: { is: null } }` alone
    // matches every merchant, admin and diner in the database.
    const merchant = await prisma.user.create({
      data: {
        email: uniqueEmail('merchant'),
        role: 'MERCHANT',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });
    userIds.push(merchant.id);

    // Scoped to the merchant's own address. `total === 0` says the predicate excluded it;
    // "not in the first ten rows" would have said nothing at all.
    const missing = await listProfilelessOrganisers({ q: uniqueEmail('merchant') });
    expect(missing.total).toBe(0);
    expect(missing.rows).toHaveLength(0);
  });

  it('caps the rows but not the total, so the page can admit what it is not showing', async () => {
    // The two facts the page needs are separable, and the cap is what separates them.
    //
    // This test used to assert them against *whatever the database happened to hold*:
    // `rows.length <= limit` and `total > 2`, on the strength of a comment saying this
    // database had held dozens of profile-less organisers since before the suite existed.
    // That was residue standing in for a fixture. On a clean database the surplus is zero,
    // `total` is 0, and the assertion fails — which is the correct outcome for a test whose
    // precondition was never something it created.
    //
    // So it creates twelve. Twelve rather than three because the claim needs a population
    // strictly larger than both caps under test (2 and the default 10); with twelve, each
    // cap has something real to truncate and `total` has a number that no cap can produce.
    const capIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const row = await prisma.user.create({
        data: {
          email: uniqueEmail(`cap-${index}`),
          role: 'ORGANISER',
          passwordHash: 'not-a-real-hash',
        },
        select: { id: true },
      });
      capIds.push(row.id);
      userIds.push(row.id);
    }

    // Scoped by the shared prefix, not a full address: the fixtures are `…-cap-0@…`,
    // `…-cap-1@…`, so `uniqueEmail('cap-')` would render `…-cap-@…` and match nothing.
    // That exact mistake was made and caught in the tiebreak test below.
    const search = `${PREFIX}-cap-`;

    const capped = await listProfilelessOrganisers({ limit: 2, q: search });
    expect(capped.rows).toHaveLength(2);
    expect(capped.limit).toBe(2);
    // Exactly twelve, not "at least a few". `total` is a count of matches, so a cap that
    // leaked into it would show 2 here and this line is what notices.
    expect(capped.total).toBe(12);

    const unbounded = await listProfilelessOrganisers({ q: search });
    expect(unbounded.limit).toBe(10);
    // The default cap actually bites. Asserting `limit === 10` alone would pass against a
    // query that returned all twelve and merely *reported* a limit of 10.
    expect(unbounded.rows).toHaveLength(10);
    // While `total` still reports the whole population, which is what lets the page write
    // "showing the 10 oldest of 12" and mean it.
    expect(unbounded.total).toBe(12);

    // And the two rows the tight cap returned are real members of the population, not
    // padding. Without this, `toHaveLength(2)` would pass on any two rows at all.
    const ids = new Set(capIds);
    expect(capped.rows.every((row) => ids.has(row.userId))).toBe(true);
  });

  it('breaks ties on createdAt, so a collision cannot reshuffle the cap', async () => {
    // Probe P9 deleted the `{ id: 'asc' }` tiebreak and **every test in the file stayed
    // green**, because the real fixtures are created milliseconds apart and their
    // timestamps differ. So the tiebreak was untested, not unnecessary.
    //
    // It is necessary: `createdAt` is a database default, and two accounts created in the
    // same round — a seed, an import, two form submissions in one second — can share a
    // timestamp exactly. Then "oldest first" is whatever order Postgres happens to return,
    // and a *capped* list that reshuffles between reloads is one the operator cannot work
    // through: repair a row, reload, and the next ten are different.
    //
    // The fixtures below all share one timestamp, which is the only way to make the
    // ordering observable. Asserted against the sorted ids rather than against a second
    // call, because "same answer twice" can pass on a stable-but-wrong order — Postgres
    // is usually stable, and the defect is that it is not *obliged* to be.
    const shared = new Date('2020-01-01T00:00:00.000Z');
    const collidedIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const row = await prisma.user.create({
        data: {
          email: uniqueEmail(`tie-${index}`),
          role: 'ORGANISER',
          passwordHash: 'not-a-real-hash',
          createdAt: shared,
        },
        select: { id: true },
      });
      collidedIds.push(row.id);
      userIds.push(row.id);
    }

    // Searched by the shared prefix, not by a full address: the fixtures are
    // `…-tie-0@…`, `…-tie-1@…`, so `uniqueEmail('tie-')` would render `…-tie-@…` and match
    // nothing — the first version of this test asserted an empty array equals four ids.
    const listed = await listProfilelessOrganisers({ q: `${PREFIX}-tie-` });
    expect(listed.rows.map((row) => row.userId)).toEqual([...collidedIds].sort());
  });
});

describe('backfillOrganiserProfile', () => {
  it('repairs a profile-less organiser and returns the new profile', async () => {
    const broken = await prisma.user.create({
      data: {
        email: uniqueEmail('repair'),
        role: 'ORGANISER',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });
    userIds.push(broken.id);

    const repaired = await backfillOrganiserProfile({
      userId: broken.id,
      displayName: 'Repaired Name',
      phone: '+17805550000',
      commissionPct: 4,
    });

    expect(repaired).not.toBeNull();

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: broken.id },
      select: { displayName: true, phone: true, commissionPct: true },
    });
    expect(profile.displayName).toBe('Repaired Name');
    expect(profile.phone).toBe('+17805550000');
    expect(Number(profile.commissionPct)).toBe(4);

    // And it is no longer in the broken list, which is the point of repairing it.
    //
    // Scoped to the fixture's own address, because the list is capped: "not in the first
    // ten of a truncated list" is true for a repaired account and for an untouched one, so
    // the unscoped form of this assertion would have passed against a
    // `backfillOrganiserProfile` that did nothing. `total === 0` under the search is the
    // claim that actually fails.
    const stillMissing = await listProfilelessOrganisers({ q: uniqueEmail('repair') });
    expect(stillMissing.total).toBe(0);
    // Now it appears where it should.
    expect((await listOrganisers()).map((row) => row.userId)).toContain(broken.id);
  });

  it('refuses an account that already has a profile', async () => {
    const healthy = await create({ tag: 'already-fine', displayName: 'Already Fine' });

    const result = await backfillOrganiserProfile({
      userId: healthy.userId,
      displayName: 'Second Name',
    });

    // `null`, not a silent no-op: a "repair" that reports success on a healthy row
    // means whatever found the row was wrong, and that needs to surface.
    expect(result).toBeNull();

    const profile = await prisma.organiserProfile.findUniqueOrThrow({
      where: { userId: healthy.userId },
      select: { displayName: true },
    });
    expect(profile.displayName).toBe('Already Fine');
  });

  it('refuses a non-organiser, because two role systems would disagree', async () => {
    const merchant = await prisma.user.create({
      data: {
        email: uniqueEmail('not-an-organiser'),
        role: 'MERCHANT',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });
    userIds.push(merchant.id);

    const result = await backfillOrganiserProfile({
      userId: merchant.id,
      displayName: 'Should Not Exist',
    });

    expect(result).toBeNull();
    expect(await prisma.organiserProfile.count({ where: { userId: merchant.id } })).toBe(0);
  });

  it('refuses an id that is not a user at all', async () => {
    expect(
      await backfillOrganiserProfile({
        userId: '00000000-0000-0000-0000-000000000000',
        displayName: 'Nobody',
      }),
    ).toBeNull();
  });
});

describe('commissionRefusal', () => {
  it('treats blank as "use the default", so an account can be created before the rate is agreed', () => {
    expect(commissionRefusal('')).toBeNull();
    expect(commissionRefusal('   ')).toBeNull();
  });

  it('accepts zero, which is a real agreed value', () => {
    expect(commissionRefusal('0')).toBeNull();
  });

  it('accepts a rate at the ceiling and rejects one past it', () => {
    expect(commissionRefusal(String(MAX_COMMISSION_PCT))).toBeNull();
    expect(commissionRefusal(String(MAX_COMMISSION_PCT + 1))).toMatch(/at most/i);
  });

  it('rejects a negative rate', () => {
    expect(commissionRefusal('-1')).toMatch(/negative/i);
  });

  it('rejects text and gets the decimal places right', () => {
    expect(commissionRefusal('five percent')).toMatch(/number/i);
    expect(commissionRefusal('5.25')).toBeNull();
    // Two places is the limit: `Decimal(5,2)` would store this as 5.13 and quietly
    // change an agreed term.
    expect(commissionRefusal('5.125')).toMatch(/decimal places/i);
  });
});
