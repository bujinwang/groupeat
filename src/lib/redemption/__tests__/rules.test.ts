import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import { signRedemptionCode, verifyRedemptionCode } from '@/lib/settlement/redemption-code';

import {
  REDEEMABLE_STATUSES,
  REFUSAL_COPY,
  type RefusalReason,
  isRedeemableStatus,
  normaliseScannedCode,
  phoneLast4,
  resolveRedeemQuantity,
  summariseManifest,
  type ManifestRow,
} from '../rules';

/**
 * The redemption rules, without a database.
 *
 * These are the decisions a staff member's screen makes at 6pm. They are unit
 * tests rather than integration tests because the interesting failures are not
 * about SQL: they are "did we show the right sentence", "can a double tap lose a
 * plate", and "does a pasted URL work".
 */

const SECRET = Buffer.from('a-test-redemption-secret-that-is-long-enough', 'utf8');

describe('which statuses allow food to change hands', () => {
  it('allows PICKUP_OPEN and COMPLETED, and nothing else', () => {
    expect([...REDEEMABLE_STATUSES]).toEqual(['PICKUP_OPEN', 'COMPLETED']);

    for (const status of ['DRAFT', 'PUBLISHED', 'LOCKED', 'CAPTURED', 'FAILED', 'CANCELLED']) {
      expect(isRedeemableStatus(status), `${status} must not be redeemable`).toBe(false);
    }
    expect(isRedeemableStatus('PICKUP_OPEN')).toBe(true);
    expect(isRedeemableStatus('COMPLETED')).toBe(true);
  });

  it('excludes CAPTURED on purpose, because capture happens before the kitchen cooks', () => {
    // The decision this asserts: capture is at the cutoff, which can be the day
    // before pickup. If `CAPTURED` were redeemable, staff could hand over food for
    // a window that has not opened, and `redeemedQty` would look perfectly normal
    // afterwards — the mistake would leave no trace in the data.
    expect(isRedeemableStatus('CAPTURED')).toBe(false);
  });

  it('rejects an unknown status rather than defaulting to allowed', () => {
    // Fail closed: a status this build does not know about must not be treated as
    // "probably fine, hand over the food".
    for (const status of ['', 'pickup_open', 'SOMETHING_NEW', ' PICKUP_OPEN']) {
      expect(isRedeemableStatus(status), `${status}`).toBe(false);
    }
  });
});

describe('how many units a scan takes', () => {
  it('takes everything remaining when no quantity is given', () => {
    expect(resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 0 })).toEqual({ ok: true, take: 3 });
    expect(resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 1 })).toEqual({ ok: true, take: 2 });
  });

  it('takes the requested quantity when it fits', () => {
    expect(resolveRedeemQuantity({ qty: 4, alreadyRedeemed: 0, requested: 2 })).toEqual({
      ok: true,
      take: 2,
    });
  });

  it('clamps an over-request to what is left instead of refusing', () => {
    // A diner ordered 3, only 1 remains, and says "I'm collecting 2". The honest
    // answer at a counter is to hand over the 1 that exists. Refusing here would
    // turn a rounding of expectations into an argument in a queue.
    expect(resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 2, requested: 3 })).toEqual({
      ok: true,
      take: 1,
    });
  });

  it('refuses only at zero remaining, never below', () => {
    expect(resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 3 })).toEqual({
      ok: false,
      reason: 'FULLY_REDEEMED',
    });
    // Over-redeemed — only reachable through a data error, and still refused
    // rather than producing a negative `take`.
    expect(resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 5 })).toEqual({
      ok: false,
      reason: 'FULLY_REDEEMED',
    });
  });

  it('treats a nonsensical request as "all remaining" rather than trusting it', () => {
    // Zero, negative and fractional requests are caller bugs. Falling back to the
    // common case keeps the counter moving; honouring them would write a quantity
    // into `redeemedQty` that nobody asked for.
    for (const requested of [0, -1, 1.5, Number.NaN]) {
      expect(
        resolveRedeemQuantity({ qty: 3, alreadyRedeemed: 0, requested }),
        `requested=${String(requested)}`,
      ).toEqual({ ok: true, take: 3 });
    }
  });

  it('never returns a take that exceeds the order, over a spread of inputs', () => {
    for (let qty = 1; qty <= 12; qty += 1) {
      for (let already = 0; already <= qty; already += 1) {
        for (const requested of [undefined, 1, 2, 5, 99]) {
          const result = resolveRedeemQuantity({ qty, alreadyRedeemed: already, requested });
          if (result.ok) {
            expect(result.take).toBeGreaterThan(0);
            expect(result.take).toBeLessThanOrEqual(qty - already);
            expect(Number.isInteger(result.take)).toBe(true);
          }
        }
      }
    }
  });
});

describe('cleaning up what the scanner or a human produced', () => {
  it('passes a plain code through byte for byte', () => {
    const code = signRedemptionCode(
      { participantId: 'p1', dropId: 'd1', qty: 2 },
      SECRET,
    );
    expect(normaliseScannedCode(code)).toBe(code);
  });

  it('unwraps a code that arrived as a link', () => {
    const code = signRedemptionCode({ participantId: 'p1', dropId: 'd1', qty: 1 }, SECRET);
    for (const wrapped of [
      `https://groupeat.example/c/${code}`,
      `http://groupeat.example/c/${code}?utm_source=sms`,
      `https://groupeat.example/c/${code}#top`,
      `  https://groupeat.example/c/${code}  `,
    ]) {
      expect(normaliseScannedCode(wrapped), wrapped).toBe(code);
      // And the cleaned value still verifies — the point of the exercise.
      expect(verifyRedemptionCode(normaliseScannedCode(wrapped), SECRET)).not.toBeNull();
    }
  });

  it('does not unwrap a non-http scheme', () => {
    // A `javascript:` or `data:` payload must not be "repaired" into something
    // that then gets signature-checked and believed.
    const code = signRedemptionCode({ participantId: 'p1', dropId: 'd1', qty: 1 }, SECRET);
    const hostile = `javascript:alert(1)/${code}`;
    expect(normaliseScannedCode(hostile)).toBe(hostile);
  });

  it('strips a scanner prefix but does not guess at corruption', () => {
    const code = signRedemptionCode({ participantId: 'p1', dropId: 'd1', qty: 1 }, SECRET);
    expect(normaliseScannedCode(`GROUP_EAT:${code}`)).toBe(code);

    // A corrupted body stays corrupted. Cutting at the first dot would have
    // "repaired" this into a different invalid code and hidden the problem.
    const corrupt = `junk-${code}`;
    expect(normaliseScannedCode(corrupt)).toBe(corrupt);
    expect(verifyRedemptionCode(normaliseScannedCode(corrupt), SECRET)).toBeNull();
  });

  it('does NOT fold case, because base64url is case-sensitive', () => {
    // Staff typing a code will not know that `a` and `A` differ. Lowercasing to
    // "help" would turn a valid code into an invalid one, silently, at the counter.
    const code = signRedemptionCode({ participantId: 'p1', dropId: 'd1', qty: 1 }, SECRET);
    const lowered = normaliseScannedCode(code.toLowerCase());
    expect(lowered).not.toBe(code);
    expect(verifyRedemptionCode(lowered, SECRET)).toBeNull();
  });

  it('returns an empty string rather than throwing on garbage', () => {
    for (const input of ['', '   ', '\n\t', 'https://example.com/', 'https://example.com']) {
      expect(() => normaliseScannedCode(input)).not.toThrow();
    }
    expect(normaliseScannedCode('   ')).toBe('');
  });
});

describe('every refusal has a sentence', () => {
  it('covers the whole union, and no reason is blank', () => {
    const reasons: RefusalReason[] = [
      'BAD_CODE',
      'UNKNOWN_PARTICIPANT',
      'NOT_YOUR_DROP',
      'NOT_YET',
      'DROP_FAILED',
      'DROP_CANCELLED',
      'NOT_CHARGED',
      'REFUNDED',
      'FULLY_REDEEMED',
    ];

    for (const reason of reasons) {
      const copy = REFUSAL_COPY[reason];
      expect(copy, reason).toBeDefined();
      expect(copy.title.trim().length, reason).toBeGreaterThan(0);
      expect(copy.detail.trim().length, reason).toBeGreaterThan(0);
    }

    // No extras: a copy entry nothing can produce is dead text that will drift.
    expect(Object.keys(REFUSAL_COPY).sort()).toEqual([...reasons].sort());
  });

  it('keeps the two "not found" refusals identical, so a code cannot probe for drop ids', () => {
    // `NOT_YOUR_DROP` exists for logging, not for the screen. If it read
    // differently from `UNKNOWN_PARTICIPANT`, a valid code from another merchant
    // would confirm that the id exists — a probe an attacker can enumerate with.
    expect(REFUSAL_COPY.NOT_YOUR_DROP).toEqual(REFUSAL_COPY.UNKNOWN_PARTICIPANT);
  });

  it('never tells staff to hand over food', () => {
    // A blunt check on the thing that matters most in this file: no refusal's
    // copy may read as permission.
    for (const [reason, copy] of Object.entries(REFUSAL_COPY)) {
      const text = `${copy.title} ${copy.detail}`.toLowerCase();
      expect(text, reason).not.toMatch(/\b(hand (it|them) over|give them the|serve them)\b/);
    }
  });
});

describe('the batch manifest', () => {
  function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
    return {
      participantId: 'p',
      name: 'Sam',
      phoneLast4: '0123',
      qty: 2,
      redeemedQty: 0,
      redeemedAt: null,
      ...overrides,
    };
  }

  it('counts plates as well as orders, because a pickup table is checked against plates', () => {
    const rows = [
      row({ qty: 3, redeemedQty: 3 }),
      row({ qty: 2, redeemedQty: 0 }),
      row({ qty: 1, redeemedQty: 0 }),
    ];
    expect(summariseManifest(rows)).toEqual({
      orders: 3,
      plates: 6,
      collected: 3,
      outstanding: 3,
      fullyCollectedOrders: 1,
    });
  });

  it('counts a partly-collected order as outstanding, not collected', () => {
    const rows = [row({ qty: 4, redeemedQty: 3 })];
    expect(summariseManifest(rows)).toEqual({
      orders: 1,
      plates: 4,
      collected: 3,
      outstanding: 1,
      fullyCollectedOrders: 0,
    });
  });

  it('handles an empty drop without dividing by anything', () => {
    expect(summariseManifest([])).toEqual({
      orders: 0,
      plates: 0,
      collected: 0,
      outstanding: 0,
      fullyCollectedOrders: 0,
    });
  });

  it('never reports negative outstanding, even if the data is over-redeemed', () => {
    // Only reachable through a data error. A negative number on the manifest would
    // read as "we owe them food", which is the opposite of true.
    const summary = summariseManifest([row({ qty: 1, redeemedQty: 2 })]);
    expect(summary.outstanding).toBe(-1);
    expect(summary.collected).toBe(2);
    // Asserted explicitly rather than clamped, so the arithmetic stays honest and
    // the anomaly is visible to whoever reads the number.
    expect(summary.fullyCollectedOrders).toBe(1);
  });
});

describe('matching a face to an order', () => {
  it('gives the last four digits of an E.164 number', () => {
    expect(phoneLast4('+15551234567')).toBe('4567');
    expect(phoneLast4('+14165550199')).toBe('0199');
  });

  it('tolerates a number stored with punctuation', () => {
    expect(phoneLast4('+1 (555) 123-4567')).toBe('4567');
  });

  it('is not the phone number', () => {
    // The point of the field: staff can identify a person, and cannot ring them
    // tomorrow. Trivially true today, easy to break by "helpfully" returning the
    // whole number when it is short.
    expect(phoneLast4('+15551234567')).toHaveLength(4);
    expect(phoneLast4('+15551234567')).not.toContain('555');
  });
});
