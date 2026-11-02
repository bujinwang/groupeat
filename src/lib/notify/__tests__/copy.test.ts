import { describe, expect, it } from 'vitest';

import {
  cardDeclinedSms,
  dropConfirmedChargedSms,
  dropFailedNoChargeSms,
  dropFailedRefundedSms,
  joinConfirmationSms,
  stillFillingSms,
  windowLabel,
} from '../copy';

/**
 * The words a diner reads, at the moment money moves.
 *
 * ## What these tests are for
 *
 * There was no message copy in this repo before this module, so nothing here is a
 * regression test in the usual sense — there is no previous behaviour to preserve.
 * They are **contract** tests: they pin the properties that make a message safe to
 * send, so a later edit that breaks one fails here rather than on a diner's phone.
 *
 * Four properties, applied to every message below:
 *
 *   1. **No unformatted number.** A `26.2`, a `2620`, or a raw ISO timestamp in a
 *      body is a bug that reads as a message. Asserted by requiring `formatCents`
 *      output and rejecting the raw forms.
 *   2. **No `undefined`, `NaN`, `null` or `[object`.** These are how a template bug
 *      announces itself to a stranger. The confirmation page shipped "undefined" once
 *      already; a text message is worse, because it cannot be fixed by a deploy.
 *   3. **The link, when present, is the only URL-ish thing** and it is the one passed
 *      in — never one invented here.
 *   4. **Every message is under the SMS limit** so nothing is truncated in the sender
 *      (which would cut a redemption code in half).
 */
const FORBIDDEN = /\bundefined\b|\bNaN\b|\bnull\b|\[object|Infinity/;

function expectClean(body: string): void {
  expect(body).not.toMatch(FORBIDDEN);
  // No raw ISO instant: a message must never contain a machine timestamp.
  expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  // Sanity: an SMS with no letters is not a message.
  expect(body).toMatch(/[a-z]{3}/);
}

describe('windowLabel', () => {
  it('names one weekday and both clock times', () => {
    const label = windowLabel(
      new Date('2027-07-15T18:00:00Z'),
      new Date('2027-07-15T20:00:00Z'),
      'America/Edmonton',
    );

    expect(label).toBe('Thursday 12:00 PM–2:00 PM');
  });

  it('takes the weekday from the start, even when the window crosses midnight', () => {
    // A late pickup is still "Friday evening" to the person collecting, and printing
    // two weekdays would read as two separate pickups.
    const label = windowLabel(
      new Date('2027-07-17T05:30:00Z'),
      new Date('2027-07-17T07:00:00Z'),
      'America/Edmonton',
    );

    expect(label.startsWith('Friday ')).toBe(true);
  });

  it('uses the merchant zone, not the server zone', () => {
    // The same instant in two kitchens. If this function ignored its `timeZone`
    // argument both would print the same string.
    const start = new Date('2027-07-15T03:00:00Z');
    const end = new Date('2027-07-15T05:00:00Z');

    expect(windowLabel(start, end, 'Asia/Tokyo')).toBe('Thursday 12:00 PM–2:00 PM');
    expect(windowLabel(start, end, 'America/Edmonton')).toBe('Wednesday 9:00 PM–11:00 PM');
  });
});

describe('joinConfirmationSms — FR-408', () => {
  const base = {
    qty: 2,
    amountCents: 2620,
    cutoffLabel: 'Thursday 1:00 PM',
    orderPath: '/d/ABCD2345/mine?t=p1.abc',
    phone: '+17805550123',
  };

  it('says what was held, what it costs, and that nothing is charged yet', () => {
    const message = joinConfirmationSms(base);

    expectClean(message.body);
    expect(message.body).toContain('2 plates');
    expect(message.body).toContain('$26.20');
    // The sentence that stops a diner thinking they have been charged.
    expect(message.body).toContain('Nothing is charged');
    expect(message.body).toContain('Thursday 1:00 PM');
    expect(message.kind).toBe('JOIN_CONFIRMATION');
  });

  it('formats the amount rather than printing cents', () => {
    const message = joinConfirmationSms(base);

    expect(message.body).toContain('$26.20');
    expect(message.body).not.toContain('2620');
  });

  it('says "plate", not "plates", for a single plate', () => {
    expect(joinConfirmationSms({ ...base, qty: 1 }).body).toContain('1 plate for');
  });

  it('prefers the absolute URL and falls back to the path', () => {
    const absolute = joinConfirmationSms({ ...base, orderUrl: 'https://groupeat.ca/d/X/mine' });
    expect(absolute.body).toContain('https://groupeat.ca/d/X/mine');

    // With no absolute URL the path is used — truthful, if not tappable. Inventing
    // an origin here is the bug `public-origin.ts` exists to prevent.
    const relative = joinConfirmationSms(base);
    expect(relative.body).toContain('/d/ABCD2345/mine');
    expect(relative.body).not.toContain('http');
  });

  it('never contains the redemption code, only the link to it', () => {
    // The code is the food. A message is an archive, a browser history, and possibly
    // a link-preview fetcher's log.
    const message = joinConfirmationSms(base);

    expect(message.body).not.toMatch(/v1\.[A-Za-z0-9_-]{20,}/);
  });
});

describe('dropConfirmedChargedSms — FR-506', () => {
  const base = {
    chargedCents: 2620,
    qty: 2,
    redemptionCode: 'v1.payload.signature',
    windowStart: new Date('2027-07-15T18:00:00Z'),
    windowEnd: new Date('2027-07-15T20:00:00Z'),
    timeZone: 'America/Edmonton',
    phone: '+17805550123',
  };

  it('leads with the amount, because this is when money moves', () => {
    const message = dropConfirmedChargedSms(base);

    expectClean(message.body);
    expect(message.body.startsWith('Charged $26.20')).toBe(true);
  });

  it('carries the code even when there is a link', () => {
    // The link is convenience; the code is what works when the phone is dead or the
    // message was forwarded to whoever is collecting.
    const message = dropConfirmedChargedSms({
      ...base,
      orderUrl: 'https://groupeat.ca/d/ABCD/mine',
    });

    expect(message.body).toContain('v1.payload.signature');
    expect(message.body).toContain('https://groupeat.ca/d/ABCD/mine');
  });

  it('names the pickup window in the merchant zone', () => {
    const message = dropConfirmedChargedSms(base);

    expect(message.body).toContain('Thursday 12:00 PM–2:00 PM');
  });

  it('makes no claim about a link when there is none', () => {
    const message = dropConfirmedChargedSms(base);

    expect(message.body).not.toContain('http');
    expect(message.body).not.toMatch(/link|Details:/i);
    // …and the code is still there, which is the whole point of sending it.
    expect(message.body).toContain('Your code: v1.payload.signature');
  });
});

describe('the failure messages', () => {
  it('dropFailedNoChargeSms states plainly that nobody was charged', () => {
    // FR-306 makes this mandatory, and this is the message where it matters most.
    const message = dropFailedNoChargeSms({ qty: 2, phone: '+17805550123' });

    expectClean(message.body);
    expect(message.body).toContain('Nobody was charged');
    expect(message.body).toContain('cost you nothing');
  });

  it('dropFailedRefundedSms does not say "nobody was charged"', () => {
    // A diner whose statement shows a charge and a credit, told "nobody was charged",
    // reports fraud. The two failure kinds are different facts.
    const message = dropFailedRefundedSms({
      chargedCents: 2620,
      qty: 2,
      phone: '+17805550123',
    });

    expectClean(message.body);
    expect(message.body).not.toContain('Nobody was charged');
    expect(message.body).toContain('refunded in full');
    expect(message.body).toContain('$26.20');
    // The honest caveat: we refund immediately, the bank does not.
    expect(message.body).toContain('business days');
  });

  it('cardDeclinedSms does not blame the diner or promise a retry', () => {
    const message = cardDeclinedSms({ qty: 1, phone: '+17805550123' });

    expectClean(message.body);
    expect(message.body).toContain('declined');
    expect(message.body).toContain('have not been charged');
    // There is no retry flow in this build, so it must not promise one.
    expect(message.body).not.toMatch(/try again|retry|we will attempt/i);
  });
});

describe('stillFillingSms — ADR-003', () => {
  it('says it is going ahead and still filling, and names the cutoff', () => {
    const message = stillFillingSms({
      cutoffLabel: 'Thursday 1:00 PM',
      phone: '+17805550123',
    });

    expectClean(message.body);
    expect(message.body).toContain('going ahead');
    expect(message.body).toContain('still open');
    expect(message.body).toContain('Thursday 1:00 PM');
    // Nothing has been charged at this point, and the diner must know that.
    expect(message.body).toContain('nothing is charged');
  });
});

describe('every message', () => {
  it('is short enough not to be truncated by the sender', () => {
    // Truncation can cut a redemption code in half, and a half-code scans as valid
    // and is not. The sender enforces the limit, but a composer that routinely
    // exceeds it is the bug — so it is asserted here, at the source.
    const longestCode = `v1.${'A'.repeat(120)}.${'B'.repeat(43)}`;
    const messages = [
      joinConfirmationSms({
        qty: 20,
        amountCents: 999999,
        cutoffLabel: 'Wednesday 11:00 PM',
        orderPath: `/d/ABCD2345/mine?t=p1.${'x'.repeat(150)}`,
        orderUrl: `https://groupeat.ca/d/ABCD2345/mine?t=p1.${'x'.repeat(150)}`,
        phone: '+17805550123',
      }),
      dropConfirmedChargedSms({
        chargedCents: 999999,
        qty: 20,
        redemptionCode: longestCode,
        windowStart: new Date('2027-07-15T18:00:00Z'),
        windowEnd: new Date('2027-07-15T20:00:00Z'),
        timeZone: 'America/Edmonton',
        orderUrl: `https://groupeat.ca/d/ABCD2345/mine?t=p1.${'x'.repeat(150)}`,
        phone: '+17805550123',
      }),
      cardDeclinedSms({ qty: 20, phone: '+17805550123' }),
      dropFailedNoChargeSms({ qty: 20, phone: '+17805550123' }),
      dropFailedRefundedSms({ chargedCents: 999999, qty: 20, phone: '+17805550123' }),
      stillFillingSms({ cutoffLabel: 'Wednesday 11:00 PM', phone: '+17805550123' }),
    ];

    for (const message of messages) {
      expect(message.body.length, `${message.kind} is ${message.body.length} chars`).toBeLessThan(
        1600,
      );
    }
  });

  it('carries the phone number the caller supplied, verbatim', () => {
    // The sender posts this to the provider. A composer that reformatted it would
    // be a second phone normaliser, and the second one is always the wrong one.
    const e164 = '+17805550123';

    expect(joinConfirmationSms({
      qty: 1,
      amountCents: 100,
      cutoffLabel: 'Thursday 1:00 PM',
      orderPath: '/d/A/mine?t=p1.x',
      phone: e164,
    }).phone).toBe(e164);

    expect(dropFailedNoChargeSms({ qty: 1, phone: e164 }).phone).toBe(e164);
  });
});
