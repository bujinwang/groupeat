/**
 * Session tokens — the only JWT implementation in the app.
 *
 * `jose` rather than `jsonwebtoken` (ARCHITECTURE-sprint1 Q-4): middleware runs on
 * the Edge runtime, where `jsonwebtoken` cannot load. One implementation means
 * one verify path; two would mean one untested path.
 *
 * **This module must stay Edge-safe.** It therefore imports nothing but `jose`
 * and reads the secret from `process.env` directly — no Prisma, no zod, no
 * `server-only`. That is deliberate: `server-only` throws when imported outside a
 * React Server Component graph, and middleware is not one.
 */

import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'groupeat_session';

/** Sliding window: a token is refreshed when it has less than this left. */
export const SESSION_SLIDING_MINUTES = 60;
/** Hard cap: no session survives this long, however active. */
export const SESSION_ABSOLUTE_DAYS = 7;
/** Refresh early: within this window of expiry, issue a fresh token. */
export const SESSION_REFRESH_THRESHOLD_MINUTES = 15;

/** Local mirror of Prisma's `UserRole`, so the Edge bundle never imports Prisma. */
export type SessionRole = 'ADMIN' | 'MERCHANT' | 'ORGANISER';

const ROLES: readonly SessionRole[] = ['ADMIN', 'MERCHANT', 'ORGANISER'];

/**
 * FR-904 — the marker that makes a session a *borrowed* one.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * Present on the claims **only** while an admin is impersonating a merchant. Its
 * presence is the whole authorisation story for the read-only rule: `authorize.ts`
 * refuses every write when it is set, and the layout renders a banner so the admin
 * cannot forget which account they are looking at.
 *
 * ## Why the admin's own id is carried and not just a boolean
 *
 * Ending the impersonation has to put the admin back into their own session, and the
 * only trustworthy source for that is the claim itself. A boolean would mean reading
 * "who was here before" from somewhere else — a cookie, a DB row, or a header — and
 * every one of those is something the request can influence. The admin id comes from a
 * token we signed, so it cannot be forged by whoever holds the merchant cookie.
 *
 * ## Why `auditId` is here
 *
 * The audit row is the record that this session was authorised and by whom, and it
 * carries the stated reason. A session that cannot name its own authorisation is a
 * session nobody can audit later; carrying the id makes the link one hop instead of a
 * search by timestamp.
 */
export type ImpersonationClaims = {
  /** The admin whose privileges are being *exercised* — the actor, not the subject. */
  actorUserId: string;
  /** `AuditLog.id` for the `session.impersonate` row that authorised this session. */
  auditId: string;
  /** Epoch seconds. Shorter than the admin's own absolute cap; never refreshed. */
  expiresAt: number;
};

export type SessionClaims = {
  userId: string;
  role: SessionRole;
  mustChangePassword: boolean;
  /** Epoch seconds. The session dies here regardless of activity. */
  absoluteExpiresAt: number;
  /** Epoch seconds. The token's own expiry, `min(now + 60m, absoluteExpiresAt)`. */
  expiresAt: number;
  /** FR-904. Absent on every ordinary session. */
  impersonation?: ImpersonationClaims;
};

/**
 * How long a borrowed session lasts.
 *
 * Deliberately much shorter than `SESSION_ABSOLUTE_DAYS`, and deliberately much
 * shorter than the sliding window: an impersonation is a support call, not a shift.
 * The number is small enough that an admin who walks away from an unlocked laptop has
 * leaked 30 minutes of a merchant's *view*, and large enough to read what a complaint
 * was about.
 */
export const IMPERSONATION_MAX_MINUTES = 30;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    // `src/lib/config.ts` catches this at boot with a friendlier message; this
    // guard exists because middleware and tests can reach here without it.
    throw new Error('JWT_SECRET must be set and at least 32 characters long.');
  }
  return new TextEncoder().encode(secret);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `now + 7 days`, in epoch seconds — the absolute cap for a new session. */
export function newAbsoluteExpiry(from: number = nowSeconds()): number {
  return from + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60;
}

/**
 * Signs a session. The token's `exp` is `min(now + 60 min, absoluteExpiresAt)`,
 * so a refreshed token can never outlive the absolute cap.
 *
 * ## Why the impersonation claim is carried into every re-signed token
 *
 * This function is the refresh path as well as the login path, and middleware calls
 * it whenever a session is inside the sliding window. If it dropped `imp`, an
 * impersonation session would silently *become* a real merchant session at the first
 * refresh — the read-only guard would stop firing, the audit link would be lost, and
 * the admin would be left holding a merchant cookie with their own role gone. Nothing
 * would log it.
 *
 * That is why the claim is copied here rather than only at login: this is the one
 * place a session is ever re-issued, and so the one place the flag could be lost.
 *
 * An impersonation's `exp` is additionally clamped to its own expiry, so a refresh
 * cannot extend it. `absoluteExpiresAt` is set to the impersonation's expiry at
 * creation, which makes the existing clamp do the work.
 */
export async function signSession(claims: SessionClaims): Promise<string> {
  const issuedAt = nowSeconds();
  const impersonation = claims.impersonation;
  const cap = impersonation
    ? Math.min(claims.absoluteExpiresAt, impersonation.expiresAt)
    : claims.absoluteExpiresAt;
  const expiresAt = Math.min(issuedAt + SESSION_SLIDING_MINUTES * 60, cap);

  return new SignJWT({
    role: claims.role,
    mv: claims.mustChangePassword,
    absAt: claims.absoluteExpiresAt,
    ...(impersonation
      ? { imp: { a: impersonation.actorUserId, i: impersonation.auditId, e: impersonation.expiresAt } }
      : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(getSecret());
}

/**
 * Verifies a token. Returns `null` for anything wrong — expired, tampered,
 * signed with another secret, malformed, or past its absolute cap. Never throws:
 * a caller in middleware must be able to treat "no session" uniformly.
 */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });

    const userId = payload.sub;
    const role = payload.role;
    const mustChangePassword = payload.mv;
    const absoluteExpiresAt = payload.absAt;
    const expiresAt = payload.exp;

    if (typeof userId !== 'string' || userId.length === 0) {
      return null;
    }
    if (typeof role !== 'string' || !ROLES.includes(role as SessionRole)) {
      return null;
    }
    if (typeof mustChangePassword !== 'boolean') {
      return null;
    }
    if (typeof absoluteExpiresAt !== 'number' || !Number.isFinite(absoluteExpiresAt)) {
      return null;
    }
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return null;
    }
    // jose already rejected an expired `exp`; the absolute cap is ours to enforce.
    if (absoluteExpiresAt <= nowSeconds()) {
      return null;
    }

    // FR-904. Anything malformed about the claim rejects the whole token rather than
    // degrading to a plain session: a session that half-declares an impersonation is
    // a session whose guard we cannot reason about, and "ignore the unknown field"
    // is how a read-only session quietly becomes a writable one.
    let impersonation: ImpersonationClaims | undefined;
    const rawImp = payload.imp;
    if (rawImp !== undefined) {
      if (typeof rawImp !== 'object' || rawImp === null) {
        return null;
      }
      const candidate = rawImp as { a?: unknown; i?: unknown; e?: unknown };
      if (
        typeof candidate.a !== 'string' ||
        candidate.a.length === 0 ||
        typeof candidate.i !== 'string' ||
        candidate.i.length === 0 ||
        typeof candidate.e !== 'number' ||
        !Number.isFinite(candidate.e)
      ) {
        return null;
      }
      // The impersonation's own expiry is a second, earlier dead-man switch. It is
      // checked here as well as being folded into `absAt` so that a token minted
      // before that folding existed is still bounded.
      if (candidate.e <= nowSeconds()) {
        return null;
      }
      impersonation = {
        actorUserId: candidate.a,
        auditId: candidate.i,
        expiresAt: candidate.e,
      };
    }

    return {
      userId,
      role: role as SessionRole,
      mustChangePassword,
      absoluteExpiresAt,
      expiresAt,
      ...(impersonation ? { impersonation } : {}),
    };
  } catch {
    return null;
  }
}

/** True when the token is inside the refresh window and may be re-signed. */
export function needsRefresh(claims: SessionClaims): boolean {
  const secondsLeft = claims.expiresAt - nowSeconds();
  return secondsLeft < SESSION_REFRESH_THRESHOLD_MINUTES * 60;
}

/**
 * A brand-new session for a user who has just authenticated.
 *
 * Takes a closed argument list rather than `Partial<SessionClaims>`, and that is the
 * FR-904 guard: an impersonation session must be minted by `newImpersonationSession`
 * below, which is the only function that also demands an audit id. If this one
 * accepted an `impersonation` field, a caller could re-issue a borrowed session from
 * a login path — where no audit row exists — and the "flagged in audit log" half of
 * the requirement would be silently unmet.
 */
export function newSession(args: {
  userId: string;
  role: SessionRole;
  mustChangePassword: boolean;
}): SessionClaims {
  const absoluteExpiresAt = newAbsoluteExpiry();
  return {
    userId: args.userId,
    role: args.role,
    mustChangePassword: args.mustChangePassword,
    absoluteExpiresAt,
    expiresAt: Math.min(
      nowSeconds() + SESSION_SLIDING_MINUTES * 60,
      absoluteExpiresAt,
    ),
  };
}

/**
 * FR-904 — the body of an impersonation session.
 *
 * Deliberately **not** built on `newSession`: the admin's seven-day absolute cap must
 * not be inherited, because the whole point of a borrowed session is that it is short.
 * `absoluteExpiresAt` is set to the impersonation window rather than the usual cap, so
 * the existing `min(…, absoluteExpiresAt)` clamps in `signSession` do the rest and no
 * refresh can extend it.
 *
 * The role is `MERCHANT` because that is what the admin is borrowing — the merchant
 * pages and route handlers must resolve scope from `MerchantUser` rows exactly as they
 * do for a real owner. The difference is not the role; it is the claim.
 */
export function newImpersonationSession(args: {
  merchantUserId: string;
  actorUserId: string;
  auditId: string;
}): SessionClaims {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + IMPERSONATION_MAX_MINUTES * 60;

  return {
    userId: args.merchantUserId,
    role: 'MERCHANT',
    // A borrowed session must never be steered into the password-change screen: the
    // admin is not this user and cannot set their password.
    mustChangePassword: false,
    absoluteExpiresAt: expiresAt,
    expiresAt,
    impersonation: {
      actorUserId: args.actorUserId,
      auditId: args.auditId,
      expiresAt,
    },
  };
}

/** True when this session is borrowed — the read-only rule keys off this. */
export function isImpersonating(claims: SessionClaims | null): boolean {
  return claims?.impersonation !== undefined;
}

/**
 * Where each role lands after login (PRD-sprint1 §6.1).
 *
 * MERCHANT lands on `/merchant/drops`, not `/merchant/items`. A drop is the
 * thing the merchant came here to do; the dish list is the setup for it, and
 * sending a returning merchant to their ingredient costs every time is the wrong
 * first impression. The empty state of `/merchant/drops` sends them to add a dish
 * when they have none, so a new merchant still finds their way.
 */
export function roleHome(role: SessionRole): string {
  switch (role) {
    case 'ADMIN':
      return '/admin/users';
    case 'MERCHANT':
      return '/merchant/drops';
    case 'ORGANISER':
      return '/organiser';
    default:
      return '/login';
  }
}
