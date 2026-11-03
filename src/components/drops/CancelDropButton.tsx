'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';

/**
 * FR-208 — call off a published drop.
 *
 * > `FR-208 | Merchant can cancel a PUBLISHED drop | All auths voided; participants
 * >  notified. Reason required` — PRD-v1.md:461
 *
 * ## Why the confirmation is a typed code and not a second "are you sure?"
 *
 * A dialog with two buttons is dismissed by muscle memory. The two presses FR-902
 * asks for on the admin side are a UI convention; here the merchant is closing their
 * own drop, which is irreversible and messages every diner, so the second press has
 * to require reading something. Typing the drop's code does three things at once: it
 * proves the merchant is looking at the drop they think they are, it is the same
 * token the server checks (`confirmPublicCode`), and it cannot be done by reflex
 * while reaching for "Publish".
 *
 * The panel opens on a deliberate press and is **not** the default action of the page.
 *
 * ## Why the reason is required and shown to nobody
 *
 * FR-208 says "reason required". It goes on the audit row and into the log — never
 * into the diner's SMS. `copy.ts` composes that sentence from the drop and the qty
 * alone, so a merchant writing "supplier fell through, we're embarrassed" cannot
 * accidentally send it to thirty people. That separation is why the copy file takes
 * an intent rather than free text.
 *
 * ## What this component deliberately does not do
 *
 * It does not hide the button when cancellation is impossible, because the page only
 * renders it for a `PUBLISHED` drop. A `LOCKED` or settled drop never reaches here,
 * so the "already running" refusal is a server-side guard against a race, not a state
 * this UI has to represent.
 */
export function CancelDropButton({
  dropId,
  publicCode,
  participants,
}: {
  dropId: string;
  publicCode: string;
  /** How many people are holding a plate. Named in the warning, because it is the cost. */
  participants: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'refused'; message: string; rows: { field: string; message: string }[] }
  >({ kind: 'idle' });

  const matches = code.trim() === publicCode;
  const canSubmit = matches && reason.trim().length > 0 && state.kind !== 'working';

  async function submit(): Promise<void> {
    setState({ kind: 'working' });
    try {
      const response = await fetch(`/api/merchant/drops/${dropId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmPublicCode: code.trim(), reason: reason.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const fieldErrors =
          body && typeof body === 'object' && 'fieldErrors' in body
            ? ((body as { fieldErrors?: Record<string, string> }).fieldErrors ?? {})
            : {};
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That drop could not be cancelled.';
        setState({
          kind: 'refused',
          message,
          rows: Object.entries(fieldErrors).map(([field, text]) => ({ field, message: text })),
        });
        return;
      }

      // The page renders a different branch for a cancelled drop, so a refresh is what
      // makes the outcome visible. `router.refresh()` and not a redirect: the merchant
      // is already on the right URL, and moving them would hide the new state.
      router.refresh();
      setState({ kind: 'idle' });
      setOpen(false);
    } catch {
      setState({
        kind: 'refused',
        message: 'We could not reach the server. Check your connection and try again.',
        rows: [],
      });
    }
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Call off this drop
        </Button>
        <p className="text-xs leading-relaxed text-ink-soft">
          You can cancel until the cutoff. Everyone&apos;s card is released and they are told.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-blocked/40 bg-blocked/5 p-3">
      <div>
        <p className="text-sm font-semibold text-blocked">
          {participants === 0
            ? 'Cancel this drop? Nobody has joined yet.'
            : `Cancel this drop? ${participants} ${participants === 1 ? 'person is' : 'people are'} holding ${participants === 1 ? 'a plate' : 'plates'}.`}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Their cards are released and they get a text. This cannot be undone — a cancelled
          drop cannot be republished.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="confirm-code" className="block text-sm font-medium">
          Type <span className="font-mono font-semibold">{publicCode}</span> to confirm
        </label>
        <input
          id="confirm-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-thin/40 bg-surface px-3 py-2 font-mono text-sm"
          aria-describedby="confirm-code-hint"
        />
        <p id="confirm-code-hint" className="text-xs text-ink-soft">
          {code.trim().length === 0
            ? 'This is the code in the share link.'
            : matches
              ? 'That matches.'
              : 'That does not match this drop yet.'}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="cancel-reason" className="block text-sm font-medium">
          Why are you calling it off?
        </label>
        <textarea
          id="cancel-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className="w-full rounded-lg border border-thin/40 bg-surface px-3 py-2 text-sm"
          aria-describedby="cancel-reason-hint"
        />
        <p id="cancel-reason-hint" className="text-xs text-ink-soft">
          Only for our records — diners never see this.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="danger" onClick={() => void submit()} disabled={!canSubmit}>
          {state.kind === 'working' ? 'Cancelling…' : 'Cancel this drop'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setCode('');
            setState({ kind: 'idle' });
          }}
          disabled={state.kind === 'working'}
        >
          Keep it live
        </Button>
      </div>

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
