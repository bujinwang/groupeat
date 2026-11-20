import { formatCents } from '@/lib/guardrail';
import type { EmailMessage } from '@/lib/notify/email-sender';
import { escapeHtml } from '@/lib/notify/html';
import type { MerchantReport } from '@/lib/reports/drop-report';

/**
 * FR-704 — the weekly merchant digest, as words and arithmetic.
 *
 * > `FR-704 | Weekly email digest (Monday 08:00 MT) | Sent only to consenting owners`
 * > — PRD-v1.md:520
 *
 * ## The three decisions this module makes, and why each is here
 *
 * **1. The period is a local calendar week, not the last seven days.** A digest that
 * says "the last seven days" on a Tuesday describes a different set of drops than the
 * one it described on Monday, and a merchant comparing two emails cannot line them up
 * against their own week. So the period is `[Monday 00:00, next Monday 00:00)` in
 * `America/Edmonton` — the zone every merchant row defaults to and the one the PRD
 * names. The send time is Monday 08:00; the period it describes ended at midnight.
 *
 * **2. The money sentence is the fee-inclusive one.** `CONTRIBUTING.md`'s rule:
 * a sentence naming "our fee" must quote `netContributionCents`, and one that does not
 * must quote `walkInContributionCents`. The digest says "You kept $X after food,
 * packaging, card fees and our fee", so it prints the contribution the report already
 * reconciled — never a second sum of `GMV − refunds`, which is the −$21.33 bug in a
 * new place.
 *
 * **3. Nothing is sent for a week with no drops.** An email whose only sentence is
 * "nothing happened" trains a merchant to ignore the one week it matters. The
 * orchestrator skips the merchant; this module still refuses to invent a subject for
 * an empty report, so a future caller cannot send one by accident.
 *
 * ## What is not here
 *
 * No HTML framework, no template file, no React render. The body is a handful of
 * paragraphs and a table, and a string builder is the smallest thing that produces it.
 * A template engine would add a build step to a feature whose entire content is
 * already computed by `merchantReportFor`.
 */

/** The zone PRD-v1 §6.7 and NFR-04 name for cutoff, display and the digest. */
export const DIGEST_TIME_ZONE = 'America/Edmonton';

/** The hour the digest is sent, local time. Part of the requirement, not a preference. */
export const DIGEST_SEND_HOUR = 8;

/**
 * `[weekStart, weekEnd)` — the local calendar week the digest describes.
 *
 * `weekEnd` is exclusive: a drop whose pickup starts exactly at Monday 00:00 belongs
 * to the next digest, not this one, which is the only reading that makes two adjacent
 * weeks partition the timeline.
 */
export type DigestWeek = {
  /** Local Monday 00:00, as a UTC instant. */
  readonly weekStart: Date;
  /** The following local Monday 00:00, exclusive. */
  readonly weekEnd: Date;
  /** `"Oct 27 – Nov 2"`, for the subject and the opening line. */
  readonly label: string;
};

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

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
 * The wall clock an instant reads as, in a zone.
 *
 * Throws on an unknown zone rather than falling back to the server's. A boundary
 * resolved in the wrong zone is off by hours and looks entirely plausible; an
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
    // ICU renders midnight as hour "24" under `hour12: false`. Without the fold,
    // local midnight reads as 24:00 and the offset comes out a day wrong — at
    // exactly the instant this module builds its boundaries from.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * How far ahead of UTC the zone is at an instant, in milliseconds.
 *
 * The same derivation `organisers/commission.ts` uses: read the zone's wall clock and
 * ask what UTC instant would print it, because `Intl` has no offset accessor. The
 * instant is truncated to whole seconds so a millisecond remainder is not mistaken
 * for part of the offset.
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
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * The UTC instant for a local wall clock, two passes.
 *
 * One pass is wrong for a boundary on the far side of a transition, by exactly an
 * hour. Alberta has been UTC−6 year-round since 2026-11-01, so this is a safety net
 * rather than a correction aimed at a particular rule — and it is always taken, for
 * the same reason the commission module does: the boundary is a property of the tz
 * database, not of this code.
 */
function utcForLocalWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  const firstGuess = naive - offsetMsAt(new Date(naive), timeZone);
  const corrected = naive - offsetMsAt(new Date(firstGuess), timeZone);
  return new Date(corrected);
}

function addDaysUtc(year: number, month: number, day: number, days: number): Date {
  return new Date(Date.UTC(year, month - 1, day + days));
}

function shortDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(instant);
}

/**
 * The most recently finished local week, as of `now`.
 *
 * Works on any day, not only Monday: a manual `curl` on Wednesday sends the week that
 * ended on Monday, which is the useful recovery path when the scheduler missed its
 * run. The idempotency key is `weekStart`, so a second manual invocation in the same
 * week still sends nothing.
 *
 * A Monday-morning invocation **before** 08:00 also gets last week: the week ended at
 * midnight, and the send hour is a delivery preference rather than a data boundary.
 * That makes the Monday 08:00 cron a normal case and a 07:55 manual run an early one,
 * not a wrong one.
 */
export function digestWeekFor(now: Date, timeZone: string = DIGEST_TIME_ZONE): DigestWeek {
  const wall = wallClockIn(now, timeZone);
  // `getUTCDay()` on the local calendar date gives the weekday without a second
  // formatter. 0 = Sunday … 6 = Saturday; Monday is 1.
  const localDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  const daysSinceMonday = (localDay.getUTCDay() + 6) % 7;

  const thisMonday = addDaysUtc(wall.year, wall.month, wall.day, -daysSinceMonday);
  const lastMonday = addDaysUtc(
    thisMonday.getUTCFullYear(),
    thisMonday.getUTCMonth() + 1,
    thisMonday.getUTCDate(),
    -7,
  );

  const weekStart = utcForLocalWallClock(
    lastMonday.getUTCFullYear(),
    lastMonday.getUTCMonth() + 1,
    lastMonday.getUTCDate(),
    0,
    timeZone,
  );
  const weekEnd = utcForLocalWallClock(
    thisMonday.getUTCFullYear(),
    thisMonday.getUTCMonth() + 1,
    thisMonday.getUTCDate(),
    0,
    timeZone,
  );

  return {
    weekStart,
    weekEnd,
    label: `${shortDate(weekStart, timeZone)} – ${shortDate(
      new Date(weekEnd.getTime() - 1),
      timeZone,
    )}`,
  };
}

function pctLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function firstNameOf(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : 'there';
}

/** Drops per email. Weekly runs are small; a cap keeps one busy week readable. */
const MAX_DROP_LINES = 10;

/**
 * The digest for one merchant and one recipient.
 *
 * Throws when the report is empty, because an email about no drops is a decision the
 * caller must make explicitly (skip) rather than a body this function can invent.
 */
export function digestEmailFor(args: {
  readonly report: MerchantReport;
  readonly week: DigestWeek;
  readonly recipientEmail: string;
  readonly recipientName: string | null;
  /** `publicOrigin()`: absent means no link, never a `localhost` one. */
  readonly origin: string | undefined;
}): EmailMessage {
  const { report, week, origin } = args;

  if (report.dropCount === 0) {
    throw new Error(
      `digestEmailFor was asked for ${report.merchantName} with no drops in ${week.label}. ` +
        'A caller that has nothing to report must skip the merchant, not send an empty email.',
    );
  }

  const name = firstNameOf(args.recipientName);
  const totals = report.totals;
  const mix = report.totalCustomerMix;
  // "Paid", not "kept", in the subject. `CONTRIBUTING.md`'s rule is that a sentence
  // containing money is a type signature: a subject saying "kept" without "our fee"
  // would promise the fee-exclusive figure, while the body's "You kept … after … our
  // fee" promises the fee-inclusive one. Gross is unambiguous in eight words.
  const subject =
    `${report.merchantName}: ${totals.unitsSold} ${totals.unitsSold === 1 ? 'plate' : 'plates'}, ` +
    `${formatCents(totals.gmvCents)} paid`;

  const reportUrl = origin ? `${origin}/merchant/reports` : null;

  const lines: string[] = [
    `Hi ${name},`,
    '',
    `Here is last week at ${report.merchantName} (${week.label}).`,
    '',
    `${totals.unitsSold} ${totals.unitsSold === 1 ? 'plate' : 'plates'} across ${
      report.dropCount
    } ${report.dropCount === 1 ? 'drop' : 'drops'}.`,
    `Customers paid ${formatCents(totals.gmvCents)}.`,
    `You kept ${formatCents(
      totals.contributionCents,
    )} after food, packaging, card fees and our fee.`,
  ];

  if (totals.refundedCents > 0) {
    // Named rather than netted away: a refund is the fact a merchant remembers, and
    // a "you kept" figure with no explanation of the difference from "paid" reads as
    // an arithmetic error.
    lines.push(`That is after ${formatCents(totals.refundedCents)} refunded to diners.`);
  }

  lines.push('');
  if (mix.totalCustomers === 0) {
    lines.push('No one bought this week.');
  } else {
    lines.push(
      `New customers: ${mix.newCustomers} of ${mix.totalCustomers} (${pctLabel(
        mix.newCustomerPct,
      )}). ${mix.returningCustomers} returning.`,
    );
  }

  lines.push('', 'Drops:');
  for (const row of report.rows.slice(0, MAX_DROP_LINES)) {
    lines.push(
      `- ${row.dropTitle} (${row.pickupDate}): ${row.figures.unitsSold} ${
        row.figures.unitsSold === 1 ? 'plate' : 'plates'
      }, ${formatCents(row.figures.gmvCents)} paid, ${formatCents(
        row.figures.contributionCents,
      )} kept.`,
    );
  }
  if (report.rows.length > MAX_DROP_LINES) {
    lines.push(`- and ${report.rows.length - MAX_DROP_LINES} more, in the full report.`);
  }

  if (report.withheldDropCount > 0) {
    lines.push(
      '',
      `${report.withheldDropCount} ${
        report.withheldDropCount === 1 ? 'drop' : 'drops'
      } could not be reconciled with the ledger and ${
        report.withheldDropCount === 1 ? 'is' : 'are'
      } not included above. We would rather leave a figure out than print one we cannot vouch for.`,
    );
  }

  lines.push('', reportUrl ? `See the full report: ${reportUrl}` : 'Open GroupEat to see the full report.');

  return {
    kind: 'weekly_digest',
    to: args.recipientEmail,
    subject,
    text: `${lines.join('\n')}\n`,
    html: htmlFor({ report, week, name, reportUrl }),
  };
}

/**
 * The HTML alternative.
 *
 * Every interpolated value is escaped, including the merchant name and drop titles —
 * they are operator-entered strings, and an email body is a place a `<script>` in a
 * dish name would be someone else's problem only because mail clients strip it.
 */
function htmlFor(args: {
  report: MerchantReport;
  week: DigestWeek;
  name: string;
  reportUrl: string | null;
}): string {
  const { report, week, name, reportUrl } = args;
  const totals = report.totals;
  const mix = report.totalCustomerMix;

  const rows = report.rows
    .slice(0, MAX_DROP_LINES)
    .map(
      (row) =>
        `<tr><td style="padding:6px 12px 6px 0">${escapeHtml(row.dropTitle)}</td>` +
        `<td style="padding:6px 12px;text-align:right">${escapeHtml(row.pickupDate)}</td>` +
        `<td style="padding:6px 12px;text-align:right">${row.figures.unitsSold}</td>` +
        `<td style="padding:6px 0;text-align:right">${escapeHtml(
          formatCents(row.figures.contributionCents),
        )} kept</td></tr>`,
    )
    .join('');

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;max-width:560px;color:#0f172a">',
    `<p>Hi ${escapeHtml(name)},</p>`,
    `<p>Here is last week at <strong>${escapeHtml(report.merchantName)}</strong> (${escapeHtml(
      week.label,
    )}).</p>`,
    `<p><strong>${totals.unitsSold}</strong> ${
      totals.unitsSold === 1 ? 'plate' : 'plates'
    } across <strong>${report.dropCount}</strong> ${
      report.dropCount === 1 ? 'drop' : 'drops'
    }.<br>Customers paid <strong>${escapeHtml(formatCents(totals.gmvCents))}</strong>.<br>` +
      `You kept <strong>${escapeHtml(
        formatCents(totals.contributionCents),
      )}</strong> after food, packaging, card fees and our fee.</p>`,
    totals.refundedCents > 0
      ? `<p>That is after ${escapeHtml(formatCents(totals.refundedCents))} refunded to diners.</p>`
      : '',
    mix.totalCustomers === 0
      ? '<p>No one bought this week.</p>'
      : `<p>New customers: <strong>${mix.newCustomers}</strong> of ${
          mix.totalCustomers
        } (${pctLabel(mix.newCustomerPct)}). ${mix.returningCustomers} returning.</p>`,
    '<table style="border-collapse:collapse;font-size:14px"><thead><tr>' +
      '<th style="text-align:left;padding:6px 12px 6px 0">Drop</th>' +
      '<th style="text-align:right;padding:6px 12px">Pickup</th>' +
      '<th style="text-align:right;padding:6px 12px">Plates</th>' +
      '<th style="text-align:right;padding:6px 0">Kept</th>' +
      `</tr></thead><tbody>${rows}</tbody></table>`,
    report.rows.length > MAX_DROP_LINES
      ? `<p>And ${report.rows.length - MAX_DROP_LINES} more in the full report.</p>`
      : '',
    report.withheldDropCount > 0
      ? `<p>${report.withheldDropCount} ${
          report.withheldDropCount === 1 ? 'drop' : 'drops'
        } could not be reconciled with the ledger and ${
          report.withheldDropCount === 1 ? 'is' : 'are'
        } not included above. We would rather leave a figure out than print one we cannot vouch for.</p>`
      : '',
    reportUrl
      ? `<p><a href="${escapeHtml(reportUrl)}">See the full report</a></p>`
      : '<p>Open GroupEat to see the full report.</p>',
    '<p style="color:#64748b;font-size:12px">You are receiving this because you asked for the weekly digest in GroupEat Settings. You can turn it off there at any time.</p>',
    '</div>',
  ].join('');
}
