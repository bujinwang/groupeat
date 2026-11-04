import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { BackfillOrganiserForm } from '@/components/admin/BackfillOrganiserForm';
import { CreateMerchantForm } from '@/components/admin/CreateMerchantForm';
import { CreateUserForm } from '@/components/admin/CreateUserForm';
import { listMerchants } from '@/lib/db/merchants';
import {
  ADMIN_USER_ROLES,
  listUsers,
  parseAdminUserRole,
  type AdminUserRole,
} from '@/lib/db/users';
import { listOrganisers, listProfilelessOrganisers } from '@/lib/db/organisers';

/**
 * `/admin/users` — the minimal admin (PRD-sprint1 §6.5).
 *
 * Users and merchants on one screen, each with its create form. The layout has
 * already established that the caller is an ADMIN.
 *
 * ## Why organisers get their own section (FR-906)
 *
 * They were previously indistinguishable from any other account: a row in the user
 * list with an `Organiser` badge. But an organiser is a `User` **plus** an
 * `OrganiserProfile`, and the list showed only the first half — so an account created
 * without its profile looked exactly like a healthy one.
 *
 * The section shows the profile's name and commission, which is what makes a missing
 * profile visible, and it lists such accounts separately with a repair control rather
 * than leaving them to be discovered when the organiser complains that their share
 * link has no name on it.
 *
 * ## Why the user list is capped and filterable (D2)
 *
 * It was an unbounded `findMany`, so the page grew linearly with the `User` table. Measured on a
 * production build at 1,040 accounts it was **1,856,483 bytes / 11,205 nodes**, and after the cap
 * it is **400,428 bytes / 2,294 nodes** — 78.4% smaller. The figure originally recorded in
 * `PROGRESS.md` was 6,289,787 bytes, which was a *dev-server* measurement: dev flight data runs
 * about 3.4x production, so the defect was real and the number was three times too large. Both
 * are now attributed to the environment that produced them.
 *
 * The second thing the cap exposed is not visible in the byte count: **98 of the page's 100
 * `<form>` elements were repair forms**, one per profile-less organiser, and 605 of its inputs.
 * That list is now bounded too, with a total.
 *
 * `?role=` is what makes the cap honest. A cap with no filter would make the 941st account
 * unreachable from the only screen that lists accounts, which is worse than a slow page for the
 * one operator who needs it. The filter is a **link**, not a form, mirroring `/admin/drops`:
 * bookmarkable, shareable in a support thread, and it survives a reload — which matters because
 * the person using it is usually on the phone with somebody describing their screen. `?q=` is the
 * other half, for when the operator has an address rather than a category.
 *
 * ## What is deliberately *not* capped
 *
 * The organiser and merchant sections below are rosters, not logs. Organisers are
 * onboarded by hand and merchants are a fixed book of business, so both are bounded by
 * the product rather than by usage; 52 organiser cards is a list an operator can read.
 * The user table is the one that grows without limit, because every admin, merchant and
 * organiser account lands in it. Capping a roster would hide rows an operator is
 * entitled to see, which is a different mistake from capping an unbounded table.
 */

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  MERCHANT: 'Merchant',
  ORGANISER: 'Organiser',
};

/**
 * The role chips come from `ADMIN_USER_ROLES`, not from a second list.
 *
 * This was a hand-kept duplicate whose order happened to match, which is a duplicate that
 * drifts: adding a role to the enum would have shipped a role the parser accepts, the page
 * can filter by, and no chip links to. Reading the constant makes "every role has a chip"
 * structural rather than something a reviewer has to notice — and the suite asserts it by
 * iterating the same constant, so the two cannot disagree.
 */

function RoleChip({
  role,
  active,
  q,
}: {
  role: AdminUserRole | null;
  active: boolean;
  q: string;
}) {
  // The search survives a chip change. Losing it would make the two controls fight: an
  // operator searches, then narrows by role, and their search silently disappears.
  const params = new URLSearchParams();
  if (role !== null) params.set('role', role.toLowerCase());
  if (q !== '') params.set('q', q);
  const query = params.toString();
  return (
    <Link
      href={query === '' ? '/admin/users' : `/admin/users?${query}`}
      aria-current={active ? 'true' : undefined}
      className={
        active
          ? 'rounded-full bg-brand px-2.5 py-1 text-xs font-medium text-white'
          : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-ink-soft'
      }
    >
      {role === null ? 'All' : ROLE_LABEL[role]}
    </Link>
  );
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const rawRole = first(query.role);
  const role = parseAdminUserRole(rawRole);
  const q = (first(query.q) ?? '').trim();

  const [users, organisers, profileless] = await Promise.all([
    listUsers({ role, q }),
    listOrganisers(),
    // The same `q` narrows the repair list. One search box has to mean one thing: an
    // operator who types an address is asking about that *person*, and whether their
    // organiser profile is broken is part of the answer. A search that filtered only the
    // top list would leave a "99 organisers missing a profile" card above it, unchanged,
    // as if the question had not been asked.
    listProfilelessOrganisers({ q }),
  ]);

  // `listMerchants` stays a roster for the reason the docblock gives; it is read here
  // rather than in the batch above so the comment sits next to the decision.
  const merchants = await listMerchants();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Users</h1>
          {/*
            The real total, not `rows.length`. Those were the same number while the read
            was unbounded; they stopped being the same number the moment it was capped,
            and printing the visible count here would quietly say "100" about a table of
            1,040. Under a filter it reads "12 of 1,040".
          */}
          <span className="text-xs text-ink-soft">
            {users.total > users.rows.length
              ? `${users.rows.length} of ${users.total}`
              : users.total}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <RoleChip role={null} active={role === null} q={q} />
          {ADMIN_USER_ROLES.map((value) => (
            <RoleChip key={value} role={value} active={role === value} q={q} />
          ))}
        </div>

        {/*
          A GET form, so the search is a URL like the chips are — bookmarkable, shareable
          and reload-surviving. The role rides along in a hidden field so searching does
          not silently widen the filter.
        */}
        <form method="get" action="/admin/users" className="flex items-center gap-2">
          {role !== null ? <input type="hidden" name="role" value={role.toLowerCase()} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Find an account by email"
            aria-label="Find an account by email"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className={buttonClass('quiet')}>
            Search
          </button>
        </form>

        {/*
          Say what the search scopes. It narrows the two lists that can hide rows — the
          capped user list and the capped repair list. The organiser and merchant sections
          below are complete rosters and stay whole, which is visible on screen: a search
          that appears to ignore them reads as a broken search unless it is named.
        */}
        {q !== '' ? (
          <p className="text-xs text-ink-soft">
            Searching for “{q}”. The user list and the missing-profile list are narrowed;
            the organiser and merchant lists below always show everyone.
          </p>
        ) : null}

        {/*
          An unparseable `?role=` shows everything and says so. A filter that silently
          matched nothing is indistinguishable from a filter that found nothing, and here
          the difference is "there are no admins" versus "you mistyped".
        */}
        {rawRole && role === null ? (
          <p role="status" className="text-xs text-ink-soft">
            Ignored an unrecognised role filter ({String(rawRole).slice(0, 40)}). Showing
            every account.
          </p>
        ) : null}

        {users.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-soft">
              {q === ''
                ? 'No accounts match this filter.'
                : `No account matches “${q}”.`}
            </p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {users.rows.map((user) => (
              <Card as="li" key={user.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{user.email}</p>
                    <p className="text-xs text-ink-soft">
                      {user.merchantUsers.length > 0
                        ? user.merchantUsers.map((membership) => membership.merchant.name).join(', ')
                        : '—'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone="neutral">{ROLE_LABEL[user.role] ?? user.role}</Badge>
                    {user.mustChangePassword ? <Badge tone="thin">Temp password</Badge> : null}
                  </div>
                </div>
              </Card>
            ))}
          </ul>
        )}

        {/*
          The cap has to say it is a cap. Silently showing the first 100 of 1,040 reads
          as "this is all of them", and the next question — "where is the account I'm
          looking for" — has no answer on the screen. It names the two controls that do
          answer it rather than telling the operator to scroll.
        */}
        {users.total > users.rows.length ? (
          <p className="text-xs leading-relaxed text-ink-soft">
            Showing the first {users.rows.length} of {users.total} accounts, sorted by
            email. Narrow with the role filter or search for an address to reach the rest.
          </p>
        ) : null}

        <Card>
          <h2 className="mb-3 text-sm font-semibold">New user</h2>
          <CreateUserForm />
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Organisers</h1>
          <span className="text-xs text-ink-soft">{organisers.length}</span>
        </div>

        <p className="text-xs leading-relaxed text-ink-soft">
          Organisers are onboarded by hand — there is no self-serve signup in V1.
          Commission is recorded for the record only; nothing pays out automatically yet.
        </p>

        {profileless.total > 0 ? (
          <Card>
            {/*
              Under a search, `total` counts matches, not the whole backlog — so the
              heading has to say which question it is answering. "1 organiser missing a
              profile" after typing one address is true and useful; leaving the number at
              99 under the same search would be a card that ignored the search box.
            */}
            <h2 className="mb-1 text-sm font-semibold text-blocked">
              {q === ''
                ? `${profileless.total} organiser${profileless.total === 1 ? '' : 's'} missing a profile`
                : `${profileless.total} organiser${profileless.total === 1 ? '' : 's'} matching “${q}” ${profileless.total === 1 ? 'is' : 'are'} missing a profile`}
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-ink-soft">
              These accounts can sign in but have no display name or commission, because
              the profile that holds them was never created. That used to happen to every
              organiser created here.
            </p>
            <ul className="space-y-4">
              {profileless.rows.map((account) => (
                <li key={account.userId} className="border-t border-slate-200/60 pt-3 first:border-0 first:pt-0">
                  <BackfillOrganiserForm userId={account.userId} email={account.email} />
                </li>
              ))}
            </ul>
            {/*
              Each row here is a full form — hidden input, labelled text input, button,
              two sentences — because the display name is the one value the repair cannot
              invent. That is right for one account and 98 forms is a page nobody scrolls.
              The oldest are shown and the rest are named, rather than the whole set being
              rendered because the query was easy to write that way.
            */}
            {profileless.total > profileless.rows.length ? (
              <p className="mt-3 border-t border-slate-200/60 pt-3 text-xs leading-relaxed text-ink-soft">
                Showing the {profileless.rows.length} oldest
                {q === '' ? '' : ' matching'} of {profileless.total}. Repairing one removes
                it from this list and brings the next into view.
              </p>
            ) : null}
          </Card>
        ) : null}

        {organisers.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-soft">
              No organisers yet. Choose “Organiser” in the role list above to create one —
              a display name is required, because it is the name a diner sees next to
              their share link.
            </p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {organisers.map((organiser) => (
              <Card as="li" key={organiser.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{organiser.displayName}</p>
                    <p className="truncate text-xs text-ink-soft">{organiser.email}</p>
                    <p className="text-xs text-ink-soft">
                      {organiser.phone ?? 'no phone'}
                      {' · '}
                      {organiser.shareLinkCount}{' '}
                      {organiser.shareLinkCount === 1 ? 'share link' : 'share links'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone="neutral">{organiser.commissionPct}% commission</Badge>
                    {organiser.mustChangePassword ? <Badge tone="thin">Temp password</Badge> : null}
                    {organiser.lastLoginAt === null ? (
                      <span className="text-[10px] text-ink-soft">never signed in</span>
                    ) : null}
                  </div>
                </div>
              </Card>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Merchants</h1>
          <span className="text-xs text-ink-soft">{merchants.length}</span>
        </div>

        <ul className="space-y-2">
          {merchants.map((merchant) => (
            <Card as="li" key={merchant.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/admin/merchants/${merchant.id}`}
                    className="truncate text-sm font-medium underline underline-offset-4"
                  >
                    {merchant.name}
                  </Link>
                  <p className="text-xs text-ink-soft">
                    min margin {Math.round(merchant.floorPctOfMenu * 100)}%
                  </p>
                </div>
                <Badge tone={merchant.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                  {merchant.status}
                </Badge>
              </div>
            </Card>
          ))}
        </ul>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">New merchant</h2>
          <CreateMerchantForm />
        </Card>
      </section>

      <p className="text-xs text-ink-soft">
        <Link href="/merchant/items" className={buttonClass('quiet')}>
          Merchant view
        </Link>{' '}
        is only reachable from a merchant account.
      </p>
    </div>
  );
}
