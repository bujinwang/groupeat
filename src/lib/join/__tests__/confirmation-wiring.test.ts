import 'dotenv/config';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeJoinPaymentPort } from '@/lib/join/fake-payment-port';
import type { NotificationMessage } from '@/lib/notify/copy';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

/**
 * FR-408's confirmation, actually composed and actually handed to a sender.
 *
 * ## Why this file exists
 *
 * `joinConfirmationMessage` was written, gated on consent, tested in isolation — and
 * called by nothing. That is the fifth instance of a pattern this repo has now hit
 * five times: a capability built, tested, and wired into a channel nobody opened.
 * `notify-end-to-end.test.ts` caught it by joining four layers that had each been
 * green on their own; this file keeps it closed by driving the real `joinDrop` through
 * the real composer with a recording sender behind the seam.
 *
 * ## Why `APP_URL` is stubbed and the module re-imported
 *
 * `publicOrigin()` reads `env.APP_URL` from `config.ts`, which is frozen at module load
 * (`export const env = loadEnv(process.env)`). Assigning `process.env.APP_URL` inside a
 * test therefore has **no effect** on an already-imported module — the first version of
 * this file did exactly that and its "no origin" cases were passing for the wrong
 * reason, because none of them ever had an origin to begin with.
 *
 * So each case stubs the env, resets the module registry, and imports `joinDrop`
 * *after* the stub — the same pattern as `public-origin.test.ts:138`.
 *
 * ## What it asserts, and why each one is here
 *
 *   - the message is **delivered through the seam**, not merely constructed;
 *   - it names the diner's own amount, the real cutoff in the merchant's zone, and a
 *     way back to their order;
 *   - **the consent gate holds** — FR-408 says "only if consent captured", and the
 *     decision lives in one function rather than in a missing call site;
 *   - **no origin means no link**, with the path as the fallback, because a link to
 *     `localhost` is worse than a path;
 *   - a sender that throws does not turn a held card into a 503.
 */

const PREFIX = `cw${Date.now().toString(36).slice(-6)}`;

let fx: SettlementFixtures;
let merchantId: string;
let itemId: string;

let phoneSeq = 0;
function phone(): string {
  phoneSeq += 1;
  return `+17805558${String(phoneSeq).padStart(3, '0')}`;
}

async function publishedDrop(minQty = 3) {
  const id = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty,
    maxQty: 10,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const row = await prisma.drop.findUniqueOrThrow({ where: { id }, select: { publicCode: true } });
  return { id, publicCode: row.publicCode };
}

/**
 * `joinDrop` with `APP_URL` stubbed **before** the config module is loaded.
 *
 * The return type is written as a `typeof` over the imported binding rather than an
 * `import()` type annotation, which this repo's lint config forbids — and it is the
 * honest type here: what is returned is whatever the freshly-imported module exports.
 */
async function joinWithOrigin(appUrl: string | undefined) {
  if (appUrl === undefined) {
    vi.stubEnv('APP_URL', '');
  } else {
    vi.stubEnv('APP_URL', appUrl);
  }
  vi.resetModules();
  const { joinDrop } = await import('@/lib/join/service');
  return joinDrop;
}

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant('acct_test_confirmation');
  itemId = await fx.item(merchantId);
  // A zone that is deliberately not the server's, so a message that printed the
  // process clock instead of the merchant's would be visibly different.
  await prisma.merchant.update({ where: { id: merchantId }, data: { timezone: 'Asia/Tokyo' } });
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(async () => {
  await prisma.consentRecord
    .deleteMany({ where: { phone: { startsWith: '+17805558' } } })
    .catch(() => undefined);
  await fx.cleanup();
});

describe('FR-408 — the join confirmation', () => {
  it('delivers a finished sentence through the seam', async () => {
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();
    const sent: NotificationMessage[] = [];

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 2, phone: phone(), consented: true },
      {
        paymentPort: fakeJoinPaymentPort(),
        confirm: async (message) => {
          sent.push(message);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);

    const [message] = sent;
    expect(message?.kind).toBe('JOIN_CONFIRMATION');

    // 2 × $11.12 = $22.24, from `formatCents` — the one formatter.
    expect(message?.body).toContain('2 plates');
    expect(message?.body).toContain('$22.24');

    // The cutoff, in Tokyo — the merchant's zone, not the server's and not the
    // diner's. The shape is asserted rather than an hour, for the reason
    // `notify-end-to-end.test.ts` records: tzdata differs between runtimes, so a
    // pinned clock time is a test that changes meaning with the Node version.
    expect(message?.body).toMatch(
      /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{1,2}:\d{2}\s(AM|PM)/,
    );

    // The link is the absolute one, on the origin that was configured — and it is the
    // order page, which is where the redemption code lives.
    expect(message?.body).toContain('https://groupeat.example/d/');
    expect(message?.body).toContain('/mine?t=p1.');

    // Nothing machine-shaped leaked into a stranger's lock screen.
    expect(message?.body).not.toMatch(/\bundefined\b|\bNaN\b|\[object/);
    expect(message?.body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // And it went to the diner who joined.
    expect(message?.phone).toMatch(/^\+17805558\d{3}$/);
  });

  it('says nothing when consent was not captured', async () => {
    // FR-408's acceptance criterion, verbatim: "Only if consent captured". An unticked
    // box is not consent, and the gate is a parameter of the composer rather than a
    // condition at the call site — so there is one place to get it wrong instead of
    // several places to forget it.
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();
    const sent: NotificationMessage[] = [];

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(), consented: false },
      {
        paymentPort: fakeJoinPaymentPort(),
        confirm: async (message) => {
          sent.push(message);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('says nothing when consent was simply absent', async () => {
    // Absent is not `true`. The request type documents this and the default is `false`
    // in `joinConfirmationMessage`; this proves the *call site* honours it rather than
    // passing `undefined` through a truthiness check.
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();
    const sent: NotificationMessage[] = [];

    await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone() },
      {
        paymentPort: fakeJoinPaymentPort(),
        confirm: async (message) => {
          sent.push(message);
        },
      },
    );

    expect(sent).toHaveLength(0);
  });

  it('carries a path and no absolute URL when no public origin is configured', async () => {
    // "An explicit origin, or no link. Never a guess." A message pointing at
    // `localhost` is the classic way a diner taps a link and reaches nothing. With no
    // `APP_URL`, the relative path is the honest fallback.
    const joinDrop = await joinWithOrigin(undefined);
    const drop = await publishedDrop();
    const sent: NotificationMessage[] = [];

    await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(), consented: true },
      {
        paymentPort: fakeJoinPaymentPort(),
        confirm: async (message) => {
          sent.push(message);
        },
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('/d/');
    expect(sent[0]?.body).not.toContain('http://');
    expect(sent[0]?.body).not.toContain('https://');
    expect(sent[0]?.body).not.toContain('localhost');
    // Still a real route back, with a token — just not an absolute one.
    expect(sent[0]?.body).toContain('/mine?t=p1.');
  });

  it('refuses a non-public origin rather than composing a link to it', async () => {
    // `publicOrigin()` validates the scheme and refuses a private host. A staging
    // deployment with `APP_URL=http://localhost:3000` must not text that address to a
    // diner.
    const joinDrop = await joinWithOrigin('http://localhost:3000');
    const drop = await publishedDrop();
    const sent: NotificationMessage[] = [];

    await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(), consented: true },
      {
        paymentPort: fakeJoinPaymentPort(),
        confirm: async (message) => {
          sent.push(message);
        },
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain('localhost');
    expect(sent[0]?.body).toContain('/d/');
  });

  it('still completes the join when the confirmation cannot be delivered', async () => {
    // The same rule as the still-filling message, and the reason it outranks
    // everything else on this path: the card is already held by the time the seam is
    // called. A provider failure must not become a 503 that tells a diner their join
    // failed while a hold sits on their card.
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(), consented: true },
      {
        paymentPort: port,
        confirm: async () => {
          throw new Error('provider unavailable');
        },
      },
    );

    expect(result.ok).toBe(true);
    // And the money really moved, rather than only the row saying so.
    expect(port.authorisedCount()).toBe(1);
    expect(
      await prisma.dropParticipant.count({ where: { dropId: drop.id, authStatus: 'AUTHORIZED' } }),
    ).toBe(1);
  });

  it('composes but does not throw when no seam is supplied', async () => {
    // The default state of every existing caller. It must not throw — a missing seam
    // is a wiring bug to be logged, not an exception in a diner's join.
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();

    const result = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(), consented: true },
      { paymentPort: fakeJoinPaymentPort() },
    );

    expect(result.ok).toBe(true);
  });

  it('sends nothing for a replayed join, because nothing happened', async () => {
    // A diner refreshing the page did not join again, and "you're in" a second time
    // reads as a duplicate order. The existing-join exit returns before the seam.
    const joinDrop = await joinWithOrigin('https://groupeat.example');
    const drop = await publishedDrop();
    const port = fakeJoinPaymentPort();
    const number = phone();
    const sent: NotificationMessage[] = [];

    await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: number, consented: true },
      { paymentPort: port, confirm: async (message) => void sent.push(message) },
    );
    expect(sent).toHaveLength(1);

    const replay = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: number, consented: true },
      { paymentPort: port, confirm: async (message) => void sent.push(message) },
    );

    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.alreadyJoined).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
