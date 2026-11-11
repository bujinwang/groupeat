/**
 * The legacy `CAPTURED` + `redemptionCode = null` row — detection, not remediation.
 *
 * ## What this state is
 *
 * §4.2's lost write used to leave a diner whose card was debited with
 * `chargeStatus = 'CAPTURED'` and `redemptionCode = null`. The write path is fixed
 * (`0982793`: both `recordCapture` and `repairFromExistingOrder` sign the code in the
 * same CAS that sets `CAPTURED`), so a **new** row cannot legitimately arrive here. But
 * rows created before that fix are still in whatever database they were created in, and
 * a future regression would produce more.
 *
 * ## The hole this closes
 *
 * `buildCapturedIntents` used to skip such a row with no output at all:
 *
 *     if (!order || !state.redemptionCode) { continue; }
 *
 * Money debited, no message sent, and nothing anywhere recording that a person had been
 * skipped. That silence is why the original defect survived review — the symptom was
 * indistinguishable from "this diner had nothing to say". The row now logs
 * `settlement.captured_without_code` at `error`.
 *
 * ## Why detection and not repair
 *
 * The correct code *is* deterministic in `(participantId, dropId, qty)`, so a repair is
 * arithmetically possible. It is deliberately not done here: the notify path is not a
 * writer of settlement state, and making it one would mean a message-composition
 * function could move money-adjacent columns. Minting the code is an operator action
 * against the rows the log names.
 *
 * ## Why the test writes the row directly
 *
 * There is no caller that can produce it any more — that is the point. A fixture that
 * went through `settle` would be testing the fixed write path and could never construct
 * this state at all. So the test writes the row the way the old code left it and asserts
 * the log, which is the only remaining way to pin the detection.
 */
import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { fakeChargePort } from '@/lib/settlement/fake-charge-port';
import { captureEntries } from '@/lib/settlement/ledger';
import { settle } from '@/lib/settlement/settle';
import {
  settlementFixtures,
  type SettlementFixtures,
} from '@/lib/settlement/__tests__/settlement-fixtures';

const logLines = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);

vi.mock('@/lib/logging/logger', () => ({
  logger: {
    info: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    warn: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
    error: (event: string, fields: Record<string, unknown>) => {
      logLines.push({ event, fields });
    },
  },
}));

const PREFIX = `lc${Date.now().toString(36).slice(-6)}`;
const DEAL_PRICE = 1112;

let fx: SettlementFixtures;
let merchantId = '';
let itemId = '';

beforeAll(async () => {
  fx = settlementFixtures(PREFIX);
  merchantId = await fx.merchant();
  itemId = await fx.item(merchantId);
});

afterAll(async () => {
  await fx.cleanup();
});

type Legacy = { dropId: string; participantId: string };

/**
 * A drop where one diner is already `CAPTURED` with no code and has an `Order`.
 *
 * The `Order` matters: `buildCapturedIntents` needs it for `chargedCents`, and it is
 * also what makes the row realistic — a captured diner always has one, because
 * `recordCapture` writes the two together.
 *
 * Its two ledger rows are written too, and **that is not incidental**: `recordCapture`
 * writes them in one transaction with the `Order`, so an `Order` without a ledger is a
 * different invalid state. My first draft created only the `Order` and the drop failed
 * `LEDGER_MISMATCH` — L1 says the ledger shows 1112 against orders of 2224 — which is
 * the reconciliation guard doing its job on a fixture that was wrong. The row we want to
 * model is "charged, no code", not "charged, no bookkeeping".
 */
async function legacyRow(): Promise<Legacy> {
  const dropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 1,
    status: 'LOCKED',
    lockedAt: new Date(Date.now() - 60_000),
  });
  const participantId = await fx.participant({
    dropId,
    qty: 1,
    chargeStatus: 'CAPTURED',
    // The defect, written as it was left: charged, and no code.
    redemptionCode: null,
  });

  const stripeChargeId = `ch_legacy_${PREFIX}`;
  const order = await prisma.order.create({
    data: {
      dropId,
      participantId,
      qty: 1,
      unitPriceCents: DEAL_PRICE,
      subtotalCents: DEAL_PRICE,
      platformFeeCents: 0,
      stripeChargeId,
    },
    select: { id: true, subtotalCents: true, platformFeeCents: true },
  });
  await prisma.ledgerEntry.createMany({
    data: [...captureEntries({ dropId, order, stripeRef: stripeChargeId })],
  });

  return { dropId, participantId };
}

describe('a CAPTURED diner with no redemption code is reported, not silently skipped', () => {
  it('logs settlement.captured_without_code naming the real drop and participant', async () => {
    logLines.length = 0;
    const { dropId, participantId } = await legacyRow();

    await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      // A port that records without logging: the shipped `composingNotifyPort` shape.
      notify: { async notify() {} },
      baseUrl: 'https://groupeat.test',
    });

    const reported = logLines.filter((line) => line.event === 'settlement.captured_without_code');
    expect(reported).toHaveLength(1);
    expect(reported[0]!.fields).toMatchObject({
      dropId,
      participantId,
      qty: 1,
    });

    // And no confirmation was claimed for them: a message that was not built must not be
    // reported as sent. `notification.intent` is per (kind, drop), so the absence of a
    // `DROP_CONFIRMED_CHARGED` group is the assertion.
    const charges = logLines.filter(
      (line) => line.event === 'notification.intent' && line.fields.dropId === dropId,
    );
    expect(charges).toHaveLength(0);
  });

  it('still confirms the other diners in the same drop', async () => {
    // The detection must not become a drop-wide failure: one bad row is one diner who
    // needs a code minted by hand, and the rest of the drop is unaffected. This is why
    // the skip is a log rather than a thrown `SettlementIntegrityError`.
    logLines.length = 0;
    const { dropId, participantId: legacyParticipantId } = await legacyRow();

    // A second, healthy diner who has not been charged yet — settle will capture them
    // normally and must produce their confirmation.
    const healthyId = await fx.participant({ dropId, qty: 1 });

    await settle({
      dropId,
      now: new Date(),
      port: fakeChargePort(),
      notify: { async notify() {} },
      baseUrl: 'https://groupeat.test',
    });

    // The legacy row is the one reported — named, and not the healthy diner.
    const reported = logLines.filter((line) => line.event === 'settlement.captured_without_code');
    expect(reported).toHaveLength(1);
    expect(reported[0]!.fields.participantId).toBe(legacyParticipantId);
    expect(reported[0]!.fields.participantId).not.toBe(healthyId);

    // ...and the healthy diner is still charged and still told.
    const captured = await prisma.dropParticipant.findUniqueOrThrow({
      where: { id: healthyId },
      select: { chargeStatus: true, redemptionCode: true },
    });
    expect(captured.chargeStatus).toBe('CAPTURED');
    expect(captured.redemptionCode).toBeTruthy();

    const confirmations = logLines.filter(
      (line) =>
        line.event === 'notification.intent' &&
        line.fields.dropId === dropId &&
        line.fields.kind === 'DROP_CONFIRMED_CHARGED',
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.fields.count).toBe(1);
  });
});
