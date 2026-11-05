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
    // Reports sits after Pickup and before Payouts: it is the screen a merchant
    // opens *after* a drop to decide what to do next, which is a different moment
    // from pickup (while it runs) and payouts (a one-time setup).
    { href: '/merchant/reports', label: 'Reports' },
    { href: '/merchant/payouts', label: 'Payouts' },
    { href: '/merchant/settings', label: 'Settings' },
  ],
  // Drops before Users: the admin's job is mostly "a merchant says their drop is
  // stuck", and that is a drop-shaped question. Users is the setup screen. Commission
  // sits before Users and after Drops because it is a monthly closed-book task -- it is
  // done deliberately, once, not while someone is on the phone.
  ADMIN: [
    // The board an operator opens first: it answers "is the mechanic working" before
    // any individual drop does.
    { href: '/admin/metrics', label: 'Metrics' },
    { href: '/admin/drops', label: 'Drops' },
    { href: '/admin/ai-drafts', label: 'AI runs' },
    { href: '/admin/commission', label: 'Commission' },
    { href: '/admin/users', label: 'Users' },
  ],
  // Home before Commission: the two taps FR-802 is judged on happen on Home, so it
  // stays first. Commission is second because it is the only other thing an organiser
  // opens, and the figure it shows is the reason they shared anything at all.
  ORGANISER: [
    { href: '/organiser', label: 'Home' },
    { href: '/commission', label: 'Commission' },
  ],
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
