import Link from 'next/link';

import { SignOutButton } from './SignOutButton';
import type { SessionRole } from '@/lib/auth/jwt';

/**
 * Role-aware navigation. Server component: it renders links and a form, and
 * reads no state of its own.
 */

const LINKS: Record<SessionRole, readonly { href: string; label: string }[]> = {
  MERCHANT: [
    { href: '/merchant/items', label: 'Dishes' },
    { href: '/merchant/settings', label: 'Settings' },
  ],
  ADMIN: [{ href: '/admin/users', label: 'Users' }],
  ORGANISER: [{ href: '/organiser', label: 'Home' }],
};

export function AppNav({ role }: { role: SessionRole }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 pb-3">
      <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
        GroupEat
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        {LINKS[role].map((link) => (
          <Link key={link.href} href={link.href} className="text-ink-soft hover:text-ink">
            {link.label}
          </Link>
        ))}
        <SignOutButton />
      </nav>
    </header>
  );
}
