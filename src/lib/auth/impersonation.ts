import { prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

import { writeAuditEntry } from '@/lib/audit/log';
import { IMPERSONATION_MAX_MINUTES, newImpersonationSession } from '@/lib/auth/jwt';
import type { Session } from '@/lib/auth/session';

/**
 * FR-904 — an admin borrows a merchant owner's session, read-only, for 30 minutes.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 * > `| **Admin** | Email + password | Everything, plus refunds, overrides,
 * >  impersonation |` — PRD-v1.md:105
 *
 * ## What the feature is for, because it decides the design
 *
 * The only reason to be here is a support call: a merchant says "I can't publish" and
 * the fastest truthful answer is to see what they see. That means the impersonating
 * admin needs the merchant's **exact** read view — the same rows, scoped the same way,
 * with no admin privileges layered on top — and needs it briefly.
 *
 * So the session is a *real* `MERCHANT` session for the target user, minted from their
 * `MerchantUser` rows, with one extra claim that says it is borrowed. There is no
 * second code path through the merchant pages and no "admin can see everything" flag:
 * if the merchant's view is broken, the admin sees the broken thing, which is the
 * entire diagnostic value.
 *
 * ## Why the audit row is written before the session exists
 *
 * Same ordering as FR-902, for the same reason: `writeAuditEntry` throws, and a
 * borrowed session with no record of who authorised it — and why — is precisely what
 * the requirement's second half forbids. A failure to record means no session is
 * issued, and the admin gets an error while nothing has happened.
 *
 * ## Why the target must be an OWNER of an ACTIVE merchant
 *
 * FR-904 says "merchant owner". A manager's view is a different view, so impersonating
 * one would answer a different question than the one asked. And a suspended merchant's
 * pages are not where a support call comes from. Both are refused with a sentence
 * rather than silently narrowed, because an admin who asked to impersonate somebody
 * and landed in a different account would draw the wrong conclusion from what they saw.
 */

/** A refusal the route turns into a status; returned as a value so it is testable. */
export type ImpersonationRefusal =
  | { kind: 'SELF' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_AN_OWNER' }
  | { kind: 'MERCHANT_NOT_ACTIVE'; merchantStatus: string }
  | { kind: 'NOT_IN_MERCHANT' };

export type ImpersonationTarget = {
  readonly merchantUserId: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly userEmail: string;
};

/**
 * The refusals, as values.
 *
 * Pure over facts so the rules can be asserted without a database, the same shape as
 * `refusalFor` in `refunds/participant-refund.ts` and `forceFailRefusal` in
 * `admin/force-fail.ts`.
 */
export function impersonationRefusal(args: {
  actorUserId: string;
  /** The merchant the admin is acting from, when the route has one. */
  expectMerchantId?: string;
  found: {
    userId: string;
    merchantId: string;
    merchantStatus: string;
    merchantRole: string;
  } | null;
}): ImpersonationRefusal | null {
  if (!args.found) {
    return { kind: 'NOT_FOUND' };
  }
  if (args.found.userId === args.actorUserId) {
    // An admin who is also a merchant owner could impersonate themselves, which would
    // mint a read-only session for their own account — a way to lock themselves out of
    // their own write access for half an hour, and a meaningless audit row.
    return { kind: 'SELF' };
  }
  // The route is `/api/admin/merchants/:id/impersonate`, so the id in the path is a
  // statement about *which* merchant this is for. A merchant-user id belonging to a
  // different merchant is almost certainly a stale tab or a copy-paste, and honouring
  // it would mint a session for an account that has nothing to do with the page the
  // admin was looking at. Refused rather than silently corrected, because the admin's
  // next action would then be based on the wrong belief about whose view they hold.
  if (args.expectMerchantId !== undefined && args.found.merchantId !== args.expectMerchantId) {
    return { kind: 'NOT_IN_MERCHANT' };
  }
  if (args.found.merchantRole !== 'OWNER') {
    return { kind: 'NOT_AN_OWNER' };
  }
  if (args.found.merchantStatus !== 'ACTIVE') {
    return { kind: 'MERCHANT_NOT_ACTIVE', merchantStatus: args.found.merchantStatus };
  }
  return null;
}

function refusalToError(refusal: ImpersonationRefusal): AppError {
  switch (refusal.kind) {
    case 'SELF':
      return AppError.conflict('You already have access to your own account.');
    case 'NOT_FOUND':
      // A merchant user id from a URL. 404 and not 403, `authorize.ts`'s rule: the
      // admin surface is allowed to know which ids exist, but a *user* id belonging
      // to nobody should not be distinguishable from one belonging to another tenant.
      return AppError.notFound('That merchant user does not exist.');
    case 'NOT_AN_OWNER':
      return AppError.conflict(
        'FR-904 covers merchant owners only. That account is not an owner, and its view is not the one a support call is about.',
      );
    case 'MERCHANT_NOT_ACTIVE':
      return AppError.conflict(
        `That merchant is ${refusal.merchantStatus.toLowerCase()}, so there is no live account to view.`,
      );
    case 'NOT_IN_MERCHANT':
      return AppError.conflict(
        'That account is not attached to this merchant. Reload the page and try again.',
      );
  }
}

/** Loads one merchant-user row with the facts the rules need. */
async function loadTarget(merchantUserId: string) {
  return prisma.merchantUser.findUnique({
    where: { id: merchantUserId },
    select: {
      id: true,
      merchantId: true,
      userId: true,
      role: true,
      merchant: { select: { name: true, status: true } },
      user: { select: { email: true, role: true } },
    },
  });
}

export type StartImpersonationResult = {
  readonly session: Session;
  readonly auditId: string;
  readonly target: ImpersonationTarget;
  readonly expiresAt: Date;
};

/**
 * Mints the borrowed session. The caller sets it as the cookie.
 *
 * The admin's own session is **replaced**, not stacked. Two reasons: a browser will
 * not send two cookies under one name, and stacking would mean the admin's own
 * privileges were still reachable from the same browser — which is exactly what
 * "read-only" is meant to prevent while the borrowed session is live. Ending the
 * impersonation mints a fresh admin session from the claim.
 */
export async function startImpersonation(args: {
  merchantUserId: string;
  /** The merchant whose page the admin pressed the button on, from the URL. */
  expectMerchantId: string;
  reason: string;
  ipAddress?: string | null;
  actor: { userId: string; email: string };
}): Promise<StartImpersonationResult> {
  const row = await loadTarget(args.merchantUserId);

  const refusal = impersonationRefusal({
    actorUserId: args.actor.userId,
    expectMerchantId: args.expectMerchantId,
    found: row
      ? {
          userId: row.userId,
          merchantId: row.merchantId,
          merchantRole: row.role,
          merchantStatus: row.merchant.status,
        }
      : null,
  });

  if (refusal) {
    logger.info('admin.impersonation_refused', {
      actorId: args.actor.userId,
      merchantUserId: args.merchantUserId,
      reason: refusal.kind,
    });
    throw refusalToError(refusal);
  }

  // `refusal` was null, which requires a row.
  if (!row) {
    throw AppError.notFound('That merchant user does not exist.');
  }

  const expiresAt = new Date(Date.now() + IMPERSONATION_MAX_MINUTES * 60 * 1000);

  // The record, before the session exists. See the docblock.
  const auditId = await writeAuditEntry({
    actorUserId: args.actor.userId,
    actorEmail: args.actor.email,
    action: 'session.impersonate',
    targetType: 'user',
    targetId: row.userId,
    detail: {
      stage: 'STARTED',
      reason: args.reason,
      merchantUserId: row.id,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      targetEmail: row.user.email,
      expiresAt: expiresAt.toISOString(),
      // Stated in the row so a later reader does not have to infer the rule from the
      // code that happened to be deployed at the time.
      readonly: true,
    },
    ipAddress: args.ipAddress ?? null,
  });

  const session = newImpersonationSession({
    merchantUserId: row.userId,
    actorUserId: args.actor.userId,
    auditId,
  });

  logger.info('admin.impersonation_started', {
    actorId: args.actor.userId,
    merchantUserId: row.id,
    merchantId: row.merchantId,
    auditId,
    expiresAt: expiresAt.toISOString(),
  });

  return {
    session,
    auditId,
    target: {
      merchantUserId: row.id,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      userEmail: row.user.email,
    },
    expiresAt,
  };
}

export type EndImpersonationResult = {
  readonly session: Session;
  readonly auditId: string;
};

/**
 * Ends an impersonation and returns the admin's own session.
 *
 * ## Why the actor id comes from the claim and is then re-checked
 *
 * The claim is signed, so it cannot be forged — but it *can* be stale: the admin may
 * have been demoted or deleted since the session was minted, and that is half an hour
 * of nothing for a signed claim to be wrong about. So the id is used to look the user
 * up, and the resulting session is built from the **current** row rather than from
 * anything in the token. A deleted admin gets a 401 with a sentence instead of a
 * session for a user who no longer exists.
 */
export async function endImpersonation(args: {
  session: Session;
  ipAddress?: string | null;
}): Promise<EndImpersonationResult> {
  const claim = args.session.impersonation;
  if (!claim) {
    throw AppError.conflict('You are not impersonating anyone.');
  }

  const admin = await prisma.user.findUnique({
    where: { id: claim.actorUserId },
    select: { id: true, email: true, role: true, mustChangePassword: true },
  });
  if (!admin || admin.role !== 'ADMIN') {
    // Everything the admin's session needs is read from the row, so a demotion is
    // honoured on the way out rather than being carried back in from the token.
    throw AppError.unauthorized(
      'The admin account that started this session is no longer available. Sign in again.',
    );
  }

  // The record of the *end*. Written before the new session is returned, and it points
  // at the row that authorised the start, so the two halves of one session are one
  // hop apart.
  const auditId = await writeAuditEntry({
    actorUserId: admin.id,
    actorEmail: admin.email,
    action: 'session.impersonate',
    targetType: 'user',
    targetId: args.session.userId,
    detail: {
      stage: 'ENDED',
      startAuditId: claim.auditId,
      merchantUserId: args.session.userId,
    },
    ipAddress: args.ipAddress ?? null,
  });

  logger.info('admin.impersonation_ended', {
    actorId: admin.id,
    impersonatedUserId: args.session.userId,
    startAuditId: claim.auditId,
    auditId,
  });

  // Imported here rather than at the top: `newSession` lives in `jwt.ts`, which is
  // Edge-safe and already imported, but keeping the constructor call next to its use
  // makes it obvious that the *current* row is what the restored session is built
  // from.
  const { newSession } = await import('@/lib/auth/jwt');

  return {
    session: newSession({
      userId: admin.id,
      role: 'ADMIN',
      mustChangePassword: admin.mustChangePassword,
    }),
    auditId,
  };
}

/**
 * What the banner says — and why it needs two names rather than one.
 *
 * A banner reading "You are viewing Mercury Bowl" is not enough to act on. The admin
 * needs to know **whose** account this is (so they can confirm it matches the person
 * on the phone), **when** it lapses (so they do not lose the window mid-diagnosis), and
 * **as whom** they will be signed back in. That is three facts, and all three come from
 * the session plus two rows.
 *
 * The admin's own address is read here rather than carried in the claim, for the same
 * reason the audit row reads it from the row: a token minted half an hour ago may hold
 * an address that has since changed, and the banner is not an audit record — it is a
 * sign pointing at one, so it should agree with the row.
 *
 * Returns `null` for an ordinary session, which is the branch the layout needs and the
 * only one it should have to check.
 */
export type ImpersonationBanner = {
  /** The borrowed account's address — the person the admin is looking at. */
  readonly viewingEmail: string;
  /** The admin's own address — who they will be signed back in as. */
  readonly actorEmail: string;
  readonly expiresAt: Date;
  readonly auditId: string;
};

export async function impersonationBanner(session: Session): Promise<ImpersonationBanner | null> {
  const claim = session.impersonation;
  if (!claim) {
    return null;
  }

  // The actor id is read from the claim inline rather than through `actorFor` in
  // `authorize.ts`, and that is not laziness: `authorize.ts` imports `server-only`, so
  // reaching it from here would make this module — and the DB-backed suite that covers
  // the rules below — impossible to import under Vitest. The rule is one line and it is
  // restated here with the reason rather than hidden behind an import that breaks the tests.
  const actorUserId = claim.actorUserId;
  const [admin, target] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorUserId }, select: { email: true } }),
    prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } }),
  ]);

  return {
    // Both fall back to a phrase rather than to `undefined`: the banner is the one
    // place the admin cannot be allowed to see a blank, because a blank banner is
    // indistinguishable from no banner.
    viewingEmail: target?.email ?? 'this account',
    actorEmail: admin?.email ?? 'your admin account',
    expiresAt: new Date(claim.expiresAt * 1000),
    auditId: claim.auditId,
  };
}
