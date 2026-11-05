import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { dealPageViewEvent, isHumanView } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { CountPoller, type CountSnapshot } from '@/components/public/CountPoller';
import { requireMerchantScope } from '@/lib/auth/authorize';
import { getSession } from '@/lib/auth/session';
import { countShareLinkClick, resolveShareToken } from '@/lib/db/share-links';
import { formatCents } from '@/lib/guardrail';
import { SHARE_TOKEN_PARAM, isShareToken } from '@/lib/organisers/share-link';
import { headlineFor, resolveDropView, type DropView } from '@/lib/public/drop-view';
import { resolveJoinGate } from '@/lib/public/join-gate';
import { getPreviewDrop, getPublicDrop, type PublicDrop } from '@/lib/public/public-drops';
import { generatedHeroDataUri } from '@/lib/public/generated-hero';
import { socialCardOrigin } from '@/lib/metadata/social-card';

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
 * ## FR-206's preview is this page, not a second one
 *
 * A draft is reachable at `/d/:code?preview=1` for its owning merchant only. It renders
 * through this same module and the same view state, because a separate preview screen
 * would be an artefact the merchant approves and diners never see. The differences are
 * listed where they happen: `loadPreviewDrop` is the merchant-scoped read, the banner
 * says what is disabled, the poller is replaced by a static count, the analytics and
 * share-click writes are skipped, and the CTA is a disabled button rather than the
 * closed-drop sentence. `generateMetadata` returns a no-card, noindex object first.
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

/**
 * FR-206's preview lookup: session, merchant scope, then a `DRAFT` read.
 *
 * The order matters and is the whole authorisation argument. The session decides
 * whether there is a candidate at all; `requireMerchantScope` is the same list every
 * merchant query in the app filters by; and `getPreviewDrop` puts that list in the
 * **query**, so a correct code for another merchant's draft is a `null` before any row
 * is mapped. There is no branch here that could be reordered into leaking a draft.
 *
 * Returns `null` rather than throwing for "not signed in", because the caller is a
 * public page and the correct outcome is its ordinary 404 — a signed-out visitor must
 * not learn that `?preview=1` changes anything.
 */
async function loadPreviewDrop(publicCode: string): Promise<PublicDrop | null> {
  const session = await getSession();
  if (!session || session.role !== 'MERCHANT') {
    return null;
  }
  const merchantIds = await requireMerchantScope(session);
  return getPreviewDrop(publicCode, merchantIds);
}

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
  searchParams,
}: {
  params: Promise<{ publicCode: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { publicCode } = await params;
  const query = searchParams ? await searchParams : {};

  // A preview is not a share. It must not produce a card pointing at the deployment,
  // and it must not be indexed — so it returns before `loadDrop`, before any price is
  // read, and with no `openGraph` key at all. A signed-out visitor who guesses
  // `?preview=1` gets this metadata and then the page's 404; neither reveals a draft.
  if (query.preview === '1') {
    return {
      title: 'Preview — GroupEat',
      robots: { index: false, follow: false },
      // `opengraph-image.tsx` is collected by DIRECTORY, so returning no `openGraph`
      // object would let Next autofill the convention card for this page too. An
      // explicit empty `images` array is the documented suppression; `openGraph: {}`
      // happens to work today and is the shape this repo has already fixed once for
      // the opposite reason. Both channels are suppressed, because unfurlers read
      // whichever one they prefer.
      openGraph: { images: [] },
      twitter: { images: [] },
    };
  }

  const drop = await loadDrop(publicCode);

  /**
   * Whether to emit a share card at all.
   *
   * The card is a file convention (`opengraph-image.tsx`), and Next auto-fills
   * `openGraph.images` / `twitter.images` from it — **unless this object sets an
   * `images` key itself**, which is measured behaviour (`resolve-metadata.js` gates
   * the autofill on `hasOwnProperty('images')`), not an assumption. So `images: []`
   * is the only way to say "no card", and an empty array is what Next needs to hear:
   * `images: undefined` also suppresses it, but writing that key unconditionally
   * would delete the card in the healthy case, which is FR-308.
   *
   * The state this exists for: a production deployment with no usable `APP_URL`.
   * There is no origin to resolve the card against, and Next's fallback is
   * `http://localhost:3000`, delivered to every person the link is shared with. A
   * preview with a title and no image is worse than one with a card; a preview whose
   * image points at a laptop is broken and reads as our bug, in the one place the
   * PRD calls the launch blocker. `social-card.ts` makes the decision and logs it;
   * this is where it takes effect.
   */
  const cardSuppression =
    socialCardOrigin().kind === 'unavailable' ? { images: [] } : {};

  if (!drop) {
    /**
     * A 404 needs no share card, so this branch carries the suppression too.
     *
     * ## What this does *not* do
     *
     * It does not fix the localhost card on the 404. That was measured, not assumed: when
     * `notFound()` is thrown, Next discards the page's metadata entirely and re-resolves
     * with `errorConvention: 'not-found'`, so the suppression written here is never
     * consulted. The page-level copy is kept because it is correct for the module and
     * costs nothing, but the actual fix is `d/[publicCode]/not-found.tsx`, which is the
     * module read at the deepest level on that path. Recorded so the next reader does not
     * "verify" this comment by deleting that file and conclude the defect is unfixable.
     *
     * ## Why the spread is conditional
     *
     * Writing `openGraph: {}` when the origin *is* usable would stop Next autofilling the
     * convention card — `mergeStaticMetadata` keys on the presence of an `openGraph`
     * object at this level. So the key is added only when there is a card to suppress.
     * Both arms are asserted; see the two tests below.
     */
    return {
      title: 'Drop not found — GroupEat',
      ...(cardSuppression.images
        ? { openGraph: { ...cardSuppression }, twitter: { ...cardSuppression } }
        : {}),
    };
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
      ...cardSuppression,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...cardSuppression,
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
  const query = await searchParams;
  const isPreview = query.preview === '1';
  const drop = isPreview ? await loadPreviewDrop(publicCode) : await loadDrop(publicCode);

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
  if (!isPreview) {
    record(
      dealPageViewEvent({
        dropId: drop.id,
        merchantId: drop.merchantId,
        headers: requestHeaders,
        query,
      }),
    );
  }

  /**
   * FR-802's other half — the organiser's token, if this visit came from their link.
   *
   * `?o=` is read here rather than in the join flow because this is where the click
   * actually happens: an organiser's group taps the link, lands on this page, and most
   * of them read before they join. Counting only joins would undercount reach by
   * however many people looked and did not buy, which is the number an organiser
   * cannot otherwise see.
   *
   * The increment is gated on `isHumanView` for the reason `deal_page_viewed` is: every
   * share is fetched by WhatsApp's and WeChat's unfurler to build the link card, so an
   * ungated counter measures sharing *effort* rather than reach — and it penalises
   * exactly the behaviour it is meant to reward.
   *
   * A token that is malformed, unknown, or belongs to another drop resolves to `null`
   * and the page behaves as if it were absent. Attribution must never be able to break
   * a diner's page load, and must never be able to fail a join.
   */
  const shareToken = isPreview ? undefined : query[SHARE_TOKEN_PARAM];
  const shareLink =
    !isPreview && isShareToken(shareToken)
      ? await resolveShareToken({ token: shareToken, dropId: drop.id })
      : null;

  if (!isPreview && shareLink && isHumanView(requestHeaders)) {
    await countShareLinkClick(shareLink.shareLinkId);
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

  // FR-205. A merchant-supplied image wins, then the dish photo, then the card the
  // server composes from the same frozen facts the rest of the page prints. The
  // generated fallback is what stops a drop without a photo from showing a gap where
  // the one visual in the funnel belongs.
  const hero =
    drop.heroImageUrl ??
    drop.itemPhotoUrl ??
    generatedHeroDataUri({
      title: drop.title,
      merchantName: drop.merchantName,
      itemName: drop.itemName,
      dealPriceCents: drop.dealPriceCents,
      menuPriceCents: drop.menuPriceCents,
      pickupLabel: windowLabel(drop.windowStart, drop.windowEnd, drop.timeZone),
    });
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
      {isPreview ? (
        <div
          role="status"
          className="rounded-xl border border-thin/30 bg-thin/5 p-3 text-sm leading-relaxed text-ink-soft"
        >
          <span className="font-medium text-ink">Preview.</span> This is the real deal page.
          Joining and payments are disabled until you publish, and the link cannot be shared.
        </div>
      ) : null}

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
        {shareLink ? (
          // FR-302. Only a tracked link has an organiser to name; a direct visitor
          // was not brought by anyone, and inventing "GroupEat" here would be a
          // person the diner cannot ask a question. The display name is public by
          // design — it is what the organiser chose for their share links.
          <p className="mt-1 text-xs text-ink-soft">
            Shared by {shareLink.organiserName}
          </p>
        ) : null}
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
        {isPreview ? (
          // No poller in preview: the count endpoint answers 404 for a draft, and a
          // failed poll would leave a live-looking bar that never moves. A static
          // sentence is the honest preview of a drop with no participants.
          <div>
            <p className="text-base font-semibold text-ink">
              {view.joinedQty} of {drop.minQty} orders in
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              {view.joinedQty === 0
                ? 'Nobody has joined yet. Publish to open the drop.'
                : 'This draft already has participants; publish to make them official.'}
            </p>
          </div>
        ) : (
          <CountPoller publicCode={drop.publicCode} initial={countSnapshotOf(view, drop.minQty)} />
        )}

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

        {view.offerPhase === 'CANCELLED' ? (
          // Not folded into the FAILED paragraph above, and the difference matters to
          // the reader: "the kitchen is not making this batch" implies demand fell
          // short, which is the opposite of what happened when the restaurant called
          // off a drop that had orders. The headline already carries the refund
          // sentence; this line only has to name the decision and the next step.
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {view.hadCaptures
              ? 'The restaurant called this drop off. Your card has been refunded — it usually lands within five business days.'
              : 'The restaurant called this drop off. Nothing was taken from any card.'}
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

      {isPreview ? (
        <div>
          <button
            type="button"
            disabled
            className="flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-200 px-4 text-base font-medium text-ink-soft"
          >
            Join — {formatCents(drop.dealPriceCents)} a plate
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-ink-soft">
            Preview only. Publish this drop to open joins.
          </p>
        </div>
      ) : joinGate.offerJoin ? (
        <a
          // The organiser's token rides along, so the join is attributed to the person
          // who sent the link. Dropped entirely when there is no valid token, rather
          // than passed through as an empty `?o=` — a parameter with no value looks
          // like a bug in every log that records it.
          href={
            shareLink
              ? `/d/${drop.publicCode}/join?${SHARE_TOKEN_PARAM}=${encodeURIComponent(shareToken as string)}`
              : `/d/${drop.publicCode}/join`
          }
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
                : view.joinBlockedReason === 'CANCELLED'
                  ? 'This drop was cancelled'
                  : 'Joining has closed'}
          </button>
          <p className="mt-2 text-center text-xs leading-relaxed text-ink-soft">
            {view.joinBlockedReason === 'SOLD_OUT'
              ? `All ${drop.maxQty} plates are claimed. The kitchen is cooking for them.`
              : view.joinBlockedReason === 'FAILED'
                ? 'Nobody was charged.'
                : view.joinBlockedReason === 'CANCELLED'
                  ? // Same `hadCaptures` discriminator as the paragraph above, kept to
                    // one clause here because the long sentence is already on screen two
                    // lines up. "Nobody was charged" would be false for a drop that took
                    // orders and was then called off.
                    view.hadCaptures
                    ? 'Everyone who paid has been refunded.'
                    : 'Nobody was charged.'
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
