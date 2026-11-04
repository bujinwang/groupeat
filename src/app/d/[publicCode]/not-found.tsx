import type { Metadata } from 'next';

import { socialCardOrigin } from '@/lib/metadata/social-card';

/**
 * The 404 for `/d/:code`, and the only place the share card can be suppressed on it.
 *
 * ## Why this file has to exist at all
 *
 * Creating it changes what the segment's 404 *renders*, which is a real behaviour change
 * and not the reason it was added. The reason is metadata, and the mechanism is worth
 * writing down because it is the third thing tried and the first that worked.
 *
 * When `notFound()` is thrown, Next does not use the page's metadata. It builds an error
 * payload (`getErrorRSCPayload`) and re-resolves metadata with `errorConvention:
 * 'not-found'`. In that mode `resolve-metadata.js` walks each segment looking for a
 * `not-found` **component**, and pushes `[notFoundMetadataExport, staticFilesMetadata]`
 * as the *last* metadata item. The static files for this segment include
 * `opengraph-image.tsx`, and — this is the part that matters —
 * `mergeStaticMetadata` autofills `og:image` unless the metadata item at that level
 * has its own `images` key (`hasOwnProperty('images')`).
 *
 * So the suppression has to live on the module that is read at the **deepest** level on
 * the error path. Measured on a production build with no `APP_URL`:
 *
 *   suppression in `page.tsx`  `!drop` branch   → /d/NOPE123 still localhost  ✘
 *   suppression in `d/[code]/layout.tsx`        → twitter fixed, og:image not  ✘
 *   suppression in the root `app/layout.tsx`    → /d/NOPE123 still localhost  ✘
 *   suppression here                            → no card                      ✔
 *
 * Each row was measured, not reasoned about. The first two were reverted once their row
 * said so; `page.tsx` keeps its suppression anyway because it is correct for the page
 * module and costs nothing, but it is not what fixed this.
 *
 * ## Why the copy is imported rather than re-written
 *
 * S1-008 asks for one 404 that says what happened and offers one useful action. A second
 * file with its own copy is how two 404s start disagreeing. The root `app/not-found.tsx`
 * is still the answer for a URL that matches no route at all; this one exists because
 * Next cannot attach metadata to that shared component from inside this segment.
 */
export const metadata: Metadata = {
  title: 'Drop not found — GroupEat',
  // A 404 is not a destination. `page.tsx` already sets this for the page module; it is
  // repeated because this module's metadata is the one that survives on this path.
  robots: { index: false, follow: false },
  // `images: []` rather than an absent key: absent is exactly the state that lets the
  // convention autofill, which is the defect this file exists to close.
  ...(socialCardOrigin().kind === 'unavailable'
    ? { openGraph: { images: [] }, twitter: { images: [] } }
    : {}),
};

export { default } from '@/app/not-found';
