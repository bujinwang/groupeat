import type { Metadata } from 'next';
import Link from 'next/link';

import { loadOrderPage, logInvalidToken } from '@/lib/participant/order-page';

/**
 * `/d/:publicCode/mine?t=…` — the diner's own order page. M4 slice 2c, FR-408's link.
 *
 * ## Why this page exists at all
 *
 * Redemption codes are minted at capture and, until this page, existed only in the
 * merchant's manifest. FR-601's scanner could verify a code that the diner had never
 * been shown. The SMS that FR-408 promises has to link *somewhere*, and "somewhere"
 * has to be a page that works for somebody with no session — a link arriving in a
 * message is opened on a different device from the one that joined, hours later.
 *
 * ## The design decision that shapes everything here
 *
 * The token in the URL is **not** the redemption code. The code is a bearer
 * credential that buys food; putting it in a URL would put it in an SMS archive, a
 * browser history and — because every drop is shared into group chats — potentially
 * a link-preview fetcher's logs. `lib/participant/access.ts` derives a separate key
 * for a **read-only** token, and this page is the only consumer. A leaked link shows
 * a name, a quantity and four digits; it does not feed anyone.
 *
 * ## No index, no referrer
 *
 * `noindex` because this URL is a bearer token, and `Referrer-Policy: no-referrer`
 * because the code is rendered on the page: without it, any outbound link — even a
 * map link to the restaurant — would send the full URL, token included, to a third
 * party.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your order — GroupEat',
  // A tokenised URL must never appear in search results.
  robots: { index: false, follow: false, nocache: true },
};

function momentLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(instant);
}

function windowLabel(start: Date, end: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(start);
  return `${day}, ${time.format(start)} – ${time.format(end)}`;
}

export default async function MyOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicCode: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { publicCode } = await params;
  const query = await searchParams;

  // A repeated `?t=` arrives as an array. Taking the first is not a security
  // decision — every candidate has to verify anyway — but it keeps the type honest
  // instead of coercing an array to a string in a way that might look like one.
  const token = Array.isArray(query.t) ? query.t[0] : query.t;

  const order = token ? await loadOrderPage(publicCode, token, new Date()) : null;

  if (!order) {
    // One sentence for every failure: a bad signature, a token for another drop, a
    // participant that no longer exists. Distinguishing them would tell an attacker
    // which of their guesses was closer.
    if (token) {
      logInvalidToken(publicCode);
    }
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-xl font-semibold text-ink">This link is not valid</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          It may have been truncated by your messaging app, or it belongs to an order that no
          longer exists. Open the most recent message we sent you, or ask the restaurant.
        </p>
        <Link
          href={`/d/${encodeURIComponent(publicCode)}`}
          className="mt-6 flex min-h-12 w-full items-center justify-center rounded-lg border border-slate-300 px-4 text-base font-medium text-ink"
        >
          See this offer
        </Link>
      </main>
    );
  }

  const { view, drop, pickup } = order;

  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <header>
        <p className="text-sm text-ink-soft">{pickup.merchantName}</p>
        <h1 className="mt-1 text-xl font-semibold leading-snug text-ink">{drop.title}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {order.qty} {order.qty === 1 ? 'plate' : 'plates'} · {order.amountLabel}
        </p>
      </header>

      {view.phase === 'CHARGED' ? (
        <section className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="text-base font-semibold text-emerald-900">
            {view.pickupEnded ? 'Pickup has ended' : 'You are in — show this at the counter'}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-emerald-900">
            You were charged {order.amountLabel}.{view.outstandingQty > 0
              ? ` ${view.outstandingQty} of ${order.qty} still to collect.`
              : ' Everything has been collected.'}
          </p>

          {view.code ? (
            /**
             * The code is rendered as selectable text in a monospace block, not as an
             * image: a diner who cannot scan can copy it, and a screenshot of text is
             * readable by the counter's decoder whereas a screenshot of a QR inside a
             * chat bubble often is not.
             */
            <div className="mt-3 rounded-lg bg-white p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
                Redemption code
              </p>
              <p className="mt-1 break-all font-mono text-xs leading-relaxed text-ink">
                {view.code}
              </p>
            </div>
          ) : null}

          <p className="mt-3 text-sm leading-relaxed text-emerald-900">
            {view.pickupEnded
              ? `The pickup window closed ${momentLabel(pickup.windowEnd, pickup.timeZone)}. The restaurant may still be able to help — call them.`
              : `Pickup ${windowLabel(pickup.windowStart, pickup.windowEnd, pickup.timeZone)}.`}
          </p>
        </section>
      ) : null}

      {view.phase === 'NOT_CHARGED' ? (
        <section className="mt-5 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="text-base font-semibold text-ink">Nothing was charged</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            This drop did not go ahead, so your card was not charged and any hold has been
            released. You owe nothing.
          </p>
        </section>
      ) : null}

      {view.phase === 'WAITING' ? (
        <section className="mt-5 rounded-xl border border-slate-200 bg-surface p-4">
          <h2 className="text-base font-semibold text-ink">Your card is held, not charged</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            This offer needs at least {order.minQty}{' '}
            {order.minQty === 1 ? 'person' : 'people'} to go ahead. If it does not fill, the
            hold is released and you owe nothing.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            We will send your code as soon as the drop is confirmed.
          </p>
        </section>
      ) : null}

      <section className="mt-5 rounded-xl border border-slate-200 bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Pickup</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          {windowLabel(pickup.windowStart, pickup.windowEnd, pickup.timeZone)}
        </p>
        {pickup.address ? (
          <p className="mt-1 text-sm leading-relaxed text-ink">{pickup.address}</p>
        ) : null}
        {pickup.instructions ? (
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{pickup.instructions}</p>
        ) : null}
      </section>

      <p className="mt-5 text-center text-xs leading-relaxed text-ink-soft">
        This order is under the number ending {order.phoneLast4}. Keep this link — it is the
        only way back to this page, so bookmark it or save the message it came in.
      </p>
    </main>
  );
}
