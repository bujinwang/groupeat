'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/Button';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { formatCents } from '@/lib/guardrail';

/**
 * FR-903's missing half — one participant, one partial refund.
 *
 * > `FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe
 * > refund created` — PRD-v1.md:550
 *
 * ## What was actually missing
 *
 * The acceptance criterion is server-side and was met four slices ago: the ledger is
 * adjusted, the Stripe refund is created, the CAS and the `@@unique([orderId, type])`
 * index stop a double refund, and 11 tests run it against real Postgres. What did not
 * exist is a human being able to do it. `refund/route.ts` keys on a **participant**
 * id, and until this slice no page rendered one — so the only way to issue a refund
 * was to read a uuid out of the database and `curl` it. That is the same defect
 * FR-901 closed for force-fail, and marking FR-903 ✅ while it stood was the same
 * overstatement.
 *
 * ## The disabled state carries the server's own sentence
 *
 * `refusal` is not computed here. It is `refusalFor(...).publicMessage` from
 * `refunds/participant-refund.ts` — the function `issueParticipantRefund` refuses by
 * — rendered as the reason a row cannot be refunded. A local predicate would agree
 * today and drift the first time a guard was added, and a button that can only
 * produce a 409 teaches the operator that the screen is broken.
 *
 * ## Why the amount is pre-filled with the whole order
 *
 * "Partial" is the requirement, not the default. An operator refunding because a diner
 * got the wrong dish almost always means all of it, and making them type the number
 * they are looking at is an opportunity to typo a cents value. `MoneyInput` parses to
 * integer cents through the same `parseMoneyToCents` the merchant forms use, so no
 * float ever touches the money path.
 *
 * ## Why the outcome is rendered instead of a refresh
 *
 * A refund moves one diner's money and reverses a slice of the platform fee. The
 * operator needs to read back *what moved* and compare it with what they intended;
 * a silently refreshed row would leave them unable to tell whether the reversal was
 * proportional or something else. `ALREADY_REFUNDED` is reported as its own outcome,
 * not as success with a zero — it means the money was already back, which is a
 * different fact from "this call refunded it".
 */
export function ParticipantRefundControl({
  participantId,
  phoneHint,
  qty,
  chargeStatus,
  capturedCents,
  refundedCents,
  refusal,
}: {
  participantId: string;
  phoneHint: string;
  qty: number;
  chargeStatus: string;
  /** What is still held against their order. `null` when they were never charged. */
  capturedCents: number | null;
  refundedCents: number;
  /** `null` when a refund may proceed; otherwise the sentence the server would throw. */
  refusal: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amountCents, setAmountCents] = useState<number | null>(capturedCents);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'working' }
    | { kind: 'refused'; message: string; fieldErrors: { field: string; message: string }[] }
    | {
        kind: 'done';
        alreadyRefunded: boolean;
        refundedCents: number;
        feeReversedCents: number;
      }
  >({ kind: 'idle' });

  const positive = amountCents !== null && amountCents > 0;
  const withinCharge = capturedCents === null || (amountCents ?? 0) <= capturedCents;
  const canSubmit =
    positive && withinCharge && reason.trim().length > 0 && state.kind !== 'working';

  async function submit(): Promise<void> {
    if (amountCents === null) {
      return;
    }
    setState({ kind: 'working' });
    try {
      const response = await fetch(`/api/admin/participants/${participantId}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Omitted when it equals the whole order, so the server's own default is
          // exercised rather than a number the browser recomputed.
          ...(capturedCents !== null && amountCents === capturedCents ? {} : { amountCents }),
          reason: reason.trim(),
        }),
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
            : 'That refund could not be created.';
        setState({
          kind: 'refused',
          message,
          fieldErrors: Object.entries(fieldErrors).map(([field, text]) => ({
            field,
            message: text,
          })),
        });
        return;
      }

      const result = body as {
        kind?: string;
        refundedCents?: number;
        platformFeeReversedCents?: number;
      } | null;

      setState({
        kind: 'done',
        alreadyRefunded: result?.kind === 'ALREADY_REFUNDED',
        refundedCents: result?.refundedCents ?? 0,
        feeReversedCents: result?.platformFeeReversedCents ?? 0,
      });
      router.refresh();
    } catch {
      setState({
        kind: 'refused',
        message:
          'We could not reach the server. Check the connection and verify this diner’s charge before retrying.',
        fieldErrors: [],
      });
    }
  }

  if (state.kind === 'done') {
    return (
      <div role="status" className="mt-2 rounded-lg border border-ok/40 bg-ok/5 p-2">
        <p className="text-xs font-medium text-ok">
          {state.alreadyRefunded
            ? 'Already refunded — the money was back before this request, so nothing changed.'
            : `${formatCents(state.refundedCents)} refunded. ${formatCents(state.feeReversedCents)} of the platform fee reversed.`}
        </p>
      </div>
    );
  }

  if (refusal !== null) {
    // The sentence is the server's own. Not a button with a tooltip, because a disabled
    // control with no visible explanation is indistinguishable from a broken one.
    return (
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
        <span className="font-medium">No refund available.</span> {refusal}
      </p>
    );
  }

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
          Refund…
        </Button>
        <span className="text-xs text-ink-soft">
          {capturedCents === null
            ? 'Nothing captured'
            : `${formatCents(capturedCents)} held${refundedCents > 0 ? ` · ${formatCents(refundedCents)} already back` : ''}`}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-thin/50 bg-surface-muted/40 p-3">
      <div>
        <p className="text-sm font-semibold">
          Refund {phoneHint} · {qty} {qty === 1 ? 'plate' : 'plates'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Charged {chargeStatus.toLowerCase()}
          {capturedCents !== null ? ` · ${formatCents(capturedCents)} still held` : ''}.
          {refundedCents > 0 ? ` ${formatCents(refundedCents)} has already been returned.` : ''}
        </p>
        {refundedCents > 0 ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">
            V1 allows one refund per order, so this one may be refused.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={`refund-amount-${participantId}`} className="block text-xs font-medium">
          Amount
        </label>
        <MoneyInput
          id={`refund-amount-${participantId}`}
          valueCents={amountCents}
          onChangeCents={setAmountCents}
          invalid={!positive || !withinCharge}
        />
        {capturedCents !== null && !withinCharge ? (
          <p className="text-xs text-blocked">
            More than the {formatCents(capturedCents)} still held.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={`refund-reason-${participantId}`} className="block text-xs font-medium">
          Why?
        </label>
        <textarea
          id={`refund-reason-${participantId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className="w-full rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-xs"
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
          {state.kind === 'working' ? 'Refunding…' : 'Issue refund'}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            setOpen(false);
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
          {state.fieldErrors.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {state.fieldErrors.map((row) => (
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
