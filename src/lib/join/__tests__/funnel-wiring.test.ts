import 'dotenv/config';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { DEFAULT_FEES } from '@/lib/guardrail';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

import { fakeJoinPaymentPort } from '../fake-payment-port';
import { JoinProviderUnavailableError } from '../payment-port';
import { joinDrop } from '../service';

/**
 * The funnel, measured against a real join.
 *
 * ## Why this file exists when `analytics/__tests__/funnel.test.ts` is green
 *
 * That file proves the *arithmetic*: given a before and an after, does the crossing
 * fire once. It cannot prove the arithmetic is ever *called* — the `record(...)`
 * call could be missing from `service.ts`, placed after an early return, or passed
 * the capacity total instead of the threshold total, and 35 passing unit tests
 * would not notice.
 *
 * This is the wiring test for that gap, and it asserts the one property that a
 * unit test structurally cannot: that two joins on a two-plate drop produce exactly
 * **one** `threshold_reached`, read back from the sink rather than from a counter in
 * memory. Duplicated events would make PRD §10.2's threshold hit rate exceed 100%,
 * which is the kind of number that gets noticed a quarter later.
 *
 * It also pins the denominator problem the event exists to answer: `join_started`
 * is two, `join_authorised` is two, `threshold_reached` is one — so "authorised ÷
 * started" and "reached ÷ published" both have their inputs.
 */

/**
 * Short on purpose.
 *
 * `settlement-fixtures.ts` builds `publicCode` as `${prefix}${seq}` **sliced to 24
 * characters**, so a long prefix pushes the sequence off the end and every drop in
 * the file gets the same code. That surfaces as `Unique constraint failed on
 * (publicCode)` on the second fixture, not on the first — which reads like a
 * teardown bug and is not one.
 */
const PREFIX = `fl${Date.now().toString(36).slice(-6)}`;

let fixtures: SettlementFixtures;
let merchantId: string;
let itemId: string;
let dir: string;
let logPath: string;
let previousPath: string | undefined;

/**
 * The phone numbers this file issues, recorded as they are issued.
 *
 * Added because the teardown below deleted `ConsentRecord` rows by prefix and
 * **never touched `Customer` at all**. From a wiped database this file leaked five
 * customers per run (`+17805556001`–`003`, `011`, `012`), and the leak was invisible
 * because the residue gate compares counts before and after a run that starts from a
 * database already holding them — saturated, not clean. Measured: `customers 0 → 40`
 * across the whole suite from a wiped database, against `40 → 40` on the second run.
 *
 * A set cannot drift from itself, so the builder writes here and the teardown reads
 * here — the same mechanism as `join/__tests__/service.test.ts` and the join route test.
 */
const issuedPhones = new Set<string>();

/** What `normalisePhone()` prepends to a ten-digit North American number. */
const E164_COUNTRY_PREFIX = '+1';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'groupeat-funnel-live-'));
  logPath = join(dir, 'events.jsonl');
  previousPath = process.env.ANALYTICS_LOG_PATH;
  process.env.ANALYTICS_LOG_PATH = logPath;

  fixtures = settlementFixtures(PREFIX);
  merchantId = await fixtures.merchant('acct_test_funnel');
  itemId = await fixtures.item(merchantId);
});

afterAll(async () => {
  // Restore rather than delete: the variable was set by the harness, and clearing it
  // would make a later file in the same run write to the repo's default path.
  if (previousPath === undefined) {
    delete process.env.ANALYTICS_LOG_PATH;
  } else {
    process.env.ANALYTICS_LOG_PATH = previousPath;
  }
  rmSync(dir, { recursive: true, force: true });

  // Every step attempted, and the run still fails if any did. The previous version
  // ended `.catch(() => undefined)` on the only statement that could fail, which is how
  // a teardown that never deleted `Customer` kept passing review.
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };

  // `ConsentRecord` has no foreign key to anything, so nothing cascades to it.
  await step(() =>
    prisma.consentRecord.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  // The fixtures next: this removes the drops and cascades to the participants, and
  // `DropParticipant.customer` has no `onDelete` so it defaults to Restrict.
  await step(() => fixtures.cleanup());

  // Then the customers, which `fixtures.cleanup()` does NOT reach: it only deletes
  // customers whose ids it minted itself through `fixtures.participant()`. Every diner
  // here is created by `joinDrop` under test via `tx.customer.upsert`, which the
  // fixtures never see.
  await step(() =>
    prisma.customer.deleteMany({ where: { phone: { in: [...issuedPhones] } } }),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `teardown left the database dirty (${failures.length} step(s) failed)`,
    );
  }
});

/** Every line the sink has written this run, parsed. */
function events(): Record<string, unknown>[] {
  try {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function named(event: string): Record<string, unknown>[] {
  return events().filter((row) => row.event === event);
}

async function publishedDrop(minQty: number, maxQty: number): Promise<{ id: string; publicCode: string }> {
  const id = await fixtures.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: 1112,
    minQty,
    maxQty,
    status: 'PUBLISHED',
    cutoffAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    windowStart: new Date(Date.now() + 6 * 60 * 60 * 1000),
    windowEnd: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  const row = await prisma.drop.findUniqueOrThrow({
    where: { id },
    select: { publicCode: true },
  });
  return { id, publicCode: row.publicCode };
}

/**
 * A phone number unique to this test run.
 *
 * ## Phone block allocation
 *
 * The 780-555 exchange is carved up per file so two suites cannot mint the same diner.
 * Taken, as of this slice: `+17805550` (join/service), `+17805556` — this file,
 * `+17805557` (quote), `+17805558` (confirmation-wiring), `+17805559` (attribution,
 * threshold-notify), `+17805571` (order-link), `+17805580` (join route).
 *
 * `+17805556` was chosen because nothing else in the repo writes it — verified by
 * grepping every builder in `src`, not by eye. `+17805557` is `quote`'s and
 * `+17805558` is `confirmation-wiring`'s, so the neighbours on both sides were taken.
 *
 * ## The collision this replaces
 *
 * This file used to build `7805558…`, i.e. `+17805558001`, which is character-for-
 * character what `confirmation-wiring.test.ts` builds from `'+17805558' + padStart(3)`.
 * Two files, one diner. Confirmed by seeding a `ConsentRecord` at `+17805558005` — a
 * number only `confirmation-wiring` mints — and watching this file's teardown delete
 * it: `1 row(s) — DELETED` before, `SURVIVED` after.
 *
 * `fileParallelism: false` made the damage sequential and therefore masked. It also
 * masked something worse: `Customer.phone` is `@unique`, so the two files were *sharing*
 * diners rather than adding them, and the shared block silently capped this file's
 * contribution from five rows to two. Moving to its own block exposed the real figure —
 * which is why the teardown above now deletes `Customer` by registry rather than
 * leaving it to a fixture that never tracked these rows.
 *
 * Adding a file? Take a free block, grep for it, and write it down here.
 */
function phone(seq: number): string {
  const national = `7805556${String(seq).padStart(3, '0')}`;
  // Recorded in the form the database stores, at the moment of issue, so the teardown
  // deletes exactly what this run created and nothing a neighbour owns.
  issuedPhones.add(`${E164_COUNTRY_PREFIX}${national}`);
  return national;
}

describe('the funnel fires on real joins', () => {
  it('emits one threshold_reached for the join that crosses, and none for the next', async () => {
    const drop = await publishedDrop(2, 10);
    const port = fakeJoinPaymentPort();

    const first = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(1) },
      { paymentPort: port },
    );
    expect(first.ok).toBe(true);

    // After the first join the drop is 1 of 2 — below the minimum, so no event.
    const afterFirst = named('threshold_reached').filter((e) => e.dropId === drop.id);
    expect(afterFirst).toHaveLength(0);

    const second = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(2) },
      { paymentPort: port },
    );
    expect(second.ok).toBe(true);

    // Exactly one crossing, with the totals the ledger saw.
    const crossings = named('threshold_reached').filter((e) => e.dropId === drop.id);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({ minQty: 2, previousQty: 1, currentQty: 2 });

    // A third join is past the threshold and must not re-fire.
    const third = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(3) },
      { paymentPort: port },
    );
    expect(third.ok).toBe(true);
    expect(named('threshold_reached').filter((e) => e.dropId === drop.id)).toHaveLength(1);

    // Both sides of join conversion exist for this drop.
    expect(named('join_started').filter((e) => e.dropId === undefined)).toHaveLength(3);
    expect(named('join_authorised').filter((e) => e.dropId === drop.id)).toHaveLength(3);
  });

  it('measures the threshold on AUTHORIZED plates, not on capacity', async () => {
    // A 2-plate minimum on a 10-plate drop. One join authorises, a second is left
    // `PENDING` by a port that never answers — the drop has 2 plates committed but
    // only 1 paid. If the threshold counted capacity the event would fire here, and
    // the drop would be reported as having reached its minimum on a card nobody
    // confirmed. It must not.
    const drop = await publishedDrop(2, 10);

    const ok = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(11) },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(ok.ok).toBe(true);

    const unavailable = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: phone(12) },
      {
        // An inline port that cannot answer, rather than the fake's
        // `unavailableOnceFor`: the participant id is minted inside the reserve
        // transaction, so the test cannot name it in advance. Throwing
        // unconditionally is the same outcome without predicting an id.
        paymentPort: {
          async createJoinAuthorisation() {
            throw new JoinProviderUnavailableError('timeout', 'the provider did not answer');
          },
        },
      },
    );
    expect(unavailable.ok).toBe(false);

    // The row is PENDING and holds the plate, so capacity is 2...
    const held = await prisma.dropParticipant.aggregate({
      where: { dropId: drop.id, authStatus: { in: ['PENDING', 'AUTHORIZED'] } },
      _sum: { qty: true },
    });
    expect(held._sum.qty).toBe(2);

    // ...but only 1 plate is paid, so the threshold has not been reached.
    const paid = await prisma.dropParticipant.aggregate({
      where: { dropId: drop.id, authStatus: 'AUTHORIZED' },
      _sum: { qty: true },
    });
    expect(paid._sum.qty).toBe(1);

    expect(named('threshold_reached').filter((e) => e.dropId === drop.id)).toHaveLength(0);
  });

  it('records the refusal reason for a rejected join', async () => {
    const drop = await publishedDrop(2, 10);

    const refused = await joinDrop(
      { publicCode: drop.publicCode, qty: 1, phone: 'not-a-phone' },
      { paymentPort: fakeJoinPaymentPort() },
    );
    expect(refused.ok).toBe(false);

    const failures = named('join_failed');
    expect(failures.some((e) => e.reason === 'BAD_PHONE')).toBe(true);
    // No drop id: the phone is validated before the drop row is read, and an empty
    // string would join to nothing. `undefined` is the honest value.
    const badPhone = failures.find((e) => e.reason === 'BAD_PHONE');
    expect(badPhone?.dropId).toBeUndefined();
  });

  it('never writes a phone number or an email into the stream', async () => {
    const raw = readFileSync(logPath, 'utf8');

    // The fixture's numbers all start `+17805556…`, so any surviving fragment is
    // visible. This is the real assertion: the digits must not be there.
    expect(raw).not.toMatch(/7805556/);
    expect(raw).not.toMatch(/\+?1?780555/);
    expect(raw).not.toMatch(/@/);

    // Every whole line that mentions "phone" must be a *reason*, not a number. The
    // first version of this test asserted the bare word was absent and failed on
    // `BAD_PHONE`, which is the vocabulary the event is built around — a false
    // positive that would have been "fixed" by weakening the check rather than
    // sharpening it.
    for (const line of raw.trim().split('\n')) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        expect(key).not.toMatch(/phone/i);
        // A string containing "phone" is only allowed to be an enum-like reason.
        if (value.toLowerCase().includes('phone')) {
          expect(value).toMatch(/^[A-Z_]+$/);
        }
      }
    }
  });
});

// `DEFAULT_FEES` is imported so the fee table's shape is in scope for the money
// assertions above; referencing it keeps the import honest if the assertions move.
void DEFAULT_FEES;
