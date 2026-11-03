/**
 * The join rules — FR-401…FR-407. Pure: no I/O, no clock, no Prisma, no zod.
 *
 * ## What belongs here
 *
 * Every question the join path has to answer, in a module that can be read in one
 * sitting:
 *
 *   - is this a phone number a person could actually receive a text on?
 *   - is this quantity one this drop will accept?
 *   - how much money is this, and how much of it is ours?
 *   - given the drop's public view, may this person join at all?
 *
 * ## Why the module imports nothing
 *
 * Two reasons, both learned here.
 *
 * **It keeps zod out of the browser.** The join page needs `MAX_JOIN_QTY_LABEL`,
 * and `input.ts` next to it will import `zod` to build a schema. A client
 * component that imports a constant from a zod-importing module drags 19 kB of
 * validation library into the first-load bundle — the exact defect M6 shipped and
 * then fixed, where a single integer took a page from 104 kB to 122 kB. Keeping
 * the constants in a dependency-free module means the browser can import them and
 * the bundler has nothing to tree-shake.
 *
 * **It keeps the rules testable without a database.** Capacity, quantity bounds
 * and money arithmetic are the parts a diner's card depends on. They should be
 * provable in milliseconds, not by standing up Postgres.
 *
 * `payment-port.ts` and `service.ts` may import from here. This module must never
 * import from them, and `rules.purity.test.ts` enforces that.
 *
 * The one exception is `@/lib/guardrail/money`, for `formatCents`. It is a leaf
 * module of two pure functions with no imports of its own, so importing it cannot
 * pull Prisma or zod into a browser bundle, and `rules.purity.test.ts` asserts that
 * property directly rather than banning the import by name. The alternative —
 * reimplementing the formatter here to keep the "imports nothing" rule literally
 * true — is what created a second rounding rule, and the purity rule exists to
 * protect the bundle, not to protect a number.
 */
import { formatCents } from '@/lib/guardrail/money';

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

/**
 * The hard ceiling on one order, whatever the drop says.
 *
 * `Drop.maxPerCustomer` defaults to 4 and a merchant can raise it. This constant
 * is the second lock: a drop whose `maxPerCustomer` was set to 400 by a bad import
 * or a fat-fingered form must not let one diner authorise a four-figure charge.
 * The effective limit is `min(maxPerCustomer, MAX_JOIN_QTY)` — see
 * `qtyLimitFor()`.
 *
 * 20 is chosen to be generous for a genuine group order (a family, an office
 * lunch) and obviously wrong for a mistake.
 */
export const MAX_JOIN_QTY = 20;

/** For a `<input max>` and a copy string. Client-safe: this module imports nothing. */
export const MAX_JOIN_QTY_LABEL = String(MAX_JOIN_QTY);

/** The effective per-order limit for a drop: the merchant's cap, clamped. */
export function qtyLimitFor(maxPerCustomer: number): number {
  if (!Number.isInteger(maxPerCustomer) || maxPerCustomer < 1) {
    // A stored 0 or a negative is a data error, not a signal. Fall back to the
    // hardest limit rather than to "no limit", because the failure mode of the
    // latter is an unbounded authorisation.
    return 1;
  }
  return Math.min(maxPerCustomer, MAX_JOIN_QTY);
}

export type QtyRefusal = 'TOO_FEW' | 'TOO_MANY';

/**
 * Validates a quantity, or says which way it is wrong.
 *
 * Separate from the message so the reason is a bounded vocabulary a metric can
 * count, and the sentence can be reworded without changing the reason.
 */
export function checkQty(
  qty: number,
  limit: number,
): { ok: true; qty: number } | { ok: false; reason: QtyRefusal; message: string } {
  if (!Number.isInteger(qty)) {
    return { ok: false, reason: 'TOO_FEW', message: 'Choose how many you want.' };
  }
  if (qty < 1) {
    return { ok: false, reason: 'TOO_FEW', message: 'You have to order at least one.' };
  }
  if (qty > limit) {
    return {
      ok: false,
      reason: 'TOO_MANY',
      message:
        limit === 1
          ? 'This drop is limited to one per person.'
          : `This drop is limited to ${limit} per person.`,
    };
  }
  return { ok: true, qty };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * The one output format: `+1AAAEEEEEEE` for North America, `+CC…` otherwise.
 *
 * E.164 allows 15 digits total, and the leading digit of a country code cannot be
 * zero. The join path only needs to *store* a reachable number and text it; it
 * does not need to know which country is which beyond NANP, where a bare
 * 10-digit string is unambiguous and overwhelmingly the input a diner types.
 */
export type PhoneNormalisation =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneRefusal; message: string };

export type PhoneRefusal = 'EMPTY' | 'UNPARSEABLE';

/**
 * Normalises a typed phone number to E.164, or refuses.
 *
 * ## The rules, in order
 *
 *   1. Strip spaces, dashes, dots, parentheses and a leading `+`. These are how
 *      people write numbers, and refusing them is refusing the customer.
 *   2. A leading `00` is the international prefix in most of the world and means
 *      the same as `+`. Treat it as such.
 *   3. **Do not strip arbitrary letters silently.** "call me" must not become a
 *      number by a chain of `replace` calls. The check for stray characters runs
 *      *after* stripping the known separators, so `ext. 4` is refused rather than
 *      folded into the digits.
 *   4. 10 digits with no country code → NANP, so `+1` in front. This is the case
 *      that matters: every diner in Alberta types ten digits.
 *   5. 11 digits starting with `1` → NANP with the country code already there.
 *   6. Otherwise, 7–15 digits is treated as already international.
 *
 * ## What is deliberately not done
 *
 * No libphonenumber, no area-code table, no carrier lookup. A number that is
 * structurally E.164 and reachable is the requirement; validating that 780-555-01xx
 * is a real exchange is a deliverability problem, and it belongs to the SMS
 * provider (D-5), which will tell us the truth by failing to deliver. Rejecting on
 * a stale table would turn away a real diner to prevent a message that costs
 * nothing.
 */
export function normalisePhone(raw: string): PhoneNormalisation {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'EMPTY', message: 'Enter a mobile number we can text.' };
  }

  // Separators people actually type. Tab and newline included: a pasted number
  // from a contact card arrives with them.
  let working = trimmed.replace(/[\s\-.()/]/g, '');

  // `00` as an international prefix, before the `+` handling so that `0044…` and
  // `+44…` land on the same digits.
  if (working.startsWith('00')) {
    working = `+${working.slice(2)}`;
  }

  const hadPlus = working.startsWith('+');
  if (hadPlus) {
    working = working.slice(1);
  }

  // Anything that is not a digit at this point is not a phone number. Checked
  // after separator removal so `ext. 4` and `call me` are refused rather than
  // silently reduced to their digits.
  if (!/^\d+$/.test(working)) {
    return {
      ok: false,
      reason: 'UNPARSEABLE',
      message: 'That does not look like a phone number. Use digits, like 780-555-0123.',
    };
  }

  // A leading zero in a country code is not valid E.164.
  if (working.startsWith('0')) {
    return {
      ok: false,
      reason: 'UNPARSEABLE',
      message: 'That does not look like a phone number. Use digits, like 780-555-0123.',
    };
  }

  let e164: string;
  if (hadPlus) {
    e164 = `+${working}`;
  } else if (working.length === 10) {
    // The Alberta case. Ten bare digits are a North American number, and assuming
    // otherwise would make the common input an error.
    e164 = `+1${working}`;
  } else if (working.length === 11 && working.startsWith('1')) {
    e164 = `+${working}`;
  } else {
    // Already international, typed without the `+`.
    e164 = `+${working}`;
  }

  const digits = e164.slice(1);
  if (digits.length < 7 || digits.length > 15) {
    return {
      ok: false,
      reason: 'UNPARSEABLE',
      message: 'That does not look like a phone number. Use digits, like 780-555-0123.',
    };
  }

  return { ok: true, e164 };
}

/**
 * The last four digits, for a confirmation screen.
 *
 * A diner who typed their number wrong needs to see enough of it to notice, and
 * the full number echoed back is a shoulder-surfing risk in a group chat screenshot
 * — which is exactly how a deal gets shared.
 */
export function phoneLast4(e164: string): string {
  return e164.slice(-4);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * What one join costs, before any card authorisation is attempted.
 *
 * ## Why this is arithmetic and not a fee calculation
 *
 * `amountCents` is `qty × dealPriceCents` — a multiplication, no rounding, because
 * both operands are already integers and cents. The **fee** is the part with a
 * rounding rule, it lives in `platform-fee.ts` (ADR-004: round the unit, then
 * multiply), and this module deliberately does not restate it. Two implementations
 * of a rounding rule is two chances to disagree, and
 * `settlement/__tests__/no-inline-fee-rounding.test.ts` exists to forbid exactly
 * that in production code.
 *
 * So: the caller passes `platformFeeCents` in, computed by
 * `platformFeeCentsForOrder()` against the **frozen** snapshot. This function
 * supplies the gross and checks that the caller's fee is a sane integer.
 */
export type JoinMoney = {
  /** `qty × dealPriceCents`, integer cents, what the diner is authorising. */
  amountCents: number;
  /** Units, carried so a caller cannot pair an amount with the wrong quantity. */
  qty: number;
  /** Per-unit price, read verbatim from the drop. */
  unitPriceCents: number;
  /** From `platformFeeCentsForOrder()`, validated here. */
  platformFeeCents: number;
};

export type MoneyRefusal = 'BAD_PRICE' | 'BAD_FEE';

export function resolveJoinMoney(args: {
  qty: number;
  dealPriceCents: number;
  platformFeeCents: number;
}): { ok: true; money: JoinMoney } | { ok: false; reason: MoneyRefusal } {
  const { qty, dealPriceCents, platformFeeCents } = args;

  if (!Number.isInteger(dealPriceCents) || dealPriceCents < 1) {
    return { ok: false, reason: 'BAD_PRICE' };
  }
  // The fee must not exceed the amount: a fee larger than the charge is not a fee,
  // it is a bug that would make the merchant owe us money on every plate. Zero is
  // legal — a fee-waived drop — and so is the full amount, which the guardrail's
  // cap prevents in practice but which this function has no business refusing.
  if (
    !Number.isInteger(platformFeeCents) ||
    platformFeeCents < 0 ||
    platformFeeCents > qty * dealPriceCents
  ) {
    return { ok: false, reason: 'BAD_FEE' };
  }

  return {
    ok: true,
    money: {
      amountCents: qty * dealPriceCents,
      qty,
      unitPriceCents: dealPriceCents,
      platformFeeCents,
    },
  };
}

/**
 * Cents as a dollar string — by delegating, never by reimplementing.
 *
 * The same rule as `proposalFacts()`: a sentence containing a money figure is a
 * type signature (CONTRIBUTING.md), so the string is produced on the server and the
 * component prints it verbatim.
 *
 * ## Why this used to be wrong, and is not any more
 *
 * This function was `$${(cents / 100).toFixed(2)}` — a **second** formatting rule,
 * in a module whose own docblock declared that a client doing `toFixed(2)` would
 * "be blamed on the tax". It was the thing it warned about. It agreed with
 * `formatCents` on every price in the seed and disagreed on every value that is not
 * a whole cent, because `toFixed` rounds the decimal *representation* of a binary
 * float: `toFixed(2)` gives `1.005` → `1.00` while half-up gives `1.01`.
 *
 * It survived because nothing could catch it. `rules.ts` imports nothing by design
 * (see the module header), so it could not reach `formatCents`; the fee guard covers
 * settlement and never looks here; and the four assertions in `rules.test.ts` used
 * whole cents, where the two rules agree by construction. A test that only exercises
 * the agreeing case is a test that certifies a disagreement it never sees.
 *
 * It is now a delegation, and the in-line arithmetic lives in exactly one place.
 * The name is kept because four call sites say `dollars(...)` and reading
 * `formatCents` there would suggest the guardrail is involved; the docblock says
 * what it actually is.
 */
export function dollars(cents: number): string {
  return formatCents(cents);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Why a join was refused, as a bounded vocabulary.
 *
 * Every member is a *different sentence to a different person*, which is the test
 * for whether it deserves to be its own reason. `SOLD_OUT` and `CLOSED` are not
 * both "can't join": one means "come back next time", the other means "this one
 * has started". A single generic refusal would be cheaper to write and worse to
 * read.
 *
 * The payment members are separated because they need different recoveries:
 * `PAYMENT_DECLINED` is "try another card", `PAYMENT_UNAVAILABLE` is "try again in
 * a minute", and conflating them tells a diner with a good card to give up.
 */
export type JoinRefusalReason =
  /** Someone else took the last plate between the page load and the submit. */
  | 'SOLD_OUT'
  /** Not enough left for the quantity asked. FR-406. */
  | 'NOT_ENOUGH_LEFT'
  /** Past the cutoff, or the drop is no longer `PUBLISHED`. */
  | 'CLOSED'
  /** The drop failed its threshold. Nobody is charged; nobody may join. */
  | 'FAILED'
  /** Somebody called the drop off — FR-208, FR-902. Not a statement about demand. */
  | 'CANCELLED'
  /** No such code, or a draft. Indistinguishable on purpose. */
  | 'NOT_FOUND'
  /** Bad quantity. */
  | 'BAD_QTY'
  /** Bad phone number. */
  | 'BAD_PHONE'
  /** The drop's stored price or fee is not a usable integer. A data error. */
  | 'PRICE_UNAVAILABLE'
  /** The provider said no. */
  | 'PAYMENT_DECLINED'
  /** The provider could not answer. Retryable, and the row says so. */
  | 'PAYMENT_UNAVAILABLE'
  /** This drop cannot take cards at all. */
  | 'PAYMENTS_NOT_CONFIGURED'
  /** Same person, same drop, already joined. Returns the existing join. */
  | 'ALREADY_JOINED';

/**
 * The refusal copy. Exhaustive over the union, so a new reason cannot ship
 * without a sentence — the compiler is the checklist.
 *
 * `ALREADY_JOINED` has no user-facing sentence because it is not shown as an
 * error: it resolves to the existing participant and renders the confirmation the
 * diner should have seen. It is in the map to satisfy exhaustiveness, and the
 * service never returns it as a failure.
 */
export const JOIN_REFUSAL_COPY: Record<JoinRefusalReason, { title: string; detail: string }> = {
  SOLD_OUT: {
    title: 'This one is full',
    detail: 'Every plate in this batch has been claimed. Nothing has been charged.',
  },
  NOT_ENOUGH_LEFT: {
    title: 'Not enough left',
    detail: 'Someone else claimed the last plates while you were deciding. Nothing has been charged.',
  },
  CLOSED: {
    title: 'Joining has closed',
    detail: 'This drop stopped taking orders at its cutoff.',
  },
  FAILED: {
    title: "This drop didn't run",
    detail: 'It did not reach its minimum, so nobody was charged.',
  },
  CANCELLED: {
    title: 'This drop was cancelled',
    detail: 'The restaurant called it off. Nobody was charged, and anyone who paid has been refunded.',
  },
  NOT_FOUND: {
    title: 'Drop not found',
    detail: 'This link may be out of date. Ask for a fresh one.',
  },
  BAD_QTY: {
    title: 'Check the quantity',
    detail: 'Choose how many you want, within this drop’s limit.',
  },
  BAD_PHONE: {
    title: 'Check the phone number',
    detail: 'We need a mobile number to text your pickup code to.',
  },
  PRICE_UNAVAILABLE: {
    title: 'This drop cannot take orders right now',
    detail: 'Something about its pricing is not set up correctly. Nothing has been charged.',
  },
  PAYMENT_DECLINED: {
    title: 'Your card was declined',
    detail: 'Nothing has been charged. Try a different card.',
  },
  PAYMENT_UNAVAILABLE: {
    title: 'We could not reach the payment network',
    detail: 'Nothing has been charged. Try again in a minute.',
  },
  PAYMENTS_NOT_CONFIGURED: {
    title: 'Card payments are not available',
    detail: 'This site cannot take cards yet. Nothing has been charged.',
  },
  ALREADY_JOINED: {
    title: 'You are already in',
    detail: 'You joined this drop from this number.',
  },
};

/**
 * How many more plates a diner may take right now.
 *
 * The interaction of three limits, and getting it wrong is how a drop oversells:
 *
 *   - `maxPerCustomer` — the drop's own cap (FR-401);
 *   - `remaining` — what the batch has left (FR-406);
 *   - and for an existing joiner, `maxPerCustomer − alreadyJoined`, because
 *     "4 per person" must mean four in total, not four per submit.
 *
 * `Math.min` of a negative is a negative; clamped at zero so a caller never offers
 * a negative quantity.
 */
export function availableQty(args: {
  maxPerCustomer: number;
  remaining: number;
  alreadyJoined?: number;
}): number {
  const limit = qtyLimitFor(args.maxPerCustomer);
  const already = Math.max(0, args.alreadyJoined ?? 0);
  return Math.max(0, Math.min(limit - already, args.remaining));
}

/**
 * Decides whether a join may proceed, from facts only.
 *
 * ## Why the drop's join-ability is not re-derived here
 *
 * `drop-view.ts` already answers "may this person join, and if not why", and the
 * deal page, the count endpoint and its tests all read that one function. If join
 * re-implemented the status/cutoff/threshold logic there would be two definitions
 * of the open door, and the failure is a page that offers a button the API then
 * refuses (or worse, an API that accepts a join the page told the diner was
 * closed).
 *
 * So this function takes the view's `joinBlockedReason` as an **input** and only
 * translates it into join's vocabulary. The mapping is total over
 * `JoinBlockedReason`; if `drop-view.ts` grows a member, this stops compiling,
 * which is the desired behaviour — a new blocked reason must reach this sentence
 * list rather than fall through to a generic refusal.
 */
export type JoinBlockedReasonLike = 'SOLD_OUT' | 'CLOSED' | 'FAILED' | 'CANCELLED';

export function refusalFromBlocked(
  blocked: JoinBlockedReasonLike | null,
  qty: number,
  available: number,
): JoinRefusalReason | null {
  if (blocked === null) {
    // The drop is open. Whether *this quantity* fits is a separate question,
    // because the door being open does not mean four plates are left in it.
    if (available <= 0) return 'SOLD_OUT';
    if (qty > available) return 'NOT_ENOUGH_LEFT';
    return null;
  }
  if (blocked === 'FAILED') return 'FAILED';
  // A cancelled drop takes no joins and its own sentence — "the restaurant called it
  // off" — rather than `CLOSED`'s "the deadline has passed", which would be a lie
  // about a drop that may have been cancelled hours before its cutoff.
  if (blocked === 'CANCELLED') return 'CANCELLED';
  if (blocked === 'CLOSED') return 'CLOSED';
  return 'SOLD_OUT';
}

/**
 * The sentence a diner reads on the confirmation screen — FR-407.
 *
 * Required to say, in substance: *you will only be charged if {minQty} people join
 * by {cutoff}*. It is built here rather than in the component for the same reason
 * every other money sentence is: it contains figures, and a figure formatted in
 * two places is a figure that will disagree with itself.
 *
 * The "only" is doing legal work. This is the moment the diner learns that a card
 * authorisation is not a payment, and §8.1 of the PRD makes that disclosure
 * mandatory. It must not be softened into "you may be charged if" — that phrasing
 * is ambiguous about whether a charge can happen before the cutoff.
 */
export function joinConfirmationCopy(args: {
  qty: number;
  amountLabel: string;
  minQty: number;
  closesLabel: string;
  isConfirmedAlready: boolean;
}): string {
  const plates = args.qty === 1 ? '1 plate' : `${args.qty} plates`;
  const charge = `You will only be charged ${args.amountLabel} for ${plates}`;

  if (args.isConfirmedAlready) {
    // ADR-003: the drop already has its minimum, so "only if N people join" would
    // be a strange thing to say to someone joining drop 22 of 20. The charge still
    // waits for the cutoff, which is the part that needs saying.
    return `${charge} when this drop closes at ${args.closesLabel}. It has already reached its minimum, so it is going ahead.`;
  }

  return `${charge} if at least ${args.minQty} people join by ${args.closesLabel}. Nothing is charged today.`;
}
