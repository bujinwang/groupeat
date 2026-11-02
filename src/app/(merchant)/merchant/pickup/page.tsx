import Link from 'next/link';

import { RedeemScanner } from '@/components/merchant/RedeemScanner';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { requireMerchant } from '@/lib/auth/authorize';
import { primaryMerchantId } from '@/lib/db/items';
import { getMerchant } from '@/lib/db/merchants';
import { listCounterDrops, loadManifest } from '@/lib/redemption/manifest';

/**
 * `/merchant/pickup` — the counter screen, FR-601…FR-605.
 *
 * ## One page, two jobs, in the order they happen
 *
 * The scanner is first because it is what a staff member opens the page to do. The
 * manifest, when a drop is selected, is below it: the batch view is for the moment
 * between diners, not for the moment one is standing there.
 *
 * `?drop=<id>` selects a manifest. Reading it from the query string rather than a
 * route segment is deliberate: this screen is bookmarked by staff on a shared
 * phone, and a bookmark that keeps working after the drop ends is a bookmark that
 * shows an empty list — which is more honest than a 404 at a counter.
 *
 * ## Why the drop list is filtered by window, not status
 *
 * `listCounterDrops` returns drops whose window is open or recently closed. See its
 * comment: the question at 6pm is "which bags are still here", and a drop that has
 * not finished is still on the warmer whatever the enum says.
 */

export const dynamic = 'force-dynamic';

function windowLabel(start: Date, end: Date, timeZone: string): string {
  const format = (date: Date): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' }).format(date);
    }
  };
  return `${format(start)} – ${format(end)}`;
}

const STATUS_LABEL: Record<string, string> = {
  CAPTURED: 'Not open yet',
  PICKUP_OPEN: 'Open',
  COMPLETED: 'Finished',
};

export default async function MerchantPickupPage({
  searchParams,
}: {
  searchParams: Promise<{ drop?: string }>;
}) {
  const { merchantIds } = await requireMerchant();
  const merchantId = await primaryMerchantId(merchantIds);
  const merchant = await getMerchant(merchantId);

  const timeZone = merchant?.timezone ?? 'America/Edmonton';
  const now = new Date();

  const drops = await listCounterDrops(merchantIds, now);
  const { drop: selectedId } = await searchParams;

  // A manifest for a drop that is not in the counter list is still loaded if the
  // caller has the id — a merchant searching for an old drop should not be limited
  // to the window filter. `loadManifest` enforces the only rule that matters: the
  // drop is theirs.
  const selected = selectedId ? await loadManifest(merchantIds, selectedId) : null;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-ink">Pickup</h1>
        <p className="text-sm text-ink-soft">
          Check a diner&apos;s code before handing over food.
        </p>
      </header>

      <Card>
        <RedeemScanner timeZone={timeZone} />
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Drops at the counter</h2>

        {drops.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No drop is at its pickup window. When one opens it will appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {drops.map((drop) => (
              <Card as="li" key={drop.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{drop.title}</p>
                  <p className="text-xs text-ink-soft">
                    {windowLabel(drop.windowStart, drop.windowEnd, timeZone)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={drop.outstanding === 0 ? 'neutral' : 'ok'}>
                    {drop.outstanding === 0
                      ? 'All collected'
                      : `${drop.outstanding} ${drop.outstanding === 1 ? 'plate' : 'plates'} left`}
                  </Badge>
                  <Link
                    href={`/merchant/pickup?drop=${drop.id}`}
                    className="text-sm text-brand underline underline-offset-4"
                  >
                    List
                  </Link>
                </div>
              </Card>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">{selected.title}</h2>
            <Badge tone={selected.status === 'PICKUP_OPEN' ? 'ok' : 'neutral'}>
              {STATUS_LABEL[selected.status] ?? selected.status}
            </Badge>
          </div>

          {/*
            Plates as well as orders. "12 of 30 collected" is checkable against the
            warmer; "4 of 9 orders" is not, because one order can be four plates.
          */}
          <p className="text-sm text-ink-soft">
            {selected.summary.collected} of {selected.summary.plates} plates collected
            {' · '}
            {selected.summary.fullyCollectedOrders} of {selected.summary.orders} orders complete
          </p>

          {selected.rows.length === 0 ? (
            <p className="text-sm text-ink-soft">Nobody joined this drop.</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-surface">
              {selected.rows.map((row) => {
                const done = row.redeemedQty >= row.qty;
                return (
                  <li key={row.participantId} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">
                        {row.name ?? 'Unnamed'}
                        <span className="text-ink-soft"> · {row.phoneLast4}</span>
                      </p>
                      <p className="text-xs text-ink-soft">
                        {row.redeemedQty} of {row.qty} collected
                      </p>
                    </div>
                    <Badge tone={done ? 'neutral' : 'thin'}>{done ? 'Collected' : 'Waiting'}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
