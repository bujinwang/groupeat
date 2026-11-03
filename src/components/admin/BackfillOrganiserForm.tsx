'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { backfillOrganiserAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * FR-906's repair control — one organiser account that is missing its profile.
 *
 * ## Why this is per-account and not a "fix all" button
 *
 * Because the display name is the one value the repair cannot invent. It is what a
 * diner reads next to a share link, so defaulting it from the email local-part would
 * put `bujin1984` on a stranger's link. The operator types it, once, per account —
 * there are 5–15 organisers in beta and this should never run again.
 *
 * The form posts a `userId` the operator cannot see or edit, which is fine: the action
 * re-checks that the account is an ORGANISER with no profile, so a tampered id either
 * does nothing or repairs a genuinely broken account.
 */
const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function BackfillOrganiserForm({ userId, email }: { userId: string; email: string }) {
  const [state, formAction, pending] = useActionState(backfillOrganiserAction, INITIAL);

  // Once it succeeds the row is gone from this list on the next render, so the notice
  // is the only confirmation the operator gets. Show it and drop the form.
  if (state.notice) {
    return (
      <p role="status" className="text-xs text-ok">
        {state.notice}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-xs text-ink-soft">
        <span className="font-medium">{email}</span> has no organiser profile, so their
        name and commission do not exist. Their account works; nothing organiser-facing
        does.
      </p>
      <Field
        id={`backfill-name-${userId}`}
        label="Display name"
        error={state.fieldErrors.displayName}
      >
        <input
          id={`backfill-name-${userId}`}
          name="displayName"
          type="text"
          maxLength={80}
          className={inputClass}
        />
      </Field>
      {state.error ? (
        <p role="alert" className="text-xs text-blocked">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="quiet" disabled={pending}>
        {pending ? 'Creating…' : 'Create the missing profile'}
      </Button>
    </form>
  );
}
