'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

/**
 * FR-904 — the admin's way in.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why this is a two-step control and not a button
 *
 * The requirement is not a convenience: it hands one person a view of somebody else's
 * business. A single "Impersonate" button next to a row is a button that gets pressed by
 * accident, and the audit row would then record a reason nobody meant. So the admin has
 * to (a) pick a person, (b) type why, and (c) press a button that says what it will do.
 * Three deliberate actions, none of them pre-filled.
 *
 * The reason is a free-text field rather than a dropdown of canned categories, because
 * the value of the audit row is the sentence a human wrote. A picker would produce
 * `SUPPORT_CALL` for every entry, which is the same as no reason at all.
 *
 * ## Why the failure is shown inline rather than as a toast
 *
 * The statuses here are refusals with sentences — not an owner, not active, not this
 * merchant — and each one is a fact the admin needs to read and act on. A toast that
 * vanishes in four seconds is the wrong container for "that account is a manager".
 */

export type ImpersonationCandidate = {
  readonly merchantUserId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: 'OWNER' | 'MANAGER' | 'STAFF';
};

export function ImpersonateControl({
  merchantId,
  candidates,
}: {
  merchantId: string;
  /** Owners first, from `listMerchantMembers`. */
  candidates: readonly ImpersonationCandidate[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owners = candidates.filter((person) => person.role === 'OWNER');

  // The owner filter is checked **before** the closed state, and the order is the whole
  // point. With these two the other way round, a merchant with no owner renders the
  // "View as this merchant…" button — an enabled control whose one outcome is the
  // explanation this guard exists to show instead. The docblock above claims exactly that
  // ("renders a sentence explaining why rather than a control that would fail"), so the
  // branch order was what made that comment false. Found by rendering a MANAGER-only
  // merchant: the button was there and the sentence was not.
  if (owners.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        This merchant has no owner account, so there is nothing to view as. FR-904 covers
        merchant owners only.
      </p>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          View as this merchant…
        </Button>
        <p className="text-xs text-ink-soft">
          Opens a read-only session as one of this merchant&apos;s owners for 30 minutes. Every
          change is refused while it is open, and the session is recorded in the audit log.
        </p>
      </div>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/merchants/${merchantId}/impersonate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ merchantUserId: selected, reason }),
      });

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
      // A full navigation so no server component rendered under the admin's identity
      // survives into the borrowed session.
      window.location.assign(body.redirectTo ?? '/merchant/drops');
    } catch {
      setError('That did not reach the server. Try again.');
      setBusy(false);
    }
  }

  // No second `owners.length === 0` guard here: the one above the closed state has already
  // returned for that case, so a copy at this point would be unreachable. It used to live
  // here, which is exactly why the closed state won — see the note on the first guard.

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <Field id="impersonate-target" label="Owner">
        <select
          id="impersonate-target"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          required
          className={inputClass}
        >
          <option value="">Choose an owner…</option>
          {owners.map((person) => (
            <option key={person.merchantUserId} value={person.merchantUserId}>
              {person.name ? `${person.name} — ${person.email}` : person.email}
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="impersonate-reason"
        label="Why are you viewing this account?"
        helper="Written to the audit log as you type it. Be specific — this is what answers the question later."
      >
        <textarea
          id="impersonate-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          maxLength={500}
          rows={2}
          className={inputClass}
          placeholder="Merchant called about a drop that will not publish."
        />
      </Field>

      {error ? (
        <p className="text-sm text-blocked" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || selected === '' || reason.trim() === ''}>
          {busy ? 'Opening…' : 'Open read-only session'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
