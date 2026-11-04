import 'server-only';

import { logger } from '@/lib/logging/logger';
import { normalizeEmail, touchLastLogin, updatePassword, findUserByEmail, findUserById } from '@/lib/db/users';

import { getDummyHash, hashPassword, verifyPassword, assertPasswordPolicy } from './password';
import { hit, reset } from './rate-limit';
import { newSession, roleHome } from './jwt';
import type { Session } from './session';

/**
 * The auth *operations*, in one place.
 *
 * There are two entry points — the server actions the forms use, and the
 * `POST /api/auth/*` routes — and they share this module rather than each
 * implementing the sequence. Two copies of "verify, sign, set cookie" is how one
 * of them quietly loses the rate limit or the enumeration guard.
 */

export type LoginSuccess = {
  ok: true;
  session: Session;
  redirectTo: string;
};

export type LoginFailure = {
  ok: false;
  status: 401 | 429;
  /** PRD-sprint1 §6.1: one message for both wrong email and wrong password. */
  message: string;
  retryAfterSeconds?: number;
};

export type LoginResult = LoginSuccess | LoginFailure;

const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';

/**
 * Authenticates an email/password pair.
 *
 * - Rate limit first, so a blocked caller learns nothing about the account.
 * - `verifyPassword` runs even when the user does not exist, against a dummy
 *   hash, so timing does not reveal whether an email is registered.
 * - On success the counter is cleared and `lastLoginAt` is written.
 */
export async function authenticate(
  email: string,
  password: string,
  clientKey: string,
): Promise<LoginResult> {
  const limit = hit(clientKey);
  if (!limit.allowed) {
    logger.warn('auth.login_failed', { reason: 'rate_limited' });
    return {
      ok: false,
      status: 429,
      message: 'Too many attempts. Try again in a few minutes.',
      retryAfterSeconds: limit.retryAfterSeconds,
    };
  }

  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail);

  const passwordHash = user?.passwordHash ?? (await getDummyHash());
  const passwordMatches = await verifyPassword(password, passwordHash);

  if (!user || !passwordMatches) {
    logger.warn('auth.login_failed', {
      reason: user ? 'bad_password' : 'unknown_email',
    });
    return { ok: false, status: 401, message: GENERIC_LOGIN_ERROR };
  }

  reset(clientKey);
  await touchLastLogin(user.id);

  const session = newSession({
    userId: user.id,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });

  logger.info('auth.login_succeeded', { userId: user.id, role: user.role });

  return {
    ok: true,
    session,
    redirectTo: user.mustChangePassword ? '/change-password' : roleHome(user.role),
  };
}

export type ChangePasswordSuccess = {
  ok: true;
  session: Session;
  redirectTo: string;
};

export type ChangePasswordFailure = {
  ok: false;
  status: 401 | 422;
  message: string;
  field?: 'currentPassword' | 'newPassword';
};

export type ChangePasswordResult = ChangePasswordSuccess | ChangePasswordFailure;

/**
 * S1-019 — the forced change. On success the flag is cleared and the session is re-signed
 * with `mv = false`, so the middleware gate opens without a re-login.
 *
 * ## This used to claim `lastLoginAt` was refreshed, and it never was
 *
 * The docblock said "the flag is cleared, `lastLoginAt` is refreshed and the session is
 * re-signed". The function has never called `touchLastLogin`; `changePassword` touches
 * `passwordHash` and `mustChangePassword` and nothing else. Found while writing the suite
 * that proves it — `credentials.test.ts`, *"does not write lastLoginAt, whatever its
 * docblock says"* — which pins the current behaviour at a fixed date rather than accepting
 * whatever the row happens to hold.
 *
 * The sentence is the thing that was wrong, not the code: `authenticate` stamps
 * `lastLoginAt` at the moment of sign-in, and a forced change always follows a sign-in, so
 * the value is already current. Whether a *voluntary* password change should also count as
 * activity is a product question (it would make the column mean "last authenticated or
 * re-credentialed"), and it is not this function's to answer by accident.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const user = await findUserById(userId);
  if (!user) {
    return { ok: false, status: 401, message: 'Please sign in again.' };
  }

  const currentMatches = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentMatches) {
    return {
      ok: false,
      status: 422,
      field: 'currentPassword',
      message: 'That is not your current password.',
    };
  }

  if (newPassword === currentPassword) {
    return {
      ok: false,
      status: 422,
      field: 'newPassword',
      message: 'Choose a password you have not used here before.',
    };
  }

  const policyError = assertPasswordPolicy(newPassword);
  if (policyError) {
    return { ok: false, status: 422, field: 'newPassword', message: policyError };
  }

  const passwordHash = await hashPassword(newPassword);
  await updatePassword(user.id, passwordHash);

  logger.info('auth.password_changed', { userId: user.id });

  const session = newSession({
    userId: user.id,
    role: user.role,
    mustChangePassword: false,
  });

  return { ok: true, session, redirectTo: roleHome(user.role) };
}
