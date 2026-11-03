import Link from 'next/link';

import { ForceFailControl } from '@/components/admin/ForceFailControl';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { isForceFailable } from '@/lib/admin/force-fail';
import {
  ADMIN_DROP_STATUSES,
  listAdminDrops,
  parseAdminDropStatus,
  type AdminDropRow,
  type AdminDropStatus,
} from '@/lib/db/admin-drops';
import { formatCents } from '@/lib/guardrail';
import { momentLabel } from '@/lib/time/labels';

/**
 * `/admin/drops` — FR-901, and the home FR-902's confirmation never had.
 *
 * > `FR-901 | List/filter all drops by status |` — PRD-v1.md:548
 *
 * ## Why this screen exists at all, when the merchant can already see their drop
 *
 * Because the operator is on a phone with a merchant who says "it's stuck". Every
 * admin capability built so far — force-fail, partial refund, impersonation — was
 * reachable only by composing an HTTP request, which means in practice not reachable.
 * `force-fail/route.ts` has carried a docblock since FR-902 saying the double
 * confirmation is "the client's" and that no client existed. This page is that client,
 * and the requirement is not met until it renders.
 *
 * ## The filter is a link, not a form
 *
 * One `?status=` parameter, so each chip is a real URL an operator can bookmark, share
 * in a support thread, or reload without losing state. A client-side filter would be
 * invisible to exactly the person this page is for — somebody being told about the
 * state over the phone.
 *
 * The counts come from a separate unfiltered read (`countsByStatus`), because a chip
 * that counted only the visible rows would always count itself. That is the usual bug
 * in a filter bar and it makes the numbers look plausible while being useless.
 *
 * ## An unparseable filter shows everything and says so
 *
 * `?status=WHATEVER` is not a 500 and not an empty list: an operator who mistypes sees
 * all drops plus a sentence naming what was ignored. A filter that silently matches
 * nothing is indistinguishable from a filter that found nothing, and on this screen the
 * difference is "there are no failed drops" versus "you are looking at the wrong list".
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

/** Statuses where an operator is most likely to need to act, listed first in the chips. */
const CHIP_ORDER: readonly AdminDropStatus[] = [
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
  'DRAFT',
];

function Chip({
  status,
  count,
  active,
}: {
  status: AdminDropStatus | null;
  count: number;
  active: boolean;
}) {
  const href = status === null ? '/admin/drops' : `/admin/drops?status=${status}`;
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${
        active
          ? 'border-brand bg-brand/10 font-semibold text-brand'
          : 'border-slate-300 text-ink-soft hover:bg-surface-muted'
      }`}
    >
      {status ?? 'All'}
      <span className="tabular-nums opacity-70">{count}</span>
    </Link>
  );
}

/**
 * What the money column says for one drop.
 *
 * Three different facts live in the same column, and collapsing them would make the
 * page lie in one of three ways:
 *
 *   - captured and not refunded → what a force-fail would return;
 *   - captured and partly refunded → the remainder, and the refund named separately
 *     rather than absorbed (the FR-903 discipline: `refundedCents` never absorbs
 *     `alreadyRefundedCents`);
 *   - nothing captured → no money at all, which is the normal state of a published
 *     drop and must not read as "$0.00 at risk" as though something went wrong.
 */
function moneyCopy(row: AdminDropRow): { headline: string; sub: string | null } {
  if (row.capturedCents === 0 && row.refundedCents === 0) {
    return { headline: '—', sub: null };
  }
  if (row.capturedCents === 0 && row.refundedCents > 0) {
    return {
      headline: formatCents(row.refundedCents),
      sub: 'all refunded',
    };
  }
  return {
    headline: formatCents(row.capturedCents),
    sub: row.refundedCents > 0 ? `${formatCents(row.refundedCents)} already back` : 'captured',
  };
}

export default async function AdminDropsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const query = await searchParams;
  const requested = query.status;
  const status = parseAdminDropStatus(requested);
  const filterIgnored = requested !== undefined && status === null;

  const list = await listAdminDrops({ status });

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">Drops</h1>
        <span className="text-xs text-ink-soft">
          {list.rows.length} shown · {formatCents(list.totalCents)} at risk
        </span>
      </div>

      {filterIgnored ? (
        <p role="status" className="rounded-lg border border-thin/40 bg-thin/5 p-2 text-xs text-ink-soft">
          “{requested}” is not a drop status, so every drop is listed. Valid:{' '}
          {ADMIN_DROP_STATUSES.join(', ')}.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Chip status={null} count={list.totalDrops} active={status === null && !filterIgnored} />
        {CHIP_ORDER.map((entry) => (
          <Chip
            key={entry}
            status={entry}
            count={list.countsByStatus[entry]}
            active={status === entry && !filterIgnored}
          />
        ))}
      </div>

      {list.rows.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-soft">
            {status
              ? `No drops are ${status} right now.`
              : 'No drops yet. A drop appears here as soon as a merchant creates one.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {list.rows.map((row) => {
            const money = moneyCopy(row);
            const forceFailable = isForceFailable(row.status);

            return (
              <Card as="li" key={row.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.title}</p>
                    <p className="text-xs text-ink-soft">
                      {row.merchantName} · <span className="font-mono">{row.publicCode}</span> ·{' '}
                      {formatCents(row.dealPriceCents)}/plate
                    </p>
                    <p className="mt-1 text-xs text-ink-soft">
                      {/* The merchant's zone, not the server's: the operator is about to
                          say this time out loud to somebody in that kitchen. */}
                      Cutoff {momentLabel(row.cutoffAt, row.merchantTimezone)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={TONE[row.status as AdminDropStatus] ?? 'neutral'}>{row.status}</Badge>
                    <span className="text-xs tabular-nums text-ink-soft">
                      {/* Demand as plates, not joins: 30 orders of 2 is the number the
                          kitchen cares about and the number the threshold compares. */}
                      {row.joinedQty}/{row.minQty} plates
                    </span>
                    <span className="text-xs tabular-nums font-medium">{money.headline}</span>
                    {money.sub ? <span className="text-[10px] text-ink-soft">{money.sub}</span> : null}
                  </div>
                </div>

                {forceFailable ? (
                  <ForceFailControl
                    dropId={row.id}
                    publicCode={row.publicCode}
                    title={row.title}
                    merchantName={row.merchantName}
                    status={row.status}
                    joinedQty={row.joinedQty}
                    refundableCents={row.capturedCents}
                  />
                ) : null}
              </Card>
            );
          })}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-ink-soft">
        Force-fail is offered where the server would accept it — drafts and
        mid-settlement drops are excluded, and that list comes from the same constant
        the service refuses by. A partial refund for a single participant is
        `POST /api/admin/participants/:id/refund` (FR-903); it has no button here yet.
      </p>
    </div>
  );
}
