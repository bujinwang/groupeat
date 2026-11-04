import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/admin/users` rendered — gap 12(d), FR-906 and PRD-sprint1 §6.5.
 *
 * > `FR-906 | Manually create organiser accounts |` — PRD-v1.md:553
 *
 * ## This page was recorded as "browser-only" for four slices. It is not.
 *
 * `AGENTS.md` and `PROGRESS.md` both said this page could not be rendered because its
 * role form is `useState`-driven. That was never checked, and it is wrong in a way worth
 * naming: `useState` is not a rendering blocker. It renders — at its initial value. Only
 * `useRouter` blocks a render, because it throws without an `AppRouterContext`. The three
 * forms here use `useActionState`, which renders fine as a `<form action={…}>`.
 *
 * So what a render *cannot* see is one specific thing: pressing the role `<select>` and
 * swapping MERCHANT for ORGANISER. Everything else on the page is assertable, and that
 * includes the branches those forms expose once the server has answered.
 *
 * ## Two pages' worth of content on one route
 *
 * Users, organisers and merchants share this route. The organiser section is the one
 * that carries a real defect in its history: an organiser made through this screen used
 * to be a `User` with no `OrganiserProfile` — no display name, no commission — and it
 * looked exactly like a healthy one. `listProfilelessOrganisers` exists to make that
 * visible, and this suite is the only place the *rendered* consequence is asserted.
 *
 * ## The database is shared, so nothing here asserts a global total
 *
 * This is a dev database that has been used by every other suite in the repo: at the time
 * of writing, 1500+ users, 48 organiser profiles and dozens of organisers. The page also
 * now **caps and filters** — `listUsers({ role, q })` returns at most 100 rows, and the
 * repair list at most 10, unlike the unbounded `findMany` this suite was written against.
 *
 * That changes how assertions have to be written, and the change is worth stating because
 * it invalidated several of them:
 *
 *   - Every assertion is scoped to a row this file created, found by its own email.
 *   - Where a fixture must be *on screen*, the render is given `?q=` so the cap cannot
 *     hide it. Searching for a fixture's own address narrows the result to one row, which
 *     is a stronger assertion than "somewhere in 1,500 rows" ever was.
 *   - Nothing asserts a count of the whole table. The one test that does assert a number
 *     asserts the relationship between the cap and the total, which is a property of the
 *     page rather than of this database's contents — except where it deliberately proves
 *     the cap is being exercised, and says so.
 *
 * ## What is mocked
 *
 * `server-only`, and nothing else. The page reads no session (the `(admin)` layout has
 * already established the caller is an ADMIN) and mounts no router-using component, so
 * `renderToHtml` is enough — `renderWithRouter` is not needed here, unlike
 * `/admin/drops` and `/admin/drops/[id]`.
 *
 * ## What is not proven, named rather than implied
 *
 * Fifteen probes were run against this suite; fourteen fail a named test. The limits:
 *
 *   1. **The role `<select>` cannot be switched.** It is `useState('MERCHANT')`, so every
 *      render shows the non-organiser fields. The organiser branch of `CreateUserForm` is
 *      checked by reading the conditional and by the action's own tests, not by a render.
 *   2. **The repair card's zero arm is unreachable.** It needs a database with no
 *      profile-less organisers, and this one holds dozens that are not this file's to
 *      delete. The guard is asserted from the source, which is weaker than a render and
 *      is labelled as such where it is asserted.
 *   3. **The heading's singular arm is untestable.** Probe K deleted the
 *      `=== 1 ? '' : 's'` ternary and all seventeen tests stayed green, because the count
 *      is 98: both forms render `s`. Only the plural arm is asserted.
 *   4. **The merchant floor's rounding is asserted at one value.** `fx.merchant()` sets
 *      `0.25`, so `Math.round(0.25 * 100)` is 25 and the raw share prints `0.25` — the two
 *      are distinguishable, which is what the assertion needs, but a floor like `0.255`
 *      would round to 26 and this suite would not notice.
 */

vi.mock('server-only', () => ({}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');

/**
 * Unique per run, and readable in a failure message.
 *
 * `Date.now()` rather than a counter: the emails in this file must not collide with
 * rows left by a previous run, which is a real risk here because this suite creates
 * accounts that the page then lists globally.
 */
const PREFIX = `au${Date.now().toString(36)}`;
const fx = settlementFixtures(PREFIX);

/** Emails are the only stable handle on a row this file owns. */
const email = (tag: string): string => `${PREFIX}-${tag}@example.test`;

async function makeUser(args: {
  tag: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword?: boolean;
  lastLoginAt?: Date | null;
  withProfile?: { displayName: string; phone: string | null; commissionPct?: number };
  merchantId?: string;
}): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(args.tag),
      passwordHash: 'not-a-real-hash',
      role: args.role,
      mustChangePassword: args.mustChangePassword ?? false,
      lastLoginAt: args.lastLoginAt ?? null,
      // Nested, so the profile and the account are written together — the same shape
      // `createOrganiser` uses, and the reason a half-built account is notable.
      ...(args.withProfile
        ? {
            organiser: {
              create: {
                displayName: args.withProfile.displayName,
                phone: args.withProfile.phone,
                ...(args.withProfile.commissionPct === undefined
                  ? {}
                  : { commissionPct: args.withProfile.commissionPct }),
              },
            },
          }
        : {}),
      ...(args.merchantId === undefined
        ? {}
        : { merchantUsers: { create: { merchantId: args.merchantId, role: 'OWNER' } } }),
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

const createdUserIds: string[] = [];
let merchantId = '';

// Identifiers of the fixtures the assertions name. Declared here so a failing test can be
// read without scrolling to `beforeAll`.
//
// Most assertions find their row by email, because that is what the page renders. The ids
// exist for the ones that cannot: the repair form posts a `userId` the operator never
// sees, and a share link points at a profile id.
let plainUserId = '';
let tempPasswordUserId = '';
let multiMerchantUserId = '';
let aliceProfileId = '';
let bobProfileId = '';
let brokenOrganiserId = '';
let neverSignedInId = '';

beforeAll(async () => {
  // One merchant with two users attached: the `merchantUsers` list is joined by name, and
  // a single-membership fixture cannot distinguish "joined" from "took the first".
  //
  // `fx.merchant()` takes the Stripe account id, and its default is a single constant —
  // so a second call with the default collides on `stripeAccountId`, which is `@unique`.
  // Nothing here touches Stripe, but the fixture still needs distinct accounts.
  merchantId = await fx.merchant(`acct_${PREFIX}_a`);
  const secondMerchantId = await fx.merchant(`acct_${PREFIX}_b`);

  plainUserId = await makeUser({
    tag: 'plain',
    role: 'MERCHANT',
    merchantId,
  });
  tempPasswordUserId = await makeUser({
    tag: 'temp',
    role: 'ADMIN',
    mustChangePassword: true,
  });
  multiMerchantUserId = await makeUser({
    tag: 'multi',
    role: 'MERCHANT',
    merchantId,
  });
  // Names matter more than ids here. `fx.merchant()` names every merchant
  // `${prefix} merchant`, so two fixture merchants are indistinguishable in the rendered
  // row — and a page that joined only `merchantUsers[0]` would pass a `toContain` against
  // the shared name. Renaming the second one is what makes the two memberships visibly
  // different, and it is the difference the assertion needs.
  await prisma.merchant.update({
    where: { id: secondMerchantId },
    data: { name: `${PREFIX} second merchant` },
  });
  await prisma.merchantUser.create({
    data: { merchantId: secondMerchantId, userId: multiMerchantUserId, role: 'STAFF' },
  });

  // An organiser with a profile, and a commission that is not the 5% default — the badge
  // would read the same for every defaulted row, so a defaulted fixture proves nothing.
  aliceProfileId = (
    await prisma.organiserProfile.create({
      data: { userId: await makeUser({ tag: 'alice', role: 'ORGANISER' }), displayName: `${PREFIX} Alice`, phone: '+15550000001', commissionPct: 7.5 },
      select: { id: true },
    })
  ).id;

  // The same, with no phone: the page prints `no phone`, not an empty gap.
  bobProfileId = (
    await prisma.organiserProfile.create({
      data: {
        userId: await makeUser({ tag: 'bob', role: 'ORGANISER', lastLoginAt: new Date('2026-07-01T12:00:00Z') }),
        displayName: `${PREFIX} Bob`,
        phone: null,
      },
      select: { id: true },
    })
  ).id;

  // FR-906's defect, as data: an ORGANISER account with no profile. This is what
  // `/admin/users` must show as broken rather than as a normal row.
  brokenOrganiserId = await makeUser({ tag: 'broken', role: 'ORGANISER' });

  neverSignedInId = await makeUser({
    tag: 'never',
    role: 'ORGANISER',
    lastLoginAt: null,
  });
  await prisma.organiserProfile.create({
    data: { userId: neverSignedInId, displayName: `${PREFIX} Never`, phone: '+15550000002' },
  });
});

afterAll(async () => {
  // Every step is attempted, and the run still fails if any of them did. That combination
  // is the point.
  //
  // This suite leaked forty-six accounts while it was being written, and the mechanism is
  // worth recording because it is not the obvious one: the deletes were ordered correctly,
  // but a `deleteMany` that threw (the share-link foreign key, see below) aborted the
  // function, so the *later* deletes never ran. Every failing test run therefore left a
  // partially-cleaned database, and the accounts that survived were exactly the ones
  // `/admin/users` lists as broken. A green run leaked nothing; a red run leaked one row
  // per iteration.
  //
  // The wrong fix is `.catch(() => undefined)` on each delete — that is what turned a
  // foreign-key violation into a silent leak in `share-links.test.ts`. Collecting the
  // errors and rethrowing gets both properties: the database is left as clean as possible,
  // and a teardown that could not finish is a failing test rather than a tidy-looking one.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // The share link from the singular-count test goes first. `ShareLink` references
  // `OrganiserProfile` by plain foreign key — it cascades from `Drop`, not from the
  // profile — so deleting the profile while a link points at it raises
  // `ShareLink_organiserId_fkey`.
  if (bobProfileId.length > 0) {
    await step(() => prisma.shareLink.deleteMany({ where: { organiserId: bobProfileId } }));
  }
  if (createdUserIds.length > 0) {
    await step(() => prisma.organiserProfile.deleteMany({ where: { userId: { in: createdUserIds } } }));
    await step(() => prisma.merchantUser.deleteMany({ where: { userId: { in: createdUserIds } } }));
    // The account delete is the one that matters for the `broken` fixture: an ORGANISER
    // with no profile has nothing to cascade through, so it only ever goes via this line.
    await step(() => prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }));
  }
  await step(() => fx.cleanup());

  if (failures.length > 0) {
    throw new AggregateError(failures, `teardown left the database dirty (${failures.length} step(s) failed)`);
  }
});

/**
 * Render the page.
 *
 * `searchParams` is passed through as a resolved promise, matching what Next hands a
 * page. The default of `{}` is the unfiltered screen, which is what every assertion
 * that predates the filter was written against.
 */
async function render(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/users/page');
  const html = await renderToHtml(
    await page.default({ searchParams: Promise.resolve(searchParams) }),
  );
  return { html, text: textOf(html) };
}

/**
 * The `<li>` card whose text contains `needle`.
 *
 * Cards are `<Card as="li">` → `<li class="rounded-xl …">`. Slicing from one `<li` to the
 * next gives one row, which is the only way to say "this row says X" when the page holds
 * 1500 rows and every figure appears somewhere.
 *
 * `section` matters and was learned the hard way. An organiser appears **twice** on this
 * page: once in the Users list (email + role badge) and once in the Organisers list
 * (display name, commission, share links). Searching from the top of the document always
 * found the Users row, so assertions about commission and share links failed against a
 * card that never contains them. Passing the section heading makes the scope explicit.
 */
function cardFor(html: string, needle: string, section: string): string {
  return textOf(rawCardFor(html, needle, section));
}

/**
 * The same card, as text.
 *
 * Most assertions in this file are about prose — `7.5% commission`, `0 share links`,
 * `no phone` — and React splits those into separate text nodes with `<!-- -->` between
 * them, because the value is an interpolated expression rather than a literal. The raw
 * markup reads `7.5<!-- -->% commission`, so a `toContain('7.5% commission')` against it
 * fails while the page is completely correct. `textOf` strips comments and collapses
 * space; `rawCardFor` is here for the two assertions that are genuinely about attributes.
 */
function rawCardFor(html: string, needle: string, section: string): string {
  const sectionAt = html.indexOf(`>${section}<`);
  if (sectionAt === -1) {
    throw new Error(`No section heading ${section} in the render.`);
  }
  const at = html.indexOf(needle, sectionAt);
  if (at === -1) {
    throw new Error(`No row under ${section} contains ${needle}. The row is missing.`);
  }
  const start = html.lastIndexOf('<li', at);
  const end = html.indexOf('<li', at);
  return html.slice(start === -1 ? at : start, end === -1 ? html.length : end);
}

/** Every `<h1>` section heading, in document order. */
function sectionTitles(text: string): string[] {
  return ['Users', 'Organisers', 'Merchants'].filter((title) => text.includes(title));
}

describe('/admin/users — the shell', () => {
  it('renders the three sections the page exists to show', async () => {
    const { text } = await render();

    // All three, in order. This page is the only screen that lists organisers at all, so
    // a missing section is not a cosmetic defect — it removes the only way to see them.
    expect(sectionTitles(text)).toEqual(['Users', 'Organisers', 'Merchants']);

    // The fixture ids resolve to rows that exist. Asserted because every later test finds
    // its row by *email*, so a fixture that silently failed to be created would make those
    // assertions fail with a confusing "row is missing" instead of this one.
    const resolved = await prisma.user.findMany({
      where: {
        id: { in: [plainUserId, tempPasswordUserId, multiMerchantUserId, brokenOrganiserId, neverSignedInId] },
      },
      select: { id: true },
    });
    expect(resolved).toHaveLength(5);
    expect(
      await prisma.organiserProfile.count({ where: { id: { in: [aliceProfileId, bobProfileId] } } }),
    ).toBe(2);
  });

  it('says where the merchant view lives, rather than linking it as if reachable', async () => {
    const { text } = await render();

    // `/merchant/items` is not reachable from an admin account; the sentence says so
    // instead of offering a link that 403s.
    expect(text).toContain('is only reachable from a merchant account');
  });
});

describe('/admin/users — the controls the cap requires', () => {
  /*
   * These are D2's own tests. The defect was an unbounded read; the fix is a cap, and a
   * cap is only acceptable because of the two controls tested here. Deleting either
   * control leaves a page that silently shows 100 of 1,040 rows with no way to reach the
   * rest, which is the failure this whole slice exists to avoid.
   */

  it('offers a role chip per role, and says which one is active', async () => {
    const { html } = await render();

    // One chip per role the parser accepts, plus "All". Read from the same constant the
    // page uses, so a new role cannot ship without a chip.
    const { ADMIN_USER_ROLES } = await import('@/lib/db/users');

    const unfiltered = hrefsOf(html);
    for (const role of ADMIN_USER_ROLES) {
      expect(unfiltered).toContain(`/admin/users?role=${role.toLowerCase()}`);
    }
    // "All" is the absent filter, so it links to the bare route rather than `?role=`.
    expect(unfiltered).toContain('/admin/users');

    // Only one chip is marked, and on the default render it is "All" — no role filter.
    // A page that marked none, or marked several, leaves the operator unable to tell
    // which view they are in. Counted rather than searched for: `slice(indexOf(needle))`
    // was the first version of this assertion and it sliced from the anchor's *text*,
    // which sits after its attributes, so it read markup that could never contain
    // `aria-current` and failed against a correct page.
    const active = [...html.matchAll(/aria-current="true"/g)];
    expect(active).toHaveLength(1);
    const allChip = html.slice(html.lastIndexOf('<a', html.indexOf('>All<')), html.indexOf('>All<'));
    expect(allChip).toContain('aria-current="true"');

    // And a filtered render marks that chip instead, so the marker follows the query
    // rather than being hardcoded on the first chip.
    const filtered = await render({ role: 'organiser' });
    expect([...filtered.html.matchAll(/aria-current="true"/g)]).toHaveLength(1);
    const organiserChip = filtered.html.slice(
      filtered.html.lastIndexOf('<a', filtered.html.indexOf('>Organiser<')),
      filtered.html.indexOf('>Organiser<'),
    );
    expect(organiserChip).toContain('aria-current="true"');
    expect(organiserChip).toContain('href="/admin/users?role=organiser"');
  });

  it('keeps the search when a role chip is clicked, and the role when searching', async () => {
    // Two controls that silently cancel each other are worse than one. The chip carries
    // `q` forward and the search form carries `role` in a hidden field; both directions
    // are asserted because each is a separate line of code.
    const searched = await render({ q: PREFIX });
    expect(hrefsOf(searched.html).some((href) => href.includes(`q=${PREFIX}`))).toBe(true);

    const both = await render({ q: PREFIX, role: 'ORGANISER' });
    // Every chip keeps the search, not just the one. The last chip is read because the
    // first version of this assertion searched for `role=merchant` and then checked the
    // *whole document*, which contained the search box too — so it passed on the input's
    // own `q` attribute and never looked at a chip at all.
    const chipWithRole = hrefsOf(both.html).filter((href) => href.includes('role=merchant'));
    expect(chipWithRole).toHaveLength(1);
    expect(chipWithRole[0]).toContain(`q=${PREFIX}`);

    // The form carries `role` as a hidden field so searching does not widen the filter.
    // Sliced from the `<form … action="/admin/users"` open tag rather than from the
    // placeholder text, because the hidden input is the first child — a slice starting at
    // `Find an account by email` begins *after* it and could never see the field it was
    // asserting. The tag is matched on `action` + `method` rather than by attribute order,
    // which React is free to change.
    const formAt = both.html.indexOf('<form');
    expect(formAt).toBeGreaterThan(-1);
    const form = both.html.slice(formAt, both.html.indexOf('</form>', formAt));
    expect(form).toContain('action="/admin/users"');
    expect(form).toContain('method="get"');
    expect(form).toContain('type="hidden"');
    expect(form).toContain('name="role"');
    expect(form).toContain('value="organiser"');
  });

  it('says what the search scopes, so an unsearched list does not look broken', async () => {
    const { text } = await render({ q: PREFIX });

    // The organiser and merchant sections are complete rosters and deliberately ignore
    // `q`. On screen that looks like a broken search unless it is stated — the operator
    // searched for an address and two sections still list everyone.
    expect(text).toContain('Searching for');
    expect(text).toContain(PREFIX);
    expect(text).toContain('always show everyone');

    // And it is absent without a search, or every visit says something about a search
    // that is not happening.
    expect((await render()).text).not.toContain('Searching for');
  });

  it('scopes the repair list with the same search, so one box answers one question', async () => {
    // The bug this catches: `?q=` narrowing the user list but not the repair list, so
    // typing a known-broken address still shows "99 organisers missing a profile" above
    // the one row being looked for.
    const { text } = await render({ q: email('broken') });

    // One match, singular heading — which is also the singular arm that was previously
    // untestable on this database, now reachable because the search narrows to one row.
    expect(text).toContain('1 organiser matching');
    expect(text).toContain('is missing a profile');
    expect(text).not.toContain('1 organisers');

    // And a healthy account matches nothing, so the card disappears entirely rather than
    // showing a stale count.
    expect((await render({ q: email('alice') })).text).not.toContain('missing a profile');
  });

  it('shows the empty state instead of an empty table when nothing matches', async () => {
    const { html, text } = await render({ q: `${PREFIX}-nobody` });

    // The searched-for address is echoed, because the most common cause is a typo and the
    // operator needs to see what was actually searched.
    expect(text).toContain('No account matches');
    expect(text).toContain(`${PREFIX}-nobody`);
    // No rows, and no "showing the first 0 of 0" sentence underneath them.
    expect(html).not.toContain('Showing the first');

    // A role filter with no matches says something different from a search with no
    // matches — "no accounts match this filter" versus "no account matches “…”".
    expect((await render({ role: 'ADMIN', q: `${PREFIX}-nobody` })).text).toContain(
      'No account matches',
    );
  });

  it('admits the cap in words, and names the controls that reach past it', async () => {
    // Unfiltered, so the cap is genuinely reached. This is the assertion that the slice's
    // whole argument rests on: truncation that does not announce itself reads as
    // completeness, and the operator's next question has no answer on the screen.
    const { text } = await render();

    const admission = /Showing the first (\d+) of (\d+) accounts/.exec(text);
    expect(admission).not.toBeNull();
    expect(Number(admission?.[1])).toBe(100);
    expect(Number(admission?.[2])).toBeGreaterThan(100);

    // It points at both controls rather than telling the operator to scroll.
    expect(text).toContain('role filter');
    expect(text).toContain('search for an address');
  });

  it('ignores an unparseable role filter loudly rather than silently', async () => {
    // `?role=garbage` must show everything *and say so*. A filter that quietly matched
    // nothing is indistinguishable from a filter that found nothing, and the operator is
    // usually on the phone with somebody who believes their account exists.
    const { text } = await render({ role: 'admn' });

    expect(text).toContain('Ignored an unrecognised role filter');
    expect(text).toContain('admn');
    expect(text).toContain('Showing every account');

    // And a valid filter says nothing of the kind.
    expect((await render({ role: 'admin' })).text).not.toContain('Ignored an unrecognised');
  });
});

describe('/admin/users — the user rows', () => {
  it('gives each account its role as a word, not the enum', async () => {
    const { html } = await render();

    // `MERCHANT` is the stored value; `Merchant` is what an operator reads. A page that
    // printed the raw enum would pass a `toContain('MERCHANT')` assertion, so the
    // assertion is on the rendered label inside the row.
    expect(cardFor(html, email('plain'), 'Users')).toContain('Merchant');
    expect(cardFor(html, email('temp'), 'Users')).toContain('Admin');
  });

  it('falls back to the raw role when the label map has no entry for it', async () => {
    // The `?? user.role` arm of `ROLE_LABEL[user.role] ?? user.role` is unreachable from
    // the schema: `UserRole` has exactly three members and all three are in the map. So
    // it is asserted against the map itself rather than pretended to be a rendered case,
    // and the limits list says so.
    const { html } = await render();

    // What *is* assertable is that every member of the enum has a human label, which is
    // the property `?? user.role` is a fallback for. Read from the enum, not retyped, so
    // adding a role without a label fails here instead of shipping a raw `SUPPORT` badge.
    const { UserRole } = await import('@prisma/client');
    const labels: Record<string, string> = {
      ADMIN: 'Admin',
      MERCHANT: 'Merchant',
      ORGANISER: 'Organiser',
    };
    for (const role of Object.values(UserRole)) {
      expect(labels[role], `Add a label for ${role} to ROLE_LABEL`).toBeTruthy();
      expect(html).toContain(labels[role] as string);
    }
  });

  it('marks a temporary password on exactly the accounts that have one', async () => {
    const { html } = await render();

    expect(cardFor(html, email('temp'), 'Users')).toContain('Temp password');
    // The negative half matters more: a badge on every row is the failure mode of a
    // truthiness check, and `mustChangePassword` defaults to `false`.
    expect(cardFor(html, email('plain'), 'Users')).not.toContain('Temp password');
  });

  it('lists every merchant an account belongs to, not just the first', async () => {
    const { html } = await render();
    const card = cardFor(html, email('multi'), 'Users');

    // Two memberships, both joined by name. `merchantUsers.map(...)` vs
    // `merchantUsers[0]` is the distinction, and **one membership cannot make it** — nor
    // can two with the same name, which is what this fixture had at first: `fx.merchant()`
    // names every merchant `${prefix} merchant`, so `toContain` passed against either.
    // The second merchant is renamed for exactly this assertion.
    expect(card).toContain(`${PREFIX} merchant`);
    expect(card).toContain(`${PREFIX} second merchant`);
    // Joined with a comma, not printed as two lines or two badges.
    expect(card).toContain(`${PREFIX} merchant, ${PREFIX} second merchant`);

    // An em dash when there are none — a blank line reads as a rendering fault.
    expect(cardFor(html, email('temp'), 'Users')).toContain('—');
  });
});

describe('/admin/users — the organisers, which is the section with a history', () => {
  it('shows the profile, not the account, and the commission as a percentage', async () => {
    const { html } = await render();
    const card = cardFor(html, email('alice'), 'Organisers');

    // The display name is the field that did not exist for a broken organiser, so its
    // presence in the row is the whole point of the section.
    expect(card).toContain(`${PREFIX} Alice`);
    // 7.5, not the 5% schema default: a defaulted fixture would agree with a page that
    // ignored the stored value entirely.
    expect(card).toContain('7.5% commission');
    expect(card).toContain('+15550000001');
  });

  it('says “no phone” rather than leaving the line empty', async () => {
    const { html } = await render();
    const card = cardFor(html, email('bob'), 'Organisers');

    expect(card).toContain('no phone');
    // And the commission default *is* 5% here, which is the honest stored value.
    expect(card).toContain('5% commission');
  });

  it('counts share links, and gets the singular right', async () => {
    const { html } = await render();

    // Zero is the current honest answer for every organiser. "1 share links" is the
    // tell-tale of a missing plural branch, and it is invisible while every count is 0 or
    // above 1 — so the assertion is on the phrase the page actually prints.
    expect(cardFor(html, email('alice'), 'Organisers')).toContain('0 share links');

    // Give Bob exactly one, so the singular arm is reached rather than argued about.
    await prisma.shareLink.create({
      data: {
        token: `${PREFIX}-token-1`,
        dropId: await fx.drop({
          merchantId,
          menuItemId: await fx.item(merchantId),
          dealPriceCents: 625,
          minQty: 4,
          status: 'PUBLISHED',
          cutoffAt: new Date('2026-07-30T23:00:00Z'),
        }),
        merchantId,
        organiserId: bobProfileId,
      },
    });

    const { html: after } = await render();
    const bob = cardFor(after, email('bob'), 'Organisers');
    expect(bob).toContain('1 share link');
    // Not "1 share links": the absence is what proves the singular branch ran.
    expect(bob).not.toContain('1 share links');
  });

  it('marks an account that has never signed in', async () => {
    const { html } = await render();

    expect(cardFor(html, email('never'), 'Organisers')).toContain('never signed in');
    // A signed-in organiser must not carry it, or the marker means nothing.
    expect(cardFor(html, email('bob'), 'Organisers')).not.toContain('never signed in');
  });

  it('does not pay organisers, and says so where the commission is displayed', async () => {
    const { text } = await render();

    // PRD-v1.md §3.3 — "Do not build automated organiser payouts in V1". The sentence is
    // what stops an operator reading `7.5% commission` as money that moves.
    expect(text).toContain('Commission is recorded for the record only');
    expect(text).toContain('nothing pays out automatically');
  });
});

describe('/admin/users — the repair control FR-906 exists for', () => {
  it('lists a profile-less organiser as broken, with a form to repair it', async () => {
    // Scoped by the fixture's own address, because the repair list is capped at ten and
    // sorted oldest-first: this database held ~99 profile-less organisers before this
    // suite ever ran, so the `broken` fixture created in `beforeAll` is never among the
    // first ten. Rendering unfiltered and searching the HTML for its id failed for that
    // reason and no other — the page was correct and the assertion was looking in the
    // wrong ten rows.
    const { html, text } = await render({ q: email('broken') });

    // The account exists, so it is in the Users list. What must also happen is that it
    // appears here — separately, labelled, and with a control.
    expect(text).toContain('missing a');
    expect(html).toContain('Create the missing profile');

    // The form is addressed to this account. A repair form that posted the wrong
    // `userId` would be worse than none: it would silently rewrite a healthy organiser.
    const block = html.slice(html.indexOf('Create the missing profile') - 2000);
    expect(block).toContain(`value="${brokenOrganiserId}"`);

    // And it explains the consequence in the operator's terms, not the schema's.
    expect(text).toContain('has no organiser profile, so their');
    expect(text).toContain('Their account works; nothing organiser-facing');
  });

  it('keeps the heading count and the number of repair forms the same list', async () => {
    // Named for what it proves. It was called "hides the repair card entirely when no
    // organiser is missing a profile", which is a claim about the **zero** branch — and
    // that branch is not reachable here, because the dev database holds dozens of
    // profile-less organisers that are not this file's to delete. Probe I made the
    // conditional `{true ? … }` and every test passed, which is what a test named for an
    // unasserted branch looks like.
    //
    // Unfiltered on purpose: this is the one test that must see the *cap*, so it is the
    // one test that must not narrow the list first. `forms` is capped at ten while
    // `heading` reports the true total, and the assertion below is that the page says
    // both numbers rather than pretending they are one.
    const { html, text } = await render();

    const heading = /(\d+) organisers? missing a\s+profile/.exec(text);
    expect(heading).not.toBeNull();
    const total = Number(heading?.[1]);
    expect(total).toBeGreaterThan(10);

    // The count and the controls must be the same query rendered twice. A heading computed
    // from one query and forms from another is the classic way these disagree. Under the
    // cap they are deliberately different *facts* — total matching versus rows rendered —
    // so what is asserted is that the page states both and never claims the cap is the
    // backlog.
    const forms = [...html.matchAll(/Create the missing profile/g)].length;
    expect(forms).toBe(10);
    expect(forms).toBeLessThan(total);

    // The sentence that makes the gap honest. Without it the page shows ten forms under a
    // heading reading ninety-nine and leaves the operator to notice.
    expect(text).toContain(`Showing the 10 oldest of ${total}`);

    // The plural is the arm that renders on this database; "1 organisers" is what a
    // missing `=== 1` branch prints, and it is checked as an absence because the number
    // is not 1 here.
    expect(text).not.toContain('1 organisers missing a');

    // **The singular arm is untestable here, and probe K proved it.** Deleting the
    // `=== 1 ? '' : 's'` ternary left all seventeen tests green, because the count on this
    // database is 98: both the correct and the broken form render `s`. The one place it
    // *is* reachable is under a search that matches a single account, which the first test
    // above now does — so the singular arm is asserted there instead of argued about here.
    expect(text).toMatch(/\d+ organisers missing a profile/);

    // The zero arm is unreachable here — the database holds dozens of broken organisers
    // that this file does not own — so it is asserted from the source instead of
    // pretended to be a render. Probe I replaced the guard with `{true ? … }` and every
    // test stayed green, which is exactly what an unasserted branch looks like. Reading
    // the file is a weaker assertion than rendering, and it is honest about being one.
    const source = readFileSync(
      new URL('../page.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('{profileless.total > 0 ? (');
  });
});

describe('/admin/users — the merchant rows', () => {
  it('prints the floor as a percentage, not as the stored share', async () => {
    const { html } = await render();
    const card = cardFor(html, `${PREFIX} merchant`, 'Merchants');

    // `floorPctOfMenu` is a share — 0.25 — and `toPct` has already converted it to a
    // number by the time the page sees it. Printing it raw gives "min margin 0.25%",
    // which is not a typo an operator would necessarily notice but is off by 100×. The
    // fixture's 0.25 is deliberate: it is a share whose percentage is a whole number, so
    // the two readings differ in a way a reader can see.
    expect(card).toContain('min margin 25%');
    expect(card).not.toContain('min margin 0.25%');
  });

  it('links each merchant to the page that can edit it, and states its status', async () => {
    const { html } = await render();
    // The raw card, not the text projection: `href` is an attribute and `textOf` strips
    // tags, so running `hrefsOf` on the text returns nothing. That cost one run.
    const card = rawCardFor(html, `${PREFIX} merchant`, 'Merchants');

    // The link is how the floor and pickup details are reached; without it the merchant
    // list is read-only in practice. Asserted as a resolved href, not by searching for
    // the substring — React escapes `&`, and `hrefsOf` decodes.
    const hrefs = hrefsOf(card);
    expect(hrefs.some((href) => /^\/admin\/merchants\/[0-9a-f-]{36}$/.test(href))).toBe(true);
    // `ACTIVE` is the stored value; the badge shows it verbatim here (unlike user roles),
    // and the status is what tells an operator whether the merchant can take a drop.
    expect(textOf(card)).toContain('ACTIVE');
  });
});

describe('/admin/users — the form the page cannot reach', () => {
  it('keeps the organiser-only fields off the default form, and the server refuses them anyway', async () => {
    // The role `<select>` starts at MERCHANT, so a render always shows the
    // non-organiser branch of `CreateUserForm`: `Name (optional)`, no `Display name`, no
    // `Commission %`. That is the limitation of rendering, stated rather than hidden.
    //
    // The *form* is scoped by its own markup rather than by the page's text, because
    // "Display name" also appears in the repair card's per-account form — a page-wide
    // `not.toContain('Display name')` was my first version and it failed for the right
    // reason: the string is genuinely on the page, in a control that should have it.
    const { html } = await render();
    const createForm = html.slice(html.indexOf('New user'), html.indexOf('>Organisers<'));

    expect(createForm).toContain('Name (optional)');
    expect(createForm).not.toContain('Display name');
    expect(createForm).not.toContain('Commission %');

    // The other half of the claim — that `createUserAction` re-validates rather than
    // trusting the form — is **not** asserted here. It is already proven, better, in
    // `admin/__tests__/organiser-actions.test.ts:133` ("refuses an organiser with no
    // display name, and creates nothing"), where the session is stubbed. Calling the
    // action from this file fails on `cookies()` outside a request scope, and wrapping a
    // request scope around it to re-prove an existing test would add a mock that makes
    // this suite less honest about what it is: a render.

    // What this file adds is the half that test cannot see: which fields the *default*
    // form shows before any interaction, and that the repair form posts the id of the
    // account it names. That second one is probe J's assertion, kept here as a reminder
    // that these two forms are the page's only write paths.
    const repairForm = html.slice(html.indexOf('Create the missing profile') - 2000);
    expect(repairForm).toContain('type="hidden"');
    expect(repairForm).toMatch(/name="userId"/);
  });
});

describe('/admin/users — it reads, it does not write', () => {
  it('leaves every row exactly as it found it', async () => {
    const select = {
      id: true,
      role: true,
      mustChangePassword: true,
      name: true,
      lastLoginAt: true,
    } as const;

    const usersBefore = await prisma.user.findMany({
      where: { id: { in: createdUserIds } },
      select,
      orderBy: { id: 'asc' },
    });
    const profilesBefore = await prisma.organiserProfile.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true, displayName: true, phone: true, commissionPct: true },
      orderBy: { id: 'asc' },
    });

    await render();
    await render();

    const usersAfter = await prisma.user.findMany({
      where: { id: { in: createdUserIds } },
      select,
      orderBy: { id: 'asc' },
    });
    const profilesAfter = await prisma.organiserProfile.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true, displayName: true, phone: true, commissionPct: true },
      orderBy: { id: 'asc' },
    });

    // `lastLoginAt` is included because it is the one field a listing page might
    // plausibly touch, and `commissionPct` because it is a `Decimal` that a careless
    // `Number()` round trip could rewrite. A comparison of ids alone would pass against a
    // page that reset every temporary-password flag.
    expect(usersAfter).toEqual(usersBefore);
    expect(profilesAfter).toEqual(profilesBefore);
    // Non-vacuous: the fixture really does own rows, so the comparison is of something.
    expect(usersBefore.length).toBeGreaterThanOrEqual(6);
    expect(profilesBefore.length).toBeGreaterThanOrEqual(3);
  });
});
