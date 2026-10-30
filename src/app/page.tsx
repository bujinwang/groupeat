import { redirect } from 'next/navigation';

/**
 * Role-based entry point.
 *
 * The redirect targets by role (`ADMIN → /admin/users`, `MERCHANT →
 * /merchant/items`, `ORGANISER → /organiser`) are wired in T03 together with the
 * session layer; until then every visitor is sent to `/login`.
 *
 * `force-dynamic` because the answer depends on the caller's cookie, never on
 * build-time data.
 */
export const dynamic = 'force-dynamic';

export default function HomePage(): never {
  redirect('/login');
}
