import { createElement } from 'react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { roleHome } from '@/lib/auth/jwt';
import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `src/app/(admin)/layout.tsx` — the admin shell, the SECOND gate behind middleware.
 *
 * ## The claim being falsified
 *
 * Every page in this app has a render test; the layouts that wrap them have none.
 * The admin layout is four lines of JSX around one call to `requireRoleOrRedirect`.
 * That call is the second gate — middleware is a *redirect convenience*, and the
 * layout re-checks the role so a matcher change cannot become an authorisation hole
 * (ARCHITECTURE-sprint1 §7.3, restated in the merchant layout's docblock). Neither
 * that sentence nor the call it describes has ever executed under a test. A layout
 * that rendered `{children}` first and gated afterwards would hand `<AppNav
 * role="ADMIN">` and admin markup to a signed-out caller, and no page suite would
 * notice: page tests call the page function directly and Next never mounts a layout
 * in this harness.
 *
 * ## What is real, and what is deliberately replaced
 *
 * `requireRoleOrRedirect`, `roleHome`, `AppNav` and `SignOutButton` are ALL real.
 * Only the input seam is replaced — `getSession` (the seam `authorize.ts` already
 * reads through) — plus `next/navigation`'s `redirect`, which throws a control-flow
 * error in a server component and must be caught to observe its ARGUMENT. The gate
 * itself is never mocked: mocking it would turn these tests into assertions about
 * their own fixture. `vi.mock('server-only')` is mandatory or importing
 * `authorize.ts` throws outside an RSC graph.
 *
 * ## What a render cannot prove
 *
 * It proves the gate short-circuits (no element is produced for a refused caller),
 * not that a browser receives an HTTP 307 — the redirect is observed as a thrown
 * error, not a response. It cannot prove the gate is the *only* gate: middleware's
 * matcher and the cookie are outside this file. It cannot prove `AppNav`'s links
 * work, only that the ADMIN link table was the one rendered. And no browser has
 * visited `/admin/*`: the Definition-of-Done browser step is unmet here.
 *
 * ## Why the literals are product decisions
 *
 * The role list `['ADMIN']` is proven behaviourally, by admitting all three roles:
 * exactly one of them may see the shell. A spy on the array argument would pin
 * syntax a harmless refactor (a named constant, a Set) would break; the admission
 * table pins the *contract*. The wrong-role destinations are asserted twice —
 * against the real `roleHome` AND against a literal — because the first is
 * satisfied by a layout that imports the shared function while the second is not,
 * and a retargeted `roleHome` is caught only by the literal. Those literal homes
 * are product decisions (`MERCHANT` lands on `/merchant/drops`, not `/items`,
 * since M3).
 */

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(public readonly destination: string) {
      super(`NEXT_REDIRECT:${destination}`);
      this.name = 'RedirectError';
    }
  }
  // A vi.fn so the ARGUMENT to redirect can be asserted, not just the destination
  // carried by the thrown error. The real redirect returns `never`; ours throws.
  const redirect = vi.fn((destination: string) => {
    throw new RedirectError(destination);
  });
  return { RedirectError, redirect };
});

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: h.redirect,
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

const AdminLayout = (await import('../layout')).default;

type Role = 'ADMIN' | 'MERCHANT' | 'ORGANISER';
type Claims = {
  userId: string;
  role: Role;
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
};

/** Literal restatement of `roleHome` — the rival half of each destination assertion. */
const HOME_LITERAL: Record<Role, string> = {
  ADMIN: '/admin/users',
  MERCHANT: '/merchant/drops',
  ORGANISER: '/organiser',
};

const WRONG_ROLES: readonly Role[] = ['MERCHANT', 'ORGANISER'];
const ALL_ROLES: readonly Role[] = ['ADMIN', 'MERCHANT', 'ORGANISER'];

function sessionFor(role: Role, mustChangePassword = false): Claims {
  return {
    userId: 'admin-user-1',
    role,
    mustChangePassword,
    absoluteExpiresAt: 4_000_000_000,
    expiresAt: 4_000_000_000,
  };
}

const CHILD = createElement('p', { 'data-probe': 'child' }, 'ADMIN-CHILD-MARKER');

type Result = { html?: string; destination?: string };

/**
 * Calls the layout and reports EITHER its rendered HTML OR the redirect it threw.
 * Reaching `renderToHtml` at all means the gate cleared — which is exactly what a
 * refused caller must never do. `html === undefined` is the no-leak assertion.
 */
async function callLayout(session: Claims | null): Promise<Result> {
  getSession.mockResolvedValue(session);
  let element: ReactElement;
  try {
    element = await AdminLayout({ children: CHILD });
  } catch (error) {
    if (error instanceof h.RedirectError) {
      return { destination: error.destination };
    }
    throw error;
  }
  return { html: await renderToHtml(element) };
}

beforeEach(() => {
  getSession.mockReset();
  h.redirect.mockClear();
});

describe('admission is exactly one role (the exact role list, proven by who gets in)', () => {
  it('renders <main>, the children and the ADMIN AppNav for an ADMIN', async () => {
    const { html, destination } = await callLayout(sessionFor('ADMIN'));
    expect(destination).toBeUndefined();
    expect(html).toBeDefined();
    expect(html).toContain('<main>');
    expect(textOf(html ?? '')).toContain('ADMIN-CHILD-MARKER');

    const hrefs = hrefsOf(html ?? '');
    // The ADMIN link table is the product surface; arrayContaining (not equality)
    // tolerates a harmless added link but dies if any of these are removed.
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/admin/drops',
        '/admin/ai-drafts',
        '/admin/commission',
        '/admin/users',
      ]),
    );
    // Links belonging to the OTHER two roles must be absent — this is what makes
    // "the matching AppNav" a claim about role="ADMIN" and not just "some nav".
    expect(hrefs).not.toContain('/merchant/pickup');
    expect(hrefs).not.toContain('/organiser');
    expect(hrefs).toContain('/'); // wordmark
    expect(textOf(html ?? '')).toContain('GroupEat');
    expect(textOf(html ?? '')).toContain('Sign out'); // SignOutButton mounted
  });

  it.each(WRONG_ROLES)(
    'redirects a %s to its own home, never the admin shell',
    async (role) => {
      const { html, destination } = await callLayout(sessionFor(role));
      // No element was produced: a wrong-role caller must not receive admin markup.
      expect(html).toBeUndefined();
      // Dual assertion — the real shared function AND the literal. The first catches
      // a layout that bypasses roleHome; the second catches roleHome being retargeted.
      expect(destination).toBe(roleHome(role));
      expect(destination).toBe(HOME_LITERAL[role]);
      expect(h.redirect).toHaveBeenCalledWith(roleHome(role));
    },
  );
});

describe('the gate order, and the no-leak invariant', () => {
  /**
   * The leak proof. A layout that rendered `{children}` first — or that dropped the
   * `await` on `requireRoleOrRedirect` — would return markup to a signed-out caller
   * and this assertion fails on `html`. Because `redirect` throws, the ONLY way no
   * element is produced is that the gate ran and was awaited BEFORE the JSX existed.
   */
  it('sends an anonymous caller to /login and produces no HTML at all', async () => {
    const { html, destination } = await callLayout(null);
    expect(html).toBeUndefined();
    expect(destination).toBe('/login');
    expect(h.redirect).toHaveBeenCalledWith('/login');
  });

  /**
   * `mustChangePassword` outranks the role in `requireRoleOrRedirect`. Exercised for
   * every role because a single-role test cannot see the ordering: a layout that only
   * gated ADMIN would pass one case and fail the other two. Wrong-role sessions land
   * here too, because the password flag is checked BEFORE the role — the layout must
   * not bypass that shared ordering with a role check of its own.
   */
  it.each(ALL_ROLES)(
    'sends a %s on a temporary password to /change-password, not its home',
    async (role) => {
      const { html, destination } = await callLayout(sessionFor(role, true));
      expect(html).toBeUndefined();
      expect(destination).toBe('/change-password');
      expect(destination).not.toBe(roleHome(role));
      expect(h.redirect).toHaveBeenCalledWith('/change-password');
    },
  );

  /**
   * A module-scope cache would serve the first caller's ADMIN session to everyone,
   * and every single-call test above would still pass. Two callers with different
   * sessions, plus a call count, is the only way a render can see "per request".
   */
  it('re-reads the session for each caller, not a module-scope cache', async () => {
    const first = await callLayout(sessionFor('ADMIN'));
    expect(first.html).toContain('<main>');

    const second = await callLayout(null);
    expect(second.html).toBeUndefined();
    expect(second.destination).toBe('/login');

    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
