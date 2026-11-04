import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { JoinForm, PaymentsNotConfigured } from '@/components/public/JoinForm';
import { formatCents } from '@/lib/guardrail';
import { joinConfirmationCopy } from '@/lib/join/rules';
import { SHARE_TOKEN_PARAM } from '@/lib/organisers/share-link';
import { resolveDropView } from '@/lib/public/drop-view';
import { getPublicDrop } from '@/lib/public/public-drops';
import { socialCardOrigin } from '@/lib/metadata/social-card';

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

  /**
   * The share card, suppressed on the same condition the deal page uses.
   *
   * This page never declared an `openGraph` object, so the omission looked harmless —
   * and was not. The card is a **file convention**
   * (`d/[publicCode]/opengraph-image.tsx`), and Next resolves it against the directory,
   * not against the page: a sibling route that declares no `openGraph` still gets
   * `og:image` auto-filled. Measured on a production build with no `APP_URL` — the exact
   * state `social-card.ts` exists for:
   *
   *   /d/8EN9AJCA       og:image → (absent, suppressed)                    ✔
   *   /d/8EN9AJCA/join  og:image → http://localhost:3201/…/opengraph-image  ✘
   *
   * The second row is a join step a real person can be sent to, previewing itself with a
   * laptop URL. D1 fixed the page it was looking at and this one was outside its field of
   * view, which is the recurring shape in this repo: a correct decision that only some of
   * its callers make.
   *
   * It is written here rather than shared with the deal page through a helper because the
   * two pages genuinely differ in title and in what they describe; what they must not
   * differ in is whether they leak the origin. `images: []` and not `undefined`, for the
   * reason the deal page's docblock gives: an omitted key is indistinguishable from the
   * key never having been added, so a refactor that deleted this would pass an
   * `undefined` assertion.
   */
  const cardSuppression =
    socialCardOrigin().kind === 'unavailable' ? { images: [] } : {};

  return {
    // A join page is not a destination — it is a step. Indexing it would put a card
    // form in search results for an offer that has expired by the time anyone clicks.
    title: drop ? `Join — ${drop.title}` : 'Join — GroupEat',
    robots: { index: false, follow: false },
    /**
     * Spread the suppression in, rather than always emitting `openGraph` / `twitter`.
     *
     * This is measured, and it cost a regression to learn. Writing
     * `openGraph: { ...cardSuppression }` unconditionally emits an `openGraph` object
     * with no `images` key in the healthy case — and `mergeStaticMetadata` autofills the
     * convention image only when the metadata item at that level does **not** have its
     * own such object with `images`. An empty object is enough to stop the autofill:
     *
     *   APP_URL=https://groupeat.ca
     *     spread-in     → /d/8EN9AJCA/join  og:image=https://groupeat.ca/… ✔
     *     always-emit   → /d/8EN9AJCA/join  og:image=(absent)              ✘
     *
     * The deal page never hit this because its healthy branch sets `openGraph` with a
     * title and description *and* inherits the card through them. A page with no
     * `openGraph` of its own has no such cover, so for this page the key has to be
     * absent, not empty. FR-308 is the launch blocker; deleting its card to fix a
     * suppressed one would have been the worse trade.
     */
    ...(cardSuppression.images
      ? { openGraph: { ...cardSuppression }, twitter: { ...cardSuppression } }
      : {}),
  };
}

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicCode: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicCode } = await params;
  const query = await searchParams;
  const drop = await getPublicDrop(publicCode);

  if (!drop) {
    // Same answer for a draft, a deleted drop and a mistyped code.
    notFound();
  }

  /**
   * FR-802. The organiser's token, carried from the deal page's join button.
   *
   * Shape-checked only. It is deliberately **not** resolved to a share link here: this
   * page must render for anyone, and a token naming a different drop, or no drop at
   * all, is not a reason to refuse a diner the form. The join service resolves it
   * against the drop it is joining and ignores it if it does not belong — which is the
   * only place that can tell, because it is the only place that knows the drop id.
   *
   * Passed through unchanged rather than dropped when it looks wrong: a token that
   * arrives malformed is the server's to reject (silently), and second-guessing it in
   * two places is how the two places come to disagree.
   */
  const rawToken = query[SHARE_TOKEN_PARAM];
  const organiserToken = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : undefined;

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
            organiserToken={organiserToken}
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
