import 'server-only';

import { compare, hash } from 'bcryptjs';

/**
 * Password hashing. bcryptjs at cost 10 (PRD-sprint1 §7.1) — ported from the
 * previous repo, not rewritten.
 *
 * Node-only (bcryptjs cannot run on the Edge runtime), hence `server-only`.
 */

export const BCRYPT_COST = 10;

/** PRD-sprint1 §7.1 sets no length rule; 12 is the floor this sprint enforces. */
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  try {
    return await compare(plain, passwordHash);
  } catch {
    // A malformed stored hash must read as "wrong password", not as a 500.
    return false;
  }
}

/**
 * Returns a merchant-safe error message, or `null` when the password is
 * acceptable. Kept separate from hashing so the route handler can report a
 * field error before doing any work.
 */
export function assertPasswordPolicy(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (plain.length > 200) {
    return 'Use 200 characters or fewer.';
  }
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return 'Use at least one letter and one number.';
  }
  return null;
}

let dummyHash: string | null = null;

/**
 * A real bcrypt hash of a value nobody knows, used to keep the failed-login path
 * roughly constant-time: verifying against `user?.passwordHash ?? DUMMY_HASH`
 * means "no such account" and "wrong password" take the same time, so the
 * response cannot be used to enumerate accounts (PRD-sprint1 §6.1).
 */
export async function getDummyHash(): Promise<string> {
  if (dummyHash === null) {
    dummyHash = await hash('groupeat-timing-equaliser-not-a-password', BCRYPT_COST);
  }
  return dummyHash;
}
