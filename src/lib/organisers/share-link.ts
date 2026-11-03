import { formatCents } from '@/lib/guardrail';
import { momentLabel } from '@/lib/time/labels';

/**
 * FR-802 — the organiser's share link and the message that carries it.
 *
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 * >
 * > `FR-805 | Organiser cannot see participant phone numbers | P0 privacy requirement`
 * > — PRD-v1.md:540
 *
 * ## Why the URL is built here and not in the page
 *
 * Because three separate places have to agree about it: the link the organiser copies,
 * the `?o=` the public deal page reads, and the `src=` that the funnel's
 * `deal_page_viewed` event classifies. A link assembled from string fragments in a
 * server component and read by a hand-written regex somewhere else is how a share link
 * ends up counting as `direct` — silently, and only in production.
 *
 * So the source value is a named constant here, the analytics side is asserted against
 * it in the tests, and the page renders `shareUrlFor`'s output rather than composing
 * one.
 *
 * ## Why `src` and `o` are separate parameters
 *
 * `?src=organiser_link` already existed (funnel.ts, `VIEW_SOURCE_PARAM`) and answers
 * "was this view driven by an organiser?" — a closed set of three values, deliberately
 * not extensible so a stranger cannot pollute the funnel by inventing one. The token
 * answers a different question: *which* organiser. Folding the token into `src` would
 * have turned a three-value enum into an open set, which is exactly what that comment
 * forbids.
 *
 * ## What this module does not do
 *
 * No database, no clock, no random source. The token is *generated* in
 * `lib/db/share-links.ts`, where `node:crypto` belongs; here it is only validated and
 * placed in a URL. That keeps the message formatter testable without a database and
 * keeps `node:crypto` out of anything a client component might import.
 */

/**
 * The `?src=` value an organiser link carries.
 *
 * Must be one of `DEAL_VIEW_SOURCES` in `lib/analytics/funnel.ts`. The assertion lives
 * in `__tests__/share-link.test.ts` rather than in a type import, because importing the
 * analytics module here would drag `node:fs` into a module the organiser page imports.
 */
export const ORGANISER_LINK_SOURCE = 'organiser_link';

/** The query parameter carrying the share token. Short, because it is in a shared link. */
export const SHARE_TOKEN_PARAM = 'o';

/**
 * 16 bytes, base64url — 22 characters, 128 bits.
 *
 * 128 rather than 64: the token is a bearer credential for attribution, and a 64-bit
 * space is birthday-collidable at a scale a public product could plausibly reach
 * (~4 billion links for a 50% chance). 128 bits makes that arithmetic irrelevant.
 */
export const SHARE_TOKEN_BYTES = 16;
/** The character length that follows from the byte count, asserted by the generator. */
export const SHARE_TOKEN_LENGTH = 22;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Whether a value has the *shape* of a share token.
 *
 * Checked before any database read, so a hand-edited `?o=<script>` costs a regex
 * instead of a query. This is a shape check and not an authorisation check: a
 * well-formed token that names a different drop is rejected by the loader, which is
 * the only place that knows what the token belongs to.
 */
export function isShareToken(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value);
}

export type ShareUrlArgs = {
  readonly publicCode: string;
  readonly token: string;
  /**
   * The public origin, or `undefined` when `APP_URL` is unset or unusable.
   *
   * `undefined` yields a relative URL rather than a guessed host. A guess would put
   * `http://localhost:3000` in a WeChat message — and it would look correct on the
   * machine that generated it, which is the worst property a broken link can have.
   * `lib/notify/public-origin.ts` already owns that judgement; this function only
   * respects it.
   */
  readonly origin: string | undefined;
};

/**
 * `/d/{publicCode}?src=organiser_link&o={token}`.
 *
 * The path is absolute either way (`/d/:code` is not nested under a base path), so a
 * relative result is still a working link on the deployment that produced it.
 */
export function shareUrlFor(args: ShareUrlArgs): string {
  const query = `src=${ORGANISER_LINK_SOURCE}&${SHARE_TOKEN_PARAM}=${encodeURIComponent(args.token)}`;
  const path = `/d/${encodeURIComponent(args.publicCode)}?${query}`;
  return args.origin === undefined ? path : `${args.origin}${path}`;
}

export type ShareMessageArgs = {
  readonly title: string;
  readonly merchantName: string;
  readonly dealPriceCents: number;
  readonly menuPriceCents: number;
  readonly minQty: number;
  readonly joinedQty: number;
  readonly cutoffAt: Date;
  readonly timeZone: string;
  readonly url: string;
};

/**
 * The message the organiser pastes into the group chat, before editing.
 *
 * ## The rules it follows
 *
 * **Every number is real and already on the deal page.** No "huge savings", no urgency
 * that the cutoff does not already imply. The Competition Act point from
 * `PlannedProposal.discountPct` applies to copy an organiser forwards too — a claim in
 * a group chat is still a claim, and this text is generated by us, not by them.
 *
 * **It never names a person.** FR-805 is about participant PII, and the most tempting
 * way to break it is a friendly line like "Sarah's already in" — so the message quotes
 * a count and nothing else. There is no field on the input type that could carry a
 * name, which is the structural version of that rule.
 *
 * **It says what is needed, then what is already there.** "8 of 20" answers the two
 * questions a group member has in the order they ask them. Once the threshold is met
 * the sentence changes rather than going stale — a message that still says "we need
 * 20" after the drop is locked reads as a bug to everyone who taps it.
 *
 * **Four lines.** It is pasted into a chat window next to other people's messages;
 * a paragraph is edited down or skipped, and a skipped message is a lost drop.
 */
export function shareMessageFor(args: ShareMessageArgs): string {
  const savingCents = args.menuPriceCents - args.dealPriceCents;
  const discountPct =
    args.menuPriceCents > 0 ? Math.round((savingCents / args.menuPriceCents) * 100) : 0;

  const priceLine =
    savingCents > 0 && discountPct > 0
      ? `${formatCents(args.dealPriceCents)} instead of ${formatCents(args.menuPriceCents)} (${discountPct}% off)`
      : formatCents(args.dealPriceCents);

  const deadline = momentLabel(args.cutoffAt, args.timeZone);
  const demandLine =
    args.joinedQty >= args.minQty
      ? `It’s on — ${args.joinedQty} ${args.joinedQty === 1 ? 'plate' : 'plates'} so far.`
      : `${args.joinedQty} of ${args.minQty} needed by ${deadline}.`;

  return [
    `${args.title} — ${args.merchantName}`,
    priceLine,
    demandLine,
    args.url,
  ].join('\n');
}
