import Link from 'next/link';

import { SignOutButton } from './SignOutButton';
import type { SessionRole } from '@/lib/auth/jwt';

const LINKS: Record<SessionRole, readonly { href: string; label: string }[]> = {
  MERCHANT: [
    // Drops before Dishes: a drop is the thing the merchant came to do, and the
    // dish list is the setup for it.
    { href: '/merchant/drops', label: 'Drops' },
    // Pickup sits next to Drops rather than at the end: it is the only merchant
    // screen used *while a drop is running*, and staff should not have to hunt for
    // it with a diner waiting.
    { href: '/merchant/pickup', label: 'Pickup' },
    { href: '/merchant/items', label: 'Dishes' },
    { href: '/merchant/payouts', label: 'Payouts' },
    { href: '/merchant/settings', label: 'Settings' },
  ],
  // Drops before Users: the admin's job is mostly "a merchant says their drop is
  // stuck", and that is a drop-shaped question. Users is the setup screen.
  ADMIN: [
    { href: '/admin/drops', label: 'Drops' },
    { href: '/admin/ai-drafts', label: 'AI runs' },
    { href: '/admin/users', label: 'Users' },
  ],
  ORGANISER: [{ href: '/organiser', label: 'Home' }],
};

/**
 * Role-aware navigation. Server component: it renders links and a form, and
 * reads no state of its own.
 *
 * ## The width problem at 360px
 *
 * Five merchant links plus the wordmark plus Sign out do not fit on one line of a
 * 360px phone, which the nav must keep working on (NFR-02). The nav is therefore
 * `w-full` below `sm` and takes its own row under the wordmark; above `sm` it sits
 * inline as before.
 *
 * The earlier version let the single flex row wrap **items** instead, which is
 * worse than it sounds: it broke "Sign out" across two lines as
 * `Sign` / `out` while the other links stayed whole, so the nav looked broken
 * rather than stacked. `whitespace-nowrap` on each link plus a whole-row wrap is
 * the fix — items never split, rows do.
 */
export function AppNav({ role }: { role: SessionRole }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 pb-3">
      <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
        GroupEat
      </Link>
      <nav className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 whitespace-nowrap text-sm sm:w-auto">
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
