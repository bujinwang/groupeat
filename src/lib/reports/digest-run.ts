import { merchantsForDigest, digestAlreadySent, recordDigestDelivery } from '@/lib/db/digest';
import { reportSourcesFor } from '@/lib/db/reports';
import type { EmailSender } from '@/lib/notify/email-sender';
import { merchantReportFor } from '@/lib/reports/drop-report';

import { digestEmailFor, digestWeekFor } from './digest';

/**
 * FR-704 — one weekly run, with the clock and the sender as arguments.
 *
 * ## Why the route is a thin wrapper
 *
 * The interesting behaviour is not HTTP: it is which merchants are eligible, which
 * week a run describes, which owners already received it, and what happens when the
 * provider fails. All of that needs a real Postgres and a controllable clock, so it
 * lives here and the route supplies `new Date()` and a resolved sender. The route test
 * then only has to prove auth and wiring; this module's test can pin the decisions.
 *
 * ## What is sent, in what order, and why a failure is per recipient
 *
 * The report is computed once per merchant — the expensive reads are per drop, not per
 * owner — and then composed once per owner, because the greeting is personal and the
 * delivery record is per owner. A provider failure for one owner does not stop the
 * next: the guarantee is best-effort delivery with an exact account of what happened,
 * not an all-or-nothing batch that a single bad address can silence.
 *
 * ## Why a week with no drops sends nothing
 *
 * See `digest.ts` §3. The merchant is counted in `merchantsWithNothingToReport`, so an
 * operator reading the job response can tell "nobody had activity" from "the query
 * broke" — two states that would otherwise both look like `sent: 0`.
 */

export type DigestRunResult = {
  readonly week: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  /** Merchants with at least one consenting owner that were examined. */
  readonly merchants: number;
  /** Owners considered after consent filtering. */
  readonly recipients: number;
  readonly sent: number;
  readonly failed: number;
  readonly skippedAlreadySent: number;
  readonly skippedNoDrops: number;
  /** Sends the provider refused because no credentials are configured. */
  readonly notConfigured: number;
  /** Merchants whose week had no reportable drops. */
  readonly merchantsWithNothingToReport: number;
};

export async function runWeeklyDigest(args: {
  now: Date;
  sender: EmailSender;
  /** `publicOrigin()` — absent means the email carries no link. */
  origin: string | undefined;
}): Promise<DigestRunResult> {
  const week = digestWeekFor(args.now);
  const merchants = await merchantsForDigest();

  let recipients = 0;
  let sent = 0;
  let failed = 0;
  let skippedAlreadySent = 0;
  let skippedNoDrops = 0;
  let notConfigured = 0;
  let merchantsWithNothingToReport = 0;

  for (const merchant of merchants) {
    recipients += merchant.owners.length;

    const { sources, skippedDropCount } = await reportSourcesFor({
      merchantId: merchant.id,
      from: week.weekStart,
      to: week.weekEnd,
      // The page's default cap is 50, which is generous for "recent drops" and can
      // silently truncate a busy week. A digest is a statement about a period, so it
      // asks for enough to cover one. Two hundred drops in seven days is not a cap
      // problem; it is data that should not exist, and the email's per-drop list caps
      // at ten regardless.
      limit: 200,
    });

    if (sources.length === 0) {
      // `skippedDropCount` can be non-zero with no readable sources; that is still
      // "nothing we can state", and sending "no one bought" would be a false claim
      // about a week that had drops we could not read.
      skippedNoDrops += merchant.owners.length;
      merchantsWithNothingToReport += 1;
      continue;
    }

    const report = merchantReportFor({
      merchantId: merchant.id,
      merchantName: merchant.name,
      timezone: merchant.timezone,
      sources,
    });

    const reportWithSkipped = {
      ...report,
      withheldDropCount: report.withheldDropCount + skippedDropCount,
    };

    if (reportWithSkipped.dropCount === 0) {
      skippedNoDrops += merchant.owners.length;
      merchantsWithNothingToReport += 1;
      continue;
    }

    for (const owner of merchant.owners) {
      const already = await digestAlreadySent({
        merchantId: merchant.id,
        userId: owner.userId,
        weekStart: week.weekStart,
      });
      if (already) {
        skippedAlreadySent += 1;
        continue;
      }

      const email = digestEmailFor({
        report: reportWithSkipped,
        week,
        recipientEmail: owner.email,
        recipientName: owner.name,
        origin: args.origin,
      });

      const result = await args.sender.send([email]);
      const outcome = result.outcomes[0];

      if (outcome?.sent) {
        sent += 1;
        await recordDigestDelivery({
          merchantId: merchant.id,
          userId: owner.userId,
          weekStart: week.weekStart,
          ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
        });
        continue;
      }

      failed += 1;
      if (outcome?.reason === 'NOT_CONFIGURED') {
        notConfigured += 1;
      }
    }
  }

  return {
    week: week.label,
    weekStart: week.weekStart.toISOString(),
    weekEnd: week.weekEnd.toISOString(),
    merchants: merchants.length,
    recipients,
    sent,
    failed,
    skippedAlreadySent,
    skippedNoDrops,
    notConfigured,
    merchantsWithNothingToReport,
  };
}
