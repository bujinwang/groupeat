import { redirect } from 'next/navigation';

import { getSession, roleHome } from '@/lib/auth/session';

/**
 * Role-based entry point (PRD-sprint1 §6.1).
 *
 * The gate order is the part that matters, and it matches `middleware.ts` and
 * `requireRoleOrRedirect`: **no session → `mustChangePassword` → role**. A
 * temporary-password user is sent to `/change-password` before their role is
 * consulted, so S1-019 does not depend on a layout gate catching them later.
 *
 * On the destinations: PRD-sprint1 §6.1 says `MERCHANT → /merchant/items`, and
 * `roleHome()` returns **`/merchant/drops`**. That departure is intentional and
 * dates from M3, when a merchant's first meaningful screen became their drops
 * rather than their dishes; it is pinned in `/login`, `/change-password`, the
 * impersonation route and `/admin/merchants/[id]`. This comment used to repeat the
 * PRD value beside code that does something else, which is how a reader learns to
 * distrust a docblock.
 *
 * `force-dynamic` because the answer depends on the caller's cookie and never on
 * build-time data.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<never> {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }
  if (session.mustChangePassword) {
    redirect('/change-password');
  }
  redirect(roleHome(session.role));
}
