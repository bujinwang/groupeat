import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyParticipantAccess } from '@/lib/participant/access';
import { prisma } from '@/lib/db/prisma';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';
import { runCutoffTick } from '@/lib/settlement/run-tick';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * The `baseUrl` travels the whole way: job argument → tick → settle → intent → link.
 *
 * ## Why the existing tests did not cover this
 *
 * `settle-order-link.test.ts` proves `settle` builds a good link when handed a
 * `baseUrl`. `route.test.ts` proves the route hands `publicOrigin()` to the tick —
 * but it mocks the tick, so it proves a call signature, not a link. Between those
 * two sits `runCutoffTick`, and the thing that can go wrong there is precisely a
 * dropped parameter: the argument is destructured once and passed once, two lines
 * apart, in a function with eight other things going on.
 *
 * That failure mode is invisible from every other angle. The tick still settles the
 * drop, the job still returns 200, the charged intent still carries the code — only
 * `orderUrl` is missing, and only the diner notices. So this file runs a **real**
 * tick against a **real** drop and inspects what came out of the notify port.
 *
 * ## The two cases are not the same case
 *
 * A link that verifies proves the wiring. The absence of a link when no origin was
 * supplied proves the opposite: that nothing invented a fallback. Both are asserted
 * here because a `baseUrl ?? 'http://localhost:3000'` slipped into the chain would
 * pass the first test and ruin the second.
 */

const PREFIX = `rto${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;
const ORIGIN = 'https://groupeat.example';

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

function charged(notify: Recorder): Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }>[] {
  return notify.intents.filter(
    (intent): intent is Extract<NotifyIntent, { kind: 'DROP_CONFIRMED_CHARGED' }> =>
      intent.kind === 'DROP_CONFIRMED_CHARGED',
  );
}

/** A published drop whose cutoff is in the past and whose minimum is met. */
async function dueDrop(qty: number): Promise<{ dropId: string; participantId: string; publicCode: string }> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: qty,
  });
  const participantId = await fx.participant({ dropId, qty });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id: dropId },
    select: { publicCode: true },
  });
  return { dropId, participantId, publicCode: row.publicCode };
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

describe('a tick with a public origin', () => {
  it('emits a charged intent whose link resolves to that participant', async () => {
    const { dropId, participantId, publicCode } = await dueDrop(2);

    const notify = recordingNotify();
    const result = await runCutoffTick({
      now: new Date(),
      port: fakeChargePort(),
      notify,
      baseUrl: ORIGIN,
    });

    // The drop really went through the whole pipeline rather than being skipped.
    expect(result.settled).toBeGreaterThanOrEqual(1);

    const intent = charged(notify).find((candidate) => candidate.dropId === dropId);
    expect(intent).toBeDefined();
    expect(intent?.participantId).toBe(participantId);

    // The link is the thing under test: built by the job path, and it must verify
    // with the same function the page uses.
    expect(intent?.orderUrl).toBeTruthy();
    const url = new URL(intent?.orderUrl ?? '');
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/d/${publicCode}/mine`);
    expect(verifyParticipantAccess(url.searchParams.get('t') ?? '')).toEqual({
      participantId,
      dropId,
    });
  });
});

describe('a tick with no public origin', () => {
  it('emits the code and no link, and invents no fallback', async () => {
    // The production shape until `APP_URL` is set on a deployment. A message that
    // cannot carry a link is still a message that must tell a diner their card was
    // charged, so the intent is emitted either way — with the key absent, not
    // `undefined`, so a sender can branch on `'orderUrl' in intent`.
    const { dropId } = await dueDrop(2);

    const notify = recordingNotify();
    await runCutoffTick({ now: new Date(), port: fakeChargePort(), notify });

    const intent = charged(notify).find((candidate) => candidate.dropId === dropId);
    expect(intent).toBeDefined();
    expect('orderUrl' in (intent ?? {})).toBe(false);
    expect(intent?.redemptionCode).toBeTruthy();
  });

  it('does not leak a localhost origin from anywhere in the chain', async () => {
    // Belt and braces on the same point: scan every emitted intent for a host that
    // no phone can reach. This is the assertion that would fail if somebody "fixed"
    // the missing link with `baseUrl ?? 'http://localhost:3000'` in `settle`, in the
    // tick, or in the port.
    //
    // It needs a drop of its own. Without one the loop below iterates an empty array
    // and passes without checking anything — which it did, until a mutation that
    // injected exactly the fallback this test names went unnoticed.
    await dueDrop(2);

    const notify = recordingNotify();
    await runCutoffTick({ now: new Date(), port: fakeChargePort(), notify });

    // Guard against the vacuous version returning: there must be something to scan.
    expect(notify.intents.length).toBeGreaterThan(0);

    for (const intent of notify.intents) {
      if (!('orderUrl' in intent) || !intent.orderUrl) {
        continue;
      }
      const host = new URL(intent.orderUrl).hostname;
      expect(['localhost', '127.0.0.1', '0.0.0.0', '::1']).not.toContain(host);
    }
  });
});
