import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { dealPageViewEvent } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { CountPoller, type CountSnapshot } from '@/components/public/CountPoller';
import { formatCents } from '@/lib/guardrail';
import { headlineFor, resolveDropView, type DropView } from '@/lib/public/drop-view';
import { resolveJoinGate } from '@/lib/public/join-gate';
import { getPublicDrop } from '@/lib/public/public-drops';

/**
 * `/d/:publicCode` — the deal page (PRD-v1 §6.3, FR-301…FR-308).
 *
 * ## This page is the distribution
 *
 * There is no feed and no discovery. A drop reaches people because somebody
 * pastes this URL into a group chat, so the page has exactly one job after the
 * tap: make the offer legible in under five seconds on a phone, with no account,
 * no app, and no JavaScript. Everything that is not that is somewhere else.
 *
 * ## Why it is fully server-rendered
 *
 * FR-301: "works with JS disabled for core content". So the price, the window,
 * the address and the state are in the initial HTML. The only client component is
 * the counter (`CountPoller`), and if it never loads the page is still correct —
 * just with a number that does not tick.
 *
 * ## Why `menuPriceCents` comes from the snapshot
 *
 * The "was $16.00" is not decoration; it is a price representation under the
 * Competition Act (PRD-v1 §15.2). It has to be the price that was true when the
 * offer was struck, which is what the frozen `guardrailSnapshot` holds — not
 * whatever the merchant typed into the dish this morning.
 */

export const dynamic = 'force-dynamic';

/**
 * Whether the join flow has been proven against Stripe.
 *
 * The page and the API both exist as of 2b (`/d/[publicCode]/join` renders, and
 * `/api/public/drops/[code]/intent` quotes). This flag is therefore **not** about
 * missing code any more — it is about the one claim nothing here can support:
 * `join/real-payment-port.ts` has never executed against Stripe, because there is
 * no key on this machine, so no card has ever been held. A green suite means the
 * fake works.
 *
 * Flipping it is a judgement call about evidence, not a product decision, and the
 * evidence needed is one live run: join → `AUTHORIZED` → no `CHARGE` row → the
 * confirmation renders.
 *
 * It is combined with the publishable-key check by `resolveJoinGate`
 * (`src/lib/public/join-gate.ts`), which is unit-tested — this constant is the
 * evidence half, and that module's tests pin the rule that keys alone cannot open
 * the button.
 */
const JOIN_FLOW_PROVEN_LIVE = false;

/** Deduplicates the lookup between `generateMetadata` and the page body. */
const loadDrop = cache(async (publicCode: string) => getPublicDrop(publicCode));

function windowLabel(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(start);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${day}, ${time.format(start)} – ${time.format(end)}`;
}

function momentLabel(instant: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${day} ${time.format(instant)}`;
}

function countSnapshotOf(view: DropView, minQty: number): CountSnapshot {
  return {
    headline: headlineFor(view, minQty),
    joinedQty: view.joinedQty,
    minQty: view.minQty,
    maxQty: view.maxQty,
    remainingQty: view.remainingQty,
    progress: view.progress,
    showScarcity: view.showScarcity,
    offerPhase: view.offerPhase,
    canJoin: view.canJoin,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicCode: string }>;
}): Promise<Metadata> {
  const { publicCode } = await params;
  const drop = await loadDrop(publicCode);

  if (!drop) {
    return { title: 'Drop not found — GroupEat' };
  }

  const saving = drop.menuPriceCents - drop.dealPriceCents;
  // "Beef Bowl from Beef Bowl" is what a restaurant named after its own dish
  // produces. The same guard as the share message in `lib/ai/plan.ts`, for the
  // same reason: a preview that reads like a failed template costs a tap.
  const from =
    drop.merchantName.trim().toLowerCase() === drop.itemName.trim().toLowerCase()
      ? ''
      : ` from ${drop.merchantName}`;
  // The link preview is the whole funnel (FR-308), so the title states the offer
  // and the price rather than the restaurant's name. Somebody deciding whether to
  // tap needs "$11.15, Tuesday 2–4pm", not "Golden Dragon".
  const title = `${drop.title} — ${formatCents(drop.dealPriceCents)}`;
  const description =
    `${drop.itemName}${from}. ` +
    `${formatCents(drop.dealPriceCents)} a plate, was ${formatCents(drop.menuPriceCents)}` +
    `${saving > 0 ? ` (save ${formatCents(saving)})` : ''}. ` +
    `Pickup ${windowLabel(drop.windowStart, drop.windowEnd, drop.timeZone)}. ` +
    `Nobody is charged unless ${drop.minQty} orders come in.`;

  return {
    title,
    description,
    // A dated batch offer is not a durable page, and its URL is a bearer token
    // handed out in group chats. Indexing it adds nothing and leaves an expired
    // price in search results.
    robots: { index: false, follow: false },
    openGraph: {
      type: 'website',
      title,
      description,
      siteName: 'GroupEat',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default async function PublicDropPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicCode: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicCode } = await params;
  const drop = await loadDrop(publicCode);

  if (!drop) {
    // Drafts, deleted drops and mistyped codes all land here. One answer for all
    // three, so a guessed code cannot reveal that a draft exists.
    notFound();
  }

  // `deal_page_viewed` is the denominator of PRD §10.2's join-conversion target.
  // Fired here — after the not-found gate — rather than in `generateMetadata`, which
  // also runs for a page that 404s and would count a mistyped code as a visit.
  //
  // The decision (fetcher or reader, which source) lives in `funnel.ts` so it can be
  // tested without a server-component harness. `record` swallows sink failures, so a
  // full disk cannot turn a diner's page load into an error — which matters more
  // here than anywhere else in the app.
  const requestHeaders = await headers();
  record(
    dealPageViewEvent({
      dropId: drop.id,
      merchantId: drop.merchantId,
      headers: requestHeaders,
      query: await searchParams,
    }),
  );

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

  const hero = drop.heroImageUrl ?? drop.itemPhotoUrl;
  const discountPct = Math.round(
    ((drop.menuPriceCents - drop.dealPriceCents) / drop.menuPriceCents) * 100,
  );

  /**
   * The capability gate: can this deployment take a card at all?
   *
   * Read the same way `/d/[publicCode]/join` reads it, so the button and the page it
   * links to can never disagree about whether payments work. Server-side only — no
   * `NEXT_PUBLIC_`-prefixed value needs to reach the browser to decide this, and the
   * button is rendered disabled rather than hydrated into a disabled state.
   */
  const stripeConfigured = Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
  const joinGate = resolveJoinGate({
    canJoin: view.canJoin,
    stripeConfigured,
    provenLive: JOIN_FLOW_PROVEN_LIVE,
  });

  return (
    <article className="space-y-4">
      {hero ? (
        // Plain <img> rather than next/image: the URL is merchant-supplied, so the
        // optimiser would need every host allow-listed, and the hero is already
        // sized by the source. `eager` because this is the LCP element (FR-301).
        <img
          src={hero}
          alt={drop.itemName}
          width={420}
          height={236}
          className="h-[236px] w-full rounded-xl object-cover"
          loading="eager"
        />
      ) : null}

      <header>
        <p className="text-sm text-ink-soft">{drop.merchantName}</p>
        <h1 className="mt-1 text-xl font-semibold leading-snug text-ink">{drop.title}</h1>
      </header>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-ink">{formatCents(drop.dealPriceCents)}</span>
        <span className="text-sm text-ink-soft">a plate</span>
        {discountPct > 0 ? (
          <span className="ml-auto rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
            {discountPct}% off {formatCents(drop.menuPriceCents)}
          </span>
        ) : null}
      </div>

      {drop.description ? (
        <p className="text-sm leading-relaxed text-ink-soft">{drop.description}</p>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-surface p-4">
        <CountPoller publicCode={drop.publicCode} initial={countSnapshotOf(view, drop.minQty)} />

        {view.canJoin ? (
          <p className="mt-2 text-sm text-ink-soft">
            {view.offerPhase === 'CONFIRMED'
              ? // ADR-003: the drop is running and still filling. Saying only
                // "confirmed" would let a diner think the door had shut, and would
                // let the merchant think the count was final.
                `The kitchen is on. More can join until ${momentLabel(drop.cutoffAt, drop.timeZone)}, up to ${drop.maxQty}.`
              : `Joining closes ${momentLabel(drop.cutoffAt, drop.timeZone)}.`}
          </p>
        ) : null}

        {view.offerPhase === 'CONFIRMED' && view.settling ? (
          <p className="mt-2 text-sm text-ink-soft">
            You will get a message as soon as the cards are charged.
          </p>
        ) : null}

        {view.offerPhase === 'FAILED' ? (
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Nothing was taken from any card. The kitchen is not making this batch.
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Pickup</h2>
        <p className="text-sm text-ink">
          {windowLabel(drop.windowStart, drop.windowEnd, drop.timeZone)}
        </p>
        {drop.merchantAddress ? (
          <p className="text-sm text-ink-soft">{drop.merchantAddress}</p>
        ) : null}
        {drop.merchantInstructions ? (
          <p className="text-sm text-ink-soft">{drop.merchantInstructions}</p>
        ) : null}
        {view.pickupPhase === 'ENDED' ? (
          <p className="text-sm font-medium text-ink-soft">Pickup for this drop has ended.</p>
        ) : null}
      </section>

      {joinGate.offerJoin ? (
        <a
          href={`/d/${drop.publicCode}/join`}
          className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand px-4 text-base font-medium text-white"
        >
          Join — {formatCents(drop.dealPriceCents)} a plate
        </a>
      ) : view.canJoin ? (
        // The offer is open, and the button is disabled for a reason that has
        // nothing to do with the drop. The two reasons are genuinely different and
        // are worded separately: one deployment cannot take a card at all, the other
        // can take one but the flow has never been proven against Stripe. Saying
        // "cannot take joins yet" for both would be a lie in the second case, and a
        // lie here is what makes a diner stop trusting the screen.
        <div>
          <button
            type="button"
            disabled
            className="flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-200 px-4 text-base font-medium text-ink-soft"
          >
            Join — {formatCents(drop.dealPriceCents)} a plate
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-ink-soft">
            {joinGate.blockedBy === 'UNPROVEN'
              ? 'This drop is not taking joins yet. Nothing has been charged and nothing will be.'
              : 'This drop cannot take card payments yet. Nothing has been charged and nothing will be.'}
          </p>
        </div>
      ) : (
        <div>
          <button
            type="button"
            disabled
            className="flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-200 px-4 text-base font-medium text-ink-soft"
          >
            {view.joinBlockedReason === 'SOLD_OUT'
              ? 'All plates claimed'
              : view.joinBlockedReason === 'FAILED'
                ? 'This drop did not run'
                : 'Joining has closed'}
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-ink-soft">
            {view.joinBlockedReason === 'SOLD_OUT'
              ? `All ${drop.maxQty} plates are claimed. The kitchen is cooking for them.`
              : view.joinBlockedReason === 'FAILED'
                ? 'Nobody was charged.'
                : 'The deadline has passed.'}
          </p>
        </div>
      )}

      <footer className="border-t border-slate-200 pt-3 text-xs leading-relaxed text-ink-soft">
        <p>
          Sold by {drop.merchantName}. GroupEat takes the orders and passes them to the kitchen.
        </p>
        <p className="mt-1">
          You are only charged if {drop.minQty} orders come in by{' '}
          {momentLabel(drop.cutoffAt, drop.timeZone)}. Up to {drop.maxPerCustomer} per person.
        </p>
      </footer>
    </article>
  );
}
