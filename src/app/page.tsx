import { redirect } from 'next/navigation';

import { getSession, roleHome } from '@/lib/auth/session';

/**
 * Role-based entry point (PRD-sprint1 §6.1): `ADMIN → /admin/users`,
 * `MERCHANT → /merchant/items`, `ORGANISER → /organiser`, nobody → `/login`.
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
