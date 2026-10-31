import 'server-only';

/**
 * Public surface of the auth layer.
 *
 * `jwt.ts` is deliberately importable on its own by `src/middleware.ts`: the Edge
 * runtime must not pull Prisma, bcrypt or `server-only` into its bundle, and this
 * barrel re-exports all three.
 */

export {
  SESSION_ABSOLUTE_DAYS,
  SESSION_COOKIE,
  SESSION_REFRESH_THRESHOLD_MINUTES,
  SESSION_SLIDING_MINUTES,
  needsRefresh,
  newAbsoluteExpiry,
  signSession,
  verifySession,
} from './jwt';
export type { SessionClaims, SessionRole } from './jwt';

export {
  applySessionCookie,
  clearSessionCookie,
  clearSessionCookieInAction,
  getSession,
  newSession,
  roleHome,
  sessionCookieOptions,
  setSessionCookie,
} from './session';
export type { Session, SessionCookieOptions } from './session';

export {
  requireAdmin,
  requireMerchant,
  requireMerchantScope,
  requireRole,
  requireRoleOrRedirect,
  requireSession,
} from './authorize';

export {
  BCRYPT_COST,
  MIN_PASSWORD_LENGTH,
  assertPasswordPolicy,
  getDummyHash,
  hashPassword,
  verifyPassword,
} from './password';

export { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, hit as rateLimitHit, reset as rateLimitReset } from './rate-limit';

export { authenticate, changePassword } from './credentials';
export type {
  ChangePasswordFailure,
  ChangePasswordResult,
  ChangePasswordSuccess,
  LoginFailure,
  LoginResult,
  LoginSuccess,
} from './credentials';
