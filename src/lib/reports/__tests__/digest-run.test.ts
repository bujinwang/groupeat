import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  digestAlreadySent,
  merchantsForDigest,
  recordDigestDelivery,
} from '@/lib/db/digest';
import { reportSourcesFor } from '@/lib/db/reports';
import { recordingEmailSender } from '@/lib/notify/email-sender';
import { runWeeklyDigest } from '@/lib/reports/digest-run';
import type { DropReportSource } from '@/lib/reports/drop-report';

/**
 * FR-704's orchestration, with the database and the clock controlled.
 *
 * The DB-backed suite proves the two queries that decide *who* and *what week*. This
 * file proves the decisions between them, which are the parts a query test cannot see:
 * a failed send must not be recorded as delivered, an already-delivered owner must be
 * skipped, and a merchant with nothing to report must not receive an empty email.
 *
 * The report arithmetic is **not** mocked. `merchantReportFor` runs on a real source,
 * so the email in these assertions contains figures the product computed rather than
 * figures this test invented and then asserted against itself.
 */

vi.mock('@/lib/db/digest', () => ({
  merchantsForDigest: vi.fn(),
  digestAlreadySent: vi.fn(),
  recordDigestDelivery: vi.fn(),
}));

vi.mock('@/lib/db/reports', () => ({
  reportSourcesFor: vi.fn(),
}));

const NOW = new Date('2026-11-04T15:00:00Z'); // Wednesday 09:00 Edmonton
const WEEK_START = '2026-10-26T06:00:00.000Z';
const WEEK_END = '2026-11-02T06:00:00.000Z';

function source(overrides: Partial<DropReportSource> = {}): DropReportSource {
  return {
    dropId: 'drop-1',
    dropTitle: 'Thursday Beef Bowl',
    merchantName: 'Café Test',
    merchantTimezone: 'America/Edmonton',
    windowStart: new Date('2026-10-29T23:00:00Z'),
    minQty: 5,
    maxQty: 10,
    dealPriceCents: 1112,
    costBasis: {
      menuPriceCents: 1600,
      foodCostCents: 480,
      packagingCents: 80,
      platformFeePct: 0.08,
      platformFeeFloorCents: 60,
      platformFeeCapCents: 200,
      stripePct: 0.029,
      stripeFixedCents: 30,
    },
    orders: [
      {
        orderId: 'order-1',
        qty: 2,
        subtotalCents: 2224,
        platformFeeCents: 178,
        refundedCents: 0,
        platformFeeReversedCents: 0,
      },
    ],
    ledger: [
      { orderId: 'order-1', type: 'CHARGE', amountCents: 2224 },
      { orderId: 'order-1', type: 'PLATFORM_FEE', amountCents: 178 },
    ],
    customers: [{ participantId: 'participant-1', qty: 2, priorCapturedOrderCount: 0 }],
    attribution: [],
    ...overrides,
  };
}

const OWNERS = [
  { userId: 'user-1', email: 'ann@example.test', name: 'Ann Owner' },
  { userId: 'user-2', email: 'ben@example.test', name: 'Ben Owner' },
];

beforeEach(() => {
  vi.mocked(merchantsForDigest).mockReset();
  vi.mocked(digestAlreadySent).mockReset();
  vi.mocked(recordDigestDelivery).mockReset();
  vi.mocked(reportSourcesFor).mockReset();

  vi.mocked(merchantsForDigest).mockResolvedValue([
    {
      id: 'merchant-1',
      name: 'Café Test',
      timezone: 'America/Edmonton',
      owners: OWNERS,
    },
  ]);
  vi.mocked(digestAlreadySent).mockResolvedValue(false);
  vi.mocked(recordDigestDelivery).mockResolvedValue();
  vi.mocked(reportSourcesFor).mockResolvedValue({
    sources: [source()],
    skippedDropCount: 1,
  });
});

describe('runWeeklyDigest', () => {
  it('emails every consenting owner and records each delivery', async () => {
    const sender = recordingEmailSender();
    const result = await runWeeklyDigest({ now: NOW, sender, origin: 'https://groupeat.example' });

    expect(result).toMatchObject({
      week: 'Oct 26 – Nov 1',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      merchants: 1,
      recipients: 2,
      sent: 2,
      failed: 0,
      skippedAlreadySent: 0,
      skippedNoDrops: 0,
      notConfigured: 0,
      merchantsWithNothingToReport: 0,
    });

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent.map((email) => email.to)).toEqual([
      'ann@example.test',
      'ben@example.test',
    ]);
    expect(sender.sent[0]?.text).toContain('You kept $8.02');
    expect(sender.sent[0]?.text).toContain('could not be reconciled');

    expect(recordDigestDelivery).toHaveBeenCalledTimes(2);
    expect(recordDigestDelivery).toHaveBeenNthCalledWith(1, {
      merchantId: 'merchant-1',
      userId: 'user-1',
      weekStart: new Date(WEEK_START),
    });
  });

  it('queries the report for exactly the completed local week', async () => {
    await runWeeklyDigest({ now: NOW, sender: recordingEmailSender(), origin: undefined });

    expect(reportSourcesFor).toHaveBeenCalledWith({
      merchantId: 'merchant-1',
      from: new Date(WEEK_START),
      to: new Date(WEEK_END),
      limit: 200,
    });
  });

  it('skips owners who already received this week and records nothing again', async () => {
    vi.mocked(digestAlreadySent).mockResolvedValue(true);
    const sender = recordingEmailSender();

    const result = await runWeeklyDigest({ now: NOW, sender, origin: undefined });

    expect(result.sent).toBe(0);
    expect(result.skippedAlreadySent).toBe(2);
    expect(sender.sent).toHaveLength(0);
    expect(recordDigestDelivery).not.toHaveBeenCalled();
  });

  it('does not record a failed send, so the next run retries it', async () => {
    const sender = recordingEmailSender();
    sender.failNext(1);

    const first = await runWeeklyDigest({ now: NOW, sender, origin: undefined });

    expect(first).toMatchObject({ sent: 1, failed: 1 });
    expect(recordDigestDelivery).toHaveBeenCalledTimes(1);
    expect(recordDigestDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-2' }),
    );

    // The failed owner is still unrecorded, so a retry sends to them. The successful
    // owner's row is what stops a duplicate.
    vi.mocked(digestAlreadySent).mockImplementation(
      async (args) => args.userId === 'user-2',
    );
    const retry = await runWeeklyDigest({ now: NOW, sender, origin: undefined });

    expect(retry).toMatchObject({ sent: 1, failed: 0, skippedAlreadySent: 1 });
    // The first run sent to Ben (Ann failed). The retry sends Ann, and skips Ben.
    expect(sender.sent.map((email) => email.to)).toEqual([
      'ben@example.test',
      'ann@example.test',
    ]);
  });

  it('sends nothing for a merchant with no reportable drops', async () => {
    vi.mocked(reportSourcesFor).mockResolvedValue({ sources: [], skippedDropCount: 0 });
    const sender = recordingEmailSender();

    const result = await runWeeklyDigest({ now: NOW, sender, origin: undefined });

    expect(result).toMatchObject({
      sent: 0,
      skippedNoDrops: 2,
      merchantsWithNothingToReport: 1,
    });
    expect(sender.sent).toHaveLength(0);
  });

  it('reports NOT_CONFIGURED without recording a delivery', async () => {
    // The real logging sender is what a keyless deployment gets. Its outcome is
    // `NOT_CONFIGURED`, and the important claim is that the delivery table stays
    // empty — so a later keyed run still sends this week rather than losing it.
    const { loggingEmailSender } = await import('@/lib/notify/email-sender');
    const result = await runWeeklyDigest({
      now: NOW,
      sender: loggingEmailSender(),
      origin: undefined,
    });

    expect(result).toMatchObject({ sent: 0, failed: 2, notConfigured: 2 });
    expect(recordDigestDelivery).not.toHaveBeenCalled();
  });
});
