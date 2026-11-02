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
    // asserting the wrong thing. Three of the five intents name no time, so a batch
    // guard meant one zone-threading bug silenced `DROP_FAILED_NO_CHARGE` — the
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
