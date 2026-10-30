import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { CreateMerchantForm } from '@/components/admin/CreateMerchantForm';
import { CreateUserForm } from '@/components/admin/CreateUserForm';
import { listMerchants } from '@/lib/db/merchants';
import { listUsers } from '@/lib/db/users';

/**
 * `/admin/users` — the minimal admin (PRD-sprint1 §6.5).
 *
 * Users and merchants on one screen, each with its create form. The layout has
 * already established that the caller is an ADMIN.
 */

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Admin',
  MERCHANT: 'Merchant',
  ORGANISER: 'Organiser',
};

export default async function AdminUsersPage() {
  const [users, merchants] = await Promise.all([listUsers(), listMerchants()]);

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
