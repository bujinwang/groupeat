import { describe, expect, it } from 'vitest';

import type { MerchantReport, DropReportFigures } from '@/lib/reports/drop-report';
import { digestEmailFor, digestWeekFor } from '@/lib/reports/digest';

/**
 * FR-704's composition, without a database or a provider.
 *
 * Three claims are worth pinning here and nowhere else:
 *
 *   1. **The period is a local calendar week.** A boundary resolved in the server's
 *      zone looks plausible for eleven months and is an hour or a day wrong at the
 *      one a merchant checks. The literal `Oct 26 – Nov 1` is the assertion.
 *   2. **The money sentence quotes the reconciled contribution.** `CONTRIBUTING.md`
 *      turns the sentence into a type signature: "You kept … after … our fee" must
 *      print `contributionCents`, not GMV and not a refund-adjusted second sum.
 *   3. **An empty report cannot be sent.** The orchestrator's skip is the product
 *      decision; this is the guard that stops a future caller from bypassing it.
 */

function figures(overrides: Partial<DropReportFigures> = {}): DropReportFigures {
  return {
    unitsSold: 24,
    gmvCents: 26688,
    platformFeeCents: 2136,
    netCapturedCents: 26688,
    refundedCents: 0,
    contributionCents: 16080,
    contributionPctOfGmv: 16080 / 26688,
    ...overrides,
  };
}

function report(overrides: Partial<MerchantReport> = {}): MerchantReport {
  return {
    merchantId: 'merchant-1',
    merchantName: 'Café Test',
    timezone: 'America/Edmonton',
    dropCount: 1,
    totals: figures(),
    totalCustomerMix: {
      newCustomers: 18,
      returningCustomers: 6,
      totalCustomers: 24,
      newCustomerPct: 0.75,
    },
    rows: [
      {
        dropId: 'drop-1',
        dropTitle: 'Thursday <Beef Bowl>',
        pickupDate: '2026-10-29',
        figures: figures(),
        customerMix: {
          newCustomers: 18,
          returningCustomers: 6,
          totalCustomers: 24,
          newCustomerPct: 0.75,
        },
        attribution: [],
        unattributedUnits: 24,
        suggestedAction: { kind: 'SOLD_OUT', soldOutAtQty: 24, suggestedQty: 34 },
      },
    ],
    withheldDropCount: 0,
    ...overrides,
  };
}

const WEEK = digestWeekFor(new Date('2026-11-04T15:00:00Z'));

describe('digestWeekFor', () => {
  it('returns the local Monday-to-Monday week that ended before now', () => {
    // Wednesday 2026-11-04, 09:00 in Edmonton (UTC−6). The completed week is
    // Monday Oct 26 00:00 through Sunday Nov 1 23:59:59.
    expect(WEEK.weekStart.toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(WEEK.weekEnd.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(WEEK.label).toBe('Oct 26 – Nov 1');
  });

  it('gives the same week on Monday before 08:00 and after 08:00', () => {
    // The send hour is a delivery preference, not a data boundary. A manual 07:55
    // run must not describe a different week than the 08:00 cron ten minutes later.
    const before = digestWeekFor(new Date('2026-11-02T13:55:00Z'));
    const after = digestWeekFor(new Date('2026-11-02T15:00:00Z'));

    expect(before.weekStart.toISOString()).toBe(WEEK.weekStart.toISOString());
    expect(before.weekEnd.toISOString()).toBe(WEEK.weekEnd.toISOString());
    expect(after.weekStart.toISOString()).toBe(WEEK.weekStart.toISOString());
    expect(after.weekEnd.toISOString()).toBe(WEEK.weekEnd.toISOString());
  });

  it('rolls over at local Monday midnight, not UTC midnight', () => {
    // Sunday 2026-11-01 23:30 Edmonton = 2026-11-02T05:30Z. The current week has
    // not finished yet, so the digest describes Oct 19–25. At 00:30 local on Monday
    // the week that just ended is Oct 26–Nov 1.
    const sundayNight = digestWeekFor(new Date('2026-11-02T05:30:00Z'));
    const mondayMorning = digestWeekFor(new Date('2026-11-02T06:30:00Z'));

    expect(sundayNight.weekStart.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    expect(sundayNight.weekEnd.toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(mondayMorning.weekStart.toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(mondayMorning.weekEnd.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('throws on an unknown zone instead of silently using the server zone', () => {
    expect(() => digestWeekFor(new Date(), 'Not/AZone')).toThrow();
  });
});

describe('digestEmailFor', () => {
  it('quotes the reconciled contribution in the sentence that names our fee', () => {
    const email = digestEmailFor({
      report: report(),
      week: WEEK,
      recipientEmail: 'owner@example.test',
      recipientName: 'Sam Okafor',
      origin: 'https://groupeat.example',
    });

    expect(email.kind).toBe('weekly_digest');
    expect(email.to).toBe('owner@example.test');
    expect(email.subject).toBe('Café Test: 24 plates, $266.88 paid');

    // The money sentence: fee-inclusive, per CONTRIBUTING.md.
    expect(email.text).toContain(
      'You kept $160.80 after food, packaging, card fees and our fee.',
    );
    expect(email.text).toContain('Customers paid $266.88.');
    expect(email.text).toContain('New customers: 18 of 24 (75%). 6 returning.');
    expect(email.text).toContain('See the full report: https://groupeat.example/merchant/reports');

    // The plain-text body is what a text-only client reads; it must not contain
    // HTML-escaped punctuation.
    expect(email.text).toContain('Thursday <Beef Bowl>');
  });

  it('escapes every interpolated value in the HTML body', () => {
    const email = digestEmailFor({
      report: report({ merchantName: 'Café <script>alert(1)</script>' }),
      week: WEEK,
      recipientEmail: 'owner@example.test',
      recipientName: 'Sam "The" Owner',
      origin: 'https://groupeat.example',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    // The greeting is the first name only, and it is escaped like every other
    // interpolated value; the merchant name is the one carrying the markup here.
    expect(email.html).toContain('<p>Hi Sam,</p>');
  });

  it('carries no link when the deployment has no public origin', () => {
    const email = digestEmailFor({
      report: report(),
      week: WEEK,
      recipientEmail: 'owner@example.test',
      recipientName: null,
      origin: undefined,
    });

    expect(email.text).toContain('Open GroupEat to see the full report.');
    expect(email.text).not.toContain('localhost');
    expect(email.html).not.toContain('localhost');
  });

  it('names a refund instead of letting "paid" and "kept" look like bad arithmetic', () => {
    const email = digestEmailFor({
      report: report({
        totals: figures({
          netCapturedCents: 16680,
          refundedCents: 10008,
          contributionCents: 10050,
        }),
      }),
      week: WEEK,
      recipientEmail: 'owner@example.test',
      recipientName: 'Sam',
      origin: undefined,
    });

    expect(email.text).toContain('That is after $100.08 refunded to diners.');
    expect(email.text).toContain('You kept $100.50');
  });

  it('names withheld drops rather than quietly shrinking the total', () => {
    const email = digestEmailFor({
      report: report({ withheldDropCount: 2 }),
      week: WEEK,
      recipientEmail: 'owner@example.test',
      recipientName: 'Sam',
      origin: undefined,
    });

    expect(email.text).toContain('2 drops could not be reconciled with the ledger');
    expect(email.text).toContain('not included above');
  });

  it('refuses to compose an email for a week with no drops', () => {
    expect(() =>
      digestEmailFor({
        report: report({ dropCount: 0, rows: [] }),
        week: WEEK,
        recipientEmail: 'owner@example.test',
        recipientName: 'Sam',
        origin: undefined,
      }),
    ).toThrow(/must skip the merchant, not send an empty email/);
  });
});
