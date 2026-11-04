import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';

import {
  ADMIN_USER_ROLES,
  listUsers,
  parseAdminUserRole,
  type AdminUserRole,
} from '../users';

/**
 * D2 — the `/admin/users` list was unbounded, and is now bounded.
 *
 * ## The defect, in one measurement
 *
 * `listUsers()` was `findMany` with no `take`. On the dev database at 1,040 users the page it
 * fed measured **6,289,778 bytes / 12,518 nodes** — and re-measured on a **production build**,
 * **1,856,483 bytes / 11,205 nodes**. The dev figure was 3.4x the real one because dev-mode
 * flight data is inflated; the defect was real either way, and with the cap the page is
 * **400,428 bytes / 2,294 nodes**.
 *
 * ## What this suite protects, and why it is not the page's suite
 *
 * `admin/users/__tests__/page.test.ts` renders the page and is the right place to assert
 * what an operator reads. It is the *wrong* place to assert this module's contract,
 * because a render can only see the default unfiltered call — the `limit`, the `total`
 * and the `q` predicate are all invisible behind it. In particular the page's suite
 * cannot distinguish "the cap is 100" from "the cap is 10,000 and this table is small".
 *
 * So the assertions here are about the three facts the page depends on and cannot verify:
 *
 *   1. `rows` is capped and `total` is not, and they are computed from the **same**
 *      `where`. A header that says "100 of 1,040" is only honest if both numbers answer
 *      the same question.
 *   2. Every filter narrows `total` as well as `rows`. A `total` computed without the
 *      filter would print "3" rows under "1,040" and look like a rendering bug.
 *   3. The ordering is a **total** order on the column it claims. `email` is `@unique`,
 *      so this is true by construction — asserted anyway, because the ordering decides
 *      *which* rows are visible once a cap exists, and an `orderBy` that is not total
 *      would make the cap return a different page on each reload.
 *
 * ## Fixtures are unique per run and deleted in teardown
 *
 * This is the shared dev database: 1,500+ users that other suites also write to. Every
 * assertion is scoped to an email this file created, and never to a total count of the
 * table.
 */

const PREFIX = `usr${Date.now().toString(36)}`;
const createdUserIds: string[] = [];

function uniqueEmail(tag: string): string {
  return `${PREFIX}-${tag}@example.test`;
}

async function makeUser(args: {
  tag: string;
  role: AdminUserRole;
}): Promise<{ id: string; email: string }> {
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail(args.tag),
      role: args.role,
      passwordHash: 'not-a-real-hash',
    },
    select: { id: true, email: true },
  });
  createdUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('parseAdminUserRole', () => {
  it('accepts every role the enum declares, in any case', () => {
    // Read from `ADMIN_USER_ROLES` rather than retyped, so adding a role to the schema
    // without teaching the parser fails here. The page's role chips are driven by the
    // same constant, which is what keeps a chip from linking to a filter that does not
    // parse — a chip that 404s into "no accounts match" is worse than no chip.
    for (const role of ADMIN_USER_ROLES) {
      expect(parseAdminUserRole(role)).toBe(role);
      expect(parseAdminUserRole(role.toLowerCase())).toBe(role);
      expect(parseAdminUserRole(`  ${role.toLowerCase()}  `)).toBe(role);
    }
  });

  it('treats anything unrecognised as "no filter", not as an empty result', async () => {
    // `null` means "show everything". The alternative — returning a sentinel that matches
    // no rows — would render an empty table under a mistyped `?role=admn`, which on this
    // screen is indistinguishable from "the database has no admins". The operator is
    // usually on the phone with somebody who believes there is one, so the page can say
    // what happened; the parser's job is only to make "nothing valid was asked for"
    // visible rather than silently authoritative.
    expect(parseAdminUserRole('admn')).toBeNull();
    expect(parseAdminUserRole('')).toBeNull();
    expect(parseAdminUserRole(null)).toBeNull();
    expect(parseAdminUserRole(undefined)).toBeNull();
    expect(parseAdminUserRole('   ')).toBeNull();

    // And the page distinguishes the two cases by keeping the raw value, which is why
    // this function returns `null` rather than a default role: `?role=` absent and
    // `?role=garbage` both produce `null`, and only the caller knows the difference.
  });
});

describe('listUsers — the cap', () => {
  it('never returns more rows than the limit, and defaults to a hundred', async () => {
    const defaulted = await listUsers();
    // `/admin/drops` caps at 100 and `/admin/ai-drafts` at 50; the PRD gives no number
    // for this screen, so the repo's own precedent decides it. Asserted so that a future
    // change to the default is a deliberate edit here rather than a silent drift.
    expect(defaulted.limit).toBe(100);
    expect(defaulted.rows.length).toBeLessThanOrEqual(100);

    const capped = await listUsers({ limit: 3 });
    expect(capped.limit).toBe(3);
    expect(capped.rows.length).toBeLessThanOrEqual(3);
  });

  it('counts the whole match, not the cap, and the two come from one filter', async () => {
    // Three accounts in one role, uniquely searchable by this run's prefix.
    await makeUser({ tag: 'cap-a', role: 'ORGANISER' });
    await makeUser({ tag: 'cap-b', role: 'ORGANISER' });
    await makeUser({ tag: 'cap-c', role: 'ORGANISER' });

    const capped = await listUsers({ q: PREFIX, limit: 2 });
    expect(capped.rows).toHaveLength(2);
    // The number the header prints. It is what makes "2 of 3" possible; without it the
    // page could only print the cap and call it the truth.
    expect(capped.total).toBeGreaterThanOrEqual(3);

    // Raising the limit must raise `rows` without changing `total` — the strongest
    // available statement that the cap and the count are independent, which is the
    // property a single `findMany` cannot provide.
    const uncapped = await listUsers({ q: PREFIX, limit: 100 });
    expect(uncapped.total).toBe(capped.total);
    expect(uncapped.rows.length).toBeGreaterThan(capped.rows.length);
  });

  it('orders by email, so the cap returns a stable, browsable page', async () => {
    await makeUser({ tag: 'order-a', role: 'MERCHANT' });
    await makeUser({ tag: 'order-b', role: 'MERCHANT' });

    const first = await listUsers({ q: PREFIX, limit: 50 });
    const emails = first.rows.map((row) => row.email);

    // A total order on a `@unique` column: sorted ascending, and no duplicates.
    expect([...emails].sort()).toEqual(emails);
    expect(new Set(emails).size).toBe(emails.length);

    // Same query twice, same page. With a cap in place, an unstable `orderBy` means the
    // operator's next reload shows a different set of rows and any row they were about to
    // act on moves.
    const second = await listUsers({ q: PREFIX, limit: 50 });
    expect(second.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  });

  it('orders by email rather than by role, because role-first shows only admins', async () => {
    // The regression this replaced. `[{ role: 'asc' }, { email: 'asc' }]` was harmless
    // while the read was unbounded — ordering only grouped rows on a page showing all of
    // them. With a cap it decides what is *visible*: the dev database holds ~760 ADMINs,
    // so `role` ascending puts a hundred admins on the default screen and no merchant or
    // organiser at all.
    //
    // Asserted as a property of the returned page rather than by reading the source: the
    // unfiltered default page must contain more than one distinct role once the table is
    // large enough to fill the cap. If it is capped and monotonic in role, this fails.
    const defaulted = await listUsers();
    if (defaulted.total > defaulted.rows.length) {
      const roles = new Set(defaulted.rows.map((row) => row.role));
      expect(roles.size).toBeGreaterThan(1);
    }
    // Otherwise the table is small enough that the cap is not exercised and the assertion
    // would be vacuous — named rather than left to look like it ran.
  });
});

describe('listUsers — the filters the cap requires', () => {
  it('narrows by role and counts only that role', async () => {
    await makeUser({ tag: 'role-org', role: 'ORGANISER' });
    await makeUser({ tag: 'role-mer', role: 'MERCHANT' });

    const organisers = await listUsers({ role: 'ORGANISER', q: PREFIX });
    expect(organisers.total).toBeGreaterThanOrEqual(1);
    // Every returned row is the requested role. `total` is scoped by the same `where`,
    // which is the assertion that stops "3 of 1,040" from appearing on the page.
    expect(organisers.rows.every((row) => row.role === 'ORGANISER')).toBe(true);

    const merchants = await listUsers({ role: 'MERCHANT', q: PREFIX });
    expect(merchants.rows.every((row) => row.role === 'MERCHANT')).toBe(true);

    // The two filters are disjoint, so the counts cannot both include the same fixture.
    expect(organisers.total + merchants.total).toBeGreaterThanOrEqual(2);
  });

  it('searches email case-insensitively, because a human types the address', async () => {
    const created = await makeUser({ tag: 'Find-Me', role: 'MERCHANT' });

    // `normalizeEmail` lowercases on the way in, so the stored value is lowercase while
    // the operator may type the capitalisation they were given. `mode: 'insensitive'` is
    // what makes that work, and it is invisible to a test that searches in lowercase.
    const upper = await listUsers({ q: created.email.toUpperCase() });
    expect(upper.rows.map((row) => row.id)).toContain(created.id);

    const mixed = await listUsers({ q: `${PREFIX}-find-me` });
    expect(mixed.rows.map((row) => row.id)).toContain(created.id);
  });

  it('trims the search, and treats blank as no search at all', async () => {
    const created = await makeUser({ tag: 'trim', role: 'ORGANISER' });

    // A padded address pasted from an email thread is the common case.
    const padded = await listUsers({ q: `  ${created.email}  ` });
    expect(padded.rows.map((row) => row.id)).toContain(created.id);

    // Blank must be indistinguishable from absent. A `contains: ''` narrows to nothing in
    // some databases and to everything in others; either way a page whose search box was
    // submitted empty would change behaviour, which the operator would read as a bug.
    const blank = await listUsers({ q: '   ' });
    const absent = await listUsers();
    expect(blank.total).toBe(absent.total);
  });

  it('returns nothing, and says so, when no account matches', async () => {
    const none = await listUsers({ q: `${PREFIX}-no-such-account` });
    expect(none.rows).toHaveLength(0);
    // Zero, not `undefined`: the page interpolates this into "No account matches “…”",
    // and `undefined` would render the word.
    expect(none.total).toBe(0);
  });
});
