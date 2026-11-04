'use client';

import { useActionState, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';

import {
  setDigestConsentAction,
  type DigestConsentState,
} from '@/app/(merchant)/merchant/settings/actions';

/**
 * FR-704 — the one place a merchant owner opts in to the weekly digest.
 *
 * ## Why a controlled checkbox
 *
 * The server is the truth after a save, and the response carries the stored value.
 * An uncontrolled `defaultChecked` would keep the browser's last click even if the
 * server refused it — the one state that must never happen is a box that looks ticked
 * while `MerchantUser.digestOptIn` is false, because the next Monday it would not
 * arrive and nothing on this screen would explain why.
 *
 * ## Why the copy says "only the numbers" before it says "email"
 *
 * A merchant agreeing to a weekly email is agreeing to a cadence, not to a data-sharing
 * arrangement; the sentence that reassures them is the one that says what is *not* in
 * it. The actual report stays behind a login link, and this email contains no diner
 * names or phone numbers — the report never selects them.
 */
const INITIAL: DigestConsentState = { error: null, notice: null, optIn: null };

export function DigestConsentForm({ initialOptIn }: { initialOptIn: boolean }) {
  const [state, formAction, pending] = useActionState(setDigestConsentAction, INITIAL);
  const [checked, setChecked] = useState(initialOptIn);

  useEffect(() => {
    if (state.optIn !== null) {
      setChecked(state.optIn);
    }
  }, [state.optIn]);

  return (
    <form action={formAction} className="space-y-3">
      <label htmlFor="digestOptIn" className="flex items-start gap-3 text-sm leading-relaxed">
        <input
          id="digestOptIn"
          name="digestOptIn"
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
        />
        <span>
          <span className="font-medium text-ink">Weekly email</span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-soft">
            Every Monday morning: last week&apos;s plates, what customers paid, what you
            kept, and how many buyers were new. The numbers only — the full report stays
            behind your login.
          </span>
        </span>
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-blocked">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-ok">
          {state.notice}
        </p>
      ) : null}

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Save email setting'}
      </Button>
    </form>
  );
}
