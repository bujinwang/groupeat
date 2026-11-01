'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';

/**
 * FR-207 — the publish button, and the only place refusals are rendered as a
 * list.
 *
 * The refusals come from the server, which is the only authority on whether the
 * price clears the floor. This component's job is to show every blocking reason
 * at once rather than one per attempt: a merchant with a bad price *and* a bad
 * date should not have to fix them in two round trips.
 *
 * `payoutsReady === false` renders a link to the payouts screen instead of a
 * retry, because pressing publish again cannot help.
 */
export function PublishButton({
  dropId,
  payoutsReady,
}: {
  dropId: string;
  payoutsReady: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'publishing' }
    | { kind: 'refused'; message: string; rows: { field: string; message: string }[] }
  >({ kind: 'idle' });

  async function publish(): Promise<void> {
    setState({ kind: 'publishing' });
    try {
      const response = await fetch(`/api/merchant/drops/${dropId}/publish`, { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const fieldErrors =
          body && typeof body === 'object' && 'fieldErrors' in body
            ? ((body as { fieldErrors?: Record<string, string> }).fieldErrors ?? {})
            : {};
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That could not be published.';
        setState({
          kind: 'refused',
          message,
          rows: Object.entries(fieldErrors).map(([field, text]) => ({ field, message: text })),
        });
        return;
      }

      router.refresh();
    } catch {
      setState({
        kind: 'refused',
        message: 'We could not reach the server. Check your connection and try again.',
        rows: [],
      });
    }
  }

  return (
    <div className="space-y-3">
      {payoutsReady ? (
        <Button type="button" onClick={() => void publish()} disabled={state.kind === 'publishing'}>
          {state.kind === 'publishing' ? 'Publishing…' : 'Publish this drop'}
        </Button>
      ) : (
        <div className="rounded-lg border border-thin/30 bg-thin/5 p-3">
          <p className="text-sm font-medium text-thin">Set up payouts first.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            Diners cannot be charged until your Stripe account is ready, so publishing is blocked
            until then. It takes about five minutes.
          </p>
          <a
            href="/merchant/payouts"
            className="mt-2 inline-block text-sm font-medium text-brand underline underline-offset-4"
          >
            Go to payouts
          </a>
        </div>
      )}

      {state.kind === 'refused' ? (
        <div role="alert" className="rounded-lg border border-blocked/30 bg-blocked/5 p-3">
          <p className="text-sm font-medium text-blocked">{state.message}</p>
          {state.rows.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {state.rows.map((row) => (
                <li key={row.field} className="text-sm leading-relaxed text-ink-soft">
                  {row.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
