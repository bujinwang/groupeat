import { describe, expect, it } from 'vitest';

import { parseMoneyToCents } from '@/components/ui/MoneyInput';

/**
 * §7.2 rule 1 — parsing happens once, at the boundary, and it must be exact.
 *
 * These are the formats PRD-sprint1 §6.3 says the merchant may type. The function
 * works on the digits rather than `Number(text) * 100`, because
 * `Number('16.1') * 100` is `1609.9999999999998`.
 */
describe('parseMoneyToCents', () => {
  it('accepts every form the PRD lists', () => {
    expect(parseMoneyToCents('16')).toBe(1600);
    expect(parseMoneyToCents('16.0')).toBe(1600);
    expect(parseMoneyToCents('16.00')).toBe(1600);
    expect(parseMoneyToCents('$16.00')).toBe(1600);
    expect(parseMoneyToCents('  $16.00 ')).toBe(1600);
    expect(parseMoneyToCents('1,600')).toBe(160000);
  });

  it('does not go through floating point', () => {
    // The classic: Number('16.1') * 100 === 1609.9999999999998
    expect(parseMoneyToCents('16.1')).toBe(1610);
    expect(parseMoneyToCents('0.07')).toBe(7);
    expect(parseMoneyToCents('4.35')).toBe(435);
  });

  it('keeps one and two decimal places exact', () => {
    expect(parseMoneyToCents('0.5')).toBe(50);
    expect(parseMoneyToCents('0.05')).toBe(5);
    expect(parseMoneyToCents('0')).toBe(0);
  });

  it('returns null for anything it cannot parse', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('   ')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('16.005')).toBeNull();
    expect(parseMoneyToCents('-5')).toBeNull();
    expect(parseMoneyToCents('1e3')).toBeNull();
  });
});
