import { describe, expect, it } from 'vitest';

import { compose, composingNotifyPort, joinConfirmationMessage } from '../compose-port';
import { recordingSender, type NotificationSender } from '../sender';
import type { NotifyIntent } from '@/lib/settlement/notify-port';

/**
 * The bridge: intent → words → sender.
 *
 * ## The two properties that matter
 *
 *   1. **Every intent kind produces a message.** Not "the four I remembered" — the
 *      `never` check in `compose()` makes a new kind a compile error, and this file
 *      asserts it at runtime too, because a `switch` with a `never` in the default
 *      can still be defeated by a cast.
 *   2. **`notify()` never throws.** It is called after cards have been charged. A
 *      sender that rejects must produce a log line, not an exception that becomes a
 *      500 and a scheduler retry on a settled drop.
 */

const TZ = 'America/Edmonton';

function chargedIntent(overrides: Partial<Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }>> = {}) {
  return {
    kind: 'DROP_CONFIRMED_CHARGED' as const,
    dropId: 'drop-1',
    participantId: 'p-1',
    phone: '+17805550123',
    chargedCents: 2620,
    qty: 2,
    redemptionCode: 'v1.payload.signature',
    orderUrl: 'https://groupeat.ca/d/ABCD/mine?t=p1.x',
    windowStart: new Date('2027-07-15T18:00:00Z'),
    windowEnd: new Date('2027-07-15T20:00:00Z'),
    ...overrides,
  };
}

const ALL_INTENTS: NotifyIntent[] = [
  chargedIntent(),
  {
    kind: 'DROP_CONFIRMED_CARD_DECLINED',
    dropId: 'drop-1',
    participantId: 'p-2',
    phone: '+17805550124',
    qty: 1,
  },
  {
    kind: 'DROP_FAILED_NO_CHARGE',
    dropId: 'drop-2',
    participantId: 'p-3',
    phone: '+17805550125',
    qty: 3,
  },
  {
    kind: 'DROP_FAILED_REFUNDED',
    dropId: 'drop-2',
    participantId: 'p-4',
    phone: '+17805550126',
    chargedCents: 3930,
    qty: 3,
  },
  {
    kind: 'THRESHOLD_REACHED_STILL_FILLING',
    dropId: 'drop-3',
    participantId: 'p-5',
    phone: '+17805550127',
    qty: 2,
    cutoffAt: new Date('2027-07-15T19:00:00Z'),
  },
  {
    kind: 'DROP_CANCELLED_REFUNDED',
    dropId: 'drop-4',
    participantId: 'p-6',
    phone: '+17805550128',
    chargedCents: 3930,
    qty: 3,
  },
  {
    kind: 'DROP_CANCELLED_NO_CHARGE',
    dropId: 'drop-4',
    participantId: 'p-7',
    phone: '+17805550129',
    qty: 3,
  },
];

describe('compose', () => {
  it('produces a message for every intent kind', () => {
    for (const intent of ALL_INTENTS) {
      const message = compose(intent, TZ);

      expect(message, `${intent.kind} produced no message`).not.toBeNull();
      expect(message?.kind).toBe(intent.kind);
      expect(message?.phone).toBe(intent.phone);
      expect(message?.body.length).toBeGreaterThan(20);
    }
  });

  it('names the pickup window only in the merchant zone', () => {
    // The zone is the argument. If `compose` ignored it, this would print one string
    // twice — which is what a defaulted zone would also do, silently and for every
    // merchant outside Alberta.
    const edmonton = compose(chargedIntent(), 'America/Edmonton');
    const tokyo = compose(chargedIntent(), 'Asia/Tokyo');

    expect(edmonton?.body).toContain('Thursday 12:00 PM–2:00 PM');
    expect(tokyo?.body).toContain('Friday 3:00 AM–5:00 AM');
  });

  it('never puts a phone number or a body into a log-shaped string', () => {
    // Not a log assertion — a property of the composed text: the body must not echo
    // the phone back, because a message that repeats the number is a message that
    // makes the number forwardable in a screenshot.
    for (const intent of ALL_INTENTS) {
      const message = compose(intent, TZ);
      expect(message?.body).not.toContain(intent.phone);
    }
  });
});

describe('composingNotifyPort', () => {
  it('hands every composed message to the sender', async () => {
    const sender = recordingSender();
    const port = composingNotifyPort({ sender });

    await port.notify(ALL_INTENTS, { timeZone: TZ });

    expect(sender.sent).toHaveLength(ALL_INTENTS.length);
    expect(sender.sent.map((message) => message.kind)).toEqual(
      ALL_INTENTS.map((intent) => intent.kind),
    );
    expect(port.composed).toHaveLength(ALL_INTENTS.length);
  });

  it('withholds only the time-naming messages when there is no zone', async () => {
    // The failure mode this prevents: every message says a plausible hour that is
    // wrong for the merchant, and nobody notices because nothing errors.
    //
    // ## Why this is per message and not per batch
    //
    // This test used to assert `sender.sent` was empty, and it passed. It was
    // asserting the wrong thing. Five of the seven intents name no time (both
    // cancellation kinds were added after this sentence was first written), so a
    // batch guard meant one zone-threading bug silenced `DROP_FAILED_NO_CHARGE` — the
    // sentence FR-306 makes mandatory, the one that tells a diner their card was not
    // charged — while the guard's failure message said nothing was wrong with the
    // messages it had suppressed.
    //
    // The zone is withheld from the *message* that needs it, not from the diner who
    // needs to be told no money moved.
    const sender = recordingSender();
    // No `timeZone` on the port and none on the call.
    const port = composingNotifyPort({ sender });

    await port.notify(ALL_INTENTS);

    const sentKinds = sender.sent.map((message) => message.kind);
    expect(sentKinds).not.toContain('DROP_CONFIRMED_CHARGED');
    expect(sentKinds).not.toContain('THRESHOLD_REACHED_STILL_FILLING');
    expect(sentKinds).toEqual(
      expect.arrayContaining([
        'DROP_CONFIRMED_CARD_DECLINED',
        'DROP_FAILED_NO_CHARGE',
        'DROP_FAILED_REFUNDED',
      ]),
    );
    // Every message that did go out is time-free, which is the property that makes
    // the exemption safe rather than merely convenient.
    for (const message of sender.sent) {
      expect(message.body).not.toMatch(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/);
      expect(message.body).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    }
  });

  it('accepts a zone from the port when the call supplies none', async () => {
    // The join path composes this way: it has the zone from its own reservation and
    // never goes through a settlement tick.
    const sender = recordingSender();
    const port = composingNotifyPort({ sender, timeZone: TZ });

    await port.notify(ALL_INTENTS);

    expect(sender.sent).toHaveLength(ALL_INTENTS.length);
  });

  it('does not throw when the sender throws', async () => {
    // `NotificationSender.send` promises not to throw. If it breaks that promise, the
    // port must absorb it: this runs after money has moved, and an exception here
    // becomes a 500 that the scheduler retries against a settled drop.
    const exploding: NotificationSender = {
      name: 'exploding',
      async send() {
        throw new Error('provider exploded');
      },
    };

    const port = composingNotifyPort({ sender: exploding });

    await expect(port.notify(ALL_INTENTS, { timeZone: TZ })).resolves.toBeUndefined();
  });

  it('sends nothing and says nothing when there are no intents', async () => {
    const sender = recordingSender();
    const port = composingNotifyPort({ sender, timeZone: TZ });

    await port.notify([]);

    expect(sender.sent).toHaveLength(0);
  });

  it('composes but does not send in dry-run mode', async () => {
    const sender = recordingSender();
    const port = composingNotifyPort({ sender, timeZone: TZ, dryRun: true });

    await port.notify(ALL_INTENTS);

    expect(sender.sent).toHaveLength(0);
    // Still composed, so a test can assert the wording that *would* have gone out.
    expect(port.composed).toHaveLength(ALL_INTENTS.length);
  });
});

describe('joinConfirmationMessage — FR-408 consent gate', () => {
  const args = {
    qty: 2,
    amountCents: 2620,
    cutoffAt: new Date('2027-07-15T19:00:00Z'),
    timeZone: TZ,
    orderPath: '/d/ABCD/mine?t=p1.x',
    phone: '+17805550123',
  };

  it('is produced when the diner consented', () => {
    const message = joinConfirmationMessage({ ...args, consented: true });

    expect(message).not.toBeNull();
    expect(message?.body).toContain('You\'re in');
    expect(message?.body).toContain('$26.20');
  });

  it('is withheld when the diner did not consent', () => {
    // FR-408's acceptance is "only if consent captured". This message is the one
    // gated message in the product; settlement's outcome messages are transactional
    // and are not — see the docblock for why those two policies differ.
    expect(joinConfirmationMessage({ ...args, consented: false })).toBeNull();
  });

  it('names the cutoff in the merchant zone', () => {
    const message = joinConfirmationMessage({ ...args, consented: true });

    // 2027-07-15T19:00Z is 1:00 PM in Edmonton.
    expect(message?.body).toContain('Thursday 1:00 PM');
  });
});

describe('the refund sentence carries the intent it was given', () => {
  /**
   * `compose-port.ts:189-194` maps `DROP_FAILED_REFUNDED` into
   * `dropFailedRefundedSms`. The per-kind test above asserts `kind`, `phone` and
   * `body.length > 20`, so the mapping of `qty` and `chargedCents` was never in an
   * `expect` — a message could say "$0.01 charge for 1 plate" and still pass.
   *
   * Measured, by mutation, over the whole suite: replacing `qty` and `chargedCents`
   * in this case with `1` (phone left correct) left **200 files / 2648 tests** green
   * (`EXIT=0`). A three-field mutant that also replaced `phone` *was* caught, but only
   * by the per-kind `message.phone` assertion — `expected '+15550000000' to be
   * '+17805550126'`. So the address was guarded and the numbers were not.
   *
   * 3930 cents is $39.30; `qty: 3` must print "for 3 plates". Absolute figures, read
   * from the intent rather than from the production helper, so the guard is about the
   * mapping and not about `formatCents`.
   */
  it('prints that intent\'s own amount and plate count', () => {
    const intent: NotifyIntent = {
      kind: 'DROP_FAILED_REFUNDED',
      dropId: 'drop-2',
      participantId: 'p-4',
      phone: '+17805550126',
      chargedCents: 3930,
      qty: 3,
    };

    const message = compose(intent, TZ);
    expect(message?.body).toContain('$39.30');
    expect(message?.body).toContain('for 3 plates');
    expect(message?.body).not.toContain('for 1 plate');
    expect(message?.phone).toBe(intent.phone);
  });
});

describe('every other sentence prints the numbers its own intent carried', () => {
  /**
   * `copy.test.ts` calls the sentence builders **directly**, with its own qty and
   * amount arguments. It therefore cannot see a broken *mapping* in
   * `compose-port.ts`: the helper can be perfect while the case that feeds it hands
   * every diner `1` plate. The per-kind bridge test above pins `kind`, `phone` and
   * `body.length > 20`, so the words between were never in an `expect`.
   *
   * Per-line **full-suite** sweep (200 files / 2650 tests per run), one mapping
   * replaced by a constant at a time:
   *
   * | case | mutation | result |
   * |---|---|---|
   * | pristine control | — | passes, 2650 |
   * | `DROP_CONFIRMED_CARD_DECLINED` | `qty: 1` | **survives** |
   * | `DROP_FAILED_NO_CHARGE` | `qty: 1` | **survives** |
   * | `DROP_FAILED_REFUNDED` | `qty: 1`, `chargedCents: 1` | caught — the guard above |
   * | `DROP_CANCELLED_REFUNDED` | `qty: 1`, `chargedCents: 1` | **survives** |
   * | `DROP_CANCELLED_NO_CHARGE` | `qty: 1` | **survives** |
   *
   * The one sweep run that reported `DROP_CANCELLED_REFUNDED` as "caught" was a
   * **flake, not a guard**: the only failing test was
   * `organiser/commission/route.test.ts > carries no participant PII on the wire`,
   * which does not import compose at all. Its assertion
   * `not.toContain(customer.phone.slice(-4))` had failed on `"0001"` occurring inside
   * a hexadecimal dropId (`"c1e00018-…"`). Three repeat full-suite runs of that same
   * mutation all passed, so nothing guards that mapping. Both defects are fixed here
   * and in the commission test respectively.
   *
   * `ALL_INTENTS` also used to contain 5 of the 7 union members — neither
   * cancellation kind was in it — so the test named "produces a message for every
   * intent kind" did not. Both are added above. Absolute clauses, read from the
   * intent rather than from the helper, so a guard cannot pass by recomputing from
   * the same wrong value.
   */
  const cases: readonly {
    readonly name: string;
    readonly intent: NotifyIntent;
    readonly required: readonly string[];
    readonly forbidden: readonly string[];
  }[] = [
    {
      name: 'card declined',
      intent: {
        kind: 'DROP_CONFIRMED_CARD_DECLINED',
        dropId: 'drop-1',
        participantId: 'p-2',
        phone: '+17805550124',
        qty: 3,
      },
      required: ['your 3 plates could not be confirmed'],
      forbidden: ['1 plate'],
    },
    {
      name: 'drop missed its minimum',
      intent: {
        kind: 'DROP_FAILED_NO_CHARGE',
        dropId: 'drop-2',
        participantId: 'p-3',
        phone: '+17805550125',
        qty: 3,
      },
      required: ['your 3 plates cost you nothing'],
      forbidden: ['1 plate'],
    },
    {
      name: 'restaurant cancelled, money went back',
      intent: {
        kind: 'DROP_CANCELLED_REFUNDED',
        dropId: 'drop-4',
        participantId: 'p-6',
        phone: '+17805550128',
        chargedCents: 3930,
        qty: 3,
      },
      required: ['$39.30', 'charge for 3 plates has been refunded in full'],
      forbidden: ['$0.01', '1 plate'],
    },
    {
      name: 'restaurant cancelled before capture',
      intent: {
        kind: 'DROP_CANCELLED_NO_CHARGE',
        dropId: 'drop-4',
        participantId: 'p-7',
        phone: '+17805550129',
        qty: 3,
      },
      required: ['card for 3 plates is released'],
      forbidden: ['1 plate'],
    },
  ];

  for (const spec of cases) {
    it(`${spec.name}: the words quote the intent's own amount and plate count`, () => {
      const message = compose(spec.intent, TZ);
      expect(message, `${spec.intent.kind} produced no message`).not.toBeNull();
      for (const clause of spec.required) {
        expect(message?.body, `${spec.intent.kind} must print "${clause}"`).toContain(clause);
      }
      for (const clause of spec.forbidden) {
        expect(message?.body, `${spec.intent.kind} must not print "${clause}"`).not.toContain(clause);
      }
      expect(message?.phone).toBe(spec.intent.phone);
    });
  }
});

describe('the still-filling sentence names the cutoff its intent carried', () => {
  /**
   * `compose-port.ts:206-211` maps `THRESHOLD_REACHED_STILL_FILLING` into
   * `stillFillingSms({ cutoffLabel: momentLabel(intent.cutoffAt, timeZone), ... })`.
   * `copy.test.ts` calls `stillFillingSms` **directly** with a literal label, and the
   * per-kind bridge test above pins only `kind`, `phone` and `body.length > 20`. So
   * the one fact ADR-003 obliges this message to state was never traced from an intent
   * to the words.
   *
   * Measured: replacing `momentLabel(intent.cutoffAt, timeZone)` with
   * `momentLabel(new Date(0), timeZone)` left the **whole suite** green
   * (200 files / 2654 tests, `EXIT=0`). The `ALL_INTENTS` fixture's cutoff is
   * `2027-07-15T19:00Z`, which is **Thursday 1:00 PM** in `America/Edmonton`; the
   * epoch is **Wednesday 5:00 PM**. Both are absolute strings, computed from the
   * fixture date rather than from `momentLabel`, so the guard is about the mapping.
   *
   * The same instant is **Friday 4:00 AM** in `Asia/Tokyo` (the epoch there is
   * **Thursday 9:00 AM**), so a mapping that hardcodes either the words or the zone
   * fails too. Measured with `Intl.DateTimeFormat` directly, not by asking
   * `momentLabel` for the answer it is being tested for.
   */
  it('prints the intent\'s own cutoff, in the merchant zone', () => {
    const intent: NotifyIntent = {
      kind: 'THRESHOLD_REACHED_STILL_FILLING',
      dropId: 'drop-3',
      participantId: 'p-5',
      phone: '+17805550127',
      qty: 2,
      cutoffAt: new Date('2027-07-15T19:00:00Z'),
    };

    const message = compose(intent, TZ);
    expect(message, 'the still-filling intent must produce a message').not.toBeNull();
    expect(message?.body).toContain("until Thursday 1:00 PM,");
    expect(message?.body).not.toContain('Wednesday 5:00 PM');
    expect(message?.phone).toBe(intent.phone);

    // A second zone must move the words, or the mapping could be a constant that
    // happens to equal this fixture's label.
    const tokyo = compose(intent, 'Asia/Tokyo');
    expect(tokyo?.body).toContain('Friday 4:00 AM');
    expect(tokyo?.body).not.toContain('Thursday 9:00 AM');
  });
});
