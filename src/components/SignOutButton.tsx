'use client';

import { useState } from 'react';

/**
 * Signs out by calling the API route, then doing a full navigation so no cached
 * server component survives with the old identity.
 *
 * `router.refresh()` would leave the previous page's RSC payload in place until
 * the next navigation; a hard `location.assign` cannot.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-60"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
