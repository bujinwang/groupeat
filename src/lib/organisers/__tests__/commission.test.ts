import { describe, expect, it } from 'vitest';

import {
  COMMISSION_CSV_COLUMNS,
  COMMISSION_PERIOD_TZ,
  assertRefundWithinSubtotal,
  buildCommissionLine,
  commissionBasisPoints,
  commissionCentsFor,
  commissionPctLabel,
  commissionPeriodFor,
  isoDateInZone,
  monthKeyOf,
  organiserSlug,
  parseCommissionPeriod,
  shiftMonthKey,
  toCsv,
  totalsFor,
  type CommissionLineRow,
  type CommissionOrderFact,
} from '../commission';

/**
 * FR-804's arithmetic, with no database and no clock.
 *
 * ## What each block is defending
 *
 *   - **AC4/AC5** are the two rounding rules that produce a figure a human can
 *     reproduce in a spreadsheet: half-up, and round-then-sum. Both have a plausible
 *     wrong implementation that differs by exactly one cent, and one cent on a
 *     statement is a support ticket.
 *   - **AC6** is the timezone. `new Date(2026, 2, 1)` is the natural way to write a
 *     month boundary and it is wrong by seven hours, every month, silently.
 *   - **The CSV block** pins the column contract and the two formatting rules the spec
 *     states explicitly: no `$`, no thousands separator.
 *   - **The parser block** is the page's safety net: a hand-edited `?month=` must give
 *     `null`, not a throw and not a silent wrong month.
 */

const ORDER_ONE: CommissionOrderFact = {
  orderId: 'order-1',
  qty: 2,
  subtotalCents: 2400,
  refundedCents: 600,
};

function line(overrides: Partial<CommissionLineRow> = {}): CommissionLineRow {
  return {
    dropId: 'drop-1',
    merchant: 'Rangoli',
    drop: 'Butter chicken bowls',
    pickupDate: '2026-03-05',
    units: 2,
    grossCapturedCents: 2400,
    refundedCents: 600,
    netCapturedCents: 1800,
    commissionBasisPoints: 500,
    commissionCents: 90,
    dropStatus: 'CAPTURED',
    ...overrides,
  };
}

/**
 * A minimal RFC 4180 row parser, so the CSV assertions test what a spreadsheet sees
 * rather than what `String.split(',')` sees.
 */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row.charAt(index);
    if (quoted) {
      if (char === '"' && row.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

describe('commissionCentsFor — AC4, half-up and nothing else', () => {
  it('rounds 90.5 up to 91, which half-even and truncation both get wrong', () => {
    // 1810 × 500 / 10000 = 90.5 exactly. `Math.floor` gives 90, banker's rounding
    // gives 90. The codebase's `roundHalfUp` gives 91 and that is the contract.
    expect(commissionCentsFor(1810, 500)).toBe(91);
  });

  it('rounds 0.5 up to 1', () => {
    // 10 × 500 / 10000 = 0.5. The smallest possible half-cent, and the one an
    // off-by-one in the divisor shows up in first.
    expect(commissionCentsFor(10, 500)).toBe(1);
  });

  it('rounds 0.45 down to 0', () => {
    expect(commissionCentsFor(9, 500)).toBe(0);
  });

  it('is exact where no rounding is needed', () => {
    // AC1 and AC3, as arithmetic: 1800 × 5% = 90, 23400 × 5% = 1170.
    expect(commissionCentsFor(1800, 500)).toBe(90);
    expect(commissionCentsFor(23400, 500)).toBe(1170);
  });

  it('pays nothing on a zero base, which is the force-failed drop', () => {
    expect(commissionCentsFor(0, 500)).toBe(0);
  });

  it('follows the rate, not a hard-coded 5%', () => {
    expect(commissionCentsFor(1000, 750)).toBe(75);
    expect(commissionCentsFor(1000, 0)).toBe(0);
  });
});

describe('totalsFor — AC5, sum the rounded lines', () => {
  it('adds 91 + 91 to 182, not the 181 a rounded sum gives', () => {
    const lines = [
      line({ dropId: 'drop-a', netCapturedCents: 1810, commissionCents: commissionCentsFor(1810, 500) }),
      line({ dropId: 'drop-b', netCapturedCents: 1810, commissionCents: commissionCentsFor(1810, 500) }),
    ];

    const totals = totalsFor(lines);

    expect(totals.commissionCents).toBe(182);
    // The wrong implementation, spelled out so the test fails with the reason rather
    // than with "expected 182, received 181": rounding the summed base loses a cent.
    expect(commissionCentsFor(totals.netCapturedCents, 500)).toBe(181);
    expect(totals.commissionCents).not.toBe(commissionCentsFor(totals.netCapturedCents, 500));
  });

  it('sums every money column independently of the commission column', () => {
    const totals = totalsFor([
      line({ units: 2, grossCapturedCents: 2400, refundedCents: 600, netCapturedCents: 1800, commissionCents: 90 }),
      line({ dropId: 'drop-b', units: 5, grossCapturedCents: 6000, refundedCents: 0, netCapturedCents: 6000, commissionCents: 300 }),
    ]);

    expect(totals).toEqual({
      units: 7,
      grossCapturedCents: 8400,
      refundedCents: 600,
      netCapturedCents: 7800,
      commissionCents: 390,
    });
  });

  it('totals an empty statement to zero rather than to undefined', () => {
    expect(totalsFor([])).toEqual({
      units: 0,
      grossCapturedCents: 0,
      refundedCents: 0,
      netCapturedCents: 0,
      commissionCents: 0,
    });
  });
});

describe('the period is Edmonton’s month — AC6', () => {
  it('puts 2026-03-01T06:30:00Z in February, where a UTC filter puts it in March', () => {
    // 06:30Z is 23:30 MST on 28 February. This is the whole point of the constant.
    expect(monthKeyOf(new Date('2026-03-01T06:30:00Z'))).toBe('2026-02');
    // Half an hour later it really is March.
    expect(monthKeyOf(new Date('2026-03-01T07:30:00Z'))).toBe('2026-03');
  });

  it('bounds February with the right UTC instants', () => {
    const february = commissionPeriodFor('2026-02');
    expect(february.from.toISOString()).toBe('2026-02-01T07:00:00.000Z');
    expect(february.to.toISOString()).toBe('2026-03-01T07:00:00.000Z');
  });

  it('gives a month containing the 2026-03-08 DST change 743 hours, not 744', () => {
    // 2026-03-08 02:00 MST springs forward to 03:00 MDT. March therefore opens at
    // UTC−7 and closes at UTC−6, so the month is one hour short of 31 days. A naive
    // boundary construction produces 744 here and 745 in November.
    const march = commissionPeriodFor('2026-03');
    expect(march.from.toISOString()).toBe('2026-03-01T07:00:00.000Z');
    expect(march.to.toISOString()).toBe('2026-04-01T06:00:00.000Z');
    expect((march.to.getTime() - march.from.getTime()) / 3_600_000).toBe(743);
  });

  it('contains every instant of the DST day and excludes the one before the month', () => {
    const march = commissionPeriodFor('2026-03');

    // 2026-03-08 03:00 MDT — an hour that exists only because the clock jumped.
    const afterSpringForward = new Date('2026-03-08T09:00:00Z');
    expect(afterSpringForward >= march.from && afterSpringForward < march.to).toBe(true);
    expect(monthKeyOf(afterSpringForward)).toBe('2026-03');

    // 23:59 on 28 February, which is one minute before March starts in Edmonton.
    const lastMinuteOfFebruary = new Date('2026-03-01T06:59:00Z');
    expect(lastMinuteOfFebruary >= march.from).toBe(false);
    expect(monthKeyOf(lastMinuteOfFebruary)).toBe('2026-02');
  });

  it('gives a month with no DST change exactly 744 hours', () => {
    const january = commissionPeriodFor('2026-01');
    expect((january.to.getTime() - january.from.getTime()) / 3_600_000).toBe(744);
  });

  it('puts every boundary at local midnight on the 1st, whatever the offset does that month', () => {
    // The environment-independent form of the AC6 proof, and the one that actually
    // catches `new Date(2026, month - 1, 1)`: under that construction `from` is
    // 00:00Z, which is 17:00 the *previous* day in Edmonton, so this fails on every
    // month rather than on the two where a transition happens.
    for (let month = 1; month <= 12; month += 1) {
      const monthKey = `2026-${String(month).padStart(2, '0')}`;
      const period = commissionPeriodFor(monthKey);

      expect(isoDateInZone(period.from, COMMISSION_PERIOD_TZ)).toBe(`${monthKey}-01`);
      expect(isoDateInZone(period.to, COMMISSION_PERIOD_TZ).endsWith('-01')).toBe(true);

      // Half-open at exactly the right instant: one second before the start is the
      // previous month, one second before the end is this one.
      expect(monthKeyOf(new Date(period.from.getTime() - 1000))).not.toBe(monthKey);
      expect(monthKeyOf(new Date(period.to.getTime() - 1000))).toBe(monthKey);
      expect(monthKeyOf(period.from)).toBe(monthKey);
    }
  });

  it('gives the autumn months their real length rather than an assumed 30 or 31 days', () => {
    // Deliberately *not* asserting 745 hours. The runtime's tz database (tzdata
    // 2026c) has Edmonton staying at UTC−6 from 2026-03-08 onward — no fall-back — so
    // November 2026 is 720 hours here while Denver's identical historical rules are
    // not. Asserting a specific hour count would test the tz database, not this code;
    // the property that matters is that the boundary is local midnight, asserted above
    // and below. What this test does assert is that the length is derived, not assumed.
    const november = commissionPeriodFor('2026-11');
    const hours = (november.to.getTime() - november.from.getTime()) / 3_600_000;
    expect(Number.isInteger(hours)).toBe(true);
    expect(hours).toBeGreaterThanOrEqual(720);
    expect(hours).toBeLessThanOrEqual(745);
    expect(november.from.getTime() % 3_600_000).toBe(0);
  });

  it('is half-open, so consecutive months share no instant', () => {
    for (const monthKey of ['2026-01', '2026-02', '2026-03', '2026-11', '2026-12']) {
      const period = commissionPeriodFor(monthKey);
      // The closing instant belongs to the next month and not to this one.
      expect(monthKeyOf(period.to)).not.toBe(monthKey);
      expect(monthKeyOf(new Date(period.to.getTime() - 1000))).toBe(monthKey);
    }
  });

  it('returns the same instants on every call — AC11, no clock leaks in', () => {
    const first = commissionPeriodFor('2026-03');
    const second = commissionPeriodFor('2026-03');
    expect(second.from.getTime()).toBe(first.from.getTime());
    expect(second.to.getTime()).toBe(first.to.getTime());
  });

  it('names the zone it resolved in', () => {
    expect(COMMISSION_PERIOD_TZ).toBe('America/Edmonton');
  });
});

describe('parseCommissionPeriod — the page’s safety net', () => {
  it.each([
    ['2026-13', 'a thirteenth month'],
    ['2026-00', 'month zero'],
    ['2026-3', 'a one-digit month'],
    ['26-03', 'a two-digit year'],
    ['2026-03-01', 'a full date'],
    ['2026/03', 'a slash'],
    ['March 2026', 'words'],
    [' 2026-03', 'a leading space'],
    ['2026-03 ', 'a trailing space'],
    ['1999-12', 'a year before the corridor existed'],
    ['2101-01', 'a year no statement will ever cover'],
    ['', 'an empty string'],
  ])('returns null for %s (%s)', (raw) => {
    expect(parseCommissionPeriod(raw)).toBeNull();
  });

  it('returns null for a missing parameter rather than defaulting silently', () => {
    // The caller decides what a missing month means. Returning "the current month"
    // here would make a mistyped month indistinguishable from an absent one.
    expect(parseCommissionPeriod(null)).toBeNull();
    expect(parseCommissionPeriod(undefined)).toBeNull();
  });

  it('accepts a well-formed key and echoes it back', () => {
    const period = parseCommissionPeriod('2026-03');
    expect(period?.monthKey).toBe('2026-03');
    expect(period?.year).toBe(2026);
    expect(period?.month).toBe(3);
  });
});

describe('shiftMonthKey', () => {
  it('crosses a year boundary in both directions', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
  });

  it('steps within a year', () => {
    expect(shiftMonthKey('2026-03', -1)).toBe('2026-02');
    expect(shiftMonthKey('2026-03', 1)).toBe('2026-04');
    expect(shiftMonthKey('2026-03', 0)).toBe('2026-03');
    expect(shiftMonthKey('2026-03', 11)).toBe('2027-02');
  });
});

describe('commissionBasisPoints and commissionPctLabel', () => {
  it('converts the two decimals `Decimal(5,2)` stores, exactly', () => {
    expect(commissionBasisPoints(5)).toBe(500);
    expect(commissionBasisPoints(5.25)).toBe(525);
    expect(commissionBasisPoints(7.1)).toBe(710);
    expect(commissionBasisPoints(0)).toBe(0);
    expect(commissionBasisPoints(100)).toBe(10_000);
  });

  it('prints two decimals with no symbol and no percent sign', () => {
    expect(commissionPctLabel(500)).toBe('5.00');
    expect(commissionPctLabel(525)).toBe('5.25');
    expect(commissionPctLabel(5)).toBe('0.05');
    expect(commissionPctLabel(0)).toBe('0.00');
    expect(commissionPctLabel(10_000)).toBe('100.00');
  });

  it('round-trips through the label for every two-decimal rate', () => {
    for (let bp = 0; bp <= 10_000; bp += 25) {
      expect(commissionBasisPoints(Number(commissionPctLabel(bp)))).toBe(bp);
    }
  });

  it('refuses a non-finite rate instead of producing NaN money', () => {
    expect(() => commissionBasisPoints(Number.NaN)).toThrow(/finite/);
  });
});

describe('buildCommissionLine', () => {
  it('nets the refund out of the base — AC1', () => {
    const built = buildCommissionLine(
      {
        dropId: 'drop-1',
        merchantName: 'Rangoli',
        dropTitle: 'Butter chicken',
        dropStatus: 'CAPTURED',
        windowStart: new Date('2026-03-05T19:00:00Z'),
        merchantTimezone: 'America/Edmonton',
        orders: [ORDER_ONE],
      },
      500,
    );

    expect(built.grossCapturedCents).toBe(2400);
    expect(built.refundedCents).toBe(600);
    expect(built.netCapturedCents).toBe(1800);
    expect(built.commissionCents).toBe(90);
    // 5% of the gross would be 120. The line must not say 120.
    expect(built.commissionCents).not.toBe(commissionCentsFor(2400, 500));
  });

  it('carries units from a fully refunded line, so the organiser sees the work', () => {
    const built = buildCommissionLine(
      {
        dropId: 'drop-2',
        merchantName: 'Rangoli',
        dropTitle: 'Failed drop',
        dropStatus: 'FAILED',
        windowStart: new Date('2026-03-05T19:00:00Z'),
        merchantTimezone: 'America/Edmonton',
        orders: [{ orderId: 'o', qty: 20, subtotalCents: 48_000, refundedCents: 48_000 }],
      },
      500,
    );

    expect(built.units).toBe(20);
    expect(built.netCapturedCents).toBe(0);
    expect(built.commissionCents).toBe(0);
  });

  it('renders pickup_date in the merchant’s zone, not the server’s', () => {
    // 2026-03-05T19:00Z is 12:00 MST on the 5th. 2026-03-06T03:00Z is 20:00 MST on
    // the 5th — a UTC date would say the 6th.
    expect(isoDateInZone(new Date('2026-03-05T19:00:00Z'), 'America/Edmonton')).toBe('2026-03-05');
    expect(isoDateInZone(new Date('2026-03-06T03:00:00Z'), 'America/Edmonton')).toBe('2026-03-05');
  });
});

describe('assertRefundWithinSubtotal', () => {
  it('accepts the boundary values', () => {
    expect(() =>
      assertRefundWithinSubtotal([
        { orderId: 'a', qty: 1, subtotalCents: 2400, refundedCents: 0 },
        { orderId: 'b', qty: 1, subtotalCents: 2400, refundedCents: 2400 },
      ]),
    ).not.toThrow();
  });

  it('refuses a refund larger than the charge, naming the order', () => {
    // Clamping this would silently underpay the organiser and destroy the only
    // evidence that a refund was recorded against the wrong order.
    expect(() =>
      assertRefundWithinSubtotal([
        { orderId: 'order-ok', qty: 1, subtotalCents: 2400, refundedCents: 0 },
        { orderId: 'order-broken', qty: 1, subtotalCents: 2400, refundedCents: 2401 },
      ]),
    ).toThrow(/order-broken/);
  });

  it('refuses a negative refund', () => {
    expect(() =>
      assertRefundWithinSubtotal([
        { orderId: 'order-negative', qty: 1, subtotalCents: 2400, refundedCents: -1 },
      ]),
    ).toThrow(/order-negative/);
  });

  it('refuses fractional money, because cents are integers everywhere else', () => {
    expect(() =>
      assertRefundWithinSubtotal([
        { orderId: 'order-float', qty: 1, subtotalCents: 2400.5, refundedCents: 0 },
      ]),
    ).toThrow(/order-float/);
  });
});

describe('toCsv', () => {
  const rows = [
    line({
      merchant: 'Rangoli',
      drop: 'Butter chicken bowls',
      pickupDate: '2026-03-05',
      units: 2,
      grossCapturedCents: 2400,
      refundedCents: 600,
      netCapturedCents: 1800,
      commissionCents: 90,
      dropStatus: 'CAPTURED',
    }),
  ];

  it('emits the eleven columns in the order the spec lists', () => {
    expect(COMMISSION_CSV_COLUMNS).toEqual([
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
    ]);

    const [header, firstRow] = toCsv(rows).split('\n');
    expect(header).toBe(COMMISSION_CSV_COLUMNS.join(','));
    expect(firstRow).toBe('Rangoli,Butter chicken bowls,2026-03-05,2,2400,600,1800,5.00,90,0.90,CAPTURED');
  });

  it('writes commission_dollars as 0.00 with no symbol and no thousands separator', () => {
    const csv = toCsv([line({ commissionCents: 123_456 })]);
    const dollars = csv.trimEnd().split('\n')[1]?.split(',')[9];

    expect(dollars).toBe('1234.56');
    expect(dollars).not.toContain('$');
    expect(dollars).not.toContain(',');
    expect(dollars).toMatch(/^\d+\.\d{2}$/);
  });

  it('pads a sub-dollar commission to two decimals', () => {
    const csv = toCsv([line({ commissionCents: 5 })]);
    expect(csv.trimEnd().split('\n')[1]?.split(',')[9]).toBe('0.05');
  });

  it('contains no dollar sign anywhere', () => {
    expect(toCsv(rows)).not.toContain('$');
  });

  it('is pure ASCII even when the merchant name is not', () => {
    const csv = toCsv([line({ merchant: 'Café Rangoli 🍛', drop: 'Bánh mì' })]);
    // `toAscii` folds accents rather than dropping the letters, and replaces what it
    // cannot fold, so the row keeps its shape.
    expect(csv).toContain('Cafe Rangoli ?');
    expect(csv).toContain('Banh mi');
    expect(csv).toMatch(/^[\x09\x0A\x0D\x20-\x7E]*$/);
  });

  it('quotes a value containing a comma instead of shifting every column after it', () => {
    const csv = toCsv([line({ merchant: 'Rangoli, Downtown' })]);
    const row = csv.trimEnd().split('\n')[1] ?? '';

    expect(row.startsWith('"Rangoli, Downtown",')).toBe(true);
    // A naive `split(',')` sees twelve fields here; an RFC 4180 parse must see eleven,
    // with the merchant whole. That difference is a spreadsheet with every money
    // column shifted one to the right.
    expect(row.split(',')).toHaveLength(12);
    const fields = parseCsvRow(row);
    expect(fields).toHaveLength(COMMISSION_CSV_COLUMNS.length);
    expect(fields[0]).toBe('Rangoli, Downtown');
    expect(fields[3]).toBe('2');
  });

  it('doubles an embedded double quote', () => {
    const csv = toCsv([line({ drop: 'The "Big" Bowl' })]);
    expect(csv).toContain('"The ""Big"" Bowl"');
  });

  it('emits a header-only file for an empty statement, not an empty string', () => {
    // A zero-byte download looks like a failed export. A header tells the operator
    // the export worked and the month was empty.
    const csv = toCsv([]);
    expect(csv).toBe(`${COMMISSION_CSV_COLUMNS.join(',')}\n`);
  });

  it('has one row per line and no totals row', () => {
    // A totals row in a data file makes SUM() over the column double-count, which is
    // the first thing anyone does with a statement export.
    const csv = toCsv([line({ dropId: 'a' }), line({ dropId: 'b' }), line({ dropId: 'c' })]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.filter((row) => row.startsWith('Total'))).toHaveLength(0);
  });

  it('sums, in a spreadsheet’s arithmetic, to the printed total', () => {
    // The property the route test asserts against real data, here on the numbers from
    // AC5: 91 + 91 must be 182 and the CSV must let a human reach that.
    const lines = [
      line({ dropId: 'a', netCapturedCents: 1810, commissionCents: 91 }),
      line({ dropId: 'b', netCapturedCents: 1810, commissionCents: 91 }),
    ];
    const columnSum = toCsv(lines)
      .trimEnd()
      .split('\n')
      .slice(1)
      .reduce((sum, row) => sum + Number(row.split(',')[8]), 0);

    expect(columnSum).toBe(totalsFor(lines).commissionCents);
    expect(columnSum).toBe(182);
  });
});

describe('organiserSlug', () => {
  it('turns a display name into a filename segment', () => {
    expect(organiserSlug('Sam Organiser')).toBe('sam-organiser');
    expect(organiserSlug('Café Bob')).toBe('cafe-bob');
    expect(organiserSlug('  Sam   O  ')).toBe('sam-o');
  });

  it('never produces an empty segment', () => {
    // `groupeat-commission--2026-03.csv` reads as a bug in the export.
    expect(organiserSlug('')).toBe('organiser');
    expect(organiserSlug('🍛🍛')).toBe('organiser');
  });

  it('bounds the length so the filename stays usable', () => {
    expect(organiserSlug('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});
