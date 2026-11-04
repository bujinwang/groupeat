import 'dotenv/config';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The segment's `not-found` metadata — the only place the 404's share card can be fixed.
 *
 * ## Why this file is tested at all
 *
 * Because it was the fourth attempt. The card leak on `/d/NOPE123` survived suppression
 * written in `page.tsx`, in `d/[publicCode]/layout.tsx`, and in the root `app/layout.tsx`;
 * each was measured on a production build and each was reverted. The mechanism is that
 * `notFound()` makes Next discard the page's metadata and re-resolve with
 * `errorConvention: 'not-found'`, which reads a `not-found` **component** per segment and
 * pushes its metadata as the deepest item. `mergeStaticMetadata` then autofills
 * `og:image` from `opengraph-image.tsx` unless *that* item has its own `images` key.
 *
 * So the claim worth pinning is narrow and it is about this module in isolation: with no
 * usable origin it emits `images: []` on both channels, and with one it emits nothing at
 * all — because an empty `openGraph: {}` would also stop the autofill and delete FR-308's
 * card on the deployments that can serve it.
 *
 * ## Why the render is not asserted here
 *
 * The rendered 404 body is covered by `/d/NOPE123` returning a 404 in the production
 * measurement recorded in `docs/PROGRESS.md`; this file re-exports the root `not-found`
 * component, so a test of its markup here would be testing `app/not-found.tsx` twice and
 * that component once.
 */
describe('/d/:publicCode not-found — the 404 carries no share card', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('suppresses both channels when production has no usable origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    vi.resetModules();

    const mod = await import('@/app/d/[publicCode]/not-found');

    // `[]` and not `undefined`: an omitted key is what a refactor that deleted the
    // suppression would look like, and absent is the state that *permits* autofill.
    expect(mod.metadata.openGraph?.images).toEqual([]);
    expect(mod.metadata.twitter?.images).toEqual([]);
    // The title is the other half of the fix. Before this file existed the 404's title was
    // the root layout's `GroupEat` — measured — which meant the page's own
    // `Drop not found` never reached the response at all.
    expect(mod.metadata.title).toBe('Drop not found — GroupEat');
    expect(mod.metadata.robots).toEqual({ index: false, follow: false });
  });

  it('emits no openGraph or twitter key at all when the origin is usable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://groupeat.ca');
    vi.resetModules();

    const mod = await import('@/app/d/[publicCode]/not-found');

    // Absence, not emptiness — see the docblock. An empty object would suppress the card
    // on a healthy deployment, which is worse than the leak this file fixes.
    expect(mod.metadata.openGraph).toBeUndefined();
    expect(mod.metadata.twitter).toBeUndefined();
  });

  it('emits no suppression outside production, where a local card is correct', async () => {
    // The third state, and the reason the suite's default environment must not suppress:
    // a fresh checkout has no APP_URL and a developer's card *should* point at localhost.
    const mod = await import('@/app/d/[publicCode]/not-found');

    expect(mod.metadata.openGraph).toBeUndefined();
    expect(mod.metadata.twitter).toBeUndefined();
  });
});
