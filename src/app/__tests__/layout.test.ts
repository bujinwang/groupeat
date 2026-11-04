import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `src/app/layout.tsx` — the root shell, and the least defended file in the app.
 *
 * ## The claim being falsified
 *
 * Every page in this app has a render test; the four layouts that wrap all of them
 * have none. The three role shells at least have a sentence in a docblock about what
 * they gate. This one has nothing: a `<html>` element, a body, a width, and two
 * exported objects that Next turns into `<head>`. "The app renders inside a 420px
 * phone shell with a mobile viewport" has been true by inspection and by never
 * executing — the same status as every unverified sentence in PROGRESS.md. Dropping
 * `viewport` would break mobile rendering on *every* page while the whole suite
 * stayed green, because no test imported this module until now.
 *
 * ## What a render can and cannot prove here
 *
 * It CAN prove `<html lang="en">`, the body's class list, the `max-w-[420px]`
 * container, and that children actually land inside that container. It CANNOT prove
 * that `metadata` reaches a `<title>` or that `viewport.width` reaches a `<meta>`
 * tag: Next injects those at the framework level, *outside* the element tree this
 * component returns, so a serialised render of `RootLayout` never contains them.
 * The exported objects are therefore asserted as objects — the only reachable form
 * of that claim — and the wiring between them and the real `<head>` is named below
 * as unproven rather than implied.
 *
 * Nor does a render apply CSS: `globals.css` is stubbed by the runner and no browser
 * has laid out a pixel. The class strings are pinned as the markup contract, not as
 * a claim that Tailwind resolved them.
 *
 * ## Why the literals are product decisions, not implementation details
 *
 *   - `lang="en"` is what a screen reader, the spellchecker and the browser's
 *     translate prompt read to decide what language a page is in. V1 is English only;
 *     an unlabelled document is an accessibility regression on all 26 pages at once.
 *   - `viewport.width = 'device-width'` and `initialScale = 1` are the mobile
 *     contract. Without `device-width` a phone assumes a ~980px desktop viewport and
 *     scales the whole 420px design down to a smudge; without `initialScale` the zoom
 *     is not pinned. This is the single most consequential unasserted line in the app.
 *   - `themeColor = '#0f7b4f'` is the brand green tinted into mobile browser chrome.
 *   - `title = 'GroupEat'` and the description are the browser tab and the SEO
 *     meta description — the app's one-line value proposition to a search result.
 *   - The body classes are the app-wide design tokens applied exactly once:
 *     `min-h-dvh` (dynamic viewport height, not `vh`, so mobile browser chrome does
 *     not clip the shell), `bg-surface-muted` / `text-ink` (the surface/contrast
 *     pair), `antialiased` (font smoothing).
 *   - `max-w-[420px]` is the mobile-first shell width (NFR-02: it must work at
 *     360px). It caps the reading measure on a desktop; removing it makes every
 *     screen full-bleed on a wide monitor.
 *
 * Assertions are on class *tokens* (present on the correct element), not on an exact
 * byte-for-byte attribute string: adding a harmless fifth class must not break them,
 * while removing or renaming any of these four must.
 */

const RootLayout = (await import('../layout')).default;
const layoutModule = await import('../layout');

/** The `class` attribute of the first `<tag ...>` in the HTML, or ''. */
function classAttrOf(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*\\bclass="([^"]*)"`));
  return match?.[1] ?? '';
}

const CHILD = createElement('p', { 'data-probe': 'child' }, 'ROOT-CHILD-MARKER');

async function renderShell(): Promise<string> {
  return renderToHtml(await RootLayout({ children: CHILD }));
}

describe('the exported head contract, as objects', () => {
  /**
   * Whole-object equality pins both the values AND the key set. For these two
   * exports a key added or removed IS a change to the document `<head>`, i.e. a
   * product change, not a harmless refactor — so `toEqual` (not `toMatchObject`)
   * is the honest strength. These are the values Next consumes to build `<title>`
   * and `<meta name="viewport">`; a render of this component never sees them.
   */
  it('exports exactly the GroupEat metadata', () => {
    expect(layoutModule.metadata).toEqual({
      title: 'GroupEat',
      description: 'Batch orders for kitchens, priced so the merchant still makes money.',
    });
  });

  it('exports exactly the mobile viewport', () => {
    expect(layoutModule.viewport).toEqual({
      width: 'device-width',
      initialScale: 1,
      themeColor: '#0f7b4f',
    });
  });
});

describe('the rendered shell, which a browser actually receives', () => {
  it('returns an html document labelled lang="en"', async () => {
    const html = await renderShell();
    expect(html).toContain('<html lang="en">');
  });

  it('puts the four design tokens on the body class list', async () => {
    const html = await renderShell();
    const bodyClasses = classAttrOf(html, 'body').split(/\s+/).filter(Boolean);
    // Asserted on the BODY specifically, not document-wide: the same words on a
    // nested div would be a different (and empty) claim. A token renamed or
    // dropped fails here even though the rest of the HTML is unchanged.
    expect(bodyClasses).toEqual(
      expect.arrayContaining([
        'min-h-dvh',
        'bg-surface-muted',
        'text-ink',
        'antialiased',
      ]),
    );
  });

  it('wraps children in the 420px mobile-first container', async () => {
    const html = await renderShell();
    const container = html.match(/<div\b[^>]*\bclass="([^"]*)"[^>]*>/g) ?? [];
    const shell = container.find((tag) => tag.includes('max-w-[420px]'));
    // The literal 420px is the product decision (NFR-02's phone-first shell);
    // this assertion dies if it is widened, renamed or removed.
    expect(shell).toBeDefined();
    expect(shell).toContain('mx-auto');
    expect(shell).toContain('w-full');
  });

  it('renders the children inside the shell, not an empty document', async () => {
    const html = await renderShell();
    // A root layout that returned the container but dropped `{children}` would
    // still pass the three assertions above and render an empty app. This is the
    // only assertion that can see the child actually made it onto the wire.
    expect(textOf(html)).toContain('ROOT-CHILD-MARKER');
  });

  it('places the child inside the 420px container, not outside it', async () => {
    const html = await renderShell();
    const shellOpen = html.search(/<div\b[^>]*max-w-\[420px\][^>]*>/);
    const shellClose = html.indexOf('</div>', shellOpen);
    const child = html.indexOf('ROOT-CHILD-MARKER');
    expect(shellOpen).toBeGreaterThan(-1);
    expect(child).toBeGreaterThan(shellOpen);
    expect(child).toBeLessThan(shellClose);
  });
});
