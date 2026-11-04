import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buttonClass } from '@/components/ui/Button';
import { hrefsOf, renderToHtml, textOf } from '@/lib/testing/render';

/**
 * The three other runtime files V8 coverage found with **zero executed
 * statements**, beside `opengraph-image.tsx`.
 *
 * `not-found.tsx` and `forbidden.tsx` are S1-008: a 404 and a 403 that say what
 * happened and offer the one useful action, in the same voice, with no stack
 * trace and no error code. `instrumentation.ts` is S1-007: importing
 * `lib/config` at boot validates the environment, so a missing `JWT_SECRET`
 * stops the process with a readable message instead of surfacing as a confusing
 * 500 on the first login.
 *
 * Neither had ever been imported by a test. They are Next.js special files —
 * the router reaches them by convention, not through a page import — which is
 * exactly why a caller-based coverage scan of `page.tsx` files cannot find
 * them, and why V8 execution counts are the only honest way to discover them.
 *
 * ## What a render proves, and what it does not
 *
 * It proves the words, the single link and its destination, and the absence of
 * diagnostics. It does NOT prove Next serves these files for a 404/403, nor that
 * a real crawler or screen reader sees them: that is framework routing, outside
 * these components' element trees. No browser has visited either route, so the
 * Definition-of-Done browser step remains unmet.
 *
 * For `instrumentation`, the assertion is **behavioural rather than a spy on an
 * import**: with a deliberately invalid `JWT_SECRET`, `register()` on the node
 * runtime must throw the readable boot error, and on the Edge runtime must not —
 * because the edge branch returns before the dynamic import. A mock that merely
 * counted `import()` calls would pass for a hook that imported config and threw
 * it away.
 */

const NotFound = (await import('../not-found')).default;
const Forbidden = (await import('../forbidden')).default;

describe('S1-008 · the 404 page', () => {
  it('says what happened, then offers the one useful action', async () => {
    const html = await renderToHtml(NotFound());
    const text = textOf(html);

    expect(html).toContain('<main');
    expect(html).toContain('<h1');
    expect(text).toContain("We couldn't find that page.");
    expect(text).toContain('The link may be old, or the dish may have been archived.');
    expect(text).toContain('Go back');
    expect(hrefsOf(html)).toContain('/');
    // "the one useful action" is a count, not a presence check: a second link
    // would turn an error page into a navigation menu.
    expect(hrefsOf(html)).toEqual(['/']);
  });

  it('does not leak a status code, an error name or a stack trace', async () => {
    /**
     * The docblock's promise: "No stack trace, no error code." A 404 page that
     * printed `Error: ENOENT` or a Prisma message would be a disclosure on a
     * page any anonymous visitor can reach.
     */
    const text = textOf(await renderToHtml(NotFound()));
    expect(text).not.toContain('404');
    expect(text).not.toMatch(/stack|trace|Error:|prisma|ENOENT/i);
  });
});

describe('S1-008 · the 403 page', () => {
  it('explains that the account is signed in but belongs elsewhere', async () => {
    const html = await renderToHtml(Forbidden());
    const text = textOf(html);

    expect(html).toContain('<main');
    expect(text).toContain("You don't have access to that page.");
    expect(text).toContain(
      'Your account is signed in, but this page belongs to a different kind of account.',
    );
    expect(text).toContain('Go to my home page');
    expect(hrefsOf(html)).toEqual(['/']);
  });

  it('uses the shared primary button class, not a second copy of it', async () => {
    /**
     * Asserted against the real `buttonClass()` AND a literal. The first proves
     * the page does not hand-roll its button; the second proves `buttonClass`
     * itself was not changed to something wrong in the same commit — the same
     * rival-assertion pair the count route uses for `headlineFor`.
     */
    const html = await renderToHtml(Forbidden());
    const expected = buttonClass('primary', 'mt-5');

    expect(html).toContain(`class="${expected}"`);
    expect(expected).toContain('min-h-11');
    expect(expected).toContain('mt-5');
    // A 403 page must not offer a destructive-looking action.
    expect(expected).not.toContain('danger');
  });

  it('does not leak a status code or a stack trace', async () => {
    const text = textOf(await renderToHtml(Forbidden()));
    expect(text).not.toContain('403');
    expect(text).not.toMatch(/stack|trace|Error:|prisma|ENOENT/i);
  });

  it('speaks in the same voice as the 404: main, one heading, one paragraph, one link', async () => {
    /**
     * "Same voice" is structural here, and asserting both pages at once is what
     * makes it load-bearing — one page alone cannot disagree with itself.
     */
    for (const html of [await renderToHtml(NotFound()), await renderToHtml(Forbidden())]) {
      expect((html.match(/<main\b/g) ?? []).length).toBe(1);
      expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
      expect((html.match(/<p\b/g) ?? []).length).toBe(1);
      expect((html.match(/<a\b/g) ?? []).length).toBe(1);
      expect(hrefsOf(html)).toEqual(['/']);
    }
  });
});

describe('S1-007 · instrumentation validates the environment at boot', () => {
  const saved = {
    NEXT_RUNTIME: process.env.NEXT_RUNTIME,
    JWT_SECRET: process.env.JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it('refuses to boot with a readable message that names the key, never its value', async () => {
    /**
     * `lib/config` throws at MODULE LOAD, and `register()` imports it lazily. A
     * hook that swallowed the error, or imported config at the top of the file,
     * would fail this either by not throwing or by throwing before `register()`
     * was called.
     *
     * The message must name the offending key (`JWT_SECRET`) and must NOT echo
     * the value we set — that absence is exactly the leak the S1-007 docblock
     * forbids, and it is the part a developer could reintroduce by changing the
     * error format. `register()` is invoked once; the same rejected promise is
     * awaited three times so each assertion observes the identical error.
     */
    delete process.env.NEXT_RUNTIME;
    process.env.JWT_SECRET = 'short-secret';
    process.env.DATABASE_URL ??= 'postgresql://localhost:5432/groupeat_dev';

    const { register } = await import('../../instrumentation');
    // Capture the rejection reason once. Re-`await`-ing the same rejected promise
    // through three `expect(...).rejects` calls trips a vitest internal; reading
    // the Error directly is also the more honest assertion.
    const error = await register().catch((reason) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cannot start|incomplete/i);
    expect((error as Error).message).toMatch(/JWT_SECRET/);
    // The message names the offending key but must NOT echo the value we set —
    // that absence is the leak the S1-007 docblock forbids, and the part a
    // developer could reintroduce by changing the error format.
    expect((error as Error).message).not.toContain('short-secret');
  });

  it('skips validation entirely on the Edge runtime', async () => {
    /**
     * Middleware runs on Edge, which has its own env handling. With the SAME
     * invalid secret that threw above, `register()` must resolve without error —
     * proving the branch is real and not merely a comment.
     */
    process.env.NEXT_RUNTIME = 'edge';
    process.env.JWT_SECRET = 'too-short';
    process.env.DATABASE_URL ??= 'postgresql://localhost:5432/groupeat_dev';
    vi.resetModules();

    const { register } = await import('../../instrumentation');
    await expect(register()).resolves.toBeUndefined();
  });

  it('loads config on the node runtime when the environment is valid', async () => {
    vi.resetModules();
    delete process.env.NEXT_RUNTIME;
    process.env.JWT_SECRET = 'a-valid-secret-that-is-at-least-32-characters-long';
    process.env.DATABASE_URL ??= 'postgresql://localhost:5432/groupeat_dev';

    const { register } = await import('../../instrumentation');
    await expect(register()).resolves.toBeUndefined();
  });
});
