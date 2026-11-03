import { describe, expect, it } from 'vitest';

import {
  COMMISSION_CSV_COLUMNS,
  COMMISSION_PERIOD_TZ,
  buildCommissionLine,
  commissionPeriodFor,
  isoDateInZone,
  monthKeyOf,
  toCsv,
  totalsFor,
  type CommissionLineRow,
  type CommissionOrderFact,
} from '../commission';

/**
 * Independent verification of FR-804, written by QA rather than by the author.
 *
 * ## Why these tests exist separately from the engineer's
 *
 * The engineer proved the three silent-wrong-answer bugs by **mutating the source** and
 * watching an existing assertion fail. That proves the assertion is load-bearing; it
 * does not prove the assertion would catch a *plausible* wrong implementation written
 * independently. These tests take the other route: construct data where the wrong
 * implementation yields a *different, specific* number, and assert the right one. If the
 * engineer's assertion and mine agree on the right answer and disagree with the wrong
 * answer, the number is pinned from two directions.
 *
 * ## What is deliberately asserted here rather than in the DB suite
 *
 *   - **Rounding of the total** (AC5) as pure arithmetic, so the failure names the cent
 *     and not a database row.
 *   - **The CSV's round-trip integrity** — the spec lists eleven columns and says
 *     nothing about escaping. A merchant or drop name containing a comma, a quote or a
 *     newline is the ordinary case (a restaurant called "Rangoli, Downtown"), and it is
 *     the one thing that can silently shift every figure in a row into the wrong column.
 *   - **The printed total equals the sum of the printed lines** — ops pays from the CSV,
 *     so the file has to add up under the arithmetic a human or a spreadsheet performs,
 *     which is "sum the column", not "round the summed base".
 */

const HOUR_MS = 60 * 60 * 1000;

/** One order fact, with the money the only thing under test. */
function fact(overrides: Partial<CommissionOrderFact> = {}): CommissionOrderFact {
  return {
    orderId: overrides.orderId ?? 'order-fixture',
    qty: overrides.qty ?? 1,
    subtotalCents: overrides.subtotalCents ?? 2400,
    refundedCents: overrides.refundedCents ?? 0,
  };
}

/** A line source whose only interesting part is the orders. */
function lineSource(orders: CommissionOrderFact[], overrides: Partial<{ dropId: string; dropTitle: string; merchantName: string }> = {}) {
  return {
    dropId: overrides.dropId ?? 'drop-fixture',
    merchantName: overrides.merchantName ?? 'Rangoli',
    dropTitle: overrides.dropTitle ?? 'Tuesday lunch',
    dropStatus: 'CAPTURED' as const,
    windowStart: new Date('2026-03-05T19:00:00Z'),
    merchantTimezone: 'America/Edmonton',
    orders,
  };
}

/**
 * A complete RFC 4180 parser, including quoted fields that contain newlines.
 *
 * Written here rather than reusing the route test's row parser because that one splits
 * on `\n` first — which is exactly the assumption a newline in a drop title breaks. A
 * parser that cannot survive the input it is checking is not a check.
 */
function parseCsvDocument(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < csv.length) {
    const char = csv.charAt(index);

    if (quoted) {
      if (char === '"' && csv.charAt(index + 1) === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r') {
      // Tolerate CRLF on the way back in; `toCsv` emits `\n`.
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  // A trailing newline leaves nothing pending; anything else is a final unterminated row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * The single data row of a one-line export.
 *
 * Indexing with `[1]` is `string | undefined` under this repo's `tsconfig`, and a test
 * that asserts on `undefined` would pass for the wrong reason. Failing loudly here means
 * a missing row reports "the export lost its row" instead of "expected 2400, got
 * undefined" against a header cell.
 */
function onlyDataRow(rows: string[][]): string[] {
  expect(rows).toHaveLength(2);
  const row = rows[1];
  if (!row) {
    throw new Error('CSV produced a header and no data row.');
  }
  return row;
}

/** One named cell of a row, by column name rather than by a magic index. */
function cell(row: readonly string[], column: string): string {
  const index = (COMMISSION_CSV_COLUMNS as readonly string[]).indexOf(column);
  if (index < 0) {
    throw new Error(`"${column}" is not one of the CSV columns.`);
  }
  const value = row[index];
  if (value === undefined) {
    throw new Error(`Row has no value for column "${column}" — the row is short.`);
  }
  return value;
}

describe('FR-804 verification — AC5, the total is the sum of the rounded lines', () => {
  it('two lines netting 1810 each total 182, and 181 is the wrong answer', () => {
    // 5.00% of 1810 is 90.5. Half-up makes each line 91, so the column is 182.
    // Rounding the summed base — roundHalfUp(3620 × 500 / 10000) — is 181.
    const first = buildCommissionLine(lineSource([fact({ subtotalCents: 1810 })], { dropId: 'drop-a' }), 500);
    const second = buildCommissionLine(lineSource([fact({ subtotalCents: 1810 })], { dropId: 'drop-b' }), 500);

    expect(first.commissionCents).toBe(91);
    expect(second.commissionCents).toBe(91);

    const totals = totalsFor([first, second]);
    expect(totals.netCapturedCents).toBe(3620);
    expect(totals.commissionCents).toBe(182);

    // The specific wrong answer, named so a regression reads as itself.
    expect(totals.commissionCents).not.toBe(181);
  });

  it('the CSV column sums to the printed total, parsed back the way a spreadsheet sums it', () => {
    const lines: CommissionLineRow[] = [
      buildCommissionLine(lineSource([fact({ subtotalCents: 1810 })], { dropId: 'drop-a' }), 500),
      buildCommissionLine(lineSource([fact({ subtotalCents: 1810 })], { dropId: 'drop-b' }), 500),
      // A third line that rounds down, so the sum is not two identical numbers.
      buildCommissionLine(lineSource([fact({ subtotalCents: 9 })], { dropId: 'drop-c' }), 500),
    ];
    const totals = totalsFor(lines);
    expect(totals.commissionCents).toBe(182);

    const rows = parseCsvDocument(toCsv(lines));
    const commissionColumn = COMMISSION_CSV_COLUMNS.indexOf('commission_cents');
    const dollarsColumn = COMMISSION_CSV_COLUMNS.indexOf('commission_dollars');

    const dataRows = rows.slice(1);
    expect(dataRows).toHaveLength(3);

    const columnSum = dataRows.reduce((sum, row) => sum + Number(row[commissionColumn]), 0);
    expect(columnSum).toBe(totals.commissionCents);
    expect(columnSum).toBe(182);

    // `commission_dollars` is the same figure in dollars, so it must agree to the cent.
    const dollarsSum = dataRows.reduce((sum, row) => sum + Math.round(Number(row[dollarsColumn]) * 100), 0);
    expect(dollarsSum).toBe(182);
  });

  it('keeps half-up at the boundary the spec names: 10 → 1, 9 → 0', () => {
    const ten = buildCommissionLine(lineSource([fact({ subtotalCents: 10 })]), 500);
    const nine = buildCommissionLine(lineSource([fact({ subtotalCents: 9 })]), 500);

    // 0.5 rounds up; 0.45 rounds down. Half-even would give 0 and 0.
    expect(ten.commissionCents).toBe(1);
    expect(nine.commissionCents).toBe(0);
  });
});

describe('FR-804 verification — CSV escaping, which the spec does not mention', () => {
  /**
   * The ordinary hostile name: a comma and embedded double quotes.
   *
   * A restaurant is called "Rangoli, Downtown"; a drop is titled `Tuesday, "best" lunch`.
   * Unquoted, the comma splits the cell and every figure after it lands in the wrong
   * column — the file still parses, and the numbers are silently attributed to the wrong
   * header. That is the failure this test is for.
   */
  it('survives a comma and embedded double quotes without shifting a column', () => {
    const line = buildCommissionLine(
      lineSource([fact({ subtotalCents: 2400, refundedCents: 600 })], {
        merchantName: 'Rangoli, Downtown',
        dropTitle: 'Tuesday, "best" lunch',
      }),
      500,
    );

    const csv = toCsv([line]);
    const rows = parseCsvDocument(csv);

    expect(rows).toHaveLength(2);
    // Every row has exactly the header's column count. This is the assertion that
    // catches an unescaped comma: it produces 12 fields against 11 headers.
    expect(rows[0]).toHaveLength(COMMISSION_CSV_COLUMNS.length);
    expect(rows[1]).toHaveLength(COMMISSION_CSV_COLUMNS.length);

    const row = onlyDataRow(rows);
    expect(cell(row, 'merchant')).toBe('Rangoli, Downtown');
    expect(cell(row, 'drop')).toBe('Tuesday, "best" lunch');

    // And the figures are still in the figures' columns.
    expect(cell(row, 'gross_captured_cents')).toBe('2400');
    expect(cell(row, 'refunded_cents')).toBe('600');
    expect(cell(row, 'net_captured_cents')).toBe('1800');
    expect(cell(row, 'commission_cents')).toBe('90');
  });

  it('survives a newline in a drop title without breaking the row count', () => {
    const line = buildCommissionLine(
      lineSource([fact({ subtotalCents: 2400 })], {
        dropTitle: 'Tuesday\nsecond sitting',
      }),
      500,
    );

    const csv = toCsv([line]);
    const rows = parseCsvDocument(csv);

    // One header row and one data row. A raw, unquoted newline produces three rows and
    // the second half of the title becomes a row of figures.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(COMMISSION_CSV_COLUMNS.length);
    const row = onlyDataRow(rows);
    expect(cell(row, 'commission_cents')).toBe('120');

    // Documented behaviour, asserted so it cannot drift silently: `toAscii` folds any
    // byte outside 0x20–0x7E to `?`, and a newline is one of those. So the newline is
    // *replaced*, not quoted — the cell never contains a newline and never needs
    // quoting for one. That makes the `\r\n` branch of `csvText`'s quote test dead
    // code, which is worth knowing but is not a corruption defect: the file is intact
    // and every figure is in its column. A title loses its line break.
    expect(cell(row, 'drop')).toBe('Tuesday?second sitting');
  });

  it('emits only printable ASCII, so the declared utf-8 charset is a superset and not a lie', () => {
    const line = buildCommissionLine(
      lineSource([fact()], { merchantName: 'Café Ünïcode 拉面', dropTitle: 'naïve — lunch' }),
      500,
    );

    const csv = toCsv([line]);
    expect(/^[\x20-\x7E\n]*$/.test(csv)).toBe(true);
    // Folded rather than dropped: the row is still identifiable to an operator.
    const rows = parseCsvDocument(csv);
    expect(cell(onlyDataRow(rows), 'merchant')).toBe('Cafe Unicode ??');
  });

  it('writes the eleven columns in the spec order, header first, and no totals row', () => {
    const line = buildCommissionLine(lineSource([fact()]), 500);
    const csv = toCsv([line]);

    const rows = parseCsvDocument(csv);
    expect(rows[0]).toEqual([
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

    // A totals row inside a data file makes SUM() double-count. Assert its absence by
    // row count: header + exactly one line.
    expect(rows).toHaveLength(2);
    expect(csv.endsWith('\n')).toBe(true);
    // `\n` endings only — a CRLF file is not what the docblock claims.
    expect(csv.includes('\r')).toBe(false);
  });

  it('prints the rate as the exact decimal the basis points encode, not a float artefact', () => {
    const line = buildCommissionLine(lineSource([fact()]), 505);
    const rows = parseCsvDocument(toCsv([line]));
    // 5.05, built by integer division. `(1.005).toFixed(2)` is the failure this avoids.
    expect(cell(onlyDataRow(rows), 'commission_pct')).toBe('5.05');
  });
});

describe('FR-804 verification — the period boundary is a property, not an hour count', () => {
  /**
   * The environment-independent invariant.
   *
   * The runtime's tz database decides what the offset *is* in a given month — and this
   * repository's Node 24 carries tzdata 2026c, in which Alberta has already stopped
   * falling back. So asserting "November is 745 hours" would be asserting the tz
   * database. What must hold under any database is that each boundary is local midnight
   * on the 1st, and that consecutive months tile without gap or overlap.
   */
  it('places every month boundary at local midnight on the 1st, for two consecutive years', () => {
    for (const year of [2026, 2027]) {
      for (let month = 1; month <= 12; month += 1) {
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        const period = commissionPeriodFor(monthKey);

        expect(isoDateInZone(period.from, COMMISSION_PERIOD_TZ)).toBe(`${monthKey}-01`);
        expect(monthKeyOf(period.from)).toBe(monthKey);
        // The instant one second before the start belongs to the previous month.
        expect(monthKeyOf(new Date(period.from.getTime() - 1000))).not.toBe(monthKey);
        // The instant one second before the end belongs to this month.
        expect(monthKeyOf(new Date(period.to.getTime() - 1000))).toBe(monthKey);
        // The end itself belongs to the next month — half-open, so no double count.
        expect(monthKeyOf(period.to)).not.toBe(monthKey);
      }
    }
  });

  it('tiles the year with no gap and no overlap between consecutive months', () => {
    for (let month = 1; month < 12; month += 1) {
      const current = commissionPeriodFor(`2026-${String(month).padStart(2, '0')}`);
      const next = commissionPeriodFor(`2026-${String(month + 1).padStart(2, '0')}`);
      expect(next.from.getTime()).toBe(current.to.getTime());
    }
  });

  it('AC6 holds regardless of which tz database is loaded: 06:30Z on 1 March is February', () => {
    // 2026-03-01T06:30Z is 23:30 MST on 28 February under both tzdata 2025c and 2026c,
    // because the spring-forward on 03-08 is unchanged between them. This is the one
    // AC whose number is runtime-independent, and it is worth asserting that explicitly.
    expect(monthKeyOf(new Date('2026-03-01T06:30:00Z'))).toBe('2026-02');
    expect(monthKeyOf(new Date('2026-03-01T07:30:00Z'))).toBe('2026-03');
  });

  it('a month is between 672 and 745 hours — derived, never assumed', () => {
    // The range spans 28 days with no transition (672) through 31 days that gain an
    // hour (745). A hardcoded 744 for every month would be the `new Date(y, m, 1)`
    // bug's sibling: the length must come from the boundary instants, not from an
    // assumption about how long a month is.
    for (let month = 1; month <= 12; month += 1) {
      const period = commissionPeriodFor(`2026-${String(month).padStart(2, '0')}`);
      const hours = (period.to.getTime() - period.from.getTime()) / HOUR_MS;
      expect(Number.isInteger(hours)).toBe(true);
      expect(hours).toBeGreaterThanOrEqual(672);
      expect(hours).toBeLessThanOrEqual(745);
    }
  });
});
