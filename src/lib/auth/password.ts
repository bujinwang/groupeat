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
 * A bcrypt hash used to keep the failed-login path roughly constant-time: verifying
 * against `user?.passwordHash ?? DUMMY_HASH` means "no such account" and "wrong password"
 * take the same time, so the response cannot be used to enumerate accounts
 * (PRD-sprint1 §6.1). Measured: ~54 ms per compare at cost 10, against ~1 ms for the
 * `findUnique` alone — a 50× gap, which is what makes the guard worth having.
 *
 * ## NOT "a value nobody knows", which is what this comment used to say
 *
 * The plaintext is the string literal on the `hash(...)` line below. Anyone reading this
 * repository can therefore produce a password that satisfies the dummy hash — and it is
 * harmless **only** because of one guard in `credentials.ts`:
 *
 *     if (!user || !passwordMatches) return { ok: false, status: 401, … };
 *
 * The `!user` half is what makes a satisfied dummy hash irrelevant, because there is no
 * account to sign in as. Delete that half and the dummy becomes a **universal login** for
 * every address that does not exist. `credentials.test.ts` kills exactly that mutation
 * (*"the dummy hash cannot authenticate a non-existent account"*), and
 * `password.test.ts` asserts the literal verifies, so neither half can drift silently.
 *
 * ## The memo is not concurrency-safe, and the cost is bounded
 *
 * `if (dummyHash === null) dummyHash = await hash(...)` is a read-check-write across an
 * `await`. Two callers that arrive before either writes both hash, so a cold start under
 * concurrency pays 2 × 54 ms instead of 1. It is a cache for sequential callers only.
 * Asserted rather than fixed: every copy is a valid hash of the same plaintext, the last
 * writer wins, and later callers agree — so it costs latency once and never correctness.
 * `password.test.ts` has to `vi.resetModules()` to observe it, because the module-level
 * value is warm by the time any later test runs.
 */
export async function getDummyHash(): Promise<string> {
  if (dummyHash === null) {
    dummyHash = await hash('groupeat-timing-equaliser-not-a-password', BCRYPT_COST);
  }
  return dummyHash;
}
