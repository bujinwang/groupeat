import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { JoinForm, PaymentsNotConfigured } from '@/components/public/JoinForm';
import { formatCents } from '@/lib/guardrail';
import { joinConfirmationCopy } from '@/lib/join/rules';
import { resolveDropView } from '@/lib/public/drop-view';
import { getPublicDrop } from '@/lib/public/public-drops';

/**
 * `/d/:publicCode/join` — the join page (M4 slice 2b).
 *
 * ## Why a separate page rather than a form on the deal page
 *
 * The deal page has one job after the tap: make the offer legible in under five
 * seconds with no JavaScript (FR-301). A card form is the opposite of that — it is
 * the heaviest interactive thing in the product, it needs Stripe.js, and putting it
 * on the deal page would make the page's first load depend on a third-party script
 * for every visitor, including the majority who only look.
 *
 * Splitting it keeps both promises: the deal page stays a fast static read, and this
 * page can be as interactive as it needs to be.
 *
 * ## Server-rendered, client-interactive
 *
 * Everything that can be decided here is decided here: whether the drop is open,
 * what the price is, the quantity limits, and the FR-407 disclosure sentence. The
 * client component receives finished strings — `priceLabel`, `chargeDisclosure` — and
 * prints them. That is the CONTRIBUTING rule about money being a type signature,
 * applied to a page boundary: the component never formats a number, so it cannot
 * disagree with the server about one.
 *
 * ## Degrading without Stripe keys
 *
 * If `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is absent the page renders
 * `PaymentsNotConfigured` instead of a form. That is the honest state for this
 * deployment — and the reason 2b can ship before the keys exist. The deal page's
 * `JOIN_FLOW_PROVEN_LIVE` is a separate gate and stays `false` until a live join has
 * actually been run, because "the page exists" and "a card can be held" are different
 * claims.
 */

export const dynamic = 'force-dynamic';

/** Same shape as the deal page's labels; kept local so the two pages cannot drift. */
function momentLabel(instant: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${day} ${time.format(instant)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicCode: string }>;
}): Promise<Metadata> {
  const { publicCode } = await params;
  const drop = await getPublicDrop(publicCode);

  return {
    // A join page is not a destination — it is a step. Indexing it would put a card
    // form in search results for an offer that has expired by the time anyone clicks.
    title: drop ? `Join — ${drop.title}` : 'Join — GroupEat',
    robots: { index: false, follow: false },
  };
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ publicCode: string }>;
}) {
  const { publicCode } = await params;
  const drop = await getPublicDrop(publicCode);

  if (!drop) {
    // Same answer for a draft, a deleted drop and a mistyped code.
    notFound();
  }

  const view = resolveDropView({
    status: drop.status,
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    cutoffAt: drop.cutoffAt,
    windowStart: drop.windowStart,
    windowEnd: drop.windowEnd,
    joinedQty: drop.joinedQty,
    now: new Date(),
    hadCaptures: drop.hadCaptures,
  });

  // The join page is only meaningful while an offer is open. Past the cutoff a diner
  // who followed a stale link should be told so and sent back, not shown a form that
  // will be refused on submit.
  if (!view.canJoin) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <h1 className="text-xl font-semibold text-ink">{drop.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {view.offerPhase === 'FAILED'
            ? 'This drop did not reach its minimum, so nothing was charged and the kitchen is not making it.'
            : view.offerPhase === 'CANCELLED'
              ? // A diner who followed a stale join link needs the decision, not the
                // deadline: "the last moment to order was Thursday" invites them to
                // wonder what they did wrong.
                view.hadCaptures
                ? 'The restaurant called this drop off. Anyone who paid has been refunded in full.'
                : 'The restaurant called this drop off. Nothing was charged to any card.'
              : `Joining has closed for this drop. ${momentLabel(drop.cutoffAt, drop.timeZone)} was the last moment to order.`}
        </p>
        <Link
          href={`/d/${drop.publicCode}`}
          className="mt-6 flex min-h-12 w-full items-center justify-center rounded-lg border border-slate-300 px-4 text-base font-medium text-ink"
        >
          Back to the offer
        </Link>
      </main>
    );
  }

  const priceLabel = formatCents(drop.dealPriceCents);
  const closesLabel = momentLabel(drop.cutoffAt, drop.timeZone);

  // FR-407. Built here, from the same helper the confirmation state uses, so the
  // promise made before the tap and the one repeated after it cannot disagree.
  // `isConfirmedAlready` is false on this page: whether the drop has already reached
  // its minimum is a property of the drop at submit time, and the confirmation
  // re-renders with the server's answer.
  const chargeDisclosure = joinConfirmationCopy({
    qty: 1,
    amountLabel: priceLabel,
    minQty: drop.minQty,
    closesLabel,
    isConfirmedAlready: view.offerPhase === 'CONFIRMED',
  });

  const publishableKeyConfigured = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <Link href={`/d/${drop.publicCode}`} className="text-sm text-ink-soft underline">
        ← {drop.merchantName}
      </Link>

      <header className="mt-3">
        <h1 className="text-xl font-semibold leading-snug text-ink">{drop.title}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Pickup {momentLabel(drop.windowStart, drop.timeZone)} · {drop.merchantName}
        </p>
      </header>

      <div className="mt-4">
        {publishableKeyConfigured ? (
          <JoinForm
            publicCode={drop.publicCode}
            priceLabel={priceLabel}
            minQty={drop.minQty}
            maxQty={drop.maxQty}
            maxPerCustomer={drop.maxPerCustomer}
            chargeDisclosure={chargeDisclosure}
          />
        ) : (
          <PaymentsNotConfigured priceLabel={priceLabel} />
        )}
      </div>

      <p className="mt-6 text-center text-xs leading-relaxed text-ink-soft">
        Card details go straight to Stripe. GroupEat never sees your card number.
      </p>
    </main>
  );
}
