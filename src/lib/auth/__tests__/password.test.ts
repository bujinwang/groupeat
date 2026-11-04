import { describe, expect, it, vi } from 'vitest';
import { getRounds } from 'bcryptjs';

/**
 * `server-only` is neutralised for the same reason as in `impersonation-jwt.test.ts` and
 * six other files: the marker throws outside a React Server Component graph, and Vitest
 * is not one. The marker is in the right place — `password.ts` loads bcryptjs, which
 * cannot run on the Edge runtime — so the mock stands in for the bundler rather than
 * removing a guard that belongs there.
 *
 * Declared before the import of the module under test: `vi.mock` is hoisted, so the
 * order in the file does not matter to Vitest, but reading it in source order is the
 * only thing that stops a future author concluding the marker was never there.
 */
vi.mock('server-only', () => ({}));

import {
  BCRYPT_COST,
  MIN_PASSWORD_LENGTH,
  assertPasswordPolicy,
  getDummyHash,
  hashPassword,
  verifyPassword,
} from '@/lib/auth/password';

/**
 * S1-005 / S1-019 — hashing and the password policy.
 *
 * `password.ts` is imported for real rather than mocked. Until this file existed the
 * module was reached only through `credentials.ts`, which every test in the repo
 * replaced: `src/app/login/__tests__/page.test.ts` and
 * `src/app/change-password/__tests__/page.test.ts` both `vi.mock('@/lib/auth/credentials')`,
 * so the whole login path — and this, the thing that decides whether a password is
 * right — had no test at all. That is what makes this file the front door's lock.
 *
 * ## What the docblock claims, and which of the claims are true
 *
 * `verifyPassword`'s comment says a malformed stored hash "must read as wrong password,
 * not as a 500". That is **only reachable for one class of malformed hash**: bcryptjs
 * returns `false` for most garbage (probed: `''`, `'not-a-real-hash'`, a truncated
 * `$2a$` string) and throws only on an unrecognised *salt version*. So a test that fed
 * it any old rubbish would pass with the `try/catch` deleted, and the catch would still
 * look covered. The test below feeds it `$9x$…`, which is the input that actually
 * throws — see *The catch that only one input reaches*.
 *
 * ## `getDummyHash`'s docblock is wrong, and the test says so
 *
 * It calls the hashed value "a value nobody knows". The plaintext is written on the
 * line below the comment, in this file's sibling. That is not a vulnerability — see the
 * `!user ||` guard in `credentials.test.ts`, which is what makes a known dummy password
 * harmless — but it is a comment that states a property the code does not have, and the
 * assertion below is the one that keeps us honest about it.
 */

const GOOD = 'correct-horse-42';

describe('S1-005 · hashing', () => {
  it('produces a bcrypt hash at the documented cost', async () => {
    const hashed = await hashPassword(GOOD);

    expect(hashed.startsWith('$2')).toBe(true);
    expect(hashed).toHaveLength(60);
    expect(getRounds(hashed)).toBe(BCRYPT_COST);
  });

  it('uses a fresh salt every time, so the same password hashes differently', async () => {
    const [first, second] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);

    expect(first).not.toBe(second);
    // …and both still verify. A salted hash that does not round-trip is worse than a
    // plain one, because it fails at the only moment anyone finds out.
    expect(await verifyPassword(GOOD, first)).toBe(true);
    expect(await verifyPassword(GOOD, second)).toBe(true);
  });

  it('verifies the right password and refuses the wrong one', async () => {
    const hashed = await hashPassword(GOOD);

    expect(await verifyPassword(GOOD, hashed)).toBe(true);
    expect(await verifyPassword(`${GOOD} `, hashed)).toBe(false);
    expect(await verifyPassword(GOOD.toUpperCase(), hashed)).toBe(false);
    expect(await verifyPassword('', hashed)).toBe(false);
  });

  it('never stores the plaintext', async () => {
    const hashed = await hashPassword(GOOD);

    expect(hashed).not.toContain(GOOD);
  });
});

describe('S1-005 · the malformed-hash catch, and the only input that reaches it', () => {
  it('reads a hash with an unknown salt version as a wrong password rather than throwing', async () => {
    // Probed: `compare()` throws `Error: Invalid salt version: $9` for this shape. This
    // is the assertion the `try/catch` exists for; every other malformed input below
    // returns `false` on its own, with or without the catch.
    const hostile = `$9x$10$${'a'.repeat(53)}`;

    await expect(verifyPassword(GOOD, hostile)).resolves.toBe(false);
  });

  it('returns false for garbage hashes bcryptjs rejects without throwing', async () => {
    // These three do NOT exercise the catch — bcryptjs returns `false` itself. They are
    // here so the set of inputs a stored row could plausibly hold is enumerated, and so
    // a future reader does not mistake this block for the one above.
    expect(await verifyPassword(GOOD, '')).toBe(false);
    expect(await verifyPassword(GOOD, 'not-a-real-hash')).toBe(false);
    expect(await verifyPassword(GOOD, '$2a$10$short')).toBe(false);
  });

  it('returns a boolean, never undefined, for every malformed shape', async () => {
    const shapes = ['', 'not-a-real-hash', '$2a$10$short', `$9x$10$${'a'.repeat(53)}`];

    for (const shape of shapes) {
      expect(typeof (await verifyPassword(GOOD, shape))).toBe('boolean');
    }
  });
});

describe('S1-019 · the password policy', () => {
  it('pins the floor as a literal, because the page duplicates it', () => {
    // `change-password/page.tsx` hardcodes `minLength={12}` on the input. The constant
    // and the attribute are two copies of one number and nothing else compares them, so
    // this assertion is the second witness: if the constant moves, this fails and sends
    // the next author to the page.
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('refuses one character below the floor and accepts the floor', () => {
    const eleven = 'abcdefghij1';
    const twelve = 'abcdefghij12';

    expect(eleven).toHaveLength(MIN_PASSWORD_LENGTH - 1);
    expect(twelve).toHaveLength(MIN_PASSWORD_LENGTH);

    expect(assertPasswordPolicy(eleven)).toBe(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    expect(assertPasswordPolicy(twelve)).toBeNull();
  });

  it('accepts 200 characters and refuses 201', () => {
    const atLimit = `${'a'.repeat(199)}1`;
    const overLimit = `${'a'.repeat(200)}1`;

    expect(atLimit).toHaveLength(200);
    expect(overLimit).toHaveLength(201);

    expect(assertPasswordPolicy(atLimit)).toBeNull();
    expect(assertPasswordPolicy(overLimit)).toBe('Use 200 characters or fewer.');
  });

  it('requires a letter and a number, and says so', () => {
    expect(assertPasswordPolicy('123456789012')).toBe('Use at least one letter and one number.');
    expect(assertPasswordPolicy('abcdefghijkl')).toBe('Use at least one letter and one number.');
    expect(assertPasswordPolicy('!!!!!!!!!!!!')).toBe('Use at least one letter and one number.');
    expect(assertPasswordPolicy('abcdefghijk1')).toBeNull();
    expect(assertPasswordPolicy('ABCDEFGHIJK1')).toBeNull();
  });

  it('reports the length failure before the composition failure', () => {
    // Ten digits are both too short and missing a letter. The order is asserted because
    // it decides which sentence the user reads, and "use at least one letter" on a
    // 10-character password would send them to fix the wrong thing.
    expect(assertPasswordPolicy('1234567890')).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  });

  it('counts only ASCII letters, so a CJK password with digits is refused', () => {
    // `/[a-zA-Z]/` is the whole alphabet the policy knows. A user writing their password
    // in Chinese and appending digits satisfies the length rule and fails the letter
    // rule, and the message they get is "Use at least one letter and one number" —
    // which they will read as false, because they typed letters.
    //
    // Pinned as current behaviour, not endorsed as correct. Changing the class to
    // `\p{L}` would be the fix; it is not made here because widening the accepted set is
    // a product decision and this slice is tests, not policy.
    const cjkWithDigits = '密码密码密码密码1234';

    // Exactly 12 code units, i.e. exactly at the floor — so the length rule passes and
    // the letter rule is the only thing left to refuse it. A shorter string would have
    // been excluded by the length rule and would have proved nothing about the class.
    expect(cjkWithDigits).toHaveLength(MIN_PASSWORD_LENGTH);
    expect(assertPasswordPolicy(cjkWithDigits)).toBe('Use at least one letter and one number.');
  });

  it('returns null rather than an empty string when the password is acceptable', () => {
    // The callers branch on truthiness (`if (policyError)`), so `''` would be a silent
    // pass dressed as a failure message.
    expect(assertPasswordPolicy('abcdefghijk1')).toBeNull();
  });
});

describe('S1-005 · the timing equaliser', () => {
  it('is memoised for sequential callers', async () => {
    const first = await getDummyHash();
    const second = await getDummyHash();

    expect(first).toBe(second);
    expect(getRounds(first)).toBe(BCRYPT_COST);
  });

  it('is NOT memoised against concurrent callers, and the cost is bounded', async () => {
    // A real defect, found by writing this file. `getDummyHash` reads `dummyHash`, awaits
    // `hash()`, then writes `dummyHash`:
    //
    //     if (dummyHash === null) { dummyHash = await hash(...); }
    //
    // Two callers that arrive before either write both see `null` and both hash. So the
    // memo is a cache for *sequential* callers only.
    //
    // **The cold start has to be manufactured, and getting that wrong is the trap.** The
    // module-level `dummyHash` is already set by every test above this one, so a bare
    // `Promise.all([getDummyHash(), getDummyHash()])` here would find it non-null and
    // agree — passing for the wrong reason and pinning the opposite of the truth. A
    // fresh module instance is the only way to observe the cold path. (`vi.resetModules()`
    // plus a dynamic import: the static import at the top of this file is bound to the
    // instance the earlier tests already warmed.)
    //
    // Severity: low, and worth stating exactly. It costs one extra bcrypt at cost 10
    // (~54 ms) per *concurrent cold start*, it is not a correctness bug — every copy is
    // a valid hash of the same plaintext, so `verifyPassword` answers identically — and
    // it self-heals once the last writer wins, because later callers see a non-null
    // value. The reason to assert it rather than ignore it is that the docblock claims
    // the cost is paid once, and it is paid once per racing caller.
    vi.resetModules();
    const cold = await import('@/lib/auth/password');

    const [first, second] = await Promise.all([cold.getDummyHash(), cold.getDummyHash()]);

    // Both are usable, which is what actually matters to `authenticate`.
    expect(await cold.verifyPassword('correct-horse-42', first)).toBe(false);
    expect(await cold.verifyPassword('correct-horse-42', second)).toBe(false);

    // And they are not the same value, because the read-check-write is not atomic.
    expect(first).not.toBe(second);

    // From here the settled value is stable, so every later caller shares one hash.
    const third = await cold.getDummyHash();
    const fourth = await cold.getDummyHash();
    expect(third).toBe(fourth);
    // …and it is one of the two the race produced, not a third value.
    expect([first, second]).toContain(third);
  });

  it('does not verify against an arbitrary password', async () => {
    const dummy = await getDummyHash();

    expect(await verifyPassword('correct-horse-42', dummy)).toBe(false);
    expect(await verifyPassword('', dummy)).toBe(false);
  });

  it('verifies against the plaintext written in the source, contrary to its docblock', async () => {
    // This assertion exists to record a wrong comment, not to celebrate the behaviour.
    // `getDummyHash`'s docblock says it hashes "a value nobody knows"; the value is a
    // string literal two lines below that comment. So the dummy hash is a hash of a
    // *known* password, and anyone reading the repository can satisfy it.
    //
    // It is harmless only because of a guard in `credentials.ts`:
    //
    //     if (!user || !passwordMatches) return { ...401 };
    //
    // The `!user` half is what saves it. `credentials.test.ts` proves that half is
    // load-bearing with a mutation probe: collapse the condition to
    // `if (!passwordMatches)`, and this literal becomes a universal login for every
    // address that does not exist. That is why this test is here and why it matters
    // more than it looks.
    const dummy = await getDummyHash();

    expect(
      await verifyPassword('groupeat-timing-equaliser-not-a-password', dummy),
    ).toBe(true);
  });
});
