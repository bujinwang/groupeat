import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'GroupEat',
  description: 'Batch orders for kitchens, priced so the merchant still makes money.',
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
