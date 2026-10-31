import Link from 'next/link';

import { buttonClass } from '@/components/ui/Button';

/**
 * S1-008 — the 403 page. Same voice as the 404: what happened, then the one
 * useful action. No error code, no stack trace.
 */
export default function Forbidden() {
  return (
    <main className="rounded-xl border border-slate-200 bg-surface p-6">
      <h1 className="text-lg font-semibold">You don&apos;t have access to that page.</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Your account is signed in, but this page belongs to a different kind of account.
      </p>
      <Link href="/" className={buttonClass('primary', 'mt-5')}>
        Go to my home page
      </Link>
    </main>
  );
}
