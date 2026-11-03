import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { BackfillOrganiserForm } from '@/components/admin/BackfillOrganiserForm';
import { CreateMerchantForm } from '@/components/admin/CreateMerchantForm';
import { CreateUserForm } from '@/components/admin/CreateUserForm';
import { listMerchants } from '@/lib/db/merchants';
import { listOrganisers, listProfilelessOrganisers } from '@/lib/db/organisers';
import { listUsers } from '@/lib/db/users';

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
 */
export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  MERCHANT: 'Merchant',
  ORGANISER: 'Organiser',
};

export default async function AdminUsersPage() {
  const [users, merchants, organisers, profileless] = await Promise.all([
    listUsers(),
    listMerchants(),
    listOrganisers(),
    listProfilelessOrganisers(),
  ]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Users</h1>
          <span className="text-xs text-ink-soft">{users.length}</span>
        </div>

        <ul className="space-y-2">
          {users.map((user) => (
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

        {profileless.length > 0 ? (
          <Card>
            <h2 className="mb-1 text-sm font-semibold text-blocked">
              {profileless.length} organiser{profileless.length === 1 ? '' : 's'} missing a
              profile
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-ink-soft">
              These accounts can sign in but have no display name or commission, because
              the profile that holds them was never created. That used to happen to every
              organiser created here.
            </p>
            <ul className="space-y-4">
              {profileless.map((account) => (
                <li key={account.userId} className="border-t border-slate-200/60 pt-3 first:border-0 first:pt-0">
                  <BackfillOrganiserForm userId={account.userId} email={account.email} />
                </li>
              ))}
            </ul>
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
