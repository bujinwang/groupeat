import { roundHalfUp } from '@/lib/guardrail';

/**
 * FR-804 — the organiser's commission statement, as arithmetic.
 *
 * > `FR-804 | Commission statement: units × 5% of captured GMV | Monthly,
 * > exportable` — PRD-v1.md:539
 *
 * Pure: no Prisma, no `Date.now()`, no I/O. Every instant this module reasons about
 * arrives as an argument, which is what makes AC11 ("the same organiser and month
 * rendered twice return byte-identical figures") a property of the code rather than
 * a hope about the clock.
 *
 * ## The base is net, and gross is the wrong answer that looks right
 *
 * `commission = roundHalfUp((subtotalCents − refundedCents) × bp / 10 000)`. Not
 * `subtotalCents`. A force-failed drop (FR-502/FR-902) captures every card and then
 * refunds every card: gross would pay the organiser for a drop that never happened,
 * on money the restaurant kept none of, and §3.3 ties the incentive to what the link
 * actually *sold*. Twenty plates at $24 that all came back is `commission 0`, not
 * `2400`.
 *
 * This is not a preference. `src/lib/settlement/ledger.ts` L1 defines the truthful
 * "money we hold" figure as `charged − refunded == Σ (order.subtotalCents −
 * order.refundedCents)`. Commission reading gross would be the only place in the
 * codebase that disagrees with the ledger about what a captured dollar is.
 *
 * ## Round the lines, then sum. Never sum the base, then round
 *
 * Two lines each netting `1810` at 5% are `91` and `91`, so the statement totals
 * `182`. Rounding the summed base gives `roundHalfUp(3620 × 500 / 10 000) = 181` — a
 * total that disagrees with the column a human adds up in the spreadsheet, by one
 * cent, once per rounding boundary per month. Ops pays from the CSV. The CSV must
 * therefore sum to the printed total, and the only way that holds for arbitrary line
 * counts is to sum already-rounded values (`totalsFor`).
 *
 * `roundHalfUp` is the codebase's only rounding point (`src/lib/guardrail/money.ts`).
 * `Math.round` happens to agree on positives today and would silently change
 * behaviour the moment a negative intermediate appeared; `toFixed` is a formatting
 * function with its own half-even-ish habits. Neither is used here.
 *
 * ## The month is Edmonton's, not the server's and not the merchant's
 *
 * `COMMISSION_PERIOD_TZ` is a constant. Not `Merchant.timezone`: the period belongs
 * to the *organiser*, `OrganiserProfile` has no timezone column, and per-merchant
 * zones would make one organiser's "March" a union of windows that no single
 * `[from, to)` pair can express — at which point the query and the CSV could no
 * longer be proven equal. `Merchant.timezone` already defaults to Edmonton and §1.3
 * defines the corridor as one zone. If a merchant outside Mountain Time ever
 * onboards, this constant is the line to revisit.
 *
 * And it is emphatically not the server's zone. The server runs UTC, so
 * `new Date(2026, 2, 1)` is `2026-03-01T00:00Z`, which is `2026-02-28T17:00` in
 * Edmonton — seven hours of February's orders silently move into March, every month,
 * with no error anywhere. `utcForLocalMidnight` resolves the offset explicitly
 * instead, and AC6 pins it: `2026-03-01T06:30:00Z` is `2026-02-28 23:30 MST`, so it
 * belongs to February even though a UTC-naive filter says March.
 *
 * ## Why `pickup_date` is an ISO date and not `momentLabel`
 *
 * `momentLabel` produces a *human label* — "Thursday 1:00 PM" — and it is the only
 * formatter for one. `pickup_date` is a machine date: it is a CSV cell that a
 * spreadsheet must be able to sort and that the screen must show identically, and
 * the spec is explicit that it is display-only and never the period key. So it is
 * `YYYY-MM-DD` in the merchant's zone, assembled from `formatToParts` — the same
 * primitive the period maths needs, not a second date library. The period key stays
 * `Order.createdAt`; nothing here is allowed to influence which month a dollar is in.
 *
 * ## Why the CSV is ASCII and why it has no totals row
 *
 * ASCII: Excel on a Windows box opens a `.csv` in the machine's ANSI code page, not
 * UTF-8, so "Café" arrives as "CafÃ©" and an operator reconciling a bank transfer
 * reads a mangled merchant name. Names are folded to ASCII (`toAscii`) rather than
 * dropped, so the row is still identifiable.
 *
 * No totals row: a totals line inside a data file makes `SUM()` over the column
 * double-count, which is the first thing anyone does with a statement export. Every
 * money column is additive by construction, so a spreadsheet sums it correctly with
 * no help from us — and the route test asserts exactly that sum equals the figure
 * the page prints.
 */

/**
 * The zone every commission month boundary is resolved in. See the module docblock
 * for why this is a constant rather than `Merchant.timezone`.
 *
 * ## This constant is not the whole answer: the tz database is an input too
 *
 * Where a month ends is decided by `Intl` and therefore by the tz database the Node
 * binary ships, so it is a **runtime dependency of a paid figure**. It is not
 * hypothetical: tzdata 2026c is the first release in which Alberta stops changing
 * clocks (from 2026-11-01), and 2025c does not know that. Under 2025c,
 * `commissionPeriodFor('2026-11')` closes at `2026-12-01T07:00Z`; under 2026c it closes
 * at `06:00Z`. The consequence is that `monthKeyOf('2026-12-01T06:30:00Z')` is November
 * on one machine and December on another — one hour of every boundary, attributed
 * differently depending on who ran the export.
 *
 * So the runtime is pinned: `.nvmrc` names 24.21.0, and `engines.node` floors at
 * `>=24.0.0` to exclude the Node lines that ship a stale database. A floor rather than
 * an exact pin, because a newer Node shipping a *newer* database is the fix, not the
 * risk.
 *
 * What is deliberately **not** done about it: no test asserts an hour count at a
 * boundary. That would encode the database rather than the rule, and would start
 * failing the day the rules move again — which they will. The invariant that is
 * asserted is the one true under any database: each boundary is local midnight on the
 * 1st, and consecutive months tile with no gap and no overlap.
 */
export const COMMISSION_PERIOD_TZ = 'America/Edmonton';

/** `5.00` → `500`. One percentage point is 100 basis points. */
export const BASIS_POINTS_PER_PCT = 100;

/** `500` bp is 5%, so the divisor is 100 × 100. */
export const BASIS_POINTS_DIVISOR = 10_000;

/**
 * The earliest and latest years `?month=` will accept.
 *
 * Not a security boundary — a typo boundary. `202-03` and `20260-03` are already
 * rejected by the shape, but `0001-03` and `9999-12` parse fine and would ask the
 * database for a century it has no rows in, or for `Date.UTC` to represent a year
 * before the epoch in a column that cannot mean anything.
 */
const MIN_PERIOD_YEAR = 2000;
const MAX_PERIOD_YEAR = 2100;

const MONTH_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Every `DropStatus`, transcribed so this module stays free of `@prisma/client`.
 *
 * The DB layer assigns a Prisma `DropStatus` into this union, so the day the enum
 * grows and this list does not, `tsc` fails at that assignment instead of the extra
 * status silently rendering as an unstyled badge.
 */
export const COMMISSION_DROP_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'LOCKED',
  'CAPTURED',
  'PICKUP_OPEN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type CommissionDropStatus = (typeof COMMISSION_DROP_STATUSES)[number];

/** A calendar month, bounded by two half-open UTC instants resolved in Edmonton. */
export type CommissionPeriod = {
  /** `YYYY-MM`. The value `?month=` carries. */
  readonly monthKey: string;
  readonly year: number;
  /** 1–12, as a human writes it. */
  readonly month: number;
  /** Inclusive. Local midnight on the 1st, as a UTC instant. */
  readonly from: Date;
  /** Exclusive. Local midnight on the 1st of the next month, as a UTC instant. */
  readonly to: Date;
};

/**
 * One order's contribution to a line — the only money facts commission reads.
 *
 * Deliberately not the Prisma `Order`: `Order.id` must never reach a row an organiser
 * can see (FR-805 lists it as forbidden), so the id lives here, on the *input* type,
 * and is used for one thing — naming the offending order in an integrity failure.
 */
export type CommissionOrderFact = {
  readonly orderId: string;
  readonly qty: number;
  readonly subtotalCents: number;
  readonly refundedCents: number;
};

/** The raw material of a line: one `ShareLink`, its drop, and its orders. */
export type CommissionLineSource = {
  readonly dropId: string;
  readonly merchantName: string;
  readonly dropTitle: string;
  readonly dropStatus: CommissionDropStatus;
  readonly windowStart: Date;
  readonly merchantTimezone: string;
  readonly orders: readonly CommissionOrderFact[];
};

/**
 * One row of the statement — and, structurally, FR-805.
 *
 * There is no field here capable of holding a phone number, an email, a customer
 * name, a customer id, a participant id, a payment intent, a redemption code or an
 * order id. Not "we do not select them": the type could not carry them if the query
 * tried. That is the same enforcement `ShareableDropRow` uses, and for the same
 * reason — a projection rule is a rule somebody eventually gets wrong, a type is not.
 *
 * `dropId` is the render key. One `ShareLink` per (drop, organiser) is enforced by
 * `@@unique([dropId, organiserId])`, so within one organiser's statement a drop
 * identifies exactly one line. It is an identifier for a drop the organiser already
 * saw, not PII.
 */
export type CommissionLineRow = {
  readonly dropId: string;
  readonly merchant: string;
  readonly drop: string;
  /** `YYYY-MM-DD` in the merchant's zone. Display only; never the period key. */
  readonly pickupDate: string;
  /** Captured units. A fully refunded line still shows them. */
  readonly units: number;
  readonly grossCapturedCents: number;
  readonly refundedCents: number;
  /** `grossCapturedCents − refundedCents`, asserted non-negative at read time. */
  readonly netCapturedCents: number;
  /** The organiser's rate, in basis points. Integers authoritative; see `commissionPctLabel`. */
  readonly commissionBasisPoints: number;
  readonly commissionCents: number;
  readonly dropStatus: CommissionDropStatus;
};

/** The statement's last row: each money column summed, and the **rounded** commissions summed. */
export type CommissionTotals = {
  readonly units: number;
  readonly grossCapturedCents: number;
  readonly refundedCents: number;
  readonly netCapturedCents: number;
  readonly commissionCents: number;
};

/** The CSV's column order, exactly as the spec lists it. Exported so the test asserts the contract, not a copy. */
export const COMMISSION_CSV_COLUMNS = [
  'merchant',
  'drop',
  'pickup_date',
  'units',
  'gross_captured_cents',
  'refunded_cents',
  'net_captured_cents',
  'commission_pct',
  'commission_cents',
  'commission_dollars',
  'drop_status',
] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function pad4(value: number): string {
  return `${value}`.padStart(4, '0');
}

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

/**
 * One formatter per zone, reused.
 *
 * Not a micro-optimisation for its own sake: the period maths calls this four times
 * per statement and the CSV path once per line, and constructing an
 * `Intl.DateTimeFormat` is the expensive part of an `Intl` call by an order of
 * magnitude. Memoising keeps the function pure — the cache is keyed by the zone and
 * an `Intl` formatter is immutable.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) {
    return existing;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
}

/**
 * The wall clock a given instant reads as, in a given zone.
 *
 * Throws on an unknown zone rather than falling back to the server's: a boundary
 * resolved in the wrong zone is off by hours and looks entirely plausible, whereas an
 * exception is one line in a log.
 */
function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) {
      throw new Error(`Time zone "${timeZone}" produced no "${type}" part.`);
    }
    const value = Number(found.value);
    if (!Number.isFinite(value)) {
      throw new Error(`Time zone "${timeZone}" produced a non-numeric "${type}" part.`);
    }
    return value;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as hour "24" under `hour12: false`. Without
    // this fold, local midnight would be read as 24:00 and the offset would come out
    // a day wrong — for exactly the two instants a month boundary is built from.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * How far ahead of UTC the zone is at a given instant, in milliseconds.
 *
 * Negative for Edmonton (UTC−7 in winter, UTC−6 in summer). Derived by reading the
 * zone's wall clock and asking what UTC instant would print that clock — which is
 * the only portable way to ask, since `Intl` exposes no offset accessor.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const wall = wallClockIn(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // The wall clock carries whole seconds, so compare against the instant truncated
  // to the same precision. A millisecond remainder would otherwise be read as part
  // of the offset and shift every boundary by up to 999 ms.
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * The UTC instant at which `year-month-01 00:00` occurs in `timeZone`.
 *
 * Two passes. The first guesses with the offset in force at the *naive* instant; the
 * second re-reads the offset at that candidate and corrects. One pass is wrong for any
 * boundary that sits on the far side of a transition from the naive guess, and the
 * error is exactly one hour — enough to move an hour of orders across a month line,
 * which is invisible in every figure except the one being paid.
 *
 * Which boundaries those are is a property of the zone database, not of this code: it
 * depends on where the transitions fall that year, and it changes when the tz data
 * changes. So the second pass is a safety net that is always taken rather than a
 * correction aimed at a particular month. The test asserts the property that must hold
 * under any rule — each boundary is local midnight on the 1st — instead of asserting an
 * hour count that belongs to the runtime's tz database.
 *
 * Known limitation, stated rather than hidden: if local midnight does not exist on
 * the 1st (a zone that springs forward at 00:00), this resolves to 01:00 local and an
 * hour of that day's orders would fall outside the period. Edmonton transitions at
 * 02:00 local, so midnight exists on every day of every month, and
 * `COMMISSION_PERIOD_TZ` is the only zone this ever sees.
 */
function utcForLocalMidnight(year: number, month: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const firstGuess = naive - offsetMsAt(new Date(naive), timeZone);
  const corrected = naive - offsetMsAt(new Date(firstGuess), timeZone);
  return new Date(corrected);
}

/**
 * `YYYY-MM` for an instant, read in a zone.
 *
 * The inverse of `commissionPeriodFor`, and the function AC6 turns on: it is what
 * says `2026-03-01T06:30:00Z` is February.
 */
export function monthKeyOf(instant: Date, timeZone: string = COMMISSION_PERIOD_TZ): string {
  const wall = wallClockIn(instant, timeZone);
  return `${pad4(wall.year)}-${pad2(wall.month)}`;
}

/**
 * `YYYY-MM-DD` for an instant, read in a zone.
 *
 * See the module docblock for why this exists beside `momentLabel` rather than
 * calling it: this is a sortable machine date for a CSV cell and a table cell that
 * must agree byte for byte, not a human label.
 */
export function isoDateInZone(instant: Date, timeZone: string): string {
  const wall = wallClockIn(instant, timeZone);
  return `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/**
 * The half-open `[from, to)` bounding a calendar month in Edmonton, or `null`.
 *
 * `null` for anything that is not exactly `YYYY-MM` in range — a missing parameter,
 * an empty string, `2026-3`, `2026-13`, `March 2026`, a full date. Returning `null`
 * rather than throwing is deliberate: the caller is a page, and a page reached from a
 * hand-edited URL must fall back to the current month rather than 500. The route is
 * the one place that turns `null` into a 400, because a file labelled with a month
 * nobody asked for is worse than no file.
 */
export function parseCommissionPeriod(
  raw: string | null | undefined,
): CommissionPeriod | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = MONTH_KEY_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || year < MIN_PERIOD_YEAR || year > MAX_PERIOD_YEAR) {
    return null;
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    monthKey: `${pad4(year)}-${pad2(month)}`,
    year,
    month,
    from: utcForLocalMidnight(year, month, COMMISSION_PERIOD_TZ),
    to: utcForLocalMidnight(nextYear, nextMonth, COMMISSION_PERIOD_TZ),
  };
}

/**
 * The same, for a caller that has already validated the key and cannot proceed
 * without one. Throws; never returns a period it guessed.
 */
export function commissionPeriodFor(monthKey: string): CommissionPeriod {
  const period = parseCommissionPeriod(monthKey);
  if (!period) {
    throw new Error(`"${monthKey}" is not a commission month; expected YYYY-MM.`);
  }
  return period;
}

/**
 * `2026-03` + 1 → `2026-04`, `2026-01` − 1 → `2025-12`.
 *
 * Integer month arithmetic on a zero-based month index, so December and January are
 * not special cases and no `Date` is constructed — a `Date` here would reintroduce
 * exactly the zone bug the period maths exists to avoid.
 */
export function shiftMonthKey(monthKey: string, deltaMonths: number): string {
  const period = commissionPeriodFor(monthKey);
  const zeroBased = period.year * 12 + (period.month - 1) + Math.trunc(deltaMonths);
  const year = Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return `${pad4(year)}-${pad2(month)}`;
}

/**
 * `5.00` → `500`. Exact for the two decimals `Decimal(5,2)` stores.
 *
 * `Math.round` rather than `roundHalfUp` because this is not a money rounding: it is
 * a decimal-to-integer conversion of a value that is already exact at two places, and
 * `roundHalfUp`'s `Math.floor(x + 0.5)` would be wrong for the `-0.4` that a caller
 * who skipped validation could supply. A negative rate is refused upstream
 * (`commissionRefusal` in `lib/db/organisers.ts`), so the sign question does not arise.
 */
export function commissionBasisPoints(pct: number): number {
  if (!Number.isFinite(pct)) {
    throw new Error(`Commission rate "${pct}" is not a finite number.`);
  }
  return Math.round(pct * BASIS_POINTS_PER_PCT);
}

/**
 * `500` → `'5.00'`. Two decimals, no symbol, no `%`.
 *
 * Built by integer division on the basis points rather than `toFixed`, so the string
 * is the exact decimal the basis points encode. `(5.05).toFixed(2)` is `'5.05'` but
 * `(1.005).toFixed(2)` is `'1.00'` — the float is already wrong before the formatting
 * starts, and the CSV would carry a rate that is not the rate.
 */
export function commissionPctLabel(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / BASIS_POINTS_PER_PCT);
  const fraction = Math.abs(basisPoints % BASIS_POINTS_PER_PCT);
  return `${whole}.${pad2(fraction)}`;
}

/**
 * The number ops pays for one line: `roundHalfUp(net × bp / 10 000)`.
 *
 * `netCents` must already be `subtotalCents − refundedCents`; this function does not
 * know about orders and must not be handed a gross figure.
 */
export function commissionCentsFor(netCents: number, basisPoints: number): number {
  return roundHalfUp((netCents * basisPoints) / BASIS_POINTS_DIVISOR);
}

/**
 * Refuses a line whose refunds exceed what was charged, naming the order.
 *
 * `Order.refundedCents` accumulates via `{ increment }`, `assertRefundAmount` refuses
 * more than `subtotalCents`, and `issueParticipantRefund` refuses a second refund, so
 * this cannot fire on correct data — which is exactly why it throws instead of
 * clamping. A clamp turns a ledger defect into a plausible smaller commission: the
 * organiser is underpaid, nobody is told, and the number that would have pointed at
 * the broken refund is gone. The order id is in the message because the point of the
 * failure is which row disagrees.
 *
 * Non-integer money is refused too. `Decimal` → `number` conversions and any future
 * arithmetic that forgets to round both surface here rather than as a statement that
 * is off by a fraction of a cent in a direction nobody can reproduce.
 */
export function assertRefundWithinSubtotal(orders: readonly CommissionOrderFact[]): void {
  for (const order of orders) {
    if (
      !Number.isInteger(order.subtotalCents) ||
      !Number.isInteger(order.refundedCents) ||
      !Number.isInteger(order.qty)
    ) {
      throw new Error(
        `Commission facts for order ${order.orderId} are not integers (qty ${order.qty}, subtotal ${order.subtotalCents}, refunded ${order.refundedCents}). Money in this codebase is integer cents.`,
      );
    }
    if (order.refundedCents < 0 || order.refundedCents > order.subtotalCents) {
      throw new Error(
        `Commission base is inconsistent for order ${order.orderId}: refundedCents ${order.refundedCents} is outside 0..${order.subtotalCents}. Refusing to clamp — a refund larger than its charge is a ledger defect, and a clamped commission would hide it.`,
      );
    }
  }
}

/**
 * One statement line from one `ShareLink`'s orders.
 *
 * Presence is the caller's decision and it is decided by activity: this function is
 * only ever called with at least one order, which is how a force-failed drop still
 * appears (its orders exist, they just net to zero) while a link nobody joined does
 * not (it has no orders to group).
 */
export function buildCommissionLine(
  source: CommissionLineSource,
  basisPoints: number,
): CommissionLineRow {
  assertRefundWithinSubtotal(source.orders);

  let units = 0;
  let grossCapturedCents = 0;
  let refundedCents = 0;
  for (const order of source.orders) {
    units += order.qty;
    grossCapturedCents += order.subtotalCents;
    refundedCents += order.refundedCents;
  }
  const netCapturedCents = grossCapturedCents - refundedCents;

  return {
    dropId: source.dropId,
    merchant: source.merchantName,
    drop: source.dropTitle,
    pickupDate: isoDateInZone(source.windowStart, source.merchantTimezone),
    units,
    grossCapturedCents,
    refundedCents,
    netCapturedCents,
    commissionBasisPoints: basisPoints,
    commissionCents: commissionCentsFor(netCapturedCents, basisPoints),
    dropStatus: source.dropStatus,
  };
}

/**
 * The totals row: sum each money column, and **sum the already-rounded commissions**.
 *
 * See the module docblock. Summing `netCapturedCents` and then rounding it once would
 * produce a total that differs from the column above it by a cent at every rounding
 * boundary — the printed total would not equal the spreadsheet's, and the figure ops
 * pays would not equal the figure the organiser added up.
 */
export function totalsFor(lines: readonly CommissionLineRow[]): CommissionTotals {
  let units = 0;
  let grossCapturedCents = 0;
  let refundedCents = 0;
  let netCapturedCents = 0;
  let commissionCents = 0;

  for (const line of lines) {
    units += line.units;
    grossCapturedCents += line.grossCapturedCents;
    refundedCents += line.refundedCents;
    netCapturedCents += line.netCapturedCents;
    commissionCents += line.commissionCents;
  }

  return { units, grossCapturedCents, refundedCents, netCapturedCents, commissionCents };
}

/**
 * Folds a display string to printable ASCII.
 *
 * `NFKD` splits an accented letter into base + combining mark, the mark is dropped,
 * and anything still outside `0x20–0x7E` (CJK, emoji, a stray control byte) becomes
 * `?` so the cell keeps its width and its position in the row. Dropping the whole
 * character instead would silently shorten a merchant name.
 */
function toAscii(value: string): string {
  const folded = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return folded.replace(/[^\x20-\x7E]/g, '?');
}

/**
 * One CSV cell, quoted only when it has to be.
 *
 * Quoting every cell would be valid CSV and unreadable in a terminal; quoting none
 * breaks on the first merchant called "Rangoli, Downtown". The rule is RFC 4180's,
 * applied to the string `toAscii` produces: quote when it contains a comma, a double
 * quote, or leading or trailing whitespace, and double any embedded quote.
 *
 * The line-break half of RFC 4180's rule is **not** live here, and saying so is worth
 * more than the rule is. `toAscii` folds every byte outside `0x20–0x7E` to `?`, and
 * `\n` (0x0A) and `\r` (0x0D) are inside that excluded range — so by the time the quote
 * test runs, the cell cannot contain a line break and the `\r\n` alternative below is
 * unreachable. It stays as defence in depth for the day `toAscii` stops folding control
 * bytes; it is doing no work today, and a comment claiming otherwise is worse than no
 * comment because the next maintainer trusts it.
 *
 * Folding is the right answer for a line break here rather than quoting it. A folded
 * cell keeps its width and its row position, and the row count stays one line per
 * statement line. A quoted multi-line cell is technically valid CSV and worse in
 * practice: it reads correctly only in a parser that honours quoting, and the operator
 * reconciling a bank transfer against it sees a title broken across a row of figures.
 * `Tuesday?second sitting` is uglier than the original and better than either
 * alternative.
 */
function csvText(value: string): string {
  const ascii = toAscii(value);
  const escaped = ascii.replace(/"/g, '""');
  const needsQuotes = /[",\r\n]/.test(ascii) || ascii !== ascii.trim();
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * Integer cents as a plain decimal — `90` → `'0.90'`.
 *
 * No `$`, no thousands separator, no locale. This is the one column a bank transfer
 * is checked against, so it must be a number a spreadsheet parses without a cleaning
 * step. Integer arithmetic rather than `toFixed`, for the reason in
 * `commissionPctLabel`: by the time `toFixed` sees a float, the float has already
 * decided.
 */
function centsAsPlainDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}${dollars}.${pad2(remainder)}`;
}

/**
 * The statement as CSV bytes — a serialisation of the table, not a transaction export.
 *
 * One row per line, the eleven columns in `COMMISSION_CSV_COLUMNS`, header included,
 * `\n` line endings, trailing newline. No totals row and no comment preamble: see the
 * module docblock. The bytes are pure ASCII, so the `charset=utf-8` the route sends is
 * a truthful superset rather than a promise the content does not keep.
 */
export function toCsv(rows: readonly CommissionLineRow[]): string {
  const lines: string[] = [COMMISSION_CSV_COLUMNS.join(',')];

  for (const row of rows) {
    lines.push(
      [
        csvText(row.merchant),
        csvText(row.drop),
        csvText(row.pickupDate),
        `${row.units}`,
        `${row.grossCapturedCents}`,
        `${row.refundedCents}`,
        `${row.netCapturedCents}`,
        commissionPctLabel(row.commissionBasisPoints),
        `${row.commissionCents}`,
        centsAsPlainDollars(row.commissionCents),
        csvText(row.dropStatus),
      ].join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * A filename-safe slug for an organiser, derived from their display name.
 *
 * `OrganiserProfile` has no slug column and adding one is a migration this slice was
 * told not to make, so the slug is derived. That is enough for its only job — naming
 * a download `groupeat-commission-sam-organiser-2026-03.csv` instead of
 * `groupeat-commission-<uuid>-2026-03.csv` — and the derivation is stable for a given
 * name. Two organisers with the same name produce the same filename, which costs
 * nothing: the file is a download on their own machine, never a key.
 *
 * Falls back to `'organiser'` rather than an empty segment, because
 * `groupeat-commission--2026-03.csv` reads as a bug in the export.
 */
export function organiserSlug(displayName: string): string {
  const folded = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return folded.length > 0 ? folded : 'organiser';
}
