/**
 * The redemption rules — FR-601…FR-605. Pure: no I/O, no clock, no Prisma.
 *
 * ## Why the decisions live here and not in the route
 *
 * "Can this code be redeemed, and if not, what do I tell the person holding the
 * phone?" is a question with a dozen answers and one of them is a lie that costs
 * money. A staff member at a counter at 6pm cannot debug; the screen must say the
 * one true thing. Keeping the mapping here means it is unit-tested against every
 * combination rather than written inline in a component and never exercised.
 *
 * ## The four things a scan can be
 *
 * | Outcome | Meaning | What the screen does |
 * |---|---|---|
 * | `REDEEMED` | units were taken off this order just now | green, show remaining |
 * | `ALREADY_REDEEMED` | nothing left to take | neutral, show when (FR-605) |
 * | `PARTIAL` | some units taken, the rest already gone | green-ish, show both |
 * | `REFUSED` | this code must not produce food | red, with the reason |
 *
 * `ALREADY_REDEEMED` is deliberately **not** an error. FR-605 says a double scan is
 * idempotent and shows "already redeemed at {time}" — a queue is full of people
 * double-tapping, and answering with a 409 and a red box teaches staff that the
 * screen is flaky rather than that the food is gone.
 */

/** The statuses in which handing over food is legitimate. */
export const REDEEMABLE_STATUSES = ['PICKUP_OPEN', 'COMPLETED'] as const;

export type RedeemableStatus = (typeof REDEEMABLE_STATUSES)[number];

/**
 * Why a code cannot be redeemed.
 *
 * Every member is a distinct sentence on screen, so this is a copy enum as much
 * as a logic one. Collapsing two reasons into one ("not valid") is how a staff
 * member ends up unable to tell "this diner is at the wrong restaurant" from "our
 * job has not run yet".
 */
export type RefusalReason =
  /** Not a code we signed, or signed with a different key. */
  | 'BAD_CODE'
  /** The code verifies but names a participant that no longer exists. */
  | 'UNKNOWN_PARTICIPANT'
  /**
   * Someone else's drop. **Deliberately indistinguishable on screen from
   * `UNKNOWN_PARTICIPANT`** — the two share their copy (asserted in the tests), so
   * a valid code from another merchant cannot be used to confirm that a drop id
   * exists. The distinct member is for the log, not the screen.
   */
  | 'NOT_YOUR_DROP'
  /** The drop is still `PUBLISHED`/`LOCKED` — nothing has been charged yet. */
  | 'NOT_YET'
  /** The drop failed. There is no food and nobody was charged. */
  | 'DROP_FAILED'
  /** The drop was cancelled. */
  | 'DROP_CANCELLED'
  /** The participant's card was declined; they were never charged. */
  | 'NOT_CHARGED'
  /** The order was refunded after capture (below capture tolerance). */
  | 'REFUNDED'
  /** All units already collected. */
  | 'FULLY_REDEEMED';

/**
 * The refusal table.
 *
 * Written as a `Record` over the union so adding a reason without writing copy
 * fails to compile. That is the whole mechanism: a new refusal with no sentence is
 * a blank red box at the counter.
 */
export const REFUSAL_COPY: Record<RefusalReason, { title: string; detail: string }> = {
  BAD_CODE: {
    title: 'Not a GroupEat code',
    detail: 'This does not look like one of ours. Ask them to open the link in their message again.',
  },
  UNKNOWN_PARTICIPANT: {
    title: 'Order not found',
    detail: 'This code is valid but there is no order for it here. Do not hand over food — call us.',
  },
  NOT_YOUR_DROP: {
    // Identical to UNKNOWN_PARTICIPANT by design. See the union's comment: the
    // screen must not distinguish "this drop is not yours" from "this order does
    // not exist", or a valid code becomes a probe for drop ids.
    title: 'Order not found',
    detail: 'This code is valid but there is no order for it here. Do not hand over food — call us.',
  },
  NOT_YET: {
    title: 'Not ready to collect',
    detail: 'This drop has not been charged yet. Nothing has been taken from them.',
  },
  DROP_FAILED: {
    title: 'This drop did not run',
    detail: 'Too few people joined, so nobody was charged. There is no order to collect.',
  },
  DROP_CANCELLED: {
    title: 'This drop was cancelled',
    detail: 'The drop was called off. Nobody was charged.',
  },
  NOT_CHARGED: {
    title: 'Their card was declined',
    detail: 'The charge did not go through, so there is no paid order. Do not hand over food.',
  },
  REFUNDED: {
    title: 'This order was refunded',
    detail: 'They were refunded in full. There is no paid order to collect.',
  },
  FULLY_REDEEMED: {
    title: 'Already collected',
    detail: 'Every plate on this order has been handed over.',
  },
};

/**
 * Whether a drop's status allows food to change hands.
 *
 * `PICKUP_OPEN` and `COMPLETED` only. `CAPTURED` is **not** enough: capture
 * happens at the cutoff, which can be the day before, and the kitchen has not
 * cooked yet. Redemption opens when the pickup window opens.
 *
 * That is a decision, not an accident of the enum: if `CAPTURED` were redeemable,
 * a staff member could hand over food for a drop whose window is tomorrow, and the
 * mistake would be invisible in the data — `redeemedQty` would look normal.
 */
export function isRedeemableStatus(status: string): status is RedeemableStatus {
  return (REDEEMABLE_STATUSES as readonly string[]).includes(status);
}

export type RedeemQuantityCheck =
  | { readonly ok: true; readonly take: number }
  | { readonly ok: false; readonly reason: 'FULLY_REDEEMED' };

/**
 * How many units this scan should take.
 *
 * `requested` is optional because the common scan takes everything left: the
 * staff member scanned a code, not a quantity. Asking for a number in a queue is
 * how queues get slower.
 *
 * Clamped rather than rejected when `requested` exceeds what is left. A diner who
 * ordered 3 and says "I'm collecting 2" while only 1 remains is a real
 * conversation at a counter, and the honest answer is to hand over the 1 that
 * exists — not to refuse and make them argue. The refusal only fires at zero.
 */
export function resolveRedeemQuantity(args: {
  readonly qty: number;
  readonly alreadyRedeemed: number;
  readonly requested?: number;
}): RedeemQuantityCheck {
  const remaining = args.qty - args.alreadyRedeemed;
  if (remaining <= 0) {
    return { ok: false, reason: 'FULLY_REDEEMED' };
  }
  if (args.requested === undefined) {
    return { ok: true, take: remaining };
  }
  // Integer, at least 1: a fractional or zero request is a caller bug, and
  // silently rounding it would put a number in `redeemedQty` nobody asked for.
  if (!Number.isInteger(args.requested) || args.requested < 1) {
    return { ok: true, take: remaining };
  }
  return { ok: true, take: Math.min(args.requested, remaining) };
}

/**
 * Trims what a scanner or a human typed into something `verifyRedemptionCode` can
 * look at.
 *
 * Three real inputs, all of which fail without this:
 *
 *   - a QR payload that arrived as a URL because the code page wrapped it in a
 *     link (`https://…/c/v1.abc.def`),
 *   - a trailing newline from a paste,
 *   - uppercase from a manual entry field — the token is base64url, which is
 *     case-sensitive, and staff will not know that.
 *
 * **Case is *not* folded.** base64url distinguishes `a` from `A`, so lowercasing
 * a pasted code would turn a valid code into an invalid one. Only the scheme and
 * whitespace are removed; the token is passed through byte for byte, because the
 * signature is over those bytes.
 */
export function normaliseScannedCode(raw: string): string {
  let value = raw.trim();

  // A QR that encodes a link: take the last path segment. Only `http(s)`, so a
  // crafted string like `javascript:…` is not silently unwrapped into something
  // that then gets signature-checked and—worse—believed.
  if (/^https?:\/\//i.test(value)) {
    const withoutQuery = value.split(/[?#]/)[0] ?? value;
    const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
    value = segments[segments.length - 1] ?? '';
  }

  // Some hand-held scanners prefix the payload. Drop a known prefix rather than
  // blindly stripping everything before the first dot, which would happily
  // "repair" a corrupt code into a different corrupt code.
  value = value.replace(/^GROUP_EAT[:;]/i, '');

  return value.trim();
}

/** One row of the batch manifest — what the pickup table needs to see. */
export type ManifestRow = {
  readonly participantId: string;
  readonly name: string | null;
  /** Digits only, last 4. The counter needs to match a person, not to phone them. */
  readonly phoneLast4: string;
  readonly qty: number;
  readonly redeemedQty: number;
  readonly redeemedAt: Date | null;
};

export type ManifestSummary = {
  readonly orders: number;
  readonly plates: number;
  readonly collected: number;
  readonly outstanding: number;
  readonly fullyCollectedOrders: number;
};

/**
 * The manifest's header numbers.
 *
 * Counts **plates** as well as orders because a pickup table is run against
 * plates: "12 of 30 collected" is checkable against the warmer, "4 of 9 orders"
 * is not. Both are shown; neither is derived from the other, because a single
 * order can be four plates.
 */
export function summariseManifest(rows: readonly ManifestRow[]): ManifestSummary {
  let plates = 0;
  let collected = 0;
  let fullyCollectedOrders = 0;

  for (const row of rows) {
    plates += row.qty;
    collected += row.redeemedQty;
    if (row.redeemedQty >= row.qty) {
      fullyCollectedOrders += 1;
    }
  }

  return {
    orders: rows.length,
    plates,
    collected,
    outstanding: plates - collected,
    fullyCollectedOrders,
  };
}

/**
 * Last four digits of a stored E.164 number, for staff to match a face to an
 * order without being handed a phone number they could ring.
 *
 * Deliberately not the whole number: FR-805's spirit — PII minimisation — applies
 * to the staff screen too. A NAME plus four digits identifies a person at a
 * counter; a full number identifies them afterwards.
 */
export function phoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}
