import { createElement } from 'react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { roleHome } from '@/lib/auth/jwt';
import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `src/app/(organiser)/layout.tsx` — the organiser shell, the SECOND gate behind
 * middleware.
 *
 * ## The claim being falsified
 *
 * Every page has a render test; the layouts that wrap them have none. The organiser
 * layout is the smallest of the three shells — one `requireRoleOrRedirect` call and
 * two elements — and it is the gate that stands between a MERCHANT cookie and the
 * organiser's commission/share-link screens. `requireRoleOrRedirect` is the second
 * gate behind middleware: middleware routes, this layout authorises. That a matcher
 * change must not become an authorisation hole is written in the merchant layout's
 * docblock; it is a claim about all three shells and none of the three has ever
 * executed under test. The organiser page test even says so outright ("the
 * profile-less account's layout is not part of the render ... it never executes
 * here") — every page suite in this repo stops one layer short of the layout.
 *
 * ## What is real, and what is deliberately replaced
 *
 * `requireRoleOrRedirect`, `roleHome`, `AppNav` and `SignOutButton` are real. Only
 * `getSession` (the seam the gate reads through) and `next/navigation`'s `redirect`
 * are replaced; the gate is never mocked, because a mocked gate makes a test assert
 * its own fixture. `vi.mock('server-only')` is mandatory for importing
 * `authorize.ts` outside an RSC graph.
 *
 * ## What a render cannot prove
 *
 * The redirect is a thrown control-flow error, not an HTTP 307. This proves the
 * layout short-circuits before producing an element; it does not prove middleware's
 * matcher agrees, that the cookie is what `getSession` reports, or that the ORGANISER
 * links resolve to working screens. No browser has visited `/organiser`. The
 * "matching AppNav" assertion is about which link table rendered, not about those
 * links' destinations working.
 *
 * ## Why the literals are product decisions
 *
 * The role list `['ORGANISER']` is pinned by admitting all three roles (exactly one
 * may see the shell), not by spying on an array a harmless refactor would reshape.
 * Wrong-role destinations are asserted against the real `roleHome` AND a literal:
 * the first catches a layout bypassing the shared function, the second catches
 * `roleHome` being retargeted. `HOME` (Home before Commission) is FR-802's two-tap
 * ordering — a product decision recorded in `AppNav`, so `/organiser` is first.
 */

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(public readonly destination: string) {
      super(`NEXT_REDIRECT:${destination}`);
      this.name = 'RedirectError';
    }
  }
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

const OrganiserLayout = (await import('../layout')).default;

type Role = 'ADMIN' | 'MERCHANT' | 'ORGANISER';
type Claims = {
  userId: string;
  role: Role;
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
};

const HOME_LITERAL: Record<Role, string> = {
  ADMIN: '/admin/users',
  MERCHANT: '/merchant/drops',
  ORGANISER: '/organiser',
};

const WRONG_ROLES: readonly Role[] = ['ADMIN', 'MERCHANT'];
const ALL_ROLES: readonly Role[] = ['ADMIN', 'MERCHANT', 'ORGANISER'];

function sessionFor(role: Role, mustChangePassword = false): Claims {
  return {
    userId: 'organiser-user-1',
    role,
    mustChangePassword,
    absoluteExpiresAt: 4_000_000_000,
    expiresAt: 4_000_000_000,
  };
}

const CHILD = createElement('p', { 'data-probe': 'child' }, 'ORGANISER-CHILD-MARKER');

type Result = { html?: string; destination?: string };

/** Returns EITHER rendered HTML OR the redirect destination. `html === undefined`
 * for a refused caller is the no-leak assertion: the gate was awaited before JSX. */
async function callLayout(session: Claims | null): Promise<Result> {
  getSession.mockResolvedValue(session);
  let element: ReactElement;
  try {
    element = await OrganiserLayout({ children: CHILD });
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

describe('admission is exactly one role', () => {
  it('renders <main>, the children and the ORGANISER AppNav for an ORGANISER', async () => {
    const { html, destination } = await callLayout(sessionFor('ORGANISER'));
    expect(destination).toBeUndefined();
    expect(html).toBeDefined();
    expect(html).toContain('<main>');
    expect(textOf(html ?? '')).toContain('ORGANISER-CHILD-MARKER');

    const hrefs = hrefsOf(html ?? '');
    expect(hrefs).toEqual(expect.arrayContaining(['/organiser', '/commission']));
    // ADMIN and MERCHANT links must be absent — the claim is about role="ORGANISER".
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/merchant/pickup');
    expect(hrefs).toContain('/');
    expect(textOf(html ?? '')).toContain('GroupEat');
    expect(textOf(html ?? '')).toContain('Sign out');
  });

  it.each(WRONG_ROLES)(
    'redirects a %s to its own home, never the organiser shell',
    async (role) => {
      const { html, destination } = await callLayout(sessionFor(role));
      expect(html).toBeUndefined();
      expect(destination).toBe(roleHome(role));
      expect(destination).toBe(HOME_LITERAL[role]);
      expect(h.redirect).toHaveBeenCalledWith(roleHome(role));
    },
  );
});

describe('the gate order, and the no-leak invariant', () => {
  it('sends an anonymous caller to /login and produces no HTML at all', async () => {
    const { html, destination } = await callLayout(null);
    expect(html).toBeUndefined();
    expect(destination).toBe('/login');
    expect(h.redirect).toHaveBeenCalledWith('/login');
  });

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

  it('re-reads the session for each caller, not a module-scope cache', async () => {
    const first = await callLayout(sessionFor('ORGANISER'));
    expect(first.html).toContain('<main>');

    const second = await callLayout(null);
    expect(second.html).toBeUndefined();
    expect(second.destination).toBe('/login');

    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
