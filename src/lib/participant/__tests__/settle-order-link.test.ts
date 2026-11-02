import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { verifyParticipantAccess } from '@/lib/participant/access';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import { settle } from '@/lib/settlement/settle';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The link in the charged message carries the same token the page verifies.
 *
 * ## The gap this closes
 *
 * `order-page.test.ts` proves `orderUrl` builds a link that verifies. `settle.test.ts`
 * proves settlement emits `DROP_CONFIRMED_CHARGED` with the right money. Neither
 * proves the two are wired together — the intent could carry the code and no link,
 * or a link built against the wrong public code, or a link for the participant on the
 * row *before* it. That wiring is a single spread expression in `buildCapturedIntents`
 * and it is exactly the kind of line that is silently dropped in a refactor.
 *
 * So this file settles a real drop and hands the emitted intent's `orderUrl` back to
 * `verifyParticipantAccess`, which is what the page does. If the link does not
 * resolve, a diner's SMS points at a 404 and nothing else in the suite would say so.
 *
 * ## And the case where there is no link
 *
 * `baseUrl` is optional. Absent, the intent must still be emitted — with the code and
 * no URL — because a message that cannot carry a link is still a message that has to
 * tell a diner their card was charged. The test asserts the key is absent rather than
 * `undefined`, so a sender can branch on `'orderUrl' in intent` without ambiguity.
 */

const PREFIX = `nl${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

type Recorder = NotifyPort & { readonly intents: NotifyIntent[] };

function recordingNotify(): Recorder {
  const intents: NotifyIntent[] = [];
  return {
    intents,
    async notify(batch) {
      intents.push(...batch);
    },
  };
}

async function lockedDrop(minQty: number): Promise<{ dropId: string; publicCode: string }> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty,
    status: 'LOCKED',
    lockedAt: new Date(Date.now() - 60_000),
  });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { publicCode: true },
  });
  return { dropId, publicCode: row.publicCode };
}

function chargedIntents(notify: Recorder): Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }>[] {
  return notify.intents.filter(
    (intent): intent is Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }> =>
      intent.kind === 'DROP_CONFIRMED_CHARGED',
  );
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('the charged intent carries a working link', () => {
  it('emits a link per participant that verifies to that participant', async () => {
    const { dropId, publicCode } = await lockedDrop(2);
    const first = await fx.participant({ dropId, qty: 2 });
    const second = await fx.participant({ dropId, qty: 1 });

    const notify = recordingNotify();
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify,
      baseUrl: 'https://groupeat.example',
    });
    expect(outcome.kind).toBe('CAPTURED');

    const charged = chargedIntents(notify);
    expect(charged).toHaveLength(2);

    for (const intent of charged) {
      expect(intent.orderUrl).toBeTruthy();
      const url = new URL(intent.orderUrl ?? '');

      expect(url.origin).toBe('https://groupeat.example');
      expect(url.pathname).toBe(`/d/${publicCode}/mine`);

      // The link must resolve to the participant it was sent to — not to whichever
      // row the loop happened to be on.
      const payload = verifyParticipantAccess(url.searchParams.get('t') ?? '');
      expect(payload).toEqual({ participantId: intent.participantId, dropId });
    }

    // Both participants got distinct links.
    const tokens = charged.map((intent) => new URL(intent.orderUrl ?? '').searchParams.get('t'));
    expect(new Set(tokens).size).toBe(2);
    expect(new Set([first, second]).size).toBe(2);
  });

  it('omits the key entirely when no public origin was supplied', async () => {
    // The sender must be able to tell "no link" from "an empty link" without a truthiness
    // test that would also catch a legitimately empty string. No `baseUrl` here — the
    // production shape until `/api/jobs/cutoff` is given one.
    const { dropId } = await lockedDrop(2);
    await fx.participant({ dropId, qty: 2 });

    const notify = recordingNotify();
    await settle({ dropId, now: new Date(), port: fakeChargePort(), notify });

    const charged = chargedIntents(notify);
    expect(charged).toHaveLength(1);
    expect('orderUrl' in (charged[0] ?? {})).toBe(false);
    // The code itself is still there: the message is still worth sending.
    expect(charged[0]?.redemptionCode).toBeTruthy();
  });

  it('does not put the redemption code in the link', async () => {
    // Snapshot into a string and look for the code, because this is the mistake that
    // would be invisible in review: `orderUrl` and `redemptionCode` sit two lines
    // apart in `buildCapturedIntents`.
    const { dropId } = await lockedDrop(2);
    await fx.participant({ dropId, qty: 2 });

    const notify = recordingNotify();
    await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify,
      baseUrl: 'https://groupeat.example',
    });

    const intent = chargedIntents(notify)[0];
    expect(intent?.orderUrl).toBeTruthy();
    expect(intent?.redemptionCode).toBeTruthy();
    expect(intent?.orderUrl).not.toContain(intent?.redemptionCode ?? '');

    // And the token is the participant-access version, not the redemption version.
    const token = new URL(intent?.orderUrl ?? '').searchParams.get('t') ?? '';
    expect(token.startsWith('p1.')).toBe(true);
    expect(intent?.redemptionCode?.startsWith('v1.')).toBe(true);
  });

  it('never emits a link for a declined card', async () => {
    // A diner whose card was declined has no food and no code, so a link would point
    // at a page with nothing on it — and, worse, teach them there is an order to see.
    //
    // The drop has to *succeed* for this intent to exist at all: `minQty` 2 is met by
    // the first participant, so the second diner's decline is the
    // captured-with-one-declined case rather than a failed drop. (A drop where the
    // only card declines is `BELOW_CAPTURE_TOLERANCE` and emits
    // `DROP_FAILED_NO_CHARGE` instead — asserting the decline intent there would be
    // asserting a message this codebase correctly does not send.)
    const { dropId } = await lockedDrop(2);
    await fx.participant({ dropId, qty: 2 });
    const declinedId = await fx.participant({ dropId, qty: 1 });

    const notify = recordingNotify();
    const outcome = await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort({ declineParticipantIds: [declinedId] }),
      notify,
      baseUrl: 'https://groupeat.example',
    });
    expect(outcome.kind).toBe('CAPTURED');

    const declined = notify.intents.filter((intent) => intent.kind === 'DROP_CONFIRMED_CARD_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]).not.toHaveProperty('orderUrl');
    expect(declined[0]).not.toHaveProperty('redemptionCode');

    // The diner whose card worked still gets a link.
    const charged = chargedIntents(notify);
    expect(charged).toHaveLength(1);
    expect(charged[0]?.orderUrl).toBeTruthy();
  });
});
