import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CancelDropButton } from '@/components/drops/CancelDropButton';
import { DropForm, type DishOption } from '@/components/drops/DropForm';
import { PublishButton } from '@/components/drops/PublishButton';
import { requireMerchant } from '@/lib/auth/authorize';
import { countJoinedQty, findDrop } from '@/lib/db/drops';
import { listItems } from '@/lib/db/items';
import { primaryMerchantFloor } from '@/lib/db/merchants';
import { reviewForPublish } from '@/lib/drops/publish';
import {
  DEFAULT_FEES,
  formatCents,
  minViablePrice,
  readGuardrailSnapshot,
  snapshotBreakdown,
} from '@/lib/guardrail';
import { readOnboarding } from '@/lib/payments/onboarding-service';

/**
 * `/merchant/drops/:id` — review a draft, or look at a published drop.
 *
 * Two modes, and the difference is `status`:
 *
 *   - **Draft.** The form is editable, the blocking problems are listed from
 *     `reviewForPublish` (the same function publish runs, so the preview cannot
 *     disagree with the server), and the publish button sits below.
 *   - **Anything else.** Read-only. The terms are frozen, and for a published
 *     drop the money shown comes from the snapshot — never recomputed.
 *
 * That second point is FR-207 in the UI: a published drop's page must not
 * re-evaluate the guardrail, because the dish may have changed since.
 *
 * ## FR-206's preview is the real public page, not a second rendering
 *
 * The draft branch links to `/d/{publicCode}?preview=1`. That URL is served by the
 * public page module with a merchant-scoped `DRAFT` read — the same component, the
 * same copy and the same numbers a diner will see after publishing. A merchant who
 * previewed a separate "preview screen" would be reviewing an artefact that does not
 * exist, and the two would drift the first time either changed.
 */

export const dynamic = 'force-dynamic';

/** `datetime-local` needs local time without an offset. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default async function DropDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { merchantIds } = await requireMerchant();
  const { id } = await params;

  const drop = await findDrop(merchantIds, id);
  if (!drop) {
    notFound();
  }

  const [items, floor, joinedQty] = await Promise.all([
    listItems(merchantIds),
    primaryMerchantFloor(merchantIds),
    // Only the published branch renders it, but reading it unconditionally keeps the
    // page's data loading in one place instead of branching the `await` — and the query
    // is a scoped index read either way.
    countJoinedQty(merchantIds, drop.id),
  ]);
  const dishes: DishOption[] = items
    .filter((item) => item.isBatchable && !item.containsAlcohol)
    .map((item) => ({
      id: item.id,
      name: item.name,
      menuPriceCents: item.menuPriceCents,
      batchYield: item.batchYield,
      minViablePriceCents: minViablePrice({
        ...DEFAULT_FEES,
        menuPriceCents: item.menuPriceCents,
        foodCostCents: item.foodCostCents,
        packagingCents: item.packagingCents,
        floorPctOfMenu: floor.floorPctOfMenu,
      }),
    }));

  const itemName = items.find((item) => item.id === drop.menuItemId)?.name ?? 'Dish';

  if (drop.status === 'DRAFT') {
    const review = await reviewForPublish({ drop, now: new Date() });

    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{drop.title}</h1>
            <p className="mt-1 text-sm text-ink-soft">
              Draft · {itemName} · {formatCents(drop.dealPriceCents)} per plate
            </p>
          </div>
          <Badge tone="neutral">Draft</Badge>
        </div>

        {review.refusals.length > 0 ? (
          <Card>
            <h2 className="text-sm font-semibold">Before this can go live</h2>
            <ul className="mt-2 space-y-1">
              {review.refusals.map((refusal) => (
                <li key={refusal.reason} className="text-sm leading-relaxed text-ink-soft">
                  {refusal.message}
                  {Object.entries(refusal.fieldErrors).map(([field, text]) => (
                    <span key={field} className="mt-1 block text-sm text-blocked">
                      {text}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Details</h2>
          <DropForm
            dishes={dishes}
            dropId={drop.id}
            submitLabel="Save changes"
            initial={{
              menuItemId: drop.menuItemId,
              title: drop.title,
              description: drop.description ?? '',
              dealPriceCents: drop.dealPriceCents,
              minQty: drop.minQty,
              maxQty: drop.maxQty,
              cutoffAt: toLocalInput(drop.cutoffAt),
              windowStart: toLocalInput(drop.windowStart),
              windowEnd: toLocalInput(drop.windowEnd),
            }}
          />
        </Card>

        <Card>
          <h2 className="text-sm font-semibold">Preview</h2>
          <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-soft">
            See the actual deal page — the same one diners will reach after you publish.
            Only you can open this link, and joining is disabled.
          </p>
          <a
            href={`/d/${drop.publicCode}?preview=1`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-muted"
          >
            Open preview
          </a>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold">Publish</h2>
          <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-soft">
            Publishing freezes the numbers for this drop. Later changes to the dish will not alter
            what this drop earns.
          </p>
          <PublishButton
            dropId={drop.id}
            payoutsReady={(await readOnboarding({ merchantId: drop.merchantId })).state === 'READY'}
          />
        </Card>
      </div>
    );
  }

  // Published: read-only, and the money comes from the frozen snapshot.
  //
  // Not from `buildDealView` against the current dish. That was my first draft
  // and it was wrong in the most expensive possible way: the dish may have been
  // edited since publish, and a view rebuilt now would silently report a
  // different contribution than the one this drop actually earned. The snapshot
  // is the record; `snapshotBreakdown` renders it with the fee constants that
  // were in force at publish.
  const snapshot = readGuardrailSnapshot(drop.guardrailSnapshot);
  const breakdown = snapshotBreakdown(snapshot);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{drop.title}</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {itemName} · {formatCents(snapshot.result.dealPriceCents)} per plate · need {drop.minQty}
          </p>
        </div>
        <Badge tone="ok">{drop.status === 'PUBLISHED' ? 'Live' : drop.status}</Badge>
      </div>

      <Card>
        <h2 className="text-sm font-semibold">This drop is live</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Its terms are frozen. Share the link to fill it.
        </p>
        <p className="mt-2 break-all rounded-lg bg-slate-100 p-2 text-xs text-ink-soft">
          /d/{drop.publicCode}
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">What you keep</h2>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {formatCents(breakdown.netContributionCents)}
          <span className="ml-1 text-sm font-normal text-ink-soft">per plate</span>
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          After ingredients ({formatCents(breakdown.ingredientsAndPackagingCents)}), card fees (
          {formatCents(breakdown.cardFeeCents)}) and the GroupEat fee (
          {formatCents(breakdown.platformFeeCents)}). These are the figures frozen when you
          published.
        </p>
      </Card>

      {/*
        FR-208. Only a `PUBLISHED` drop gets this card: `LOCKED` is mid-settlement (the
        cutoff passed and the money is moving), and everything after it has already run.
        Offering the button in those states would be offering something the server
        refuses, and the refusal sentence — "the cutoff has passed" — reads much better
        than a button that cannot work.
      */}
      {drop.status === 'PUBLISHED' ? (
        <Card>
          <h2 className="text-sm font-semibold">Call it off</h2>
          <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-soft">
            Until the cutoff you can cancel. Everyone&apos;s card is released, and they are told.
            Nothing is charged and nothing is refunded, because nothing was ever taken.
          </p>
          <CancelDropButton
            dropId={drop.id}
            publicCode={drop.publicCode}
            participants={joinedQty}
          />
        </Card>
      ) : null}

      {drop.status === 'CANCELLED' ? (
        <Card>
          <h2 className="text-sm font-semibold">This drop was called off</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            Every card that was holding a plate has been released, and everyone who joined has
            been told. Nothing was charged. A cancelled drop cannot be republished — start a new
            one if you want to run it again.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
