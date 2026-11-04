import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { socialCardOrigin } from '@/lib/metadata/social-card';

import './globals.css';

/**
 * The origin every relative metadata URL resolves against — `metadataBase`.
 *
 * ## Why this is here and not per page
 *
 * `metadataBase` is inherited: declaring it once in the root layout is the only
 * place it can be declared without four pages each having to remember. A page that
 * forgets is a page whose share card silently falls back to Next's default, which
 * is `http://localhost:3000` — see `lib/metadata/social-card.ts` for the measured
 * table and for why an absent origin means "no card" rather than "no link".
 *
 * ## Why it is `undefined` rather than absent in two of the three cases
 *
 * `socialCardOrigin()` returns one of three states, and this expression keeps the
 * key **out of the object entirely** unless an origin is genuinely usable. That
 * distinction is load-bearing in Next, not stylistic: `metadataBase: undefined` and
 * a missing key both trigger the localhost fallback, while `images: []` at the page
 * level (which this enables) suppresses the card. Writing `metadataBase: undefined`
 * unconditionally would be harmless; writing a *string* fallback here would be the
 * defect this replaces.
 */
const cardOrigin = socialCardOrigin();

export const metadata: Metadata = {
  title: 'GroupEat',
  description: 'Batch orders for kitchens, priced so the merchant still makes money.',
  ...(cardOrigin.kind === 'public' ? { metadataBase: cardOrigin.base } : {}),
};

/** 360px-safe: the panel and forms are designed for the narrowest phone first. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f7b4f',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-surface-muted text-ink antialiased">
        <div className="mx-auto w-full max-w-[420px] px-4 py-6">{children}</div>
      </body>
    </html>
  );
}
