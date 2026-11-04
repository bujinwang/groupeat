import { beforeEach, describe, expect, it, vi } from 'vitest';

import { roleHome } from '@/lib/auth/jwt';

/**
 * `src/app/page.tsx` — the role router (PRD-sprint1 §6.1).
 *
 * Four lines of logic and the only page in the app that every signed-in user
 * passes through, whichever role they hold. It had **no test of any kind**: a
 * grep for the module finds no importer, and a scan for a colocated `__tests__`
 * directory finds none either, because there is nothing to colocate it with at
 * the root of `src/app`.
 *
 * ## What is actually at stake
 *
 * Not the destination table — `roleHome` is a pure function with its own callers
 * and its own tests. The claim this file pins is the **order of the gates**:
 *
 * ```
 *   no session            → /login
 *   mustChangePassword    → /change-password
 *   else                  → roleHome(role)
 * ```
 *
 * `mustChangePassword` is checked **before** the role, and that ordering is the
 * whole security property of S1-019. A user holding a temporary password who is
 * routed to `/merchant/drops` would reach a page whose own layout gate then has
 * to catch them. Three entry points do this — this page, `middleware.ts`, and
 * `requireRoleOrRedirect` — and they must agree, or the answer to "where does a
 * temporary-password user land" depends on which one happened to run.
 *
 * ## How a redirect is observed
 *
 * `redirect()` throws a control-flow error, so the test replaces it with one that
 * carries its destination — the same pattern `change-password`'s suite already
 * uses, rather than a second convention. Only `redirect` is replaced: `roleHome`
 * is the real one from `jwt.ts`, so the destination table is not restated here.
 *
 * ## What is deliberately replaced, and what that costs
 *
 * `getSession` is mocked; everything else is production code. That is honest for
 * this page — it reads one value and branches on it. The cost is that nothing
 * here proves the *cookie* is what `getSession` claims; that is `session`'s job.
 */

vi.mock('server-only', () => ({}));

const redirectError = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(public readonly destination: string) {
      super(`NEXT_REDIRECT:${destination}`);
      this.name = 'RedirectError';
    }
  }
  return RedirectError;
});

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: (destination: string) => {
    throw new redirectError(destination);
  },
}));

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', async () => {
  const jwt = await import('@/lib/auth/jwt');
  return {
    getSession,
    roleHome: jwt.roleHome,
    newSession: jwt.newSession,
  };
});

const HomePage = (await import('@/app/page')).default;

type MockSession = {
  userId: string;
  role: 'ADMIN' | 'MERCHANT' | 'ORGANISER';
  mustChangePassword: boolean;
};

function sessionFor(
  role: MockSession['role'],
  mustChangePassword = false,
): MockSession {
  return { userId: 'user-1', role, mustChangePassword };
}

/** Calls the page and reports where it sent the caller. */
async function whereDoesItSend(): Promise<string> {
  try {
    await HomePage();
  } catch (error) {
    if (error instanceof redirectError) {
      return error.destination;
    }
    throw error;
  }
  // `HomePage` returns `Promise<never>`: every path redirects, so reaching here
  // means the page returned normally, which is the bug this makes visible rather
  // than letting a bare `.toThrow()` pass.
  return 'DID NOT REDIRECT';
}

beforeEach(() => {
  getSession.mockReset();
});

describe('the role table, as the page applies it', () => {
  /**
   * One case per role, asserted **twice**: against `roleHome` and against the
   * literal.
   *
   * The `roleHome` comparison alone is the weaker assertion — it cannot catch a
   * wrong destination, because both sides come from the same function. What it
   * catches is the page bypassing `roleHome` (hardcoding a path, or routing every
   * role to one screen), which is the realistic regression when someone adds a
   * fifth role. The literal catches the other direction: `roleHome` being retargeted
   * without anyone noticing that three screens' links no longer match.
   *
   * The literal for MERCHANT is worth a note, because **PRD-sprint1 §6.1 says
   * `/merchant/items` and the code says `/merchant/drops`.** The departure is
   * intentional and dates from `9280441` ("M3 slice 2"), when a merchant's first
   * meaningful screen became their drops rather than their dishes. It is already
   * pinned in `/login`, `/change-password`, the impersonation route and
   * `/admin/merchants/[id]`. `src/app/page.tsx`'s docblock used to repeat the PRD
   * value beside code doing something else; that comment is corrected rather than
   * the code, because a docblock disagreeing with its function teaches the next
   * reader to distrust the file.
   */
  it.each([
    ['ADMIN', '/admin/users'],
    ['MERCHANT', '/merchant/drops'],
    ['ORGANISER', '/organiser'],
  ] as const)('sends a %s to roleHome, which is %s', async (role, expected) => {
    getSession.mockResolvedValue(sessionFor(role));
    const destination = await whereDoesItSend();
    expect(destination).toBe(roleHome(role));
    // And `roleHome` agrees with the literal, so a change there fails here too.
    expect(destination).toBe(expected);
  });
});

describe('the gate order, which is the security property', () => {
  it('sends an anonymous caller to /login', async () => {
    getSession.mockResolvedValue(null);
    expect(await whereDoesItSend()).toBe('/login');
  });

  /**
   * **A temporary password outranks the role.**
   *
   * The interesting case is a user who is *both* on a temporary password and has a
   * real role — every role, because a page that checked the role first would pass
   * a single-role test and fail for the other two. Routing such a user anywhere
   * but `/change-password` leaves S1-019 to be enforced one layer down, at a
   * layout gate, on a screen that has already been chosen.
   */
  it.each(['ADMIN', 'MERCHANT', 'ORGANISER'] as const)(
    'sends a %s on a temporary password to /change-password, not their home',
    async (role) => {
      getSession.mockResolvedValue(sessionFor(role, true));
      const destination = await whereDoesItSend();
      expect(destination).toBe('/change-password');
      // Named explicitly: the failure this guards is the home page winning.
      expect(destination).not.toBe(roleHome(role));
    },
  );

  /**
   * An anonymous caller is not asked to change a password.
   *
   * Reaching the `mustChangePassword` branch with no session would mean reading
   * `session.mustChangePassword` off `null` — a `TypeError` and a 500 on the app's
   * front door. The session check has to come first, and this asserts the order
   * rather than the outcome only, because "redirects to /login" would also be the
   * answer if the branch order were right for the wrong reason.
   */
  it('checks for a session before reading the password flag', async () => {
    getSession.mockResolvedValue(null);
    // Would be `/change-password` if the flag were read off a null session and
    // coerced; would be a thrown TypeError if it were read unguarded.
    expect(await whereDoesItSend()).toBe('/login');
  });
});

describe('the page always redirects', () => {
  /**
   * `HomePage` is typed `Promise<never>`, and this is the test that makes the type
   * honest.
   *
   * A page that returns markup renders a home screen nobody designed. The
   * exhausted-`switch` default in `roleHome` returns `/login`, so an unknown role
   * lands somewhere rather than nowhere.
   */
  it('never returns normally, for any session shape', async () => {
    const cases: (MockSession | null)[] = [
      null,
      sessionFor('ADMIN'),
      sessionFor('MERCHANT'),
      sessionFor('MERCHANT', true),
      sessionFor('ORGANISER'),
    ];

    for (const session of cases) {
      getSession.mockResolvedValue(session);
      const destination = await whereDoesItSend();
      expect(destination).not.toBe('DID NOT REDIRECT');
      // Every destination is an absolute path — a relative or absolute URL would
      // be an open-redirect shape even here.
      expect(destination.startsWith('/')).toBe(true);
    }
  });

  /**
   * The session is read **once per request**, not cached at module scope.
   *
   * `export const dynamic = 'force-dynamic'` is the declaration; this is the
   * behaviour. A module-level cache would serve the first caller's role to
   * everyone — the single worst failure this page could have, and invisible in
   * every test above because they each run once.
   */
  it('re-reads the session for each caller', async () => {
    getSession.mockResolvedValue(sessionFor('ADMIN'));
    expect(await whereDoesItSend()).toBe('/admin/users');

    getSession.mockResolvedValue(sessionFor('MERCHANT'));
    expect(await whereDoesItSend()).toBe('/merchant/drops');

    getSession.mockResolvedValue(null);
    expect(await whereDoesItSend()).toBe('/login');

    expect(getSession).toHaveBeenCalledTimes(3);
  });
});
