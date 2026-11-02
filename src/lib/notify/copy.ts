import { formatCents } from '@/lib/guardrail/money';

/**
 * The words in every notification — FR-408 and FR-506.
 *
 * ## Why this is a module of its own
 *
 * There was no message copy anywhere in this repo before it. `NotifyIntent` carried
 * a `chargedCents`, a `redemptionCode`, a window — data, deliberately, because the
 * intent is a decision and a decision must not contain prose. But a transport that
 * has to invent its own sentences is a transport that eventually sends a diner
 * `26.2` or `2026-11-06T01:00:00.000Z`, on the first afternoon someone changes a
 * field. A provider that formats money is a second rounding rule wearing a template.
 *
 * So the split is: the **intent** decides *what happened and to whom*; this module
 * decides *how it is said*. A provider implementation may choose channel, encoding
 * and sender — never a word, and never a format.
 *
 * ## The rules these sentences keep
 *
 *   1. **One formatter, and it is not here.** These functions take **integer cents**
 *      and call `formatCents` themselves. That is deliberately not "the caller
 *      formats and we print it": handing a pre-formatted string to the composer
 *      would let a second rule slip in at a call site, which is exactly the defect
 *      `join/rules.ts`'s `dollars()` had. The composer is the one place a number
 *      becomes words for a message.
 *   2. **No invented claims.** Nothing here says a message was sent, that a card will
 *      be retried, or that a refund has landed, unless the intent says so.
 *   3. **A link, or no claim about one.** The absolute URL is optional by type because
 *      it needs a validated public origin. When it is absent these sentences must not
 *      hint that a link exists — a diner tapping a dead word is worse than a plain
 *      code. Where a path is also available it is used as the fallback, because a
 *      relative path in a message is useless but at least truthful.
 *   4. **The amount is gross.** It is what the diner's statement shows. A sentence
 *      naming a net figure would be a sentence the diner cannot reconcile.
 *
 * ## Why the copy is a function of the intent rather than of the drop
 *
 * A message must be reproducible. If the wording needed a database read, a re-send
 * after a provider outage would say something different from the original, and the
 * diner would hold two texts that disagree about their own order. Everything these
 * functions need is on the intent — which is also why `notify-port.ts` carries a
 * `windowStart`/`windowEnd` it does not otherwise seem to need.
 */

/** One message, before a channel is chosen. */
export type NotificationMessage = {
  /**
   * The channel-neutral body. Plain text: SMS has no rich formatting, and anything a
   * channel needs to add (an email subject) is derived from `kind`.
   */
  readonly body: string;
  /** The intent kind, so a sender can log `{ kind, count }` without parsing a body. */
  readonly kind: string;
  /** E.164. The caller passes it straight to the provider; never to a log. */
  readonly phone: string;
};

/**
 * The pickup window as a diner reads it: `"Thursday 1:00 PM–3:00 PM"`.
 *
 * Both ends in the **merchant's** zone, supplied by the caller. The locked drop does
 * not carry a zone — settlement reads no merchant row after the lock is taken — so a
 * default here would print the server's zone for every merchant in the country,
 * which reads as correct and is wrong by hours. The parameter is required rather
 * than defaulted for that reason: a wrong-but-plausible pickup time is worse than a
 * compile error.
 *
 * The weekday comes from the **start**, because a window that crosses midnight is
 * still "Friday evening" to the person collecting food, and spelling both days would
 * read as two pickups.
 */
export function windowLabel(start: Date, end: Date, timeZone: string): string {
  const format = (options: Intl.DateTimeFormatOptions, instant: Date): string =>
    new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(instant);

  const clock = (instant: Date): string =>
    format({ hour: 'numeric', minute: '2-digit' }, instant);

  return `${format({ weekday: 'long' }, start)} ${clock(start)}–${clock(end)}`;
}

/**
 * `"You're in: 2 plates for $26.20…"` — FR-408.
 *
 * The sentence a diner needs immediately, and the one this build has never been able
 * to send. Its job is to close the two questions a card form opens: *did that work*
 * and *was I just charged*.
 *
 * The link carries a read-only token, never the redemption code. A code in a message
 * is a code in an archive, a browser history, and possibly a link-preview fetcher's
 * logs; the code belongs on the page the link opens.
 */
export function joinConfirmationSms(args: {
  qty: number;
  amountCents: number;
  cutoffLabel: string;
  orderPath: string;
  orderUrl?: string;
  phone: string;
}): NotificationMessage {
  const plates = args.qty === 1 ? 'plate' : 'plates';

  return {
    kind: 'JOIN_CONFIRMATION',
    phone: args.phone,
    body:
      `You're in: ${args.qty} ${plates} for ${formatCents(args.amountCents)}. ` +
      `Nothing is charged unless the drop fills by ${args.cutoffLabel}. ` +
      `Your order and pickup code: ${args.orderUrl ?? args.orderPath}`,
  };
}

/**
 * `DROP_CONFIRMED_CHARGED` — FR-506's good outcome, and the message carrying the code.
 *
 * ## Why it leads with the amount
 *
 * This is the first moment money actually moves. A diner who reads "your drop is
 * confirmed" and has to scroll for the figure will, some of the time, not scroll.
 *
 * ## Why the code appears even when there is a link
 *
 * The link is the convenient route; the code is the one that works when the phone is
 * dead, the link is mistyped at a counter, or the message is forwarded to whoever is
 * collecting. Omitting it to keep the message short would make the diner depend on a
 * URL at the exact moment they are standing in front of a stranger with a scanner.
 */
export function dropConfirmedChargedSms(args: {
  chargedCents: number;
  qty: number;
  redemptionCode: string;
  windowStart: Date;
  windowEnd: Date;
  timeZone: string;
  orderUrl?: string;
  phone: string;
}): NotificationMessage {
  const plates = args.qty === 1 ? 'plate' : 'plates';
  const where = args.orderUrl ? ` Details: ${args.orderUrl}` : '';

  return {
    kind: 'DROP_CONFIRMED_CHARGED',
    phone: args.phone,
    body:
      `Charged ${formatCents(args.chargedCents)} for ${args.qty} ${plates}. ` +
      `Pickup ${windowLabel(args.windowStart, args.windowEnd, args.timeZone)}.${where} ` +
      `Your code: ${args.redemptionCode}`,
  };
}

/**
 * `DROP_CONFIRMED_CARD_DECLINED` — the drop filled, this card did not.
 *
 * The hardest message in the product and the one most likely to be written badly. It
 * must not imply the diner still has food, must not blame them, and must not invent a
 * next step nobody built: there is no retry flow in this build, so it says who to ask
 * and stops.
 */
export function cardDeclinedSms(args: { qty: number; phone: string }): NotificationMessage {
  const plates = args.qty === 1 ? 'plate' : 'plates';
  return {
    kind: 'DROP_CONFIRMED_CARD_DECLINED',
    phone: args.phone,
    body:
      `The drop filled, but your card was declined, so your ${args.qty} ${plates} ` +
      `could not be confirmed. You have not been charged. Please contact the ` +
      `restaurant if you think this is wrong.`,
  };
}

/**
 * `DROP_FAILED_NO_CHARGE` — the drop did not reach its minimum.
 *
 * FR-306 makes the no-money claim mandatory and explicit, and this is where it
 * matters most: the diner did nothing wrong and wants one fact, which is whether they
 * are out of pocket.
 */
export function dropFailedNoChargeSms(args: {
  qty: number;
  phone: string;
}): NotificationMessage {
  const plates = args.qty === 1 ? 'plate' : 'plates';
  return {
    kind: 'DROP_FAILED_NO_CHARGE',
    phone: args.phone,
    body:
      `This drop didn't reach its minimum, so it's off. Nobody was charged and the ` +
      `hold on your card is released — your ${args.qty} ${plates} cost you nothing.`,
  };
}

/**
 * `DROP_FAILED_REFUNDED` — captured, then refunded.
 *
 * A separate sentence from `DROP_FAILED_NO_CHARGE` because it is a different fact:
 * money left the account and came back. Telling someone whose statement shows a
 * charge and a credit that "nobody was charged" is the kind of inaccuracy a diner
 * reports as fraud.
 *
 * The "few business days" clause is the honest caveat: our refund is immediate, the
 * diner's bank is not, and the gap is measured in days. Promising "now" would generate
 * support messages during a period when everything is in fact proceeding normally.
 */
export function dropFailedRefundedSms(args: {
  chargedCents: number;
  qty: number;
  phone: string;
}): NotificationMessage {
  const plates = args.qty === 1 ? 'plate' : 'plates';
  return {
    kind: 'DROP_FAILED_REFUNDED',
    phone: args.phone,
    body:
      `This drop could not go ahead, so your ${formatCents(args.chargedCents)} charge ` +
      `for ${args.qty} ${plates} has been refunded in full. Depending on your bank it ` +
      `can take a few business days to appear.`,
  };
}

/**
 * `THRESHOLD_REACHED_STILL_FILLING` — ADR-003's copy obligation.
 *
 * The diner who took the drop over its minimum is told it is going ahead **and** that
 * it is still taking orders, because both are true and either alone is misleading:
 * "confirmed" alone invites them to plan around a drop that might still change size,
 * and "still filling" alone sounds like nothing was achieved.
 *
 * ## Why this sentence names no number
 *
 * The intent carries this diner's `qty` and the `cutoffAt`, but **not** the drop's
 * `minQty` or its joined count. An earlier draft of this function said "N people have
 * joined", which would have meant adding a field to the intent purely to fill a
 * sentence — and a field added for a sentence is a field that will disagree with the
 * database the first time one of them changes.
 *
 * ADR-003's obligation is the *cutoff*, so the cutoff is what it says. The diner does
 * not need the threshold to act correctly: they need to know it is going ahead, that
 * more can join, and that nothing is charged unless it holds.
 */
export function stillFillingSms(args: {
  cutoffLabel: string;
  phone: string;
}): NotificationMessage {
  return {
    kind: 'THRESHOLD_REACHED_STILL_FILLING',
    phone: args.phone,
    body:
      `Good news — this drop is going ahead. It's still open to more people until ` +
      `${args.cutoffLabel}, and nothing is charged unless it stays above the ` +
      `minimum.`,
  };
}
