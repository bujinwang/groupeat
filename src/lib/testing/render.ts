import type { ReactElement } from 'react';


/**
 * Render a server component to HTML, under Vitest, without a browser.
 *
 * ## Why this exists, and what it is not
 *
 * `docs/PROGRESS.md` gap 12 is the weakest claim in the file: most admin and organiser
 * screens were "verified by review and `tsc`" and nobody had ever rendered one. This repo
 * has no `.tsx` tests by design (`evidence: vitest.config.ts`'s `environment: 'node'`
 * plus an `include` glob that admits only `.test.ts` under `src`), and that decision is
 * right — a DOM harness for five pages would be a second runtime to keep alive, and
 * jsdom tests would still not exercise a `<form action={serverAction}>`.
 *
 * (That sentence used to spell the glob out. It cannot: `*` immediately followed by `/`
 * closes this comment, and the file then fails to compile with `Unexpected "*"` at the
 * line below. Found by running it, not by reading it.)
 *
 * What a DOM harness is *not* needed for is the thing most likely to be wrong: whether
 * the page's own branches produce the words they promise. A server component is an
 * async function that returns an element tree. Calling it and serialising that tree is a
 * real render — the branches execute, the queries run, `next/link` becomes `<a href>`,
 * and the copy is byte-for-byte what a browser would receive as the initial payload.
 *
 * First consumer: `src/app/(organiser)/commission/__tests__/page.test.ts`. The five admin
 * pages are still unrendered.
 *
 * ## The three mechanics, each probed before this file was written
 *
 * 1. **`renderToReadableStream`, not `renderToStaticMarkup`.** The legacy renderer
 *    cannot await an async component; it throws *"A component suspended while responding
 *    to synchronous input"*. The stream renderer awaits it. Probed.
 * 2. **`esbuild: { jsx: 'automatic' }` in `vitest.config.ts`.** `tsconfig` sets
 *    `jsx: "preserve"` for Next, which leaves esbuild on the *classic* transform — so a
 *    page file compiles to `React.createElement` with no `React` in scope and fails with
 *    `React is not defined`. The automatic transform is what Next itself uses. Probed
 *    both ways; the config comment records it.
 * 3. **No `.tsx` test file is needed.** This module takes an already-called element, so
 *    tests stay `.ts` and the `include` glob is untouched. A test builds props with
 *    `createElement` only when it wants markup; mostly it calls the page function, which
 *    is where the branch is.
 *
 * ## What it deliberately cannot check
 *
 * Client components are not hydrated, so an `onClick` is inert and a `useState` branch
 * renders its initial value only. `ShareLinkControl`, `ForceFailControl` and
 * `ParticipantRefundControl` are therefore still only partly covered: their *server*
 * halves and their initial markup are asserted, their interactions are not. Gap 12 keeps
 * the interaction list; this module removes "has never been rendered" from it and must
 * not be cited as removing the rest.
 *
 * ## Why `renderWithRouter` exists and `renderToHtml` still does the work
 *
 * Two of those controls call `useRouter()`, and `next/navigation`'s implementation throws
 * an invariant — *"expected app router to be mounted"* — when the context is absent.
 * Probed: importing `/admin/drops` and calling it under `renderToHtml` fails inside
 * `ForceFailControl` before a byte is written, so **any page that mounts a router-using
 * client component is unrenderable by the plain entry point.** That is `/admin/drops`
 * today and `/admin/drops/[id]` next.
 *
 * The fix is to supply the context Next itself supplies, not to fake the component: the
 * stub is a plain object satisfying `AppRouterInstance`, and the assertion is that the
 * *real* component read a router and rendered. A test can therefore see what a client
 * component prints on its initial state, which is more than "has never been rendered".
 *
 * It must not be sold as more than that. Nothing is hydrated, so `refresh()` is recorded
 * and never navigates; a `useState` branch still shows its initial value; and no `onClick`
 * fires. The context is a *rendering* prerequisite, not an interaction one.
 */

/** Concatenate a React 19 server-render stream into a string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    html += decoder.decode(value, { stream: true });
  }

  // Flush: a multi-byte character can straddle the last chunk.
  return html + decoder.decode();
}

/**
 * Serialise an element tree — the return value of a page or component function.
 *
 * `await`ed on the module so this file stays importable from a `.ts` test without
 * pulling `react-dom/server` into anything else.
 *
 * ## Why the element is wrapped in `<Suspense>`
 *
 * A client component calling `useActionState()` **throws when rendered bare** —
 * `Cannot read properties of null (reading 'useActionState')`, from React reading a context
 * that only exists inside a boundary. Probed on `/change-password`, which is a bare
 * `useActionState` and nothing else:
 *
 *     renderToHtml(ChangePasswordPage())                        // TypeError
 *     renderToHtml(<Suspense>{ChangePasswordPage()}</Suspense>)  // renders
 *
 * Next puts every page inside a boundary, so the boundary is part of the environment this
 * helper is imitating, not a workaround for a broken page. A page that supplies its own outer
 * `<Suspense>` is unaffected: nesting is legal.
 *
 * ## Why `onError` rethrows, and why that is not optional
 *
 * A boundary turns a **recoverable** error into markup: React emits
 * `<!--$!--><template data-msg="Switched to client rendering because the server rendering
 * errored: …">` and the stream completes normally. Adding the boundary therefore changed the
 * failure mode of every existing suite from "rejects" to "returns a near-empty string", and a
 * near-empty string makes `expect(html).not.toContain(…)` pass for the wrong reason. Found by
 * the 1815-test suite: `/admin/drops`' guard test asserted `rejects.toThrow(/expected app
 * router to be mounted/)` and started failing because nothing was thrown any more.
 *
 * So errors are collected through `onError` and rethrown once the stream is drained. The
 * element renders (the boundary is satisfied) and a page that fails still fails loudly.
 */
export async function renderToHtml(element: ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server');
  const { createElement, Suspense } = await import('react');

  const errors: unknown[] = [];
  const html = await drain(
    await renderToReadableStream(createElement(Suspense, { fallback: null }, element), {
      onError: (error) => {
        errors.push(error);
      },
    }),
  );

  const first = errors[0];
  if (first !== undefined) {
    throw first;
  }
  return html;
}

/** The slice of `AppRouterInstance` a render can observe. */
export type RouterStub = {
  /** Every `refresh()` call, in order. A render may legitimately record zero. */
  readonly refreshes: number;
};

/**
 * Render a page that mounts a client component calling `useRouter()`.
 *
 * Only difference from `renderToHtml` is the context provider, and the difference is
 * structural rather than cosmetic — probed: without it, `ForceFailControl` throws before
 * anything renders. See the module docblock for why the real context is supplied rather
 * than the component stubbed out.
 *
 * Takes the element the same way, so a caller writes
 * `renderWithRouter(await page({ searchParams }))` and nothing else changes.
 */
export async function renderWithRouter(
  element: ReactElement,
): Promise<{ html: string; router: RouterStub }> {
  const { createElement } = await import('react');
  const { AppRouterContext } = await import(
    // Deep import, and the alternative is worse. `next/navigation` exports the hooks,
    // not the context they read, so the only public path to supplying it is to render a
    // whole Next runtime. This module is pinned by `package.json` (`next@^15.5.0`,
    // resolved 15.5.28) and the type is `AppRouterInstance`, so a breaking change fails
    // `tsc` here rather than silently producing a stub that no longer matches.
    'next/dist/shared/lib/app-router-context.shared-runtime'
  );

  const state = { refreshes: 0 };
  const router = {
    back: () => undefined,
    forward: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
    refresh: () => {
      state.refreshes += 1;
    },
  };

  const html = await renderToHtml(
    createElement(AppRouterContext.Provider, { value: router }, element),
  );
  return { html, router: state };
}

/**
 * Render a page that calls `useSearchParams()`.
 *
 * `useSearchParams` reads `SearchParamsContext`, and **without it the hook suspends**: the
 * rendered output is the nearest `<Suspense>` fallback and nothing else. First consumer was
 * `/login`, whose whole tree is wrapped in a `<Suspense fallback={…Loading…}>` — so the first
 * version of that suite asserted the fields of a page it had never rendered, and failed with
 * `<!--$!--><template data-msg="Switched to client rendering">…` where the form should have
 * been. That is the failure mode this helper exists to remove; it is easy to mistake for a
 * broken page.
 *
 * The value is a `URLSearchParams`, which is what Next supplies, so `?.get('next')` behaves
 * exactly as it would in a browser. Pass the query string with or without the leading `?`.
 *
 * Not a substitute for `renderWithRouter` when a page also mounts a router-using component —
 * a page needing both needs a combined helper, and none exists because no page needs both
 * yet. Writing one speculatively would be an untested branch in the harness itself.
 */
export async function renderWithSearchParams(
  element: ReactElement,
  query = '',
): Promise<{ html: string; searchParams: URLSearchParams }> {
  const { createElement } = await import('react');
  const { SearchParamsContext } = await import(
    // Same trade-off as `renderWithRouter`: `next/navigation` exports the hook, not the
    // context, so supplying it means a deep import pinned by `package.json`.
    'next/dist/shared/lib/hooks-client-context.shared-runtime'
  );

  const searchParams = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const html = await renderToHtml(
    createElement(SearchParamsContext.Provider, { value: searchParams }, element),
  );
  return { html, searchParams };
}

/**
 * Collapse HTML to comparable text.
 *
 * Assertions are about *words*, and the words are interrupted by tags: a sentence split
 * across a `<Link>` would fail a `toContain` that the browser renders as one line. So
 * tags become a single space, entities are decoded for the handful Next emits, and runs
 * of whitespace collapse.
 *
 * ## Why comments go first, and why the space before punctuation is then removed
 *
 * React's server renderer emits `<!-- -->` between two adjacent text nodes to mark a
 * hydration boundary, and JSX produces exactly that all over these pages:
 * `read ({rawMonth}), so` is three children, so the wire carries
 * `read (<!-- -->nonsense<!-- -->), so`. A comment is not a place a browser shows a
 * space, so stripping tags blindly gives `read ( nonsense), so` and `5.00 %` where the
 * screen says `read (nonsense), so` and `5.00%`. The natural repair — asserting the
 * halves separately — would stop checking that they are one sentence. So comments are
 * removed before tags become spaces. Probed: without that order the output was
 * `"…we can read ( nonsense), so…"` and `"5.00 %"`.
 *
 * The same reasoning one step later: the page writes
 * `These figures are <strong>current as of right now</strong>, not a frozen invoice.`
 * and renders `right now, not` — the tag boundary contributes nothing. Turning the tag
 * into a space leaves `right now , not`, so the space before punctuation is dropped too.
 *
 * Entities: only the ones React escapes (`&amp; &lt; &gt; &quot; &#x27;`) plus the
 * non-breaking space, because the pages use `&nbsp;`-free copy on purpose. A broader
 * decoder would be a dependency for no case this repo has.
 */
export function textOf(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .trim();
}

/**
 * Every `href` in the markup, in document order, entity-decoded.
 *
 * The month selector is a set of `<Link>`s whose correctness is entirely in the query
 * string — `?month=2026-03` — and a test that asserts the rendered *label* cannot see a
 * link pointing at the wrong month. That is the drift `?month=a&month=b` exposed.
 *
 * **Decoded, because React escapes `&` in an attribute to `&amp;`.** Probed: an href of
 * `/api/x?month=2026-03&format=csv` serialises as
 * `href="/api/x?month=2026-03&amp;format=csv"`. Returning that raw would mean every
 * assertion about a two-parameter URL has to be written in escaped form — and the
 * natural repair, loosening the assertion to `toContain('format=csv')`, would stop
 * checking the month. Decode here so a test compares against the URL a browser would
 * request.
 */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    (match[1] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'"),
  );
}
