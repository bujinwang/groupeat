'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { createUserAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * US-A1 — create an account. Every account is bootstrapped with a temporary
 * password and `mustChangePassword = true` (there is no email delivery until M2).
 *
 * ## Why the organiser fields are conditional
 *
 * FR-906. An organiser is the only role that needs a `displayName` — it is non-null on
 * `OrganiserProfile` and it is the name a diner reads next to a share link. Showing
 * the field for every role would make it look optional (three roles out of four do not
 * use it), and an operator who filled it in for a merchant would reasonably expect it
 * to be saved somewhere.
 *
 * So the extra inputs render only when `role === 'ORGANISER'`, and the server action
 * *re-validates* the requirement rather than trusting that they were rendered. A
 * conditional field is a UI affordance, not an authorisation check.
 *
 * The client-side `required` attribute is deliberately not used: it would block
 * submission on a role switch mid-form, and the server's sentence is better than the
 * browser's bubble because it names the consequence.
 */
const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, INITIAL);
  // Controlled, because the shape of the form now depends on its own value. The
  // server action still reads everything from `FormData` — this state exists only to
  // decide what to render.
  const [role, setRole] = useState('MERCHANT');
  const isOrganiser = role === 'ORGANISER';

  return (
    <form action={formAction} className="space-y-4">
      <Field id="new-user-email" label="Email" error={state.fieldErrors.email}>
        <input id="new-user-email" name="email" type="email" required className={inputClass} />
      </Field>

      {isOrganiser ? null : (
        <Field id="new-user-name" label="Name (optional)">
          <input id="new-user-name" name="name" type="text" className={inputClass} />
        </Field>
      )}

      <Field id="new-user-role" label="Role" error={state.fieldErrors.role}>
        <select
          id="new-user-role"
          name="role"
          className={inputClass}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="MERCHANT">Merchant</option>
          <option value="ORGANISER">Organiser</option>
          <option value="ADMIN">Admin</option>
        </select>
      </Field>

      {isOrganiser ? (
        <>
          <Field
            id="new-user-display-name"
            label="Display name"
            helper="Shown to diners next to this organiser’s share links. Required."
            error={state.fieldErrors.displayName}
          >
            <input
              id="new-user-display-name"
              name="displayName"
              type="text"
              maxLength={80}
              className={inputClass}
            />
          </Field>

          <Field
            id="new-user-phone"
            label="Phone (optional)"
            helper="Used by ops to reach them. Never shown to a diner."
            error={state.fieldErrors.phone}
          >
            <input id="new-user-phone" name="phone" type="tel" maxLength={32} className={inputClass} />
          </Field>

          <Field
            id="new-user-commission"
            label="Commission % (optional)"
            helper="Leave blank for the default of 5%. Recorded only — V1 does not pay organisers automatically."
            error={state.fieldErrors.commissionPct}
          >
            <input
              id="new-user-commission"
              name="commissionPct"
              type="text"
              inputMode="decimal"
              placeholder="5"
              className={inputClass}
            />
          </Field>
        </>
      ) : null}

      <Field
        id="new-user-password"
        label="Temporary password"
        helper="At least 12 characters, with a letter and a number. They must change it on first sign-in."
        error={state.fieldErrors.password}
      >
        <input
          id="new-user-password"
          name="password"
          type="text"
          required
          minLength={12}
          className={inputClass}
        />
      </Field>

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

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : isOrganiser ? 'Create organiser' : 'Create user'}
      </Button>
    </form>
  );
}
