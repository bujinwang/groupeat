import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ForceFailControl } from '@/components/admin/ForceFailControl';
import { ParticipantRefundControl } from '@/components/admin/ParticipantRefundControl';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { isForceFailable } from '@/lib/admin/force-fail';
import { loadAdminDropDetail, type AdminDropDetail } from '@/lib/db/admin-drop-detail';
import type { AdminDropStatus } from '@/lib/db/admin-drops';
import { formatCents } from '@/lib/guardrail';
import { momentLabel } from '@/lib/time/labels';

/**
 * `/admin/drops/[id]` — the surface FR-903 never had.
 *
 * > `FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe
 * > refund created` — PRD-v1.md:550
 *
 * ## Why FR-901 alone left FR-903 unreachable
 *
 * FR-901 listed drops and put a force-fail on each — which refunds *everyone*. It had
 * no way to reach one diner, and the refund endpoint keys on a **participant** id that
 * no page rendered. So the requirement "issue a partial refund on one participant" was
 * met by a service with 11 tests and no caller a human could use: an operator's only
 * route was to read a uuid out of Postgres and `curl` it. That is exactly the gap
 * FR-901 closed for force-fail, one level down, and it is why this page is a slice
 * rather than a flourish.
 *
 * ## The two controls are different in kind, and sit at different scopes
 *
 * Force-fail is a **drop** action: it refuses participants one at a time and refunds
 * all of them. It renders once, at the top, from the same `FORCE_FAILABLE` the service
 * refuses by. A refund is a **row** action: it names one diner, moves their money, and
 * reverses a proportional slice of the platform fee. It renders per participant, and
 * each row's availability is `refusalFor`'s verdict — the sentence the server would
 * have thrown — so a row can never offer a refund the service would reject.
 *
 * ## What this page does not show
 *
 * It does not list the diners by name or phone number. The operator is identifying
 * somebody they are already talking to, so last-four is enough, and a full number on an
 * admin screen is a privacy liability with no operational benefit. It also does not
 * show the ledger: `reconcileDrop` already asserts L1–L4 on every refund, and a
 * half-rendered ledger would invite arithmetic that the assertion has already done.
 */

export const dynamic = 'force-dynamic';

const TONE: Record<AdminDropStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PUBLISHED: 'thin',
  LOCKED: 'thin',
  CAPTURED: 'ok',
  PICKUP_OPEN: 'ok',
  COMPLETED: 'neutral',
  FAILED: 'blocked',
  CANCELLED: 'blocked',
};

/** Participant charge states, ordered so the ones with money attached read first. */
const CHARGE_TONE: Record<string, BadgeTone> = {
  CAPTURED: 'ok',
  PARTIALLY_REFUNDED: 'thin',
  REFUNDED: 'neutral',
  FAILED: 'blocked',
  NONE: 'neutral',
};

function moneySummary(drop: AdminDropDetail): string {
  if (drop.capturedCents === 0 && drop.refundedCents === 0) {
    // The normal state of a published drop. Saying "$0.00" would read as a fault.
    return 'No money captured';
  }
  if (drop.capturedCents === 0) {
    return `${formatCents(drop.refundedCents)} refunded · nothing still held`;
  }
  return `${formatCents(drop.capturedCents)} still held${
    drop.refundedCents > 0 ? ` · ${formatCents(drop.refundedCents)} already back` : ''
  }`;
}

export default async function AdminDropDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const drop = await loadAdminDropDetail(id);

  if (!drop) {
    notFound();
  }

  const forceFailable = isForceFailable(drop.status);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/drops" className="text-xs text-ink-soft underline underline-offset-2">
          ← All drops
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{drop.title}</h1>
            <p className="text-xs text-ink-soft">
              {drop.merchantName} · <span className="font-mono">{drop.publicCode}</span> ·{' '}
              {formatCents(drop.dealPriceCents)}/plate
            </p>
            <p className="mt-1 text-xs text-ink-soft">
              {/* The merchant's zone, not the server's: the operator is about to say
                  this time out loud to somebody in that kitchen. */}
              Cutoff {momentLabel(drop.cutoffAt, drop.merchantTimezone)}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={TONE[drop.status as AdminDropStatus] ?? 'neutral'}>{drop.status}</Badge>
            <span className="text-xs tabular-nums text-ink-soft">
              {/* Demand as plates, not joins: the threshold compares plates. */}
              {drop.joinedQty}/{drop.minQty} plates
            </span>
          </div>
        </div>
      </div>

      <Card>
        <p className="text-sm font-medium">{moneySummary(drop)}</p>
        <p className="mt-1 text-xs text-ink-soft">
          {drop.participants.length} {drop.participants.length === 1 ? 'participant' : 'participants'}
          {drop.refundableCount > 0
            ? ` · ${drop.refundableCount} can be refunded now`
            : ' · none refundable in this state'}
        </p>
        {forceFailable ? (
          <div className="mt-3">
            <ForceFailControl
              dropId={drop.id}
              publicCode={drop.publicCode}
              title={drop.title}
              merchantName={drop.merchantName}
              status={drop.status}
              joinedQty={drop.joinedQty}
              refundableCents={drop.capturedCents}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-ink-soft">
            Force-fail is not offered for a {drop.status.toLowerCase()} drop. It appears
            once the drop has been published, and disappears while settlement holds it.
          </p>
        )}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Participants</h2>
        {drop.participants.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-soft">
              Nobody has joined yet. Refunds appear here once somebody has been charged.
            </p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {drop.participants.map((participant) => (
              <Card as="li" key={participant.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium tabular-nums">
                      {participant.phoneHint} · {participant.qty}{' '}
                      {participant.qty === 1 ? 'plate' : 'plates'}
                    </p>
                    <p className="mt-1 text-xs text-ink-soft">
                      {formatCents(participant.amountCents)} authorised · joined{' '}
                      {momentLabel(participant.joinedAt, drop.merchantTimezone)}
                      {participant.redeemedQty > 0
                        ? ` · ${participant.redeemedQty} collected`
                        : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={CHARGE_TONE[participant.chargeStatus] ?? 'neutral'}>
                      {participant.chargeStatus}
                    </Badge>
                    {participant.capturedCents !== null ? (
                      <span className="text-xs tabular-nums font-medium">
                        {formatCents(participant.capturedCents)}
                      </span>
                    ) : null}
                    {participant.refundedCents > 0 ? (
                      <span className="text-[10px] text-ink-soft">
                        {formatCents(participant.refundedCents)} back
                      </span>
                    ) : null}
                  </div>
                </div>

                <ParticipantRefundControl
                  participantId={participant.id}
                  phoneHint={participant.phoneHint}
                  qty={participant.qty}
                  chargeStatus={participant.chargeStatus}
                  capturedCents={participant.capturedCents}
                  refundedCents={participant.refundedCents}
                  refusal={participant.refusal}
                />
              </Card>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs leading-relaxed text-ink-soft">
        A refund moves one diner’s money and reverses a proportional slice of the platform
        fee. The amount Stripe actually reverses is read back from the provider rather
        than recomputed here, so the figure shown after a refund is theirs, not ours. Every
        refund writes two audit rows: what was asked and what moved.
      </p>
    </div>
  );
}
