'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { formatCents } from '@/lib/guardrail';

/**
 * FR-902's double confirmation — the half that has never existed.
 *
 * > `FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry`
 * > — PRD-v1.md:549
 *
 * The route shipped with only its server-side half. `force-fail/route.ts` says so in
 * its own docblock: *"The PRD asks for two confirmations. The **first** is the
 * client's: a dialog that names the drop and the total about to be refunded, dismissed
 * by default. The **second** is this route's: the body must carry the drop's
 * `publicCode` back."* Until this component, an operator calling the API skipped the
 * first press entirely, because nothing rendered it. A requirement that names two
 * confirmations and ships one is not met, whatever the tests say.
 *
 * ## The two presses are different in kind, and that is the point
 *
 * Press one opens the dialog. Press two is a **typed code**, not another button — a
 * dialog with two buttons is dismissed by muscle memory, and this is the largest
 * money-moving action in the product: one press can refund an entire drop. Typing the
 * code forces the operator to read which drop they are looking at, and it is the same
 * token the server verifies, so the two halves check the same fact.
 *
 * The dialog is never the default action, and it starts closed. On a list of rows, a
 * force-fail button that a double-tap can reach is a hazard.
 *
 * ## Why the total is computed by the server and passed in
 *
 * `refundableCents` comes from the row, which summed `subtotal − refunded` from the
 * `Order` table. Recomputing it here from price and quantity would show a different
 * number wherever a hand refund (FR-903) had already returned part of an order, and the
 * dialog would promise a figure the refund loop would not deliver. The dialog says
 * *approximately* out loud, because the real number is settled per order at refund time
 * and Stripe's fee reversal is its own decision (see `force-fail.ts` on
 * `ApplicationFee.amount_refunded`).
 *
 * ## What it deliberately does not do
 *
 * It does not hide itself on a drop the server would refuse — the parent decides that
 * from `FORCE_FAILABLE`, so the list and the service share one definition instead of
 * two that agree today.
 */
export function ForceFailControl({
  dropId,
  publicCode,
  title,
  merchantName,
  status,
  joinedQty,
  refundableCents,
}: {
  dropId: string;
  publicCode: string;
  title: string;
  merchantName: string;
  status: string;
  joinedQty: number;
  /** Money that moved and has not been returned. Zero is legitimate and common. */
  refundableCents: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'refused'; message: string; rows: { field: string; message: string }[] }
    | { kind: 'done'; refundedCents: number; refundedParticipants: number; alreadyCancelled: boolean }
  >({ kind: 'idle' });

  const matches = code.trim() === publicCode;
  const canSubmit = matches && reason.trim().length > 0 && state.kind !== 'working';

  async function submit(): Promise<void> {
    setState({ kind: 'working' });
    try {
      const response = await fetch(`/api/admin/drops/${dropId}/force-fail`, {
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
            : 'That drop could not be force-failed.';
        setState({
          kind: 'refused',
          message,
          rows: Object.entries(fieldErrors).map(([field, text]) => ({ field, message: text })),
        });
        return;
      }

      const result = body as {
        refundedCents?: number;
        refundedParticipants?: number;
        alreadyCancelled?: boolean;
      } | null;

      // The outcome is shown, not swallowed into a refresh. An operator who just
      // refunded a drop needs to read the number back and compare it with what they
      // expected — a silently refreshed list would leave them unsure whether it ran.
      setState({
        kind: 'done',
        refundedCents: result?.refundedCents ?? 0,
        refundedParticipants: result?.refundedParticipants ?? 0,
        alreadyCancelled: result?.alreadyCancelled ?? false,
      });
      router.refresh();
    } catch {
      setState({
        kind: 'refused',
        message: 'We could not reach the server. Check the connection and verify the drop’s state before retrying.',
        rows: [],
      });
    }
  }

  if (state.kind === 'done') {
    return (
      <div role="status" className="rounded-lg border border-ok/40 bg-ok/5 p-2">
        <p className="text-xs font-medium text-ok">
          {state.alreadyCancelled
            ? 'Already cancelled — nothing further was refunded.'
            : `Cancelled. ${formatCents(state.refundedCents)} refunded across ${state.refundedParticipants} ${state.refundedParticipants === 1 ? 'participant' : 'participants'}.`}
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
        Force-fail…
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-blocked/40 bg-blocked/5 p-3">
      <div>
        <p className="text-sm font-semibold text-blocked">Force-fail “{title}”?</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          {merchantName} · {status} · {joinedQty} joined.
          {refundableCents > 0
            ? ` Approximately ${formatCents(refundableCents)} will be refunded and the application fee reversed.`
            : ' Nothing has been captured, so no money moves — this cancels the drop and releases every hold.'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Every diner is messaged. This cannot be undone.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor={`ff-code-${dropId}`} className="block text-xs font-medium">
          Type <span className="font-mono font-semibold">{publicCode}</span> to confirm
        </label>
        <input
          id={`ff-code-${dropId}`}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-thin/40 bg-surface px-2 py-1.5 font-mono text-xs"
        />
        {code.trim().length > 0 && !matches ? (
          <p className="text-xs text-blocked">Does not match this drop.</p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={`ff-reason-${dropId}`} className="block text-xs font-medium">
          Why?
        </label>
        <textarea
          id={`ff-reason-${dropId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className="w-full rounded-lg border border-thin/40 bg-surface px-2 py-1.5 text-xs"
          placeholder="Recorded on the audit row."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="danger"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="min-h-9 px-3 text-xs"
        >
          {state.kind === 'working' ? 'Refunding…' : 'Force-fail and refund'}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            setOpen(false);
            setCode('');
            setReason('');
            setState({ kind: 'idle' });
          }}
          disabled={state.kind === 'working'}
        >
          Cancel
        </Button>
      </div>

      {state.kind === 'refused' ? (
        <div role="alert" className="rounded-lg border border-blocked/30 bg-surface p-2">
          <p className="text-xs font-medium text-blocked">{state.message}</p>
          {state.rows.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {state.rows.map((row) => (
                <li key={row.field} className="text-xs text-ink-soft">
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
