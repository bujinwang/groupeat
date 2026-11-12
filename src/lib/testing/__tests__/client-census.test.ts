import { describe, expect, it } from 'vitest';

import { computeClientCensus } from '@/lib/testing/client-census';

/**
 * Guards on the client-component census, and on the three comments that got it wrong.
 *
 * ## What this file is defending
 *
 * The claim *"a client component with hooks cannot be tested here"* appeared in three
 * places in three wordings and was false in all three. Rewriting the sentences is not
 * enough — the same reasoning would reproduce them. So this asserts the **relationships**
 * a reader of those comments relies on, at the population level:
 *
 *   - every `'use client'` component in the tree is rendered by some test, directly or
 *     through a page a test renders;
 *   - "render" and "interact" are different things, and the census counts only the first;
 *   - a client file's high statement coverage can come from a pure helper next to the
 *     component, which is why coverage alone never proved the component ran.
 *
 * The last point is the one that hid `FloorEscapeHatch`: `MoneyInput` sat at 82 % on the
 * strength of `parseMoneyToCents`, and `LiveProgress` at 70 % on `mergeLiveCounts`. The
 * component half of both was a different story.
 */
describe('client-component census — the population and its rendering', () => {
  const census = computeClientCensus();

  it('counts a plausible population at all (guards against a broken walk)', () => {
    // A floor, not a target: it fails loudly if the walk breaks, without pinning a count
    // that legitimately grows with every component added.
    expect(census.total).toBeGreaterThan(20);
    expect(census.files.length).toBe(census.total);
  });

  it('every client component is rendered by some test, directly or via a page', () => {
    // This is the assertion that would have failed for months, and the one that makes the
    // corrected comments true rather than merely reworded. If someone adds a `'use client'`
    // component with no test and no tested page, this fails and names it.
    expect(census.unrendered).toEqual([]);
  });

  it('most are rendered directly, and the rest through a page — not none', () => {
    // Both paths exist and both are non-trivial. If `renderedViaParent` collapsed to zero
    // the census would have stopped following the import chain; if `renderedDirectly`
    // collapsed, the suite would have stopped naming components at all.
    expect(census.renderedDirectly.length).toBeGreaterThan(0);
    expect(census.renderedViaParent.length).toBeGreaterThan(0);
    expect(census.renderedDirectly.length + census.renderedViaParent.length).toBe(census.total);
  });

  it('the two populations are disjoint', () => {
    // A component cannot be both "named by a test" and "reached only through a parent";
    // overlap would mean the classification is double-counting and the total is inflated.
    const overlap = census.renderedDirectly.filter((file) =>
      census.renderedViaParent.includes(file),
    );
    expect(overlap).toEqual([]);
  });

  it('identifies the client files whose coverage comes from a pure helper', () => {
    // These are the files where a high statement percentage says nothing about the
    // component. Naming them is what stops the next census from reading 82 % and
    // concluding the JSX ran. `MoneyInput` (parseMoneyToCents) and `LiveProgress`
    // (mergeLiveCounts) are the two; if a third appears, the comment in `render.ts`
    // about "the tested half" needs to know.
    expect(census.withPureHelper).toContain('src/components/ui/MoneyInput.tsx');
    expect(census.withPureHelper).toContain('src/components/organiser/LiveProgress.tsx');
    expect(census.withPureHelper.length).toBeLessThan(census.total);
  });
});

describe('client-component census — the claims it exists to keep honest', () => {
  it('"rendered" does not mean "interacted with": no DOM library is installed', async () => {
    // The distinction that replaces the false claim. A render asserts markup; a click
    // needs a DOM. Nothing in `devDependencies` provides one, so the boundary is real —
    // it is just drawn in a different place than "hooks need a browser".
    const pkg = (await import('../../../../package.json')) as {
      default: { devDependencies: Record<string, string> };
    };
    const deps = Object.keys(pkg.default.devDependencies);

    expect(deps).not.toContain('jsdom');
    expect(deps).not.toContain('happy-dom');
    expect(deps).not.toContain('linkedom');
    expect(deps).not.toContain('@testing-library/react');
  });

  it('a useState component renders to markup with no document present', async () => {
    // The mechanism, probed rather than argued: hooks need a React dispatcher, and
    // `react-dom/server` supplies one. If this ever fails, the corrected comments are
    // wrong again and this file is where that shows up.
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { SignOutButton } = await import('@/components/SignOutButton');

    const html = renderToStaticMarkup(createElement(SignOutButton));

    expect(html.length).toBeGreaterThan(0);
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });
});
