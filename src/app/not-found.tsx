import Link from 'next/link';

/**
 * S1-008 — a 404 that says what happened and offers the one useful action.
 * No stack trace, no error code.
 */
export default function NotFound() {
  return (
    <main className="rounded-xl border border-slate-200 bg-surface p-6">
      <h1 className="text-lg font-semibold">We couldn&apos;t find that page.</h1>
      <p className="mt-2 text-sm text-ink-soft">
        The link may be old, or the dish may have been archived.
      </p>
      <Link
        href="/"
        className="mt-5 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
      >
        Go back
      </Link>
    </main>
  );
}
