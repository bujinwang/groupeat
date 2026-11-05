'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';

import { addMerchantMemberAction, type AdminFormState } from '@/app/(admin)/admin/actions';

/**
 * Attaches an existing MERCHANT account to this merchant.
 *
 * The account must already exist — creating one is `/admin/users`, and keeping the two
 * actions separate means the operator sees the email-and-password rules before the
 * membership decision. The select's three options are the schema's enum; the server
 * re-validates it rather than trusting the rendered option set.
 */
const INITIAL: AdminFormState = { error: null, fieldErrors: {}, notice: null };

export function AddMerchantMemberForm({ merchantId }: { merchantId: string }) {
  const [state, formAction, pending] = useActionState(addMerchantMemberAction, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="merchantId" value={merchantId} />

      <Field
        id="memberEmail"
        label="Account email"
        helper="An existing MERCHANT account. Create it on the Users page first if it does not exist."
        error={state.fieldErrors.memberEmail}
      >
        <input
          id="memberEmail"
          name="memberEmail"
          type="email"
          required
          className={inputClass}
        />
      </Field>

      <Field id="role" label="Role" error={state.fieldErrors.role}>
        <select id="role" name="role" defaultValue="STAFF" className={inputClass}>
          <option value="STAFF">Staff — scan and redeem only</option>
          <option value="MANAGER">Manager — run this merchant</option>
          <option value="OWNER">Owner — everything, including people</option>
        </select>
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

      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Adding…' : 'Add to merchant'}
      </Button>
    </form>
  );
}
