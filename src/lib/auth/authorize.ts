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

/**
 * FR-904 — the read-only rule, in one place.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why this is a separate function and not a flag inside `requireMerchant`
 *
 * `requireMerchant` answers "may this caller see this merchant's data", and the answer
 * for an impersonating admin is **yes** — that is the entire point of the feature.
 * Folding the write refusal into it would conflate two questions, and the first caller
 * that legitimately needed read scope would have to opt out. So the read gate stays
 * exactly as it was, and every mutating entry point calls this one as well.
 *
 * ## Why refusing here is enough, and why it has to be here
 *
 * Middleware cannot be the gate for this: it runs on the Edge runtime, sees only the
 * cookie, and its job is routing. A route handler that forgets to call this is the
 * failure mode — so the discipline is that **every** handler with a mutating export
 * calls it, and `impersonation-readonly.test.ts` walks `src/app/api/merchant/**` and
 * fails if any of them does not. A convention that is only stated is a convention that
 * gets missed on the twelfth route; one that is grepped for is not.
 *
 * ## The sentence
 *
 * 403 with a message naming the reason. Not a 404: the admin is *supposed* to know
 * this merchant exists — they are looking at it — and a concealment status here would
 * read as a bug rather than a rule.
 */
export function refuseIfImpersonating(session: Session): void {
  if (session.impersonation) {
    throw AppError.forbidden(
      'You are viewing this account as an admin. Changes are disabled during impersonation — end the session to make edits as yourself.',
    );
  }
}

/** Convenience for the merchant surface: session plus scope in one call. */
export async function requireMerchant(): Promise<{ session: Session; merchantIds: string[] }> {
  const session = await requireSession();
  const merchantIds = await requireMerchantScope(session);
  return { session, merchantIds };
}

/**
 * The same, for a route that changes something. One call instead of two, so a
 * mutating handler cannot get the read gate and forget the write gate — the ordering
 * it returns is the ordering the audit trail needs.
 */
export async function requireMerchantWrite(): Promise<{
  session: Session;
  merchantIds: string[];
}> {
  const result = await requireMerchant();
  refuseIfImpersonating(result.session);
  return result;
}

/**
 * Who actually performed an action, for the audit trail — FR-904's "session flagged
 * in audit log", generalised to every action an impersonating admin causes.
 *
 * While impersonating, the actor is the **admin**, not the merchant whose session is
 * being borrowed. Recording the merchant as the actor would be a false record: they
 * did not press anything, and an audit trail whose purpose is to attribute actions to
 * people must not attribute them to the wrong one.
 *
 * `userId` is therefore the admin's id and `impersonatedUserId` names the borrowed
 * account. Both are needed: one answers "who did this", the other answers "as whom".
 */
export async function actorFor(session: Session): Promise<{
  userId: string;
  impersonatedUserId: string | null;
}> {
  if (session.impersonation) {
    return {
      userId: session.impersonation.actorUserId,
      impersonatedUserId: session.userId,
    };
  }
  return { userId: session.userId, impersonatedUserId: null };
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
