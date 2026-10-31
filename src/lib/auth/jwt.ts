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

export type SessionClaims = {
  userId: string;
  role: SessionRole;
  mustChangePassword: boolean;
  /** Epoch seconds. The session dies here regardless of activity. */
  absoluteExpiresAt: number;
  /** Epoch seconds. The token's own expiry, `min(now + 60m, absoluteExpiresAt)`. */
  expiresAt: number;
};

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
 */
export async function signSession(claims: SessionClaims): Promise<string> {
  const issuedAt = nowSeconds();
  const expiresAt = Math.min(
    issuedAt + SESSION_SLIDING_MINUTES * 60,
    claims.absoluteExpiresAt,
  );

  return new SignJWT({
    role: claims.role,
    mv: claims.mustChangePassword,
    absAt: claims.absoluteExpiresAt,
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

    return {
      userId,
      role: role as SessionRole,
      mustChangePassword,
      absoluteExpiresAt,
      expiresAt,
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

/** A brand-new session for a user who has just authenticated. */
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

/** Where each role lands after login (PRD-sprint1 §6.1). */
export function roleHome(role: SessionRole): string {
  switch (role) {
    case 'ADMIN':
      return '/admin/users';
    case 'MERCHANT':
      return '/merchant/items';
    case 'ORGANISER':
      return '/organiser';
    default:
      return '/login';
  }
}
