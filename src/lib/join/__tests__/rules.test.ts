import { describe, expect, it } from 'vitest';

import { formatCents } from '@/lib/guardrail/money';

import {
  MAX_JOIN_QTY,
  availableQty,
  checkQty,
  dollars,
  joinConfirmationCopy,
  normalisePhone,
  phoneLast4,
  qtyLimitFor,
  refusalFromBlocked,
  resolveJoinMoney,
} from '../rules';

/**
 * The join rules.
 *
 * Everything here is a decision a diner's card depends on and nothing here needs
 * a database, which is the point of the module being pure. The expected values are
 * written as literals — the E.164 strings, the cents — rather than computed by the
 * code under test, so a bug in `rules.ts` cannot satisfy both sides of an
 * assertion.
 */

describe('normalisePhone', () => {
  /**
   * The case that matters most: a diner in Alberta types ten digits, with whatever
   * punctuation their phone's keyboard offered.
   */
  it.each([
    ['7805550123', '+17805550123'],
    ['780-555-0123', '+17805550123'],
    ['780.555.0123', '+17805550123'],
    ['(780) 555-0123', '+17805550123'],
    ['780 555 0123', '+17805550123'],
    ['  7805550123  ', '+17805550123'],
    ['17805550123', '+17805550123'],
    ['+17805550123', '+17805550123'],
    ['+1 (780) 555-0123', '+17805550123'],
    // A pasted contact-card number keeps its newlines and tabs.
    ['780\t555\n0123', '+17805550123'],
  ])('normalises %s to %s', (input, expected) => {
    const result = normalisePhone(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.e164).toBe(expected);
  });

  it('accepts an international number typed with the 00 prefix', () => {
    // Germany, in the form somebody abroad would type it.
    const result = normalisePhone('0049 30 12345678');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.e164).toBe('+493012345678');
  });

  it('keeps an explicitly international number as it is', () => {
    const result = normalisePhone('+44 20 7946 0958');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.e164).toBe('+442079460958');
  });

  it('refuses an empty string', () => {
    const result = normalisePhone('   ');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('EMPTY');
  });

  /**
   * The refusal that matters. A chain of `replace` calls that strips anything
   * non-digit turns "call me" into "" and "ext. 4" into "4", and a number that was
   * never usable gets stored and then fails to deliver — silently, at the cutoff.
   */
  it.each([['call me'], ['ext. 4'], ['780-555-CALL'], ['+1 780 555 0123 x9'], ['n/a'], ['--']])(
    'refuses %s rather than salvaging digits from it',
    (input) => {
      const result = normalisePhone(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('UNPARSEABLE');
    },
  );

  it('refuses a number that is too short or too long for E.164', () => {
    for (const input of ['123456', '1234567890123456']) {
      const result = normalisePhone(input);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a leading zero, which is not a legal country code', () => {
    // The `00` prefix was already consumed above; a single leading zero that
    // survives is a domestic number typed without its country code.
    const result = normalisePhone('07805550123');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('UNPARSEABLE');
  });
});

describe('phoneLast4', () => {
  it('returns the last four digits of an E.164 number', () => {
    expect(phoneLast4('+17805550123')).toBe('0123');
  });
});

describe('qtyLimitFor', () => {
  it('clamps a merchant cap to the hard ceiling', () => {
    expect(qtyLimitFor(4)).toBe(4);
    expect(qtyLimitFor(MAX_JOIN_QTY)).toBe(MAX_JOIN_QTY);
    // A fat-fingered 400 must not authorise a four-figure charge.
    expect(qtyLimitFor(400)).toBe(MAX_JOIN_QTY);
  });

  it('falls back to one for a stored value that is not a usable limit', () => {
    // Not "no limit": the failure mode of that reading is an unbounded charge.
    expect(qtyLimitFor(0)).toBe(1);
    expect(qtyLimitFor(-3)).toBe(1);
    expect(qtyLimitFor(2.5)).toBe(1);
  });
});

describe('checkQty', () => {
  it('accepts a quantity inside the limit', () => {
    const result = checkQty(2, 4);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.qty).toBe(2);
  });

  it('refuses zero and negatives', () => {
    for (const qty of [0, -1]) {
      const result = checkQty(qty, 4);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('TOO_FEW');
    }
  });

  it('refuses a quantity above the limit and names the limit', () => {
    const result = checkQty(5, 4);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('TOO_MANY');
    expect(result.message).toContain('4');
  });

  it('uses singular copy when the limit is one', () => {
    const result = checkQty(2, 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('This drop is limited to one per person.');
  });

  it('refuses a fractional quantity', () => {
    const result = checkQty(1.5, 4);

    expect(result.ok).toBe(false);
  });
});

describe('resolveJoinMoney', () => {
  it('multiplies the unit price by the quantity with no rounding', () => {
    const result = resolveJoinMoney({ qty: 3, dealPriceCents: 1112, platformFeeCents: 267 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 × 1112 = 3336. Written as a literal, not recomputed.
    expect(result.money.amountCents).toBe(3336);
    expect(result.money.unitPriceCents).toBe(1112);
    expect(result.money.qty).toBe(3);
    expect(result.money.platformFeeCents).toBe(267);
  });

  it('accepts a zero fee, for a fee-waived drop', () => {
    const result = resolveJoinMoney({ qty: 1, dealPriceCents: 1500, platformFeeCents: 0 });

    expect(result.ok).toBe(true);
  });

  it('refuses a price that is not a positive integer', () => {
    for (const dealPriceCents of [0, -100, 12.5]) {
      const result = resolveJoinMoney({ qty: 1, dealPriceCents, platformFeeCents: 50 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('BAD_PRICE');
    }
  });

  it('refuses a fee larger than the amount it is taken from', () => {
    // A fee above the charge means the merchant owes us money per plate.
    const result = resolveJoinMoney({ qty: 1, dealPriceCents: 1112, platformFeeCents: 1113 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BAD_FEE');
  });

  it('refuses a fee that is not an integer', () => {
    const result = resolveJoinMoney({ qty: 2, dealPriceCents: 1600, platformFeeCents: 88.96 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BAD_FEE');
  });
});

describe('dollars', () => {
  it('formats cents as a dollar string with two places', () => {
    expect(dollars(1112)).toBe('$11.12');
    expect(dollars(130)).toBe('$1.30');
    expect(dollars(100)).toBe('$1.00');
    expect(dollars(0)).toBe('$0.00');
  });

  it('agrees with formatCents where toFixed(2) does not', () => {
    // The bug these four lines exist for. `dollars()` was
    // `$${(cents / 100).toFixed(2)}`, which is a second rounding rule: `toFixed`
    // rounds the decimal *representation* of a binary float, so `1.005` formats as
    // `$1.00` while half-up gives `$1.01`. The four assertions above passed under
    // the bug because whole cents are exactly where the two rules agree — a test
    // that only exercises the agreeing case cannot see a disagreement.
    //
    // Non-integer cents are unreachable from validated data, which is precisely why
    // this went unnoticed: `formatCents`'s own docblock calls its rounding "belt and
    // braces". The point is not that a diner would see these values; it is that two
    // formatters existed and nothing said they had to agree.
    for (const awkward of [100.5, -100.5, 0.5, 1112.4999, 1112.5]) {
      expect(dollars(awkward)).toBe(formatCents(awkward));
    }
  });

  it('is formatCents, so there is one rule and not two', () => {
    // Identity of behaviour across the range that matters, sampled rather than
    // enumerated: this is a delegation guard, not a formatter test.
    for (let cents = 0; cents <= 20000; cents += 7) {
      expect(dollars(cents)).toBe(formatCents(cents));
    }
  });
});

describe('availableQty', () => {
  it('returns the smallest of the three limits', () => {
    // 4 allowed, 10 left, none taken → 4.
    expect(availableQty({ maxPerCustomer: 4, remaining: 10 })).toBe(4);
    // 4 allowed, but only 2 left → 2.
    expect(availableQty({ maxPerCustomer: 4, remaining: 2 })).toBe(2);
  });

  it('counts what this person already has against their own cap', () => {
    // "4 per person" must mean four in total, not four per submit.
    expect(availableQty({ maxPerCustomer: 4, remaining: 10, alreadyJoined: 3 })).toBe(1);
    expect(availableQty({ maxPerCustomer: 4, remaining: 10, alreadyJoined: 4 })).toBe(0);
  });

  it('never returns a negative quantity', () => {
    expect(availableQty({ maxPerCustomer: 4, remaining: 0, alreadyJoined: 0 })).toBe(0);
    expect(availableQty({ maxPerCustomer: 4, remaining: 10, alreadyJoined: 9 })).toBe(0);
  });
});

describe('refusalFromBlocked', () => {
  it('maps each blocked reason to its own refusal', () => {
    expect(refusalFromBlocked('FAILED', 1, 0)).toBe('FAILED');
    expect(refusalFromBlocked('CLOSED', 1, 0)).toBe('CLOSED');
    expect(refusalFromBlocked('SOLD_OUT', 1, 0)).toBe('SOLD_OUT');
  });

  it('allows a join when the drop is open and the quantity fits', () => {
    expect(refusalFromBlocked(null, 2, 4)).toBeNull();
  });

  it('refuses when the drop is open but not enough is left', () => {
    // The door is open; that does not mean four plates are left in it.
    expect(refusalFromBlocked(null, 4, 2)).toBe('NOT_ENOUGH_LEFT');
  });

  it('refuses when the drop is open and nothing is left', () => {
    expect(refusalFromBlocked(null, 1, 0)).toBe('SOLD_OUT');
  });

  it('accepts a quantity exactly equal to what is left', () => {
    expect(refusalFromBlocked(null, 2, 2)).toBeNull();
  });
});

describe('joinConfirmationCopy', () => {
  it('states the conditional charge and the cutoff', () => {
    const copy = joinConfirmationCopy({
      qty: 2,
      amountLabel: '$26.20',
      minQty: 20,
      closesLabel: 'Tuesday 3pm',
      isConfirmedAlready: false,
    });

    expect(copy).toContain('You will only be charged $26.20 for 2 plates');
    expect(copy).toContain('at least 20 people join by Tuesday 3pm');
    expect(copy).toContain('Nothing is charged today');
  });

  it('uses the singular for one plate', () => {
    const copy = joinConfirmationCopy({
      qty: 1,
      amountLabel: '$13.10',
      minQty: 20,
      closesLabel: 'Tuesday 3pm',
      isConfirmedAlready: false,
    });

    expect(copy).toContain('for 1 plate ');
  });

  it('drops the minimum when the drop has already reached it', () => {
    // ADR-003: "if 20 people join" is a strange thing to say to joiner 22.
    const copy = joinConfirmationCopy({
      qty: 2,
      amountLabel: '$26.20',
      minQty: 20,
      closesLabel: 'Tuesday 3pm',
      isConfirmedAlready: true,
    });

    expect(copy).not.toContain('people join');
    expect(copy).toContain('when this drop closes at Tuesday 3pm');
    expect(copy).toContain('already reached its minimum');
  });

  it('never says a charge happens before the cutoff', () => {
    // The disclosure is the point of the sentence; a softened wording ("you may be
    // charged if") leaves open whether money moves today.
    for (const isConfirmedAlready of [true, false]) {
      const copy = joinConfirmationCopy({
        qty: 1,
        amountLabel: '$13.10',
        minQty: 20,
        closesLabel: 'Tuesday 3pm',
        isConfirmedAlready,
      });
      expect(copy.startsWith('You will only be charged')).toBe(true);
    }
  });
});
