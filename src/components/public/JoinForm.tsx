'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useCallback, useMemo, useState } from 'react';

import { MAX_JOIN_QTY, MAX_JOIN_QTY_LABEL, qtyLimitFor } from '@/lib/join/rules';

/**
 * The join form — FR-401, FR-402, FR-407.
 *
 * ## The one rule that shapes this component
 *
 * **The server authors every number.** Nothing here divides cents, formats money,
 * decides a fee or works out a total. `amountLabel` arrives as a finished string
 * from `/intent` and is printed verbatim. The diner sees the exact figure the
 * server will authorise, which is the only way "you were shown $26.20 and charged
 * $26.20" can be true by construction rather than by care.
 *
 * ## Why the intent is created on quantity change, not on submit
 *
 * The Payment Element needs a `clientSecret` bound to an amount before it can
 * render a card field. So picking a quantity fires a quote, and the Element mounts
 * against it. Submitting then confirms *that* intent server-side.
 *
 * The consequence worth knowing: the amount is fixed by the quote, so changing the
 * quantity **discards the card details** and re-quotes. That is deliberate — a form
 * that silently re-priced while keeping a tokenised card would authorise an amount
 * the diner never saw.
 *
 * ## Degrading without keys
 *
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` may be absent: the app is runnable, and
 * testable, with no Stripe account. When it is absent the page renders a readable
 * "payments not configured" state instead of a card field that cannot work — the
 * same principle as `JOIN_FLOW_PROVEN_LIVE`, one level down.
 */

export type JoinFormProps = {
  publicCode: string;
  /** The drop's per-plate price, already formatted (`"$11.12"`). */
  priceLabel: string;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
  /** §FR-407 sentence, built server-side. */
  chargeDisclosure: string;
};

type Quote = {
  clientSecret: string;
  publishableKey: string;
  amountCents: number;
  amountLabel: string;
  qty: number;
  unitPriceCents: number;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
};

type Refusal = { title: string; detail: string };

/** What `/join` returns on success. Deliberately narrow: no phone, no customer id. */
type JoinSuccess = {
  ok: true;
  participantId: string;
  qty: number;
  amountLabel: string;
  phoneLast4: string;
  alreadyJoined: boolean;
  minQty: number;
  cutoffLabel: string;
  /** `/d/CODE/mine?t=…` — the diner's own order page, token included. */
  orderPath: string;
};

/** Stripe.js is cached per publishable key: `loadStripe` must not run on every render. */
const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string): Promise<Stripe | null> {
  const existing = stripeCache.get(key);
  if (existing) return existing;
  const created = loadStripe(key);
  stripeCache.set(key, created);
  return created;
}

export function JoinForm(props: JoinFormProps) {
  const limit = qtyLimitFor(Math.min(props.maxPerCustomer, props.maxQty));
  const [qty, setQty] = useState(1);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [joined, setJoined] = useState<JoinSuccess | null>(null);
  /** Bumped to force the Element to remount when the intent changes. */
  const [quoteNonce, setQuoteNonce] = useState(0);

  const requestQuote = useCallback(
    async (nextQty: number) => {
      setQuoting(true);
      setRefusal(null);
      setQuote(null);
      try {
        const response = await fetch(`/api/public/drops/${props.publicCode}/intent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ qty: nextQty }),
        });
        const body = (await response.json()) as
          | Quote
          | { error: string; copy?: Refusal };

        if (!response.ok) {
          setRefusal(
            'copy' in body && body.copy
              ? body.copy
              : {
                  title: 'We could not start this order',
                  detail: 'Please try again in a moment.',
                },
          );
          return;
        }
        setQuote(body as Quote);
        setQuoteNonce((n) => n + 1);
      } catch {
        // A network failure here is the diner's connection or ours; either way the
        // honest thing is to offer a retry rather than a dead form.
        setRefusal({
          title: 'We could not reach the payment service',
          detail: 'Check your connection and try again.',
        });
      } finally {
        setQuoting(false);
      }
    },
    [props.publicCode],
  );

  // The first quote is requested when the diner first touches the quantity, or when
  // they press the initial "Continue". Asking on mount would create an intent for
  // every page view, including for people who never intend to order.
  if (joined) {
    return <Confirmation joined={joined} />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <label htmlFor="qty" className="block text-sm font-medium text-ink">
          How many plates?
        </label>
        <p className="mt-0.5 text-xs text-ink-soft">
          {props.priceLabel} each · up to {Math.min(limit, MAX_JOIN_QTY)} per person
        </p>
        <input
          id="qty"
          name="qty"
          type="number"
          inputMode="numeric"
          min={1}
          max={limit}
          step={1}
          value={qty}
          onChange={(event) => {
            // Clamped locally so the field cannot show a value the server will
            // refuse; the server clamps again (`qtyLimitFor`), because this is a
            // convenience and not a guard.
            const parsed = Number.parseInt(event.target.value, 10);
            const next = Number.isFinite(parsed)
              ? Math.min(Math.max(parsed, 1), Math.min(limit, MAX_JOIN_QTY))
              : 1;
            setQty(next);
            // Any quantity change invalidates the amount, so the quote is dropped
            // rather than left stale behind a card form.
            setQuote(null);
            setRefusal(null);
          }}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-ink"
        />

        {quote ? null : (
          <button
            type="button"
            onClick={() => void requestQuote(qty)}
            disabled={quoting}
            className="mt-3 flex min-h-12 w-full items-center justify-center rounded-lg bg-brand px-4 text-base font-medium text-white disabled:bg-slate-300"
          >
            {quoting ? 'Checking…' : `Continue — ${qty} × ${props.priceLabel}`}
          </button>
        )}

        {refusal ? (
          <div className="mt-3 rounded-lg bg-rose-50 p-3">
            <p className="text-sm font-medium text-rose-900">{refusal.title}</p>
            <p className="mt-1 text-sm text-rose-800">{refusal.detail}</p>
          </div>
        ) : null}
      </div>

      {quote ? (
        <Elements
          // `key` so a new intent gets a fresh Element: reusing one across client
          // secrets leaves the old amount on screen.
          key={quoteNonce}
          stripe={stripeFor(quote.publishableKey)}
          options={{ clientSecret: quote.clientSecret, appearance: { theme: 'stripe' } }}
        >
          <CardStep
            publicCode={props.publicCode}
            quote={quote}
            chargeDisclosure={props.chargeDisclosure}
            onJoined={setJoined}
          />
        </Elements>
      ) : null}
    </div>
  );
}

/**
 * The card, phone and consent step.
 *
 * Split out because `useStripe`/`useElements` only work inside `<Elements>`, and
 * because this is the part that submits — the part where a mistake costs money.
 */
function CardStep({
  publicCode,
  quote,
  chargeDisclosure,
  onJoined,
}: {
  publicCode: string;
  quote: Quote;
  chargeDisclosure: string;
  onJoined: (success: JoinSuccess) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const disabled = useMemo(
    () => submitting || !stripe || !elements,
    [submitting, stripe, elements],
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setFailure(null);
    setFieldErrors({});

    try {
      // Validate the Element's own fields first: submitting an incomplete card
      // produces a Stripe error that reads like a server fault, which is a worse
      // message than "your card number is incomplete".
      const { error: elementError } = await elements.submit();
      if (elementError) {
        setFailure({
          title: 'Check your card details',
          detail: elementError.message ?? 'Some card details are missing.',
        });
        return;
      }

      // Tokenise into a PaymentMethod inside Stripe's iframe. The card number never
      // touches this page's JavaScript, let alone our server — that is what keeps the
      // integration at SAQ A-EP.
      const { error: pmError, paymentMethod } = await stripe.createPaymentMethod({
        elements,
        // `params`, not `payment_method_data`: this is Stripe.js's client-side
        // spelling of the PaymentMethod create body, and the two differ. A wrong key
        // here fails loudly only because the SDK's types say so — which is why this
        // is checked by `tsc` rather than discovered by a diner.
        params: {
          billing_details: {
            ...(name.trim() ? { name: name.trim() } : {}),
            // The phone goes to Stripe as billing detail, not as our identifier. It
            // is the number the restaurant may need to reach the diner about pickup.
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          },
        },
      });

      if (pmError || !paymentMethod) {
        setFailure({
          title: 'We could not use that card',
          detail: pmError?.message ?? 'Try a different card.',
        });
        return;
      }

      // The join. The server confirms the intent with this id, writes the participant
      // and holds the card. Nothing is captured (FR-404).
      const response = await fetch(`/api/public/drops/${publicCode}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          qty: quote.qty,
          phone,
          ...(name.trim() ? { name: name.trim() } : {}),
          consented,
          paymentMethodId: paymentMethod.id,
        }),
      });

      const body = (await response.json()) as
        | JoinSuccess
        | { error: string; copy?: Refusal; fieldErrors?: Record<string, string> };

      if (!response.ok) {
        if ('fieldErrors' in body && body.fieldErrors) {
          setFieldErrors(body.fieldErrors);
        }
        setFailure(
          'copy' in body && body.copy
            ? body.copy
            : { title: 'That did not go through', detail: 'Please try again.' },
        );
        return;
      }

      onJoined(body as JoinSuccess);
    } catch {
      setFailure({
        title: 'We could not reach the server',
        detail: 'Your card has not been charged. Check your connection and try again.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">
            {quote.qty} {quote.qty === 1 ? 'plate' : 'plates'}
          </span>
          {/* Server-formatted, printed verbatim. */}
          <span className="text-lg font-semibold text-ink">{quote.amountLabel}</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{chargeDisclosure}</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <PaymentElement
          options={{
            // A phone-first flow: the diner is on their phone, in a group chat, so the
            // card fields come first rather than behind a "more options" toggle.
            fields: { billingDetails: { name: 'auto' } },
          }}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <label htmlFor="phone" className="block text-sm font-medium text-ink">
          Mobile number
        </label>
        <p className="mt-0.5 text-xs text-ink-soft">
          For the restaurant to reach you about pickup. Never shown to other diners.
        </p>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-ink"
          aria-invalid={fieldErrors.phone ? true : undefined}
        />
        {fieldErrors.phone ? (
          <p className="mt-1 text-sm text-rose-700">{fieldErrors.phone}</p>
        ) : null}

        <label htmlFor="name" className="mt-4 block text-sm font-medium text-ink">
          Name <span className="font-normal text-ink-soft">(optional)</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-ink"
        />
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-surface p-4">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          className="mt-1 h-5 w-5 shrink-0"
        />
        <span className="text-sm leading-relaxed text-ink">
          Text me about this order. GroupEat will send updates about this drop only —
          you can stop them at any time.
        </span>
      </label>

      {failure ? (
        <div className="rounded-lg bg-rose-50 p-3" role="alert">
          <p className="text-sm font-medium text-rose-900">{failure.title}</p>
          <p className="mt-1 text-sm text-rose-800">{failure.detail}</p>
        </div>
      ) : null}

      <button
        type="submit"
        disabled={disabled}
        className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand px-4 text-base font-medium text-white disabled:bg-slate-300"
      >
        {submitting ? 'Holding your card…' : `Join — ${quote.amountLabel}`}
      </button>

      <p className="text-center text-xs leading-relaxed text-ink-soft">
        {/* FR-404, stated plainly. A diner should never be surprised by a charge. */}
        You are not charged now. This holds {quote.amountLabel} on your card until the
        offer is confirmed.
      </p>
    </form>
  );
}

/**
 * The confirmation — FR-407.
 *
 * No card details, no full phone number. `phoneLast4` is shown as an
 * **identification** fact — "the number ending 1234" tells a diner whose order this
 * is when a family shares a phone — and deliberately not as a delivery promise.
 *
 * ## The link is the point of this screen
 *
 * Until this link existed, a diner who joined had no way back to their own order.
 * The redemption code is minted at capture and lives on `/d/:code/mine`, which needs
 * a bearer token; that token was composed only inside the settlement job, for a text
 * message no sender delivers. So the confirmation was a dead end: close the tab and
 * the order — the money, the code, the pickup window — became unreachable. There was
 * not even a bookmarkable URL, because the page is unindexed and has no other entry
 * point.
 *
 * It is a plain `<a>` rather than a `<Link>`: this is a navigation to a page that
 * must be fetched fresh with its token, and a client-side transition would keep the
 * current document's state around for no reason. It is also the one link on the site
 * that must survive being copied by hand, which is a reason to keep it an ordinary
 * anchor.
 *
 * ## Why the sentence about texts changed
 *
 * It used to tell the diner that updates would arrive by text. Nothing sends texts
 * in this build (D-5: no provider, no sender), so that sentence caused the failure
 * it was meant to prevent — a diner waits for a message that never comes instead of
 * keeping the link that works. The copy now says where the updates appear *and* that
 * this page is the way to them, which is true today.
 */
function Confirmation({ joined }: { joined: JoinSuccess }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="text-lg font-semibold text-emerald-900">
          {joined.alreadyJoined ? 'You are already in' : 'You are in'}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-emerald-900">
          {joined.qty} {joined.qty === 1 ? 'plate' : 'plates'} held for{' '}
          {joined.amountLabel}. Nothing has been charged.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <p className="text-sm leading-relaxed text-ink">
          You will only be charged if at least {joined.minQty}{' '}
          {joined.minQty === 1 ? 'person joins' : 'people join'} by {joined.cutoffLabel}.
          If the drop does not fill, the hold is released and you owe nothing.
        </p>
        <p className="mt-3 text-sm text-ink-soft">
          Bookmark this page — it is where your confirmation and your pickup code appear.
          {' '}This order is under the number ending {joined.phoneLast4}.
        </p>
      </div>

      <a
        href={joined.orderPath}
        className="flex min-h-12 w-full items-center justify-center rounded-lg border border-slate-300 px-4 text-base font-medium text-ink"
      >
        View your order
      </a>

      <p className="text-center text-xs leading-relaxed text-ink-soft">
        This link is the only way to your order — keep it, in case you change phones.
      </p>
    </div>
  );
}

/**
 * The no-keys state.
 *
 * Rendered when `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is absent. It says what a diner
 * needs to know — nothing is wrong with the offer, and nothing will be charged —
 * rather than showing a card field that cannot work. Kept in this file so the two
 * states cannot drift apart.
 */
export function PaymentsNotConfigured({ priceLabel }: { priceLabel: string }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4">
        <p className="text-sm font-medium text-ink">Card payments are not switched on yet</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          This offer is real and the kitchen is making it, but this deployment cannot take
          a card. Nothing has been charged and nothing will be.
        </p>
      </div>
      <button
        type="button"
        disabled
        className="flex min-h-12 w-full items-center justify-center rounded-lg bg-slate-200 px-4 text-base font-medium text-ink-soft"
      >
        Join — {priceLabel} a plate
      </button>
    </div>
  );
}

/** Exported for the quantity cap the label promises. */
export const JOIN_QTY_CEILING_LABEL = MAX_JOIN_QTY_LABEL;
