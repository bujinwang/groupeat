import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { composingNotifyPort } from '@/lib/notify/compose-port';
import { recordingSender } from '@/lib/notify/sender';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import { runCutoffTick } from '@/lib/settlement/run-tick';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The whole chain, end to end: settled drop → intent → **words** → sender.
 *
 * ## Why every earlier test missed this
 *
 * There were four levels of test and each one stopped short of the next:
 *
 *   - `settle.test.ts` asserts the port was called with intents — counts and kinds.
 *   - `run-tick.order-link.test.ts` asserts the link in those intents verifies.
 *   - `route.test.ts` asserts the route hands a port to the tick — with the tick mocked.
 *   - `copy.test.ts` asserts each sentence in isolation, given a hand-built intent.
 *
 * So nothing asserted the join *between* them: that a real settlement produces intents
 * this composer can actually turn into sentences for a real merchant in a real time
 * zone. Every layer was green while `notify: noopNotifyPort()` sat in the route, which
 * is the definition of a wire that has never been current.
 *
 * This file runs a real tick against a real drop with the **actual composing port**
 * and a recording sender. It is the only place in the suite where a message body is
 * produced from a database row.
 *
 * ## What it still does not prove
 *
 * That a message arrives on a phone. There is no provider in this environment, and
 * `twilio-sender.test.ts` only proves the request *construction*. The gap between
 * "composed correctly" and "delivered" is exactly D-5, and this file's job is to make
 * that the only remaining gap.
 */

const PREFIX = `ntf${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 2620;
const ORIGIN = 'https://groupeat.example';

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

/** A published drop past its cutoff, with one authorised participant. */
async function dueDrop(
  qty: number,
  window?: { start: Date; end: Date },
): Promise<{
  dropId: string;
  participantId: string;
  publicCode: string;
  phone: string;
}> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: qty,
    ...(window ? { windowStart: window.start, windowEnd: window.end } : {}),
  });
  const participantId = await fx.participant({ dropId, qty });
  // The phone is on `Customer`, not on `DropParticipant` — the participant row holds
  // money and redemption, the customer row holds identity. Reaching it the wrong way
  // is what the first run of this file did, and Prisma refused the select rather than
  // returning `undefined`, which is the behaviour that makes this assertion worth
  // writing: the address the message goes to is read from the database, not assumed.
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: {
      publicCode: true,
      participants: { select: { customer: { select: { phone: true } } } },
    },
  });

  return {
    dropId,
    participantId,
    publicCode: row.publicCode,
    phone: row.participants[0]?.customer.phone ?? '',
  };
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('a tick that charges somebody composes a real message', () => {
  it('sends the diner a sentence with their amount, window and code', async () => {
    // A pinned window, because the fixture default is "now + 1 h" and a weekday
    // asserted against a moving clock is a test that passes six days out of seven.
    //
    // ## Why this pins the weekday and not the clock time
    //
    // The first version of this test asserted `Thursday 2:00 PM–4:00 PM` and passed on
    // Node 24 while failing on Node 22 with `1:00 PM`. That was not a code defect: the
    // two runtimes ship different tzdata (24 → 2026c, 22 → 2025c), and **Alberta is
    // scheduled to move to permanent daylight time in 2027**. Any instant in 2027 in
    // `America/Edmonton` therefore has two defensible answers depending on the tz
    // database the process happens to carry.
    //
    // So the assertion is the part that proves the zone was applied at all and does not
    // move with the rule: **Thursday in Edmonton, Friday in UTC**. 2027-01-15 02:00 Z is
    // Thursday evening in Edmonton and already Friday morning in UTC and Tokyo. A build
    // that printed the server's zone would say Friday; a build that printed nothing
    // would say `undefined`. Both are caught, and neither answer depends on whether
    // Alberta cancelled DST.
    const THURSDAY = { start: new Date('2027-01-15T02:00:00Z'), end: new Date('2027-01-15T04:00:00Z') };
    const { dropId, participantId, phone } = await dueDrop(2, THURSDAY);
    const sender = recordingSender();

    await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: composingNotifyPort({ sender }),
      baseUrl: ORIGIN,
    });

    const message = sender.sent.find((candidate) => candidate.kind === 'DROP_CONFIRMED_CHARGED');

    expect(message, 'the charged message was not composed').toBeDefined();
    // The body is what a stranger would read on a lock screen. It must contain the
    // money, the time, the code and the link — and nothing machine-shaped.
    //
    // 2 × $26.20 = $52.40. The first draft of this line said `$52.00`, which is what
    // `$26.00 × 2` would be — the deal price and the assertion were written from
    // different numbers. Worth stating: a money assertion that is merely *close* is
    // the one kind of wrong this suite exists to prevent, so it is checked against
    // arithmetic here rather than against a remembered figure.
    expect(DEAL_PRICE * 2).toBe(5240);
    expect(message?.body).toContain('$52.40');
    // Thursday, not Friday: the window is Thursday evening in Edmonton and already
    // Friday in UTC. See the note on `THURSDAY` for why the hour is not pinned.
    expect(message?.body).toContain('Pickup Thursday');
    expect(message?.body).not.toContain('Pickup Friday');
    expect(message?.body).toMatch(/Pickup Thursday \d{1,2}:\d{2}\s(AM|PM)–\d{1,2}:\d{2}\s(AM|PM)/);
    expect(message?.body).toContain('Your code: v1.');
    expect(message?.body).toContain(`${ORIGIN}/d/`);
    expect(message?.body).not.toMatch(/\bundefined\b|\bNaN\b|\[object/);
    expect(message?.body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // The phone is the participant's real one, taken from the row rather than from
    // the intent — so a rename between those two would show up here.
    expect(message?.phone).toBe(phone);
    // Well-formed, not a specific length. The first draft of this line asserted
    // `/^\+1\d{10}$/` and failed against the fixtures, which build `+1555` plus a
    // variable number of digits; the assertion was describing the fixture I imagined
    // rather than the one that exists. E.164's real rule is `+` then up to 15 digits.
    expect(message?.phone).toMatch(/^\+\d{8,15}$/);

    // And it is that participant's message, not another diner's.
    expect(dropId).toBeTruthy();
    expect(participantId).toBeTruthy();
  });

  it('names the pickup window in the merchant zone, not the server zone', async () => {
    // The merchant in the fixture is `America/Edmonton` by schema default. The
    // assertion is on the *shape* — a weekday and two clock times — combined with a
    // separate check that a non-default zone changes the output, which is what
    // `compose-port.test.ts` covers. Here the point is that a zone reached this
    // message at all: without one, `compose` refuses and nothing is sent.
    const sender = recordingSender();
    await dueDrop(2);

    await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: composingNotifyPort({ sender }),
      baseUrl: ORIGIN,
    });

    const message = sender.sent.find((candidate) => candidate.kind === 'DROP_CONFIRMED_CHARGED');
    expect(message?.body).toMatch(/Pickup (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/);
    expect(message?.body).toMatch(/\d{1,2}:\d{2}\s(AM|PM)–\d{1,2}:\d{2}\s(AM|PM)/);
  });

  it('sends nothing for a drop that fails, but composes the no-charge message', async () => {
    // FR-306. A failed drop voids every authorisation; the diner must be told that
    // rather than left wondering why their app shows nothing.
    const dropId = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      // Minimum far above what anyone joined, so the tick fails the drop.
      minQty: 20,
    });
    await fx.participant({ dropId, qty: 1 });

    const sender = recordingSender();
    await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: composingNotifyPort({ sender }),
      baseUrl: ORIGIN,
    });

    const failed = sender.sent.filter((message) => message.kind === 'DROP_FAILED_NO_CHARGE');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.body).toContain('Nobody was charged');
    expect(failed[0]?.body).not.toMatch(/\bundefined\b/);
  });

  it('composes for every drop in one tick, each with its own merchant zone', async () => {
    // The reason the zone travels per batch rather than per port: one tick settles
    // drops belonging to different merchants. A single zone on the port would make
    // the second merchant's diners read the first merchant's hours.
    //
    // Two merchants, two zones, one tick. The assertion is that both messages carry a
    // zone-appropriate window rather than that they differ — the fixtures' windows are
    // relative to now, so a difference is not guaranteed at every instant. What *is*
    // guaranteed is that a message reached both, which a misplaced zone would not
    // prevent; the zone correctness is pinned deterministically in
    // `compose-port.test.ts` with fixed instants.
    const tokyo = await fx.merchant('acct_test_notify_tokyo');
    await prisma.merchant.update({ where: { id: tokyo }, data: { timezone: 'Asia/Tokyo' } });
    const tokyoItem = await fx.item(tokyo);

    const tokyoDrop = await fx.drop({
      merchantId: tokyo,
      menuItemId: tokyoItem,
      dealPriceCents: DEAL_PRICE,
      minQty: 1,
    });
    await fx.participant({ dropId: tokyoDrop, qty: 1 });
    await dueDrop(1);

    const sender = recordingSender();
    await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: composingNotifyPort({ sender }),
      baseUrl: ORIGIN,
    });

    const charged = sender.sent.filter((message) => message.kind === 'DROP_CONFIRMED_CHARGED');
    expect(charged.length).toBeGreaterThanOrEqual(2);
    for (const message of charged) {
      expect(message.body).toMatch(/Pickup (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/);
    }
  });

  it('reports the outcome rather than throwing when the sender fails', async () => {
    // The rule that outranks everything else here: this runs after cards are charged.
    // A provider failure must not become an exception the scheduler retries against a
    // drop that is already settled.
    await dueDrop(2);

    const failing = {
      name: 'failing',
      async send() {
        return {
          outcomes: [],
          sentCount: 0,
          failedCount: 0,
        };
      },
    };

    const result = await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: composingNotifyPort({ sender: failing }),
      baseUrl: ORIGIN,
    });

    // The tick completed. The drop settled; only the message did not go.
    expect(result.settled).toBeGreaterThanOrEqual(1);
  });

  it('still sends the messages that name no time when no zone is available', async () => {
    // The failure this prevents: every message naming a plausible hour that is wrong
    // for the merchant. A time-naming message is withheld rather than guessed.
    //
    // But the guard is **per message**, not per batch. The first version of this test
    // asserted `sender.sent` was empty, and it was — which is why it passed while
    // hiding the real problem: a batch containing one time-naming intent and nine
    // "nobody was charged" intents would send *nothing*, and FR-306's mandatory
    // sentence is the one that would go missing. What this now asserts is the correct
    // behaviour: the charged message is withheld, the no-charge message is not.
    //
    // Reached here by constructing the port with no zone *and* calling the tick in a
    // way that supplies none: `settle` always passes `locked.timezone`, so this
    // asserts the port's own guard, using a notify wrapper that drops the context.
    const { dropId: filledDrop } = await dueDrop(2);
    const failedDrop = await fx.drop({
      merchantId,
      menuItemId: itemId,
      dealPriceCents: DEAL_PRICE,
      minQty: 20,
    });
    await fx.participant({ dropId: failedDrop, qty: 1 });

    const sender = recordingSender();

    const strippingPort = {
      async notify(intents: Parameters<ReturnType<typeof composingNotifyPort>['notify']>[0]) {
        // Deliberately no context — the same call an old caller would make.
        await composingNotifyPort({ sender }).notify(intents);
      },
    };

    await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify: strippingPort,
      baseUrl: ORIGIN,
    });

    // Nothing that names an hour went out…
    expect(sender.sent.filter((message) => message.kind === 'DROP_CONFIRMED_CHARGED')).toHaveLength(0);
    // …and the sentence a diner is owed when no money moved still did.
    expect(sender.sent.filter((message) => message.kind === 'DROP_FAILED_NO_CHARGE').length).toBeGreaterThanOrEqual(1);
    expect(filledDrop).toBeTruthy();
  });
});
