import 'dotenv/config';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSocialCardOrigin } from '@/lib/metadata/social-card';

/**
 * `lib/metadata/social-card.ts` — the origin a share card is built against.
 *
 * ## What this file is defending, and from what
 *
 * `og:image` resolved to `http://localhost:3000/d/{code}/opengraph-image` on a
 * self-hosted production deployment, because no `metadataBase` was declared. The
 * suite was green; Next suppresses its own warning for `opengraph-image` in
 * development; nothing anywhere said a word. So the first rule here is that the
 * decision is **tested directly**, at the level where a wrong answer is a wrong
 * string rather than a wrong pixel.
 *
 * ## Why the interesting assertions drive Next's own resolver
 *
 * Asserting `resolveSocialCardOrigin()` returned a `URL` says the module agrees
 * with itself. The claim that matters is *"the URL a crawler reads is the real
 * host"*, and the only thing that can be wrong about it is Next's resolution step.
 * `next/dist/lib/metadata/resolvers/resolve-opengraph.js` is exported, so the test
 * imports the real resolver and asserts the **resolved image URL** — the same
 * function Next calls at request time. A test that stopped at our own return value
 * would pass on a build where Next ignored it.
 *
 * ## The dev-mode trap, which is why one test looks odd
 *
 * `getSocialImageMetadataBaseFallback` returns `createLocalMetadataBase()`
 * *unconditionally* when `NODE_ENV === 'development'`, before it reads its
 * argument. So in `next dev` an explicit `metadataBase` is **discarded**, and the
 * dev server shows `localhost` whether this module is wired or not. Anyone
 * verifying this fix by pointing a browser at the dev server will see `localhost`
 * and conclude it failed. The `development` case is asserted below as exactly that,
 * so the next reader does not have to rediscover it.
 */

const { resolveImages, resolveTwitter } = await import(
  'next/dist/lib/metadata/resolvers/resolve-opengraph.js'
);

/** The path a file-convention `opengraph-image.tsx` produces, as Next hands it over. */
const CARD_PATH = '/d/8EN9AJCA/opengraph-image?8en9ajca';

/**
 * `NODE_ENV` under a write, without lying about its type.
 *
 * `@types/node` declares `process.env.NODE_ENV` as read-only, because in a real
 * process it is set once at boot. It is not: Next's resolver reads it **at call
 * time** (`resolve-url.js` branches on it inside the function), which is the only
 * reason its production branch can be exercised from a suite that runs under
 * `test`. Assigning through a single typed seam keeps the intent visible and the
 * cast in one place instead of sprinkled over eight lines.
 */
function setNodeEnv(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/**
 * Resolve the card the way Next does, and return the URL a crawler would fetch.
 *
 * `isStaticMetadataRouteFile: true` is the third argument Next passes for a
 * file-convention image; it is what makes the fallback apply at all.
 *
 * `origin` is passed as `URL | null` rather than `URL | undefined` because that is
 * what the resolver's own signature accepts — `undefined` there is a type error,
 * and passing it silently is the kind of coercion that makes a test assert the
 * wrong branch.
 */
function resolvedCardUrl(
  origin: ReturnType<typeof resolveSocialCardOrigin>,
  nodeEnv: 'development' | 'production' = 'production',
): string | undefined {
  const previous = process.env.NODE_ENV;
  setNodeEnv(nodeEnv);
  try {
    // A Vercel deployment would rescue a missing base; these tests are about
    // self-hosted, so those variables must be absent for the assertion to mean
    // anything. Deleted rather than trusted to be unset.
    const saved = {
      VERCEL: process.env.VERCEL,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
      VERCEL_URL: process.env.VERCEL_URL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      PORT: process.env.PORT,
    };
    const env = process.env as Record<string, string | undefined>;
    delete env.VERCEL;
    delete env.VERCEL_PROJECT_PRODUCTION_URL;
    delete env.VERCEL_URL;
    delete env.VERCEL_ENV;
    delete env.PORT;

    try {
      const base = origin.kind === 'public' ? origin.base : null;
      const images = resolveImages({ url: CARD_PATH as `/${string}` }, base, true);
      return images?.[0] && 'url' in images[0] ? String(images[0].url) : undefined;
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
  } finally {
    setNodeEnv(previous ?? 'test');
  }
}

describe('resolveSocialCardOrigin — the three states', () => {
  it('uses APP_URL when it is a usable public origin', () => {
    const origin = resolveSocialCardOrigin({
      appUrl: 'https://groupeat.ca',
      nodeEnv: 'production',
    });

    expect(origin.kind).toBe('public');
    expect(origin.kind === 'public' && origin.base.origin).toBe('https://groupeat.ca');
  });

  it('drops the path from APP_URL, so a deployment root is an origin and not a prefix', () => {
    // `/d/:code` is absolute routing; keeping a prefix would build links that 404
    // while looking correct. `validatePublicOrigin` documents this; this asserts the
    // metadata path inherits it instead of re-deciding.
    const origin = resolveSocialCardOrigin({
      appUrl: 'https://groupeat.ca/app/',
      nodeEnv: 'production',
    });

    expect(origin.kind === 'public' && origin.base.href).toBe('https://groupeat.ca/');
  });

  it('refuses localhost as APP_URL in production, rather than trusting it', () => {
    // The whole defect: `localhost` is a *valid* URL and a wrong origin. It has to
    // be refused by name, not accepted because it parses.
    for (const value of [
      'http://localhost:3000',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://0.0.0.0',
      'https://macbook.local',
      'https://192.168.1.10',
    ]) {
      expect(
        resolveSocialCardOrigin({ appUrl: value, nodeEnv: 'production' }).kind,
      ).toBe('unavailable');
    }
  });

  it('refuses plain http, because a card URL is fetched by a stranger', () => {
    expect(
      resolveSocialCardOrigin({ appUrl: 'http://groupeat.ca', nodeEnv: 'production' }).kind,
    ).toBe('unavailable');
  });

  it('is `unavailable` in production when APP_URL is unset — the state that used to be silent', () => {
    for (const value of [undefined, '', '   ']) {
      expect(
        resolveSocialCardOrigin({ appUrl: value, nodeEnv: 'production' }).kind,
      ).toBe('unavailable');
    }
  });

  it('is `local` outside production, not `unavailable`', () => {
    // A fresh checkout, a test run and a developer's dev loop all have no APP_URL.
    // The card pointing at localhost is correct there, and it must not be reported
    // as a deployment mistake — the notification path makes the same distinction.
    for (const nodeEnv of ['development', 'test']) {
      expect(resolveSocialCardOrigin({ appUrl: undefined, nodeEnv }).kind).toBe('local');
    }
  });

  it('is `local` rather than `unavailable` for a bad value outside production', () => {
    // Deliberate: a developer with `APP_URL=http://localhost:3000` in their .env is
    // describing their laptop, and refusing to emit a card there would be noise.
    expect(
      resolveSocialCardOrigin({ appUrl: 'http://localhost:3000', nodeEnv: 'development' }).kind,
    ).toBe('local');
  });
});

describe('the card URL a crawler actually receives', () => {
  it('is the real host in production once metadataBase is set', () => {
    // The assertion this whole slice exists for. Not "we returned a URL" — the URL
    // Next resolves for a file-convention card on a production deployment.
    const origin = resolveSocialCardOrigin({
      appUrl: 'https://groupeat.ca',
      nodeEnv: 'production',
    });

    expect(resolvedCardUrl(origin)).toBe(`https://groupeat.ca${CARD_PATH}`);
  });

  it('is localhost in production without it — the defect, reproduced on demand', () => {
    // A control, and the reason the fix is not cosmetic: the *same* resolver, the
    // *same* path, one input different. Without this pair, the assertion above
    // could pass on a Next version that ignores metadataBase entirely.
    const origin = resolveSocialCardOrigin({
      appUrl: undefined,
      nodeEnv: 'production',
    });

    expect(resolvedCardUrl(origin)).toBe(`http://localhost:3000${CARD_PATH}`);
  });

  it('ignores metadataBase in development, which is why dev cannot prove this fix', () => {
    // Measured against Next's own resolver, and the single most expensive trap in
    // this slice: `getSocialImageMetadataBaseFallback` returns the local base
    // unconditionally under `NODE_ENV=development`, BEFORE it looks at the argument.
    // A browser check against `next dev` therefore shows `localhost` for a correct
    // fix and for a broken one. Asserted as behaviour so it stays a fact rather than
    // a comment somebody later "fixes".
    const usable = resolveSocialCardOrigin({
      appUrl: 'https://groupeat.ca',
      nodeEnv: 'development',
    });

    expect(resolvedCardUrl(usable, 'development')).toBe(`http://localhost:3000${CARD_PATH}`);
  });

  it('resolves the twitter card from the same base, not a separate one', () => {
    // A separate declaration is the way the two disagree later. Next fills
    // `twitter.images` from the same file convention, so it must land on the same
    // host — a card that previews correctly in WhatsApp and points at a laptop in
    // Twitter is the same defect half-fixed.
    const origin = resolveSocialCardOrigin({
      appUrl: 'https://groupeat.ca',
      nodeEnv: 'production',
    });

    const previous = process.env.NODE_ENV;
    setNodeEnv('production');
    try {
      const twitter = resolveTwitter(
        { card: 'summary_large_image', images: { url: CARD_PATH } },
        origin.kind === 'public' ? origin.base : null,
        { isStaticMetadataRouteFile: true, trailingSlash: false },
        null,
      );
      expect(twitter?.images?.[0] && String(twitter.images[0].url)).toBe(
        `https://groupeat.ca${CARD_PATH}`,
      );
    } finally {
      setNodeEnv(previous ?? 'test');
    }
  });
});

describe('the page-level suppression, which is the only way to say "no card"', () => {
  /**
   * Next auto-fills the file-convention image **unless the metadata object sets an
   * `images` key itself** — measured in `resolve-metadata.js`, which gates the
   * autofill on `hasOwnProperty('images')`. So the suppression is `images: []`, and
   * the two wrong ways to express it are both worth pinning:
   *
   *   - `images: undefined` — also suppresses it, but writing that key
   *     unconditionally would delete the card in the healthy case, i.e. FR-308.
   *   - omitting the key — Next fills it from the convention, which is exactly what
   *     this branch exists to prevent.
   */
  it('emits no image when the metadata says images: []', () => {
    const previous = process.env.NODE_ENV;
    setNodeEnv('production');
    try {
      const images = resolveImages([], new URL('https://groupeat.ca'), true);
      expect(images).toEqual([]);
    } finally {
      setNodeEnv(previous ?? 'test');
    }
  });

  it('would still emit the card if the key were merely omitted', () => {
    // The control for the line above: at this level an absent `images` produces
    // nothing, so the page must pass `[]` and not rely on the layout. This asserts
    // the *absence* of a card cannot be achieved by doing nothing.
    const previous = process.env.NODE_ENV;
    setNodeEnv('production');
    try {
      expect(resolveImages(undefined, new URL('https://groupeat.ca'), true)).toBeUndefined();
    } finally {
      setNodeEnv(previous ?? 'test');
    }
  });
});

describe('socialCardOrigin() against this process environment', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('reports a production deployment with no APP_URL once, at error', async () => {
    // The visibility half. The defect persisted for months because nothing anywhere
    // said anything; a state that produces no signal is a state nobody fixes.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '');
    const { socialCardOrigin } = await import('@/lib/metadata/social-card');
    const { logger } = await import('@/lib/logging/logger');
    const error = vi.spyOn(logger, 'error');

    expect(socialCardOrigin().kind).toBe('unavailable');
    expect(socialCardOrigin().kind).toBe('unavailable');
    expect(socialCardOrigin().kind).toBe('unavailable');

    // Once per process, not once per page: this runs on every `/d/:code` render,
    // and a line per page view is a line nobody reads.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('metadata.public_origin_missing', { reason: 'UNSET' });
  });

  it('names the reason when the value is present but unusable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'http://groupeat.ca');
    const { socialCardOrigin } = await import('@/lib/metadata/social-card');
    const { logger } = await import('@/lib/logging/logger');
    const error = vi.spyOn(logger, 'error');

    expect(socialCardOrigin().kind).toBe('unavailable');
    expect(error).toHaveBeenCalledWith('metadata.public_origin_missing', { reason: 'NOT_HTTPS' });
  });

  it('says nothing in development, where localhost is the right answer', async () => {
    // Not a warning: the dev server's card is supposed to point at the dev server.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', '');
    const { socialCardOrigin } = await import('@/lib/metadata/social-card');
    const { logger } = await import('@/lib/logging/logger');
    const error = vi.spyOn(logger, 'error');
    const warn = vi.spyOn(logger, 'warn');

    expect(socialCardOrigin().kind).toBe('local');
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing when APP_URL is usable, and returns that origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://groupeat.ca/');
    const { socialCardOrigin } = await import('@/lib/metadata/social-card');
    const { logger } = await import('@/lib/logging/logger');
    const error = vi.spyOn(logger, 'error');

    const origin = socialCardOrigin();
    expect(origin.kind === 'public' && origin.base.origin).toBe('https://groupeat.ca');
    expect(error).not.toHaveBeenCalled();
  });
});
