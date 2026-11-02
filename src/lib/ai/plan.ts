import {
  THIN_DISCOUNT_THRESHOLD,
  evaluateDeal,
  type CompleteGuardrailInput,
  type DealEvaluation,
} from '@/lib/guardrail';
import { validateDropQuantities, validateDropTiming } from '@/lib/drops/rules';

/**
 * The proposal planner — PRD-v1 §9.2's "3 proposals", computed deterministically.
 *
 * ## Why this is not the model's job
 *
 * PRD-v1 §9.2's output contract has the model returning `dealPriceCents`,
 * `minQty` and `maxQty` alongside the copy. It should not. §9.1 states the rule
 * the contract then breaks:
 *
 *   1. "The model never computes money."
 *   2. "The model never sets a price. It proposes; the deterministic slider
 *      enforces."
 *
 * If the model emits `1112` and the server clamps anything below the floor up to
 * `1112`, the model contributed nothing — the number on screen was always going
 * to be the floor. What the model *did* contribute is a chance to be wrong: a
 * price above the menu, a `maxQty` of 40 for a dish that yields 10, a window that
 * ends before it starts. Each of those has to be caught by a check that exists
 * only because the model was allowed to answer a question it had no business
 * answering.
 *
 * So the split is: **this file decides the shape of the offer; the model writes
 * the words.** `planProposals` is pure, has no I/O, and produces a complete,
 * publishable proposal on its own. `deal-builder.ts` may then ask a model to
 * rewrite `rationale` / `title` / `description` / `shareMessage` — and nothing
 * else. See `docs/ADR-002-ai-price-authorship.md`.
 *
 * ## The three archetypes are different bets, not three price points
 *
 * The strategy doc's three deal archetypes (batch drop, social unlock, surplus
 * rescue) are structural. Three proposals at three prices would be a menu with
 * one dish on it; three proposals at different *commitments* is a decision:
 *
 * | Archetype     | Price        | Minimum            | Per person | Notice |
 * |---------------|--------------|--------------------|------------|--------|
 * | `QUIET_HOUR`  | closest to menu | highest of the three | 4      | 3h     |
 * | `TRIAL`       | at the floor | high               | **1**      | 12h    |
 * | `SURPLUS`     | at the floor | lowest of the three | 2        | 2h     |
 *
 * `TRIAL` is deliberately **not** called "new customers". The strategy doc is
 * explicit that a new-customer offer must be gated to people who have not bought
 * before, and nothing in the V1 schema can enforce that gate — `maxPerCustomer:
 * 1` limits a stock-up, it does not identify a first-timer. Naming it after a
 * mechanism we do not have would be the same class of lie as a snapshot built
 * from the wrong contribution figure.
 *
 * ## Every proposal is checked by the publish path's own rules
 *
 * A proposal is a draft the merchant will publish in one click. So each one is
 * run through `validateDropTiming` and `validateDropQuantities` — the functions
 * `publishDrop` runs — before it is returned. A proposal that would be refused
 * at publish never reaches the screen.
 */

/** The structural bet a proposal makes. See the table above. */
export type ProposalArchetype = 'QUIET_HOUR' | 'TRIAL' | 'SURPLUS';

/** Q4 of the interview: what the merchant wants out of this drop. */
export type PlannerIntent = 'FILL_QUIET_HOUR' | 'NEW_CUSTOMERS' | 'EITHER';

export type PlannerDish = {
  id: string;
  name: string;
  menuPriceCents: number;
  batchYield: number;
};

export type PlannedProposal = {
  archetype: ProposalArchetype;
  menuItemId: string;

  /** Server-computed. Always `>= minViablePriceCents` and `< menuPriceCents`. */
  dealPriceCents: number;
  /** The dish's normal price, carried so a screen can show the saving. */
  menuPriceCents: number;
  minViablePriceCents: number;
  /** `(menu − deal) / menu`. The Competition Act requires this to be real. */
  discountPct: number;
  /** True when `discountPct < THIN_DISCOUNT_THRESHOLD` — legal, but a weak deal. */
  isThinDiscount: boolean;

  minQty: number;
  maxQty: number;
  maxPerCustomer: number;

  /** ISO-8601 instants, ready for `DraftInput`. */
  windowStart: string;
  windowEnd: string;
  cutoffAt: string;

  /** Planner-authored copy. A model may replace these four fields, nothing else. */
  rationale: string;
  title: string;
  description: string;
  shareMessage: string;
};

export type PlanRefusalReason =
  /** `minViablePrice` returned `null`: no price clears the merchant's floor. */
  | 'NO_VIABLE_PRICE'
  /** The floor price is the menu price, so there is no discount to offer. */
  | 'NO_DISCOUNT_POSSIBLE'
  /** The named quiet slot is past the five-day authorisation window. */
  | 'WINDOW_TOO_FAR';

export type PlanResult =
  | { ok: true; proposals: PlannedProposal[]; notes: string[] }
  | { ok: false; refusal: PlanRefusalReason; message: string };

export type PlanArgs = {
  dish: PlannerDish;
  /** The narrowed guardrail input for this dish. Money is read from here only. */
  guardrail: CompleteGuardrailInput;
  /** The quiet slot the merchant named, as an instant. */
  quietStart: Date;
  /** What they said they can commit to making. Capped at `batchYield`. */
  maxQtyAsked: number;
  intent: PlannerIntent;
  merchantName: string;
  now: Date;
  /**
   * IANA zone used to turn instants into the words in the copy.
   *
   * Not `undefined` (server local): a container runs in UTC, and "pickup at 2pm"
   * written as "9pm" is the kind of defect that only shows up on the deal page in
   * production. V1 is Alberta-only (PRD-v1 §0.5), so this is one constant.
   */
  timeZone?: string;
};

/**
 * V1 is Alberta-only (PRD-v1 §0.5), so display and cutoff arithmetic share one
 * zone.
 *
 * **Alberta moved to permanent DST on 2026-11-01** — it stays on UTC−6 all year
 * instead of falling back to UTC−7 (IANA `tzdata 2026c`+; Google Cloud's Looker
 * note on `2026e` lists `America/Edmonton` as UTC−6 "instead of falling back to
 * UTC−7"). This is a legislative change, not a tzdata quirk, so:
 *
 *   - a winter instant is now **one hour later** in local time than it used to
 *     be, and any hard-coded winter expectation written before that date is
 *     stale;
 *   - the zone *name* is unchanged, so nothing here needs editing. Do not
 *     "correct" this to `America/Regina`-style fixed-offset aliases: Edmonton
 *     still has a real zone identity and may legislate again.
 *
 * A host whose tzdata predates 2026c will render these instants an hour early.
 * That is the host being out of date, not this constant.
 */
export const DEFAULT_PLAN_TIME_ZONE = 'America/Edmonton';

/** The share of the menu-to-floor gap `QUIET_HOUR` gives away. */
const QUIET_HOUR_DISCOUNT_SHARE = 0.4;

/**
 * Notice given before the window opens, per archetype.
 *
 * `TRIAL` gets the longest because reaching people who have never bought from you
 * is the slow part; `SURPLUS` the shortest because the food is already made.
 */
const NOTICE_HOURS: Readonly<Record<ProposalArchetype, number>> = {
  QUIET_HOUR: 3,
  TRIAL: 12,
  SURPLUS: 2,
};

/** Window length, in hours, per archetype. */
const WINDOW_HOURS: Readonly<Record<ProposalArchetype, number>> = {
  QUIET_HOUR: 2,
  TRIAL: 3,
  SURPLUS: 1,
};

/** Minimum share of the batch the merchant must sell, per archetype. */
const MIN_QTY_SHARE: Readonly<Record<ProposalArchetype, number>> = {
  QUIET_HOUR: 0.5,
  TRIAL: 0.6,
  SURPLUS: 0.3,
};

/** Floor on `minQty`, so a small batch does not produce a silly threshold. */
const MIN_QTY_FLOOR: Readonly<Record<ProposalArchetype, number>> = {
  QUIET_HOUR: 10,
  TRIAL: 20,
  SURPLUS: 6,
};

const MAX_PER_CUSTOMER: Readonly<Record<ProposalArchetype, number>> = {
  QUIET_HOUR: 4,
  TRIAL: 1,
  SURPLUS: 2,
};

/** Order in which proposals are shown, before the intent re-sorts them. */
const ARCHETYPE_ORDER: readonly ProposalArchetype[] = ['QUIET_HOUR', 'TRIAL', 'SURPLUS'];

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Rounds **up** to the nearest five cents.
 *
 * Up, never down: the floor is a floor, and rounding a legal price downward by
 * four cents is the one direction that can push it under. Up also gives prices
 * that read like prices rather than like the output of a scan.
 */
function roundUpToFiveCents(cents: number): number {
  return Math.ceil(cents / 5) * 5;
}

/** `"2pm"`, `"11am"` — the way a person writes a pickup time in a group chat. */
function hourLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: true,
    timeZone,
  }).formatToParts(instant);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const period = parts.find((part) => part.type === 'dayPeriod')?.value ?? '';
  return `${hour}${period.toLowerCase().replace(/\./g, '')}`;
}

function weekdayLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(instant);
}

/** `"Thursday 2pm–4pm"`. */
function slotLabel(start: Date, end: Date, timeZone: string): string {
  return `${weekdayLabel(start, timeZone)} ${hourLabel(start, timeZone)}–${hourLabel(end, timeZone)}`;
}

/** `"Thursday 11am"`. */
function momentLabel(instant: Date, timeZone: string): string {
  return `${weekdayLabel(instant, timeZone)} ${hourLabel(instant, timeZone)}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The hours a join deadline is allowed to land in, local to the merchant. */
const WAKING_START_HOUR = 9;
const WAKING_END_HOUR = 21;
/** A deadline closer than this to the window is not a deadline. */
const MIN_LEAD_HOURS = 2;

/** The wall-clock components of an instant, in a named zone. */
function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` renders midnight as 24 in some ICU builds.
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const local = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The instant at a given wall-clock time in a zone.
 *
 * Two passes: the offset at the guessed instant may differ from the offset at the
 * real one across a DST boundary, so the second pass corrects it. A one-pass
 * version is wrong for one hour twice a year, and the hour it is wrong about is
 * 2am — which is precisely the hour this function exists to avoid.
 */
function zonedWallTimeToInstant(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/**
 * When joining closes.
 *
 * `windowStart − noticeHours`, then **snapped to a waking hour**: a 12-hour notice
 * on a 2pm pickup puts the deadline at 2am, which is arithmetically correct and
 * practically useless — nobody joins at 2am, and "Joining closes Tuesday 2am" on
 * the deal page reads as a bug.
 *
 * The snap only moves a deadline *later*, and only when that still leaves
 * `MIN_LEAD_HOURS` before pickup. An early pickup keeps its early deadline: a 10am
 * window with 3 hours of notice closes at 7am, and that is a real deadline, not
 * something to round up into the same hour as the food.
 */
function cutoffFor(windowStart: Date, noticeHours: number, timeZone: string): Date {
  const computed = new Date(windowStart.getTime() - noticeHours * MS_PER_HOUR);
  const local = zonedParts(computed, timeZone);

  const snapped =
    local.hour < WAKING_START_HOUR
      ? zonedWallTimeToInstant(local, WAKING_START_HOUR, 0, timeZone)
      : local.hour >= WAKING_END_HOUR
        ? zonedWallTimeToInstant(local, WAKING_END_HOUR - 1, 0, timeZone)
        : computed;

  const latestAcceptable = windowStart.getTime() - MIN_LEAD_HOURS * MS_PER_HOUR;
  return snapped.getTime() <= latestAcceptable ? snapped : computed;
}

/**
 * The price this archetype offers.
 *
 * `QUIET_HOUR` gives away a fixed share of the gap between the floor and the
 * menu price, so it is the most profitable of the three and the least
 * attractive. The other two sit at the floor — the deepest legal discount — and
 * differ in what they ask for in return.
 */
function priceFor(
  archetype: ProposalArchetype,
  floorCents: number,
  menuPriceCents: number,
): number {
  const raw =
    archetype === 'QUIET_HOUR'
      ? floorCents + Math.ceil((menuPriceCents - floorCents) * QUIET_HOUR_DISCOUNT_SHARE)
      : floorCents;

  const rounded = roundUpToFiveCents(raw);
  // Both bounds matter: below the floor is illegal, and at the menu price there
  // is no discount at all (Competition Act, PRD-v1 §15.2).
  return Math.min(Math.max(rounded, floorCents), menuPriceCents);
}

/**
 * Clamps `minQty` into `[1, maxQty]`.
 *
 * The per-archetype floor ("20 orders" for a trial) is **soft**: it applies only
 * when the batch can support it. A merchant who can make 12 of a dish cannot be
 * asked for 20 orders, and quietly lowering the bar to 12 without saying so would
 * hide the fact that this archetype is a poor fit for the batch. Scaling the share
 * instead keeps the proportion honest — a 12-plate trial needs 8, not 20.
 */
function minQtyFor(archetype: ProposalArchetype, batchYield: number, maxQty: number): number {
  const share = Math.ceil(batchYield * MIN_QTY_SHARE[archetype]);
  const floor = MIN_QTY_FLOOR[archetype];
  const wanted = batchYield >= floor ? Math.max(floor, share) : share;
  return Math.min(Math.max(1, wanted), maxQty);
}

function rationaleFor(args: {
  archetype: ProposalArchetype;
  minQty: number;
  maxQty: number;
  dealPriceCents: number;
  isThinDiscount: boolean;
  noticeHours: number;
}): string {
  const { archetype, minQty, maxQty, dealPriceCents, isThinDiscount, noticeHours } = args;

  switch (archetype) {
    case 'QUIET_HOUR':
      return [
        `Runs in your quiet hour at ${dollars(dealPriceCents)} a plate — the closest to your menu price of the three.`,
        `You commit to ${maxQty} and need ${minQty} to run it.`,
        isThinDiscount
          ? 'The discount is small on this dish, so expect it to pull weakly.'
          : 'Small commitment, modest pull.',
      ].join(' ');
    case 'TRIAL':
      return [
        `Deepest price of the three, one per person, and ${noticeHours} hours of notice.`,
        `That combination is what reaches people who have not tried you — you commit to ${maxQty} and need ${minQty}.`,
      ].join(' ');
    case 'SURPLUS':
      return [
        `Lowest minimum of the three: ${minQty} plates and you are running.`,
        `Shortest notice, ${noticeHours} hours, for food you would otherwise be throwing out.`,
      ].join(' ');
  }
}

function titleFor(args: {
  archetype: ProposalArchetype;
  dishName: string;
  start: Date;
  end: Date;
  timeZone: string;
}): string {
  const { archetype, dishName, start, end, timeZone } = args;
  const slot = slotLabel(start, end, timeZone);
  const base =
    archetype === 'TRIAL'
      ? `${dishName} — first try, ${weekdayLabel(start, timeZone)}`
      : `${dishName} — ${slot}`;
  // The column is 60 characters; a long dish name plus a long slot can exceed it,
  // and a truncated title in the group chat looks like a broken product.
  return base.length <= 60 ? base : base.slice(0, 57).trimEnd() + '…';
}

function descriptionFor(args: {
  archetype: ProposalArchetype;
  start: Date;
  end: Date;
  cutoffAt: Date;
  minQty: number;
  timeZone: string;
}): string {
  const { archetype, start, end, cutoffAt, minQty, timeZone } = args;
  const slot = slotLabel(start, end, timeZone);
  const closes = momentLabel(cutoffAt, timeZone);

  const opening =
    archetype === 'SURPLUS'
      ? `Pickup ${slot}. Made in one batch, so it only runs if ${minQty} go.`
      : `Pickup ${slot}. Everything is made in one batch for the group.`;

  return `${opening} Joining closes ${closes}. You are only charged if ${minQty} people are in by then.`;
}

function shareMessageFor(args: {
  archetype: ProposalArchetype;
  dishName: string;
  merchantName: string;
  dealPriceCents: number;
  minQty: number;
  start: Date;
  end: Date;
  cutoffAt: Date;
  timeZone: string;
}): string {
  const { archetype, dishName, merchantName, dealPriceCents, minQty, start, end, cutoffAt, timeZone } =
    args;

  const slot = slotLabel(start, end, timeZone);
  const closes = momentLabel(cutoffAt, timeZone);
  const perPerson = archetype === 'TRIAL' ? ' (one each)' : '';

  // 140 characters, WhatsApp-sized. Built in two stages rather than sliced: a
  // message that ends mid-word reads as a broken product, so the call to action
  // is dropped before a character is cut. The last resort — a merchant name and a
  // dish name that together exceed the limit on their own — truncates, because a
  // column overflow is worse than an ellipsis.
  // A restaurant named after its own signature dish — "Pho House" selling "Pho",
  // "Beef Bowl" selling "Beef Bowl" — would otherwise produce
  // "Beef Bowl: Beef Bowl at $13.10", which reads like a template that failed.
  const speaker =
    merchantName.trim().toLowerCase() === dishName.trim().toLowerCase() ? '' : `${merchantName}: `;

  const head =
    `${speaker}${dishName} at ${dollars(dealPriceCents)} a plate${perPerson}, ` +
    `pickup ${slot}.`;
  const need = ` Need ${minQty} by ${closes} or it's off.`;

  const full = `${head}${need} Reply in to join.`;
  if (full.length <= 140) return full;

  const withoutCta = `${head}${need}`;
  if (withoutCta.length <= 140) return withoutCta;

  return `${withoutCta.slice(0, 139)}…`;
}

/**
 * Turns the interview answers into up to three publishable proposals.
 *
 * Returns fewer than three when an archetype does not fit: a batch of 12 cannot
 * support a 20-plate `TRIAL` minimum, and padding the list with a proposal the
 * merchant cannot honour would make the whole screen untrustworthy.
 */
export function planProposals(args: PlanArgs): PlanResult {
  const { dish, guardrail, quietStart, maxQtyAsked, intent, merchantName, now } = args;
  const timeZone = args.timeZone ?? DEFAULT_PLAN_TIME_ZONE;

  const evaluation: DealEvaluation = evaluateDeal(guardrail, dish.menuPriceCents);
  const floorCents = evaluation.minViablePriceCents;

  if (floorCents === null) {
    return {
      ok: false,
      refusal: 'NO_VIABLE_PRICE',
      message:
        'No price clears your minimum margin on this dish — the ingredients cost too much relative to what you charge for it. Pick a different dish.',
    };
  }

  if (floorCents >= dish.menuPriceCents) {
    return {
      ok: false,
      refusal: 'NO_DISCOUNT_POSSIBLE',
      message:
        'The lowest price that still works for you is your normal menu price, so there is no discount to offer. A "deal" at full price is not a deal.',
    };
  }

  const maxQty = Math.min(Math.max(1, Math.trunc(maxQtyAsked)), dish.batchYield);
  const notes: string[] = [];

  if (maxQtyAsked > dish.batchYield) {
    notes.push(
      `You said ${maxQtyAsked}, but this dish makes ${dish.batchYield} in one batch, so the plans use ${dish.batchYield}.`,
    );
  }

  const proposals: PlannedProposal[] = [];
  let droppedForPrice = 0;

  for (const archetype of ARCHETYPE_ORDER) {
    const dealPriceCents = priceFor(archetype, floorCents, dish.menuPriceCents);

    // Rounding up can land exactly on the menu price when the gap is a few cents.
    // A zero-discount "deal" is refused rather than shown.
    if (dealPriceCents >= dish.menuPriceCents) {
      droppedForPrice += 1;
      notes.push(
        `The ${archetype.toLowerCase().replace('_', ' ')} plan was dropped: there is not enough room above your floor to price it as a deal.`,
      );
      continue;
    }

    const minQty = minQtyFor(archetype, dish.batchYield, maxQty);
    const noticeHours = NOTICE_HOURS[archetype];

    const windowStart = new Date(quietStart.getTime());
    const windowEnd = new Date(quietStart.getTime() + WINDOW_HOURS[archetype] * MS_PER_HOUR);
    const cutoffAt = cutoffFor(quietStart, noticeHours, timeZone);

    const timingIssues = validateDropTiming({ windowStart, windowEnd, cutoffAt }, now);
    const quantityIssues = validateDropQuantities({
      minQty,
      maxQty,
      batchYield: dish.batchYield,
    });

    if (timingIssues.length > 0 || quantityIssues.length > 0) {
      // One sentence naming the first problem. `WINDOW_TOO_FAR` below turns the
      // common case into an instruction rather than three per-archetype notices.
      notes.push(
        `The ${archetype.toLowerCase().replace('_', ' ')} plan was dropped: ${
          timingIssues[0]?.message ?? quantityIssues[0]?.message
        }`,
      );
      continue;
    }

    const discountPct = (dish.menuPriceCents - dealPriceCents) / dish.menuPriceCents;
    const isThinDiscount = discountPct < THIN_DISCOUNT_THRESHOLD;

    proposals.push({
      archetype,
      menuItemId: dish.id,
      dealPriceCents,
      menuPriceCents: dish.menuPriceCents,
      minViablePriceCents: floorCents,
      discountPct,
      isThinDiscount,
      minQty,
      maxQty,
      maxPerCustomer: MAX_PER_CUSTOMER[archetype],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      cutoffAt: cutoffAt.toISOString(),
      rationale: rationaleFor({
        archetype,
        minQty,
        maxQty,
        dealPriceCents,
        isThinDiscount,
        noticeHours,
      }),
      title: titleFor({ archetype, dishName: dish.name, start: windowStart, end: windowEnd, timeZone }),
      description: descriptionFor({
        archetype,
        start: windowStart,
        end: windowEnd,
        cutoffAt,
        minQty,
        timeZone,
      }),
      shareMessage: shareMessageFor({
        archetype,
        dishName: dish.name,
        merchantName,
        dealPriceCents,
        minQty,
        start: windowStart,
        end: windowEnd,
        cutoffAt,
        timeZone,
      }),
    });
  }

  if (proposals.length === 0) {
    // Two ways to end up here, and they need different sentences. Timing is the
    // one a merchant can fix by picking an earlier day; the price case means the
    // gap between floor and menu was too thin to round into a real discount.
    if (droppedForPrice > 0) {
      return {
        ok: false,
        refusal: 'NO_DISCOUNT_POSSIBLE',
        message:
          'There is only a few cents between the lowest price that works for you and your menu price, so nothing here is a real discount.',
      };
    }
    return {
      ok: false,
      refusal: 'WINDOW_TOO_FAR',
      message:
        'That day is too far out. A card authorisation only lasts about seven days, so joining has to close within five — pick a day in the next four.',
    };
  }

  return { ok: true, proposals: sortByIntent(proposals, intent), notes };
}

/** Puts the archetype matching the merchant's answer first. */
function sortByIntent(
  proposals: readonly PlannedProposal[],
  intent: PlannerIntent,
): PlannedProposal[] {
  const preferred: ProposalArchetype | null =
    intent === 'FILL_QUIET_HOUR' ? 'QUIET_HOUR' : intent === 'NEW_CUSTOMERS' ? 'TRIAL' : null;

  if (preferred === null) {
    return [...proposals];
  }

  return [...proposals].sort((left, right) => {
    if (left.archetype === preferred) return -1;
    if (right.archetype === preferred) return 1;
    return ARCHETYPE_ORDER.indexOf(left.archetype) - ARCHETYPE_ORDER.indexOf(right.archetype);
  });
}

/** The strings a model is allowed to quote, pre-formatted by the server. */
export type ProposalFacts = {
  /** `"$13.10"` — the deal price, formatted once, here. */
  priceLabel: string;
  /** `"$16.00"` — the menu price, so a "was" reference can be checked. */
  menuPriceLabel: string;
  /** `"Thursday 2pm–4pm"`. */
  slotLabel: string;
  /** `"Thursday 11am"`. */
  closesLabel: string;
  /** `"18%"` — the real discount, rounded. */
  discountLabel: string;
};

/**
 * Formats a proposal's facts for the prompt and for the linter's expectations.
 *
 * The model is handed these exact strings and told to reuse them verbatim. That
 * is the mechanism behind "the model never computes money": it is not asked to
 * format `1310` into a price, it is handed `"$13.10"` and told not to touch it.
 * `copy-lint.ts` then checks that whatever came back still says `$13.10`.
 */
export function proposalFacts(
  proposal: Pick<PlannedProposal, 'dealPriceCents' | 'menuPriceCents' | 'windowStart' | 'windowEnd' | 'cutoffAt' | 'discountPct'>,
  timeZone: string = DEFAULT_PLAN_TIME_ZONE,
): ProposalFacts {
  const start = new Date(proposal.windowStart);
  const end = new Date(proposal.windowEnd);
  const cutoff = new Date(proposal.cutoffAt);

  return {
    priceLabel: dollars(proposal.dealPriceCents),
    menuPriceLabel: dollars(proposal.menuPriceCents),
    slotLabel: slotLabel(start, end, timeZone),
    closesLabel: momentLabel(cutoff, timeZone),
    discountLabel: `${Math.round(proposal.discountPct * 100)}%`,
  };
}
