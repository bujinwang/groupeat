import { createElement } from 'react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { roleHome } from '@/lib/auth/jwt';
import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `src/app/(merchant)/layout.tsx` — the merchant shell, and the docblock with two
 * claims that had never executed.
 *
 * ## The claim being falsified
 *
 * Every page in this app has a render test; the layouts that wrap them have none.
 * This layout's own docblock makes two claims. First: "middleware is a redirect
 * convenience, and a matcher change must not become an authorisation hole" — i.e.
 * `requireRoleOrRedirect` is the SECOND gate, and it is awaited before any HTML is
 * produced. Second: the impersonation banner "lives here rather than in each page"
 * so that "one line covers all eleven merchant pages … and the twelfth somebody
 * adds next month", because a per-page hint is "quietly absent from whatever comes
 * next". Neither claim has ever run under a test. A layout that rendered children
 * first would leak the MERCHANT nav and a `<main>` to a signed-out caller; a layout
 * that gated the wrong role would hand a MERCHANT cookie the organiser's shell or
 * vice versa. And the banner wiring — which session object is passed, and whether
 * all four props are forwarded — is invisible to every page suite, which calls the
 * page directly and never mounts a layout.
 *
 * ## What is real, and what is deliberately replaced
 *
 * REAL: `requireRoleOrRedirect`, `roleHome`, `AppNav`, `SignOutButton`, and the
 * `ImpersonationBanner` CLIENT COMPONENT. Only these seams are replaced:
 *
 *   - `getSession` (the seam `authorize.ts` reads through) and `next/navigation`'s
 *     `redirect`, which throws and must be caught to observe its ARGUMENT.
 *   - `impersonationBanner` in `@/lib/auth/impersonation` — a DB read boundary. The
 *     real function resolves two emails from two `User` rows; that behaviour is
 *     covered against real Postgres in `src/lib/auth/__tests__/impersonation.test.ts`
 *     (both directions). Here it is replaced with a controlled double so the test
 *     can (a) observe the exact session object passed and (b) supply distinctive
 *     prop values. The double MIRRORS the real decision (claim present -> banner,
 *     absent -> null) rather than inventing one.
 *   - The `ImpersonationBanner` component is wrapped with `vi.fn(real)`, NOT
 *     stubbed out: the real component renders (so its copy is asserted in the HTML)
 *     and the wrapper records its props. This is required because `expiresAt` is
 *     consumed ONLY inside the client component's `useEffect` and never appears in
 *     server-rendered HTML — the same shape as a payload a client component reads
 *     literally, where only a whole-object prop assertion can see an omission.
 *
 * `vi.mock('server-only')` is mandatory or importing `authorize.ts` throws outside
 * an RSC graph. `BannerProbe` is cleared with `mockClear()` (never `mockReset()`),
 * because its implementation IS the real component and must survive each test.
 *
 * ## What a render cannot prove
 *
 * The redirect is a thrown control-flow error, not an HTTP 307. The banner's
 * countdown, the "End session" click and the fetch are inert — `useEffect` does not
 * run server-side and nothing is hydrated. `expiresAt` reaching the client as the
 * right instant is asserted as a captured prop, not as a tick. No browser has
 * visited a `/merchant/*` route, so the Definition-of-Done browser step is unmet.
 *
 * ## Why the literals are product decisions
 *
 * The role list `['MERCHANT']` is pinned by admitting all three roles (exactly one
 * sees the shell), not by spying on an array a harmless refactor would reshape.
 * Wrong-role destinations are asserted against the real `roleHome` AND a literal.
 * The four banner prop values are the FR-904 contract: two distinct emails (whose
 * account is being viewed, who will be signed back in), an ISO instant serialised
 * on the server, and the audit id that names the row authorising the session.
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

const impersonationBanner = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/impersonation', () => ({ impersonationBanner }));

const BannerProbe = vi.hoisted(() => vi.fn());
vi.mock('@/components/merchant/ImpersonationBanner', async (importOriginal) => {
  const actual = await importOriginal<{
    ImpersonationBanner: (props: unknown) => unknown;
  }>();
  // Wrap, do not stub: React renders THIS function, so the real component's hooks
  // run under React's dispatcher and its markup reaches the HTML, while vi.fn
  // records the props object for the otherwise-invisible expiresAt assertion.
  BannerProbe.mockImplementation(actual.ImpersonationBanner);
  return { ...actual, ImpersonationBanner: BannerProbe };
});

const MerchantLayout = (await import('../layout')).default;

type Role = 'ADMIN' | 'MERCHANT' | 'ORGANISER';
type ImpersonationClaim = { actorUserId: string; auditId: string; expiresAt: number };
type Claims = {
  userId: string;
  role: Role;
  mustChangePassword: boolean;
  absoluteExpiresAt: number;
  expiresAt: number;
  impersonation?: ImpersonationClaim;
};

const HOME_LITERAL: Record<Role, string> = {
  ADMIN: '/admin/users',
  MERCHANT: '/merchant/drops',
  ORGANISER: '/organiser',
};

const WRONG_ROLES: readonly Role[] = ['ADMIN', 'ORGANISER'];
const ALL_ROLES: readonly Role[] = ['ADMIN', 'MERCHANT', 'ORGANISER'];

const VIEWING_EMAIL = 'owner@northbowl.example';
const ACTOR_EMAIL = 'admin@groupeat.example';
const AUDIT_ID = 'audit_layout_probe_0001';
const EXPIRY_SECONDS = 1_800_000_000;

function merchantClaims(): Claims {
  return {
    userId: 'merchant-owner-1',
    role: 'MERCHANT',
    mustChangePassword: false,
    absoluteExpiresAt: 4_000_000_000,
    expiresAt: 4_000_000_000,
  };
}
function impersonatingClaims(): Claims {
  return {
    ...merchantClaims(),
    impersonation: {
      actorUserId: 'admin-actor-1',
      auditId: AUDIT_ID,
      expiresAt: EXPIRY_SECONDS,
    },
  };
}

/** Mirrors the real impersonationBanner's DECISION; substitutes fixed prop values
 * for the two DB reads so the layout's forwarding (not the DB) is under test. */
function bannerFrom(session: Claims) {
  const claim = session.impersonation!;
  return {
    viewingEmail: VIEWING_EMAIL,
    actorEmail: ACTOR_EMAIL,
    expiresAt: new Date(claim.expiresAt * 1000),
    auditId: claim.auditId,
  };
}

/** Each getSession() call yields a FRESH object, recorded in `issued`. A layout
 * that re-reads the session (a stale second read) is thereby detectable. */
const issued: (Claims | null)[] = [];
function setSession(template: Claims | null): void {
  getSession.mockImplementation(async () => {
    const session = template === null ? null : { ...template };
    issued.push(session);
    return session;
  });
}

const CHILD = createElement('p', { 'data-probe': 'child' }, 'MERCHANT-CHILD-MARKER');

type Result = { html?: string; destination?: string };

/** Returns EITHER rendered HTML OR the redirect destination. `html === undefined`
 * for a refused caller is the no-leak assertion: the gate was awaited before JSX. */
async function callLayout(template: Claims | null): Promise<Result> {
  setSession(template);
  let element: ReactElement;
  try {
    element = await MerchantLayout({ children: CHILD });
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
  issued.length = 0;
  impersonationBanner.mockReset();
  impersonationBanner.mockImplementation(async (session: Claims) =>
    session.impersonation ? bannerFrom(session) : null,
  );
  // mockClear, NOT mockReset: BannerProbe's implementation is the real component.
  BannerProbe.mockClear();
});

describe('admission is exactly one role', () => {
  it('renders <main>, children and the MERCHANT AppNav for a plain MERCHANT', async () => {
    const { html, destination } = await callLayout(merchantClaims());
    expect(destination).toBeUndefined();
    expect(html).toBeDefined();
    expect(html).toContain('<main>');
    expect(textOf(html ?? '')).toContain('MERCHANT-CHILD-MARKER');

    const hrefs = hrefsOf(html ?? '');
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/merchant/drops',
        '/merchant/pickup',
        '/merchant/items',
        '/merchant/reports',
        '/merchant/payouts',
        '/merchant/settings',
      ]),
    );
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/organiser');
    expect(hrefs).toContain('/');
    expect(textOf(html ?? '')).toContain('GroupEat');
    expect(textOf(html ?? '')).toContain('Sign out');
  });

  it.each(WRONG_ROLES)(
    'redirects a %s to its own home, never the merchant shell',
    async (role) => {
      const { html, destination } = await callLayout(sessionFor(role));
      expect(html).toBeUndefined();
      // Dual assertion: the real shared function AND the literal.
      expect(destination).toBe(roleHome(role));
      expect(destination).toBe(HOME_LITERAL[role]);
      expect(h.redirect).toHaveBeenCalledWith(roleHome(role));
      // The gate refused before returning, so the banner boundary was never reached.
      expect(impersonationBanner).not.toHaveBeenCalled();
      expect(BannerProbe).not.toHaveBeenCalled();
    },
  );
});

function sessionFor(role: Role, mustChangePassword = false): Claims {
  return {
    ...merchantClaims(),
    role,
    mustChangePassword,
  };
}

describe('the gate order, and the no-leak invariant', () => {
  it('sends an anonymous caller to /login and produces no HTML at all', async () => {
    const { html, destination } = await callLayout(null);
    expect(html).toBeUndefined();
    expect(destination).toBe('/login');
    expect(h.redirect).toHaveBeenCalledWith('/login');
    // A children-first or un-awaited gate would reach this boundary and leak markup.
    expect(impersonationBanner).not.toHaveBeenCalled();
    expect(BannerProbe).not.toHaveBeenCalled();
  });

  it.each(ALL_ROLES)(
    'sends a %s on a temporary password to /change-password, not its home',
    async (role) => {
      const { html, destination } = await callLayout(sessionFor(role, true));
      expect(html).toBeUndefined();
      expect(destination).toBe('/change-password');
      expect(destination).not.toBe(roleHome(role));
      expect(h.redirect).toHaveBeenCalledWith('/change-password');
      expect(impersonationBanner).not.toHaveBeenCalled();
      expect(BannerProbe).not.toHaveBeenCalled();
    },
  );

  it('re-reads the session for each caller, not a module-scope cache', async () => {
    const first = await callLayout(merchantClaims());
    expect(first.html).toContain('<main>');

    const second = await callLayout(null);
    expect(second.html).toBeUndefined();
    expect(second.destination).toBe('/login');

    expect(getSession).toHaveBeenCalledTimes(2);
  });
});

describe('FR-904 · the banner lives in the layout, both directions of the fixture', () => {
  /**
   * DIRECTION ONE: impersonating -> banner present, all four props forwarded
   * exactly. Three props are visible in the HTML; `expiresAt` is not (client
   * useEffect only), so the props are captured as a whole object — key set and
   * values — because a value comparison cannot see a prop that was omitted.
   */
  it('mounts the banner with all four props forwarded exactly when impersonating', async () => {
    const { html } = await callLayout(impersonatingClaims());
    expect(html).toContain('<main>'); // a real render, so the negatives elsewhere are meaningful
    expect(html).toContain('role="status"');
    const text = textOf(html ?? '');
    expect(text).toContain('Viewing');
    expect(text).toContain(VIEWING_EMAIL);
    expect(text).toContain('as an admin');
    expect(text).toContain(ACTOR_EMAIL);
    expect(text).toContain(`audit ${AUDIT_ID}`);

    expect(BannerProbe).toHaveBeenCalledTimes(1);
    expect(BannerProbe.mock.calls[0]?.[0]).toEqual({
      viewingEmail: VIEWING_EMAIL,
      actorEmail: ACTOR_EMAIL,
      expiresAt: new Date(EXPIRY_SECONDS * 1000).toISOString(),
      auditId: AUDIT_ID,
    });
  });

  /**
   * DIRECTION TWO: ordinary session -> banner absent. The shell still renders
   * (asserted), so `not.toContain` is about a rendered page, not a blank one —
   * the failure mode a Suspense boundary makes vacuous. The layout still consults
   * the banner boundary unconditionally; the null decision belongs to
   * impersonationBanner, not to a layout-level guess about the session.
   */
  it('mounts no banner for an ordinary MERCHANT session', async () => {
    const { html } = await callLayout(merchantClaims());
    expect(html).toContain('<main>');
    expect(textOf(html ?? '')).toContain('GroupEat');
    expect(textOf(html ?? '')).toContain('MERCHANT-CHILD-MARKER');
    expect(html).not.toContain('role="status"');
    expect(textOf(html ?? '')).not.toContain('as an admin');
    expect(textOf(html ?? '')).not.toContain(`audit ${AUDIT_ID}`);
    expect(BannerProbe).not.toHaveBeenCalled();

    expect(impersonationBanner).toHaveBeenCalledTimes(1);
    expect(impersonationBanner.mock.calls[0]?.[0]).toBe(issued[0]);
  });

  /**
   * The session passed to `impersonationBanner` is THE SAME OBJECT the gate
   * returned — asserted by identity, not merely deep equality. `setSession` yields
   * a fresh object per call, so a layout that re-read the session (a stale second
   * `getSession()`), reconstructed one, or reached for a module-scope cache would
   * fail both `issued.length === 1` and the `toBe` identity. A layout that passed a
   * clone would satisfy deep equality but not this.
   */
  it('passes the gate\'s own session object to impersonationBanner — not a stale one', async () => {
    const template = impersonatingClaims();
    const { html } = await callLayout(template);
    expect(html).toContain('role="status"'); // the session really was impersonating

    expect(impersonationBanner).toHaveBeenCalledTimes(1);
    expect(issued).toHaveLength(1);
    expect(impersonationBanner).toHaveBeenCalledWith(template); // deep equality
    expect(impersonationBanner.mock.calls[0]?.[0]).toBe(issued[0]); // identity
  });
});
