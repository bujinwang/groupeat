import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pins the workspace root so a stray lockfile in a parent directory cannot
  // change the build's file tracing (the repo is a single app at the root).
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),

  /**
   * The diner's order page carries a bearer token in `?t=`, and it renders the
   * redemption code as text. Without this, any outbound link on that page — even a
   * map link to the restaurant — sends the full URL, token included, in the
   * `Referer` header to a third party. Scoped to the one route rather than set
   * globally so the rest of the app keeps normal referrer behaviour.
   */
  async headers() {
    return [
      {
        source: '/d/:publicCode/mine',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // A tokenised URL must not be cached by a shared proxy or written to disk
          // by an intermediary. The page is dynamic anyway; this states why.
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
