import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `FloorEscapeHatch` — the one client component in this repo that had never executed.
 *
 * ## The measurement that produced this file
 *
 * A per-function census over the stored V8 map, restricted to the 31 `'use client'`
 * sources, gave two numbers that together are the whole story:
 *
 *     client components whose component function EXECUTED (rendered): 30 / 31
 *     client components NEVER executed:                                1  -> FloorEscapeHatch.tsx
 *     functions across all 31 client files:                       42 / 146   (29 %)
 *     event handlers across the 30 that do render:                 2 / 93  fired
 *
 * The second pair is the interesting one, and it corrects a claim this repo has been
 * repeating: *"a client component with hooks remains untestable here"*. **Thirty of
 * thirty-one client components already render**, at 82–94 % statement coverage in
 * several cases. So the blocker was never hooks.
 *
 * ## What actually blocked, probed rather than guessed
 *
 * Two things, and neither is the DOM:
 *
 *   1. **`server-only`.** Importing this module from a test throws
 *      *"This module cannot be imported from a Client Component module"* before any
 *      render happens — because it reaches `./actions`, which is a server action. The
 *      repo's established seam is `vi.mock('server-only', () => ({}))`.
 *   2. **`useRouter()`.** Without an app-router context Next throws *"expected app
 *      router to be mounted"*. `renderWithRouter` already supplies it.
 *
 * Probed directly: a `useState` component renders fine through
 * `renderToStaticMarkup` under `environment: 'node'` with no DOM package installed.
 * Hooks need a React *dispatcher*, not a browser — `react-dom/server` provides one.
 *
 * ## What this file can and cannot prove — stated before the assertions
 *
 * It renders the component's **initial state** and asserts the copy in it. It cannot
 * click, because no click happens without a DOM and no DOM library is installed
 * (`jsdom`, `happy-dom`, `linkedom` are all absent from `devDependencies` — checked).
 *
 * So the honest claim is: `FloorEscapeHatch` now executes, its closed state is
 * asserted, and the two-step flow behind `useState(false)` is **still unexecuted**.
 * Its 1.1 % statement coverage will move, and it will not become a tested interacton.
 * The alternative — adding jsdom to assert two clicks — is a second runtime for one
 * component, which is the trade this repo decided against in ADR-adjacent comments and
 * which this file does not reopen.
 *
 * ## The one behavioural claim worth pinning here
 *
 * The button's label is *"Change my minimum margin"* and it is the **only** thing the
 * component renders while closed. That is deliberate in the source ("`if (!open)`"),
 * and it is the property that makes the hatch hard to use: the merchant sees a quiet
 * link, not a dial they might nudge.
 */

vi.mock('server-only', () => ({}));

const { FloorEscapeHatch } = await import('@/components/guardrail/FloorEscapeHatch');
const { renderWithRouter } = await import('@/lib/testing/render');

const NOUN = 'Change my minimum margin';

function hatch(props?: Partial<{ itemId: string; currentFloorPct: number; currentFloorCents: number }>) {
  return createElement(FloorEscapeHatch, {
    itemId: 'item_1',
    currentFloorPct: 60,
    currentFloorCents: 1200,
    ...props,
  });
}

describe('FloorEscapeHatch — the closed state it renders before anyone touches it', () => {
  it('renders a button, not a dialog', async () => {
    // The two-step flow is the whole reason the component exists ("there is no way to
    // skip step 1"). If the dialog rendered immediately, step 1 would be skippable and
    // the guardrail would degrade into a suggestion — the exact failure the docblock
    // says this component is shaped to prevent.
    const { html } = await renderWithRouter(hatch());

    expect(html).toContain(NOUN);
    expect(html).toContain('type="button"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('Lower my minimum');
  });

  it('shows no money yet, because no consequence has been computed', async () => {
    // `candidatePct` starts at `max(1, currentFloorPct - 5)` but nothing is displayed
    // until the debounced preview resolves. A closed hatch that printed a number would
    // be showing a figure the server never computed for this merchant.
    const { html } = await renderWithRouter(hatch({ currentFloorPct: 60, currentFloorCents: 1200 }));

    expect(html).not.toContain('$12.00');
    expect(html).not.toContain('%');
  });

  it('renders the same markup regardless of the numbers it is seeded with', async () => {
    // Guards the closed state against a future refactor that renders the consequence
    // eagerly. Two very different floors must produce byte-identical output.
    const a = await renderWithRouter(hatch({ currentFloorPct: 60, currentFloorCents: 1200 }));
    const b = await renderWithRouter(hatch({ currentFloorPct: 95, currentFloorCents: 4750 }));

    expect(a.html).toBe(b.html);
  });

  it('records no router refresh — the component is inert until confirmed', async () => {
    // `router.refresh()` is called exactly once, inside `apply()`, after a successful
    // PATCH. A refresh during render would re-fetch the panel on every keystroke.
    const { router } = await renderWithRouter(hatch());
    expect(router.refreshes).toBe(0);
  });

  it('is a link-styled control, not a prominent button', async () => {
    // The lead's instruction, quoted in the source: "if it's too easy, the guardrail
    // degrades into a suggestion." The styling is the only thing expressing that in the
    // closed state, so it is the assertion that keeps the intent from eroding.
    const { html } = await renderWithRouter(hatch());
    expect(html).toContain('underline');
    expect(html).toContain('text-ink-soft');
  });
});

describe('FloorEscapeHatch — the module imports what it needs, and nothing server-side leaks', () => {
  it('renders with server-only never actually consulted', async () => {
    // `vi.mock('server-only')` replaces a build marker that throws on import. Proving it
    // renders at all is the assertion that the marker — not a hook, not the DOM — was
    // the blocker. This is the test that would have failed before this file existed.
    const { html } = await renderWithRouter(hatch());
    expect(html.length).toBeGreaterThan(50);
  });

  it('exposes no floor value in the closed markup', async () => {
    // The current floor is passed in as a prop and is *not* rendered until the dialog
    // opens. Asserting its absence keeps a future "just show the current floor next to
    // the link" change from leaking a number the panel already shows elsewhere.
    const { html } = await renderWithRouter(hatch({ currentFloorPct: 73, currentFloorCents: 3650 }));
    expect(html).not.toContain('73');
    expect(html).not.toContain('3650');
  });
});

describe('the "hooks are untestable" claim, measured', () => {
  /**
   * The guard for the claim this file corrects.
   *
   * `src/lib/testing/render.ts` said a client component with hooks "remains untestable
   * here". It was false when written and stayed false for months. Rather than only
   * rewriting the sentence, this asserts the mechanism: a `useState` component renders
   * to static markup with no DOM present.
   */
  it('a useState component renders to markup with no DOM installed', async () => {
    // Deliberately **not** `FloorEscapeHatch`: this component also calls `useRouter()`,
    // so rendering it through the plain entry point fails on the *router*, which would
    // look like a DOM failure and prove nothing about hooks. `SignOutButton` is the
    // smallest client component that uses `useState` and nothing context-dependent —
    // probed, it renders through `renderToStaticMarkup` with no DOM.
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { SignOutButton } = await import('@/components/SignOutButton');
    const html = renderToStaticMarkup(createElement(SignOutButton));

    expect(html.length).toBeGreaterThan(0);
    expect(typeof globalThis.document).toBe('undefined');
  });
});
