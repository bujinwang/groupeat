import 'server-only';

import { redirect } from 'next/navigation';

import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/prisma';

import { getSession } from './session';
import type { Session } from './session';
import { roleHome } from './jwt';
import type { SessionRole } from './jwt';

/**
 * Authorisation.
 *
 * Two rules that are easy to get wrong, and both are P0 (PRD-sprint1 §7.3):
 *
 *   1. **Middleware is a convenience, not the gate.** Every route handler and
 *      every layout calls these again. A bypassed matcher must not become an
 *      authorisation hole.
 *   2. **A foreign resource is 404, never 403.** A merchant must not be able to
 *      learn that another merchant's item id exists.
 */

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw AppError.unauthorized();
  }
  return session;
}

/** Throws 401 when there is no session, 403 when the role is wrong. */
export function requireRole(session: Session | null, roles: readonly SessionRole[]): Session {
  if (!session) {
    throw AppError.unauthorized();
  }
  if (!roles.includes(session.role)) {
    throw AppError.forbidden();
  }
  return session;
}

/**
 * The merchant ids reachable from the signed-in user's `MerchantUser` rows.
 *
 * There is no "merchant id from the URL" trust anywhere: every merchant-scoped
 * query filters by this list. A user with no row gets an empty array, and an
 * empty scope means 404 on every merchant route.
 */
export async function requireMerchantScope(session: Session): Promise<string[]> {
  requireRole(session, ['MERCHANT']);

  const rows = await prisma.merchantUser.findMany({
    where: { userId: session.userId },
    select: { merchantId: true },
    orderBy: { merchantId: 'asc' },
  });

  return rows.map((row) => row.merchantId);
}

/** Convenience for the admin surface. */
export async function requireAdmin(): Promise<Session> {
  return requireRole(await getSession(), ['ADMIN']);
}

/** Convenience for the merchant surface: session plus scope in one call. */
export async function requireMerchant(): Promise<{ session: Session; merchantIds: string[] }> {
  const session = await requireSession();
  const merchantIds = await requireMerchantScope(session);
  return { session, merchantIds };
}

/**
 * Resolves the session for a *layout*, redirecting instead of throwing: a server
 * component cannot turn an `AppError` into a status code.
 */
export async function requireRoleOrRedirect(
  roles: readonly SessionRole[],
): Promise<Session> {
  const session = await getSession();

  if (!session) {
    redirect('/login');
  }
  if (session.mustChangePassword) {
    redirect('/change-password');
  }
  if (!roles.includes(session.role)) {
    redirect(roleHome(session.role));
  }
  return session;
}
