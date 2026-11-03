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
 */
export async function renderToHtml(element: ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server');
  return drain(await renderToReadableStream(element));
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
