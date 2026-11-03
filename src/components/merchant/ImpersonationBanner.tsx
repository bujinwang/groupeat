'use client';

import { useEffect, useState } from 'react';

/**
 * FR-904 — the banner that says "this is not your account, and it ends at 2:14".
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why this is a client component and the wording is not
 *
 * The *facts* are resolved on the server (`impersonationBanner`, which reads two `User`
 * rows) and arrive as props, so nothing here decides who is who. What lives here is the
 * one thing that cannot be server-rendered: the clock. A minute-by-minute remaining
 * count has to tick, and a server component would only be right at the instant of
 * render — an admin who sat on the page for twenty minutes would be told they had
 * thirty left.
 *
 * ## Why the countdown rather than just the expiry timestamp
 *
 * Because the expense of forgetting is asymmetric. An admin who runs out of window
 * mid-diagnosis loses nothing but has to start again; an admin who *thinks* they have
 * twenty minutes left and starts typing a fix they cannot submit has wasted the call.
 * The countdown makes the end visible before it happens.
 *
 * The wording states the read-only rule out loud. The 403 is correct but arrives as a
 * surprise, and "why did that fail?" is a worse experience than "I know I cannot edit
 * this yet".
 */

function formatRemaining(msLeft: number): string {
  if (msLeft <= 0) {
    return 'expired';
  }
  const totalSeconds = Math.floor(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} left`;
}

export function ImpersonationBanner({
  viewingEmail,
  actorEmail,
  expiresAt,
  auditId,
}: {
  viewingEmail: string;
  actorEmail: string;
  /** ISO-8601, serialised on the server so the client parses one exact instant. */
  expiresAt: string;
  auditId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `null` until the effect runs, because the server and the client can disagree about
  // "now" and a value rendered on the server would hydrate as a visible jump. The first
  // second is blank; every second after it is right.
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    const expiry = Date.parse(expiresAt);
    const tick = () => setRemaining(formatRemaining(expiry - Date.now()));

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  async function endSession() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/impersonation/end', { method: 'POST' });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : 'That did not work. Try again.';
        setError(message);
        setBusy(false);
        return;
      }
      const body = (await response.json()) as { redirectTo?: string };
      // A full navigation, not `router.push`: the merchant pages are cached RSC payloads
      // rendered under the borrowed identity, and nothing short of a reload is certain
      // to have replaced them.
      window.location.assign(body.redirectTo ?? '/admin/users');
    } catch {
      setError('That did not reach the server. Try again.');
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="mb-5 rounded-lg border border-thin/40 bg-thin/10 px-3 py-2 text-sm text-ink"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-medium">
            Viewing <span className="break-all">{viewingEmail}</span> as an admin
          </p>
          <p className="mt-0.5 text-xs text-ink-soft">
            Read-only — every change is refused until you end the session. You are signed
            in as <span className="break-all">{actorEmail}</span>.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="whitespace-nowrap text-xs tabular-nums text-ink-soft" aria-live="off">
            {remaining ?? '—'}
          </span>
          <button
            type="button"
            onClick={endSession}
            disabled={busy}
            className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-ink hover:bg-slate-50 disabled:opacity-60"
          >
            {busy ? 'Ending…' : 'End session'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-blocked" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-1 font-mono text-[10px] text-ink-soft">audit {auditId}</p>
    </div>
  );
}
