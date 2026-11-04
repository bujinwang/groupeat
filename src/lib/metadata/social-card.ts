/**
 * The origin a link preview is built against — and why "no origin" is a third
 * answer rather than a missing one.
 *
 * ## The defect this exists to close
 *
 * FR-308's card is the whole distribution funnel: a drop spreads by being pasted
 * into a group chat, and the image is the only thing forty people see before
 * deciding to tap. That image is a **file-convention route**
 * (`d/[publicCode]/opengraph-image.tsx`), and Next resolves its URL against
 * `metadataBase`. The app declared none, so Next fell back — measured by calling
 * Next's own `getSocialImageMetadataBaseFallback()`, not inferred from its source:
 *
 * | `NODE_ENV` | `metadataBase` | resolved origin |
 * |---|---|---|
 * | development | none | `http://localhost:3000` |
 * | development | `https://groupeat.ca` | `http://localhost:3000` — **ignored** |
 * | production | none | `http://localhost:3000` |
 * | production | `https://groupeat.ca` | `https://groupeat.ca` |
 *
 * So on a self-hosted production deployment with no Vercel environment variables,
 * every share of every drop pointed at a laptop. The suite was green and Next's
 * own warning is suppressed for `opengraph-image` in development
 * (`shouldWarn = … || NODE_ENV === 'production' || !isStaticMetadataRouteFile`), so
 * nothing said a word.
 *
 * Two rows of that table are the reason this module is not one line in
 * `layout.tsx`:
 *
 *   1. **Dev ignores an explicit base.** `getSocialImageMetadataBaseFallback`
 *      returns `createLocalMetadataBase()` unconditionally when
 *      `NODE_ENV === 'development'`, before it looks at the argument. Setting
 *      `metadataBase` therefore *cannot be demonstrated in `next dev`* — a browser
 *      pointed at the dev server shows `localhost` either way, and reading that as
 *      "the fix did not work" is the trap.
 *   2. **Absent is not safe.** For a notification link, an absent origin means "no
 *      link", which `notify/public-origin.ts` documents as the safe answer. For
 *      `metadataBase`, absent means **localhost** — a wrong answer delivered to a
 *      stranger. The same missing input has opposite safe defaults in the two
 *      consumers, so the two cannot share a function's return contract.
 *
 * ## Why this reuses `validatePublicOrigin` and not `publicOrigin`
 *
 * One definition of "a public origin" is the point: `public-origin.ts` already
 * refuses `localhost`, loopback literals, bare IPv4 and `.local` by name, and its
 * refusals are unit-tested. A second validator here would drift from it, and the
 * first time they disagreed the disagreement would be invisible.
 *
 * What is deliberately *not* shared is the absent-policy and the log event.
 * `notify.public_origin_rejected` emitted during a page render would send an
 * operator grepping notification failures to a page that never sends a message.
 *
 * ## The three states
 *
 *   - `public` — `APP_URL` validated. `metadataBase` is set; the card resolves to
 *     an absolute https URL on the real host.
 *   - `local` — no usable `APP_URL` outside production. Correct, not a defect: a
 *     developer's card *should* point at their laptop, and Next overrides the base
 *     in dev regardless. Silent.
 *   - `unavailable` — production and no usable `APP_URL`. This is a deployment
 *     mistake, and the honest response is **no card at all**. A preview with no
 *     image is degraded; a preview whose image is `localhost:3000` is broken for
 *     every recipient and looks like our bug. That is the same argument
 *     `public-origin.ts` makes — "a message carrying a code and no link is strictly
 *     better than a message carrying a broken one" — one layer up.
 */

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';
import { validatePublicOrigin, type PublicOriginRefusal } from '@/lib/notify/public-origin';

export type SocialCardOrigin =
  /** `APP_URL` is usable: resolve the card against it. */
  | { kind: 'public'; base: URL }
  /** Not production, and no usable `APP_URL`. Localhost is the right answer here. */
  | { kind: 'local' }
  /** Production with no usable origin. Emit no card rather than a broken one. */
  | { kind: 'unavailable' };

/**
 * The decision, as a pure function of its two inputs.
 *
 * `nodeEnv` is a parameter rather than a read of `process.env` so the production
 * branch is testable without re-importing the module under a stubbed environment —
 * and so the caller cannot accidentally decouple the two.
 */
export function resolveSocialCardOrigin(args: {
  appUrl: string | undefined;
  nodeEnv: string;
}): SocialCardOrigin {
  const result = validatePublicOrigin(args.appUrl);

  if ('origin' in result) {
    // `validatePublicOrigin` returns a normalised string origin; `metadataBase`
    // takes a URL instance. `base` keeps path/query dropped, exactly as the
    // notification path does — a deployment served under a path prefix is not
    // supported here either.
    return { kind: 'public', base: new URL(result.origin) };
  }

  // In development and in the suite, an absent or unusable value is not something
  // to report: a fresh checkout has no APP_URL, and the dev card pointing at
  // localhost is the correct behaviour rather than the defect.
  if (args.nodeEnv !== 'production') {
    return { kind: 'local' };
  }

  return { kind: 'unavailable' };
}

let warned = false;

/**
 * The same decision, read from this process's environment.
 *
 * Logs **once** at `error` when it returns `unavailable`. `error` rather than
 * `warn` because the consequence is that every share of every drop previews
 * without an image, which is a launch-blocking condition rather than a
 * degradation — and because the previous state of this code produced no signal at
 * all for months.
 *
 * Once per process, not once per page: this runs on every `/d/:code` render, and a
 * log line per page view is a log nobody reads (the same reasoning as
 * `public-origin.ts`).
 */
export function socialCardOrigin(): SocialCardOrigin {
  const result = resolveSocialCardOrigin({ appUrl: env.APP_URL, nodeEnv: env.NODE_ENV });

  if (result.kind === 'unavailable' && !warned) {
    warned = true;
    // The refusal reason is recomputed only to name it in the log;
    // `resolveSocialCardOrigin` collapses every unusable value to one state, and an
    // operator needs to know whether the value was absent, unparseable, non-https
    // or not public. `unavailable` implies the validation failed, so the `reason`
    // arm is the only reachable one — asserted rather than assumed, because a
    // future edit that made `unavailable` reachable with a *valid* origin would
    // otherwise log a reason that does not exist.
    const validated = validatePublicOrigin(env.APP_URL);
    const refusal: PublicOriginRefusal = 'reason' in validated ? validated.reason : 'UNSET';
    logger.error('metadata.public_origin_missing', { reason: refusal });
  }

  return result;
}
