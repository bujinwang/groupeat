import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithRouter, textOf } from '@/lib/testing/render';
import { scopedCounts } from '@/lib/testing/scoped-counts';

/**
 * `/admin/drops/[id]` rendered — gap 12(b), and FR-903's reachable half.
 *
 * ## What this page is, and why a render is the only test that can make the claim
 *
 * FR-903's acceptance criterion is server-side and was met slices ago: the ledger is
 * adjusted, the Stripe refund is created, the CAS and `@@unique([orderId, type])` stop a
 * double refund, and eleven tests run it against real Postgres. What did not exist was a
 * **human able to do it**: the route keys on a participant id and no page rendered one,
 * so the only route was to read a uuid out of Postgres and `curl` it.
 *
 * The page closes that, and three of its decisions are invisible to every test that
 * already exists:
 *
 *   1. **`refusal` is the server's own sentence, not a local predicate.** Each row's
 *      availability must be `refusalFor(...).publicMessage` — the function
 *      `issueParticipantRefund` refuses by. A UI predicate would agree today and drift
 *      the first time a guard was added, and a button that can only produce a 409
 *      teaches the operator that the screen is broken.
 *   2. **Privacy is a projection, not a habit.** The page shows last-four and nothing
 *      else. `Customer.phone` holds the real number, so the assertion has to be that the
 *      real number is *absent* — against a fixture whose number really is stored.
 *   3. **`refundableCount` and the rows agree.** The header says "N can be refunded now";
 *      it is counted in the loader from the same `refusalFor` calls the rows use. Two
 *      numbers, one computation — or two, and they disagree on some future guard.
 *
 * ## The page is unrenderable without `renderWithRouter`
 *
 * It mounts `ParticipantRefundControl`, which calls `useRouter()`. Probed the same way as
 * `/admin/drops`: under plain `renderToHtml` the render throws `expected app router to be
 * mounted` inside the control, before a byte is written. This is the second page to need
 * the context, which is why the capability lives in the harness rather than here.
 *
 * ## One fixture per refusal sentence
 *
 * `refusalFor` has **seven** branches, each with its own sentence. Asserting "a refusal
 * is shown" would pass against any of them, and the sentences are not interchangeable —
 * *"already been refunded"* and *"was never successfully charged"* send an operator to
 * two different places. So each fixture is built to reach exactly one, and the
 * assertion is the whole sentence.
 *
 * Five of the seven are reachable from a page render and are asserted below. The other
 * two are named rather than quietly skipped, because their unreachability is a fact
 * about the system and not a gap in this suite:
 *
 *   - **`MISSING_STRIPE_ACCOUNT`.** Needs a merchant with no connected account *and* a
 *     captured order. `settle.ts` throws `SettlementIntegrityError` before it captures
 *     anything on such a merchant, so a `CAPTURED` drop cannot legitimately belong to
 *     one. Covered by `refunds/__tests__/participant-refund.test.ts` (case *"refuses
 *     when the merchant has no connected account"*).
 *   - **"never successfully charged".** Needs `chargeStatus = FAILED` together with a
 *     non-null `order`. The only writer of `FAILED` is the decline path in `settle.ts`,
 *     which `continue`s *before* `recordCapture`, so the shipped code never produces
 *     that pair — it is a repair state, reachable only through a manual fix-up. Covered
 *     by the same service test (*"tells a declined card apart from an
 *     already-refunded one"*).
 *
 * ## The drop-scoped sentence cannot live on the shared drop
 *
 * *"That drop has not finished settling yet"* is a verdict about the **drop**, read from
 * `isVoidSweepStatus(dropStatus)`. Every other case shares `refundableDropId`, which is
 * `CAPTURED` — a settled status — so that sentence is unreachable there. It gets a
 * `LOCKED` drop of its own, and isolating it is the point: it is the sentence a local
 * `chargeStatus === 'CAPTURED'` predicate cannot produce, on a row that looks refundable
 * in every other respect.
 *
 * `LOCKED` rather than `PUBLISHED`, because a published drop cannot legitimately own a
 * captured order. `LOCKED` is settlement mid-flight — some participants captured, others
 * not — which is the exact race the guard exists to prevent refunds from joining.
 *
 * ## Every branch of `moneySummary` is reachable, so every branch is asserted
 *
 * Three branches, and the middle one is the state a force-failed drop is *left* in —
 * money fully returned, nothing still held. A suite that only checked "still held" and
 * "nothing captured" would never render the screen an operator sees most often after
 * using the other control on this page.
 *
 * ## What is mocked
 *
 * `server-only` and `@/lib/auth/session`. `@/lib/auth/authorize` is **real**, so the
 * route assertions go through the shipped `requireAdmin`.
 */

type MockSession = { userId: string; role: string; mustChangePassword: boolean };

const sessionState: { session: MockSession | null } = { session: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async (): Promise<MockSession | null> => sessionState.session,
}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');
const { refusalFor } = await import('@/lib/refunds/participant-refund');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `add${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

/**
 * 625 cents a plate, for the reason the two previous slices record: a round price makes
 * `subtotal − refunded` and `subtotal` agree, and then the money assertions prove nothing.
 */
const DEAL_PRICE = 625;
const PARTIAL_REFUND = 250;

/**
 * What `refundableDropId` holds, in cents, written as the sum it is.
 *
 * Four of the five participants have an order — 2, 1, 1 and 3 plates — and the fifth
 * has none, so it contributes to neither figure. Two of the four carry a refund: the
 * `refunded` fixture, whose whole 625 came back, and `carries`, which returned 250 of
 * its 1875.
 *
 * The first draft of these constants subtracted only `PARTIAL_REFUND`, forgot the
 * fully-refunded fixture, and produced `$41.25` against a page printing `$35.00`. The
 * suite caught it, which is the reason the figures are derived here rather than typed
 * into each assertion: a wrong constant fails once, loudly, instead of being pasted
 * into three tests as three plausible-looking dollar amounts.
 */
const GROSS = 2 * DEAL_PRICE + DEAL_PRICE + DEAL_PRICE + 3 * DEAL_PRICE; // 4375
/** Everything returned: the `refunded` fixture's 625 plus `carries`' 250. */
const TOTAL_REFUNDED = DEAL_PRICE + PARTIAL_REFUND; // 875
/** Still out there: `subtotal − refunded` summed per order. */
const HELD = GROSS - TOTAL_REFUNDED; // 3500

/** Plates that joined `refundableDropId`: 2 + 1 + 1 + 1 + 3. Compared against `minQty`. */
const JOINED_QTY = 8;

/** The whole order on `returnedDropId` came back: 2 plates. `moneySummary`'s middle branch. */
const RETURNED_REFUND = 2 * DEAL_PRICE; // 1250

/** The drop every participant case hangs off: `CAPTURED`, so refunds are permitted. */
let refundableDropId = '';
/**
 * A `LOCKED` drop: settlement is mid-flight, which is the only state in which a drop
 * that has *not* finished settling can legitimately own a captured order.
 */
let unsettledDropId = '';
/** A `PUBLISHED` drop with an authorised diner and no order — the normal pre-cutoff state. */
let openDropId = '';
/** A `DRAFT` drop: not publishable, not force-failable, not refundable. */
let draftDropId = '';
/**
 * A `CAPTURED` drop whose one order has been fully refunded — the state a force-fail
 * leaves behind, and the only way to render `moneySummary`'s middle branch.
 */
let returnedDropId = '';
let merchantId = '';
let itemId = '';
let adminUserId = '';
let merchantUserId = '';

/** Participant ids by the case they were built for. */
const caseIds: Record<string, string> = {};
/** The real phone number stored for the refundable diner, so its absence is assertable. */
let refundablePhone = '';
let refundablePublicCode = '';

const customerIds: string[] = [];

/**
 * A participant plus its order, with the fields each refusal sentence reads.
 *
 * Written here rather than through `fx.participant` because half these cases need an
 * `Order` with a specific `refundedCents` or a missing `stripeChargeId`, and the fixture
 * helper deliberately does not create orders at all.
 */
async function seededParticipant(args: {
  dropId: string;
  tag: string;
  qty: number;
  chargeStatus: 'CAPTURED' | 'REFUNDED' | 'NONE' | 'FAILED' | 'PARTIALLY_REFUNDED';
  withOrder: boolean;
  refundedCents?: number;
  stripeChargeId?: string | null;
}): Promise<string> {
  const phone =
    args.tag === 'refundable'
      ? `+1780${randomBytes(4).toString('hex')}`
      : `+1780${randomBytes(5).toString('hex')}`;
  if (args.tag === 'refundable') {
    refundablePhone = phone;
  }

  const customer = await prisma.customer.create({ data: { phone }, select: { id: true } });
  customerIds.push(customer.id);

  const participant = await prisma.dropParticipant.create({
    data: {
      dropId: args.dropId,
      customerId: customer.id,
      qty: args.qty,
      amountCents: args.qty * DEAL_PRICE,
      platformFeeCents: 0,
      authStatus: 'AUTHORIZED',
      chargeStatus: args.chargeStatus,
      paymentIntentId: `pi_${PREFIX}_${args.tag}`,
      ...(args.tag === 'refundable' ? { redeemedQty: 1 } : {}),
    },
    select: { id: true },
  });

  if (args.withOrder) {
    await prisma.order.create({
      data: {
        dropId: args.dropId,
        participantId: participant.id,
        qty: args.qty,
        unitPriceCents: DEAL_PRICE,
        subtotalCents: args.qty * DEAL_PRICE,
        platformFeeCents: 0,
        stripeChargeId:
          args.stripeChargeId === undefined ? `ch_${PREFIX}_${args.tag}` : args.stripeChargeId,
        refundedCents: args.refundedCents ?? 0,
      },
    });
  }

  caseIds[args.tag] = participant.id;
  return participant.id;
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}`);
  itemId = await fx.item(merchantId);

  const admin = await prisma.user.create({
    data: {
      email: `${PREFIX}-admin@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'ADMIN',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  adminUserId = admin.id;

  const merchantUser = await prisma.user.create({
    data: {
      email: `${PREFIX}-merchant@example.test`,
      passwordHash: 'not-a-real-hash',
      role: 'MERCHANT',
      mustChangePassword: false,
    },
    select: { id: true },
  });
  merchantUserId = merchantUser.id;

  refundableDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 40,
    status: 'CAPTURED',
    cutoffAt: new Date('2026-07-10T23:00:00Z'),
    windowStart: new Date('2026-07-11T00:00:00Z'),
    windowEnd: new Date('2026-07-11T02:00:00Z'),
  });
  const drop = await prisma.drop.findUniqueOrThrow({
    where: { id: refundableDropId },
    select: { publicCode: true },
  });
  refundablePublicCode = drop.publicCode;

  // ---- The five refusal sentences reachable from this drop ------------------------
  //
  // Each comment names the sentence the fixture is built to produce, in the code path
  // order `refusalFor` uses, because "a refusal is shown" is not the claim.

  // (1) Refundable: a captured order, a charge id, nothing refunded. The only row that
  // shows a Refund button — and therefore the only one that can exercise `refusalFor`
  // returning null on a real page.
  await seededParticipant({
    dropId: refundableDropId,
    tag: 'refundable',
    qty: 2,
    chargeStatus: 'CAPTURED',
    withOrder: true,
  });

  // (2) No order at all → "never charged, so there is nothing to refund".
  await seededParticipant({
    dropId: refundableDropId,
    tag: 'noorder',
    qty: 1,
    chargeStatus: 'NONE',
    withOrder: false,
  });

  // (3) REFUNDED → "has already been refunded".
  await seededParticipant({
    dropId: refundableDropId,
    tag: 'refunded',
    qty: 1,
    chargeStatus: 'REFUNDED',
    withOrder: true,
    refundedCents: DEAL_PRICE,
  });

  // (4) A captured order with no charge id → the data-defect sentence, which tells the
  // operator to escalate rather than to retry.
  await seededParticipant({
    dropId: refundableDropId,
    tag: 'nocharge',
    qty: 1,
    chargeStatus: 'CAPTURED',
    withOrder: true,
    stripeChargeId: null,
  });

  // (5) CAPTURED but the order already carries a refund → "V1 allows one refund per
  // order". This is the half-finished case the `chargeStatus` check cannot see, which is
  // why `refusalFor` has the belt as well as the brace.
  await seededParticipant({
    dropId: refundableDropId,
    tag: 'carries',
    qty: 3,
    chargeStatus: 'CAPTURED',
    withOrder: true,
    refundedCents: PARTIAL_REFUND,
  });

  // (6) A settled-status charge on a drop that has **not** settled.
  //
  // Deliberately on its own drop, and deliberately the *only* participant there. The
  // guard reads `dropStatus`, so this sentence is unreachable on `refundableDropId` —
  // that drop is `CAPTURED`, which is in `VOID_SWEEP_STATUSES`. Asserting it against the
  // shared drop was the first thing this suite got wrong, and it failed for the right
  // reason: the page declined to print a sentence that was not true of the drop it was
  // rendering.
  //
  // `LOCKED`, not `PUBLISHED`, and that correction matters. A `PUBLISHED` drop cannot
  // legitimately own a captured order — capture happens at settlement, after the cutoff
  // — so the first version of this fixture was a state the system never produces, and
  // the page said so by printing "$6.25 still held" on a drop that had not begun to
  // capture. `LOCKED` is the real thing: settlement is mid-flight, some participants
  // have been captured and others have not, and refunding one now would race the sweep
  // about to finish the job. That race is exactly what the guard is for.
  unsettledDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 40,
    status: 'LOCKED',
    cutoffAt: new Date('2026-07-12T23:00:00Z'),
    windowStart: new Date('2026-07-13T00:00:00Z'),
    windowEnd: new Date('2026-07-13T02:00:00Z'),
  });
  await seededParticipant({
    dropId: unsettledDropId,
    tag: 'unsettled',
    qty: 1,
    chargeStatus: 'CAPTURED',
    withOrder: true,
  });

  // A `PUBLISHED` drop with an authorised diner and **no order** — the ordinary state
  // before the cutoff, and the only honest way to render `moneySummary`'s first branch.
  //
  // The earlier version of this fixture reused the settling drop for the "No money
  // captured" assertion, which was wrong twice over: that drop *does* hold money once a
  // participant has been captured, and confusing "has not captured yet" with "has no
  // money" is the distinction the phrasing exists to make.
  openDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 40,
    status: 'PUBLISHED',
    cutoffAt: new Date('2026-07-18T23:00:00Z'),
    windowStart: new Date('2026-07-19T00:00:00Z'),
    windowEnd: new Date('2026-07-19T02:00:00Z'),
  });
  await seededParticipant({
    dropId: openDropId,
    tag: 'open',
    qty: 1,
    chargeStatus: 'NONE',
    withOrder: false,
  });

  // (7) Money fully returned — `moneySummary`'s middle branch.
  //
  // Not a hypothetical: this is the state `forceFailDrop` leaves a settled drop in, and
  // the operator lands on this page immediately afterwards. `capturedCents` here is
  // `subtotal − refunded` per order, so a fully-refunded order contributes 0 while
  // `refundedCents` carries the money that came back — the page has to distinguish
  // "nothing was ever taken" from "everything was taken and given back", and only this
  // fixture makes those two states textually different.
  returnedDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 40,
    status: 'CAPTURED',
    cutoffAt: new Date('2026-07-16T23:00:00Z'),
    windowStart: new Date('2026-07-17T00:00:00Z'),
    windowEnd: new Date('2026-07-17T02:00:00Z'),
  });
  await seededParticipant({
    dropId: returnedDropId,
    tag: 'returned',
    qty: 2,
    chargeStatus: 'REFUNDED',
    withOrder: true,
    refundedCents: RETURNED_REFUND,
  });

  // A `DRAFT` drop, for the force-fail refusal sentence.
  draftDropId = await fx.drop({
    merchantId,
    menuItemId: itemId,
    dealPriceCents: DEAL_PRICE,
    minQty: 4,
    maxQty: 40,
    status: 'DRAFT',
    cutoffAt: new Date('2026-07-14T23:00:00Z'),
    windowStart: new Date('2026-07-15T00:00:00Z'),
    windowEnd: new Date('2026-07-15T02:00:00Z'),
  });

  sessionState.session = { userId: adminUserId, role: 'ADMIN', mustChangePassword: false };
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } }).catch(() => undefined);
  await prisma.user
    .deleteMany({ where: { id: { in: [adminUserId, merchantUserId] } } })
    .catch(() => undefined);
});

async function render(dropId: string): Promise<{ html: string; text: string; refreshes: number }> {
  const page = await import('@/app/(admin)/admin/drops/[id]/page');
  const { html, router } = await renderWithRouter(
    await page.default({ params: Promise.resolve({ id: dropId }) }),
  );
  return { html, text: textOf(html), refreshes: router.refreshes };
}

/**
 * The text of one participant's `<li>`, located by the phone hint the page shows.
 *
 * Row-scoped for the reason the other two page suites document: a list that puts the
 * right sentence beside the wrong diner renders perfectly. The hint is the only
 * per-row identifier on screen, so it is also the only honest way to find a row — which
 * is itself the privacy claim, tested below.
 */
function rowFor(html: string, hint: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(hint)) {
      return textOf(match[0]);
    }
  }
  throw new Error(`No <li> contains ${hint}`);
}

/** Every `···NNNN` hint rendered, in document order. */
function hintsOf(text: string): string[] {
  return [...text.matchAll(/···\d{4}/g)].map((match) => match[0]);
}

describe('/admin/drops/[id] — the drop', () => {
  it('identifies the drop by title, merchant, code and price', async () => {
    const { text } = await render(refundableDropId);
    const drop = await prisma.drop.findUniqueOrThrow({
      where: { id: refundableDropId },
      select: { title: true, minQty: true, dealPriceCents: true },
    });

    expect(text).toContain(drop.title);
    expect(text).toContain(`${PREFIX} merchant`);
    expect(text).toContain(refundablePublicCode);
    expect(text).toContain(`${formatCents(drop.dealPriceCents)}/plate`);
    // Plates, not joins — the threshold compares plates. There are five participants and
    // eight plates, so "5/4" (a join count against a plate threshold) and "8/4" are
    // different strings and only one of them is the comparison the gate makes.
    expect(text).toContain(`${JOINED_QTY}/${drop.minQty} plates`);
    expect(text).not.toContain(`5/${drop.minQty} plates`);
  });

  it('summarises money as still held, and names what already came back', async () => {
    const { text } = await render(refundableDropId);

    // Four orders went through for 4375; 875 of that came back — the whole 625 on the
    // `refunded` fixture and 250 of `carries`' 1875. So 3500 is still out there.
    //
    // A `subtotal`-only sum would print $43.75 (gross, not what a force-fail returns),
    // and a page that subtracted only the partial refund would print $41.25. Neither
    // figure is in the render, and the two absences below are what say so.
    expect(text).toContain(`${formatCents(HELD)} still held`);
    expect(text).toContain(`${formatCents(TOTAL_REFUNDED)} already back`);
    expect(text).not.toContain(`${formatCents(GROSS)} still held`);
    expect(text).not.toContain(`${formatCents(GROSS - PARTIAL_REFUND)} still held`);
  });

  it('says nothing was captured rather than $0.00, on a drop with no captured money', async () => {
    const { text } = await render(openDropId);

    // A published drop that nobody has been charged on yet — the ordinary pre-cutoff
    // state, and the one where "$0.00" would read as a fault. Asserted against a drop
    // that genuinely has an authorised diner on it, so this is not the trivial case of
    // an empty page.
    expect(text).toContain('No money captured');
    expect(text).toContain('1 participant');
    expect(text).not.toContain('still held');
    // And the count line says so rather than stopping after "1 participant". Found by
    // probe J: deleting this branch left every test green, which meant the `? :` that
    // renders "none refundable in this state" was never exercised — a zero count would
    // have rendered as silence and read as a page that forgot to compute it.
    expect(text).toContain('none refundable in this state');
  });

  it('distinguishes money given back from money never taken', async () => {
    // `returnedDropId` is the state a force-fail leaves behind: nothing still held, but
    // 1250 came back. Without this branch asserted, a page that printed "No money
    // captured" here would pass every other test in this file — and it would be lying to
    // an operator about a drop they had just cancelled.
    const { text } = await render(returnedDropId);

    expect(text).toContain(
      `${formatCents(RETURNED_REFUND)} refunded · nothing still held`,
    );
    // The sentence that would be wrong, and the one a `capturedCents === 0` check
    // without the `refundedCents` half would emit.
    expect(text).not.toContain('No money captured');
  });

  it('counts who can be refunded now, from the same verdicts the rows show', async () => {
    const { text } = await render(refundableDropId);

    // Five participants on this drop, all reachable from the shared fixture. Exactly
    // one — `refundable` — has a captured order, a charge id, nothing refunded, and a
    // settled drop status.
    //
    // This is the loader's `refundableCount`, which it increments from the same
    // `refusalFor` calls the rows render. Asserting the number *and* the rows is what
    // catches a header counted by a second rule: four refusals plus one button is five
    // rows, and the header's "5 participants · 1 can be refunded now" has to agree with
    // both halves of that.
    expect(text).toContain('5 participants');
    expect(text).toContain('1 can be refunded now');

    expect([...text.matchAll(/No refund available\./g)]).toHaveLength(4);
    expect([...text.matchAll(/Refund…/g)]).toHaveLength(1);
  });
});

describe('/admin/drops/[id] — the refusal sentences are the server’s', () => {
  it('renders refusalFor’s own sentence for each ineligible diner', async () => {
    const { text } = await render(refundableDropId);

    // Each sentence is asserted in full, against a fixture built to reach exactly that
    // branch. A local predicate would have to invent four sentences, and they would
    // drift from these the first time a guard changed.

    // (2) no order
    expect(text).toContain(
      'That participant was never charged, so there is nothing to refund. Their authorisation is released automatically.',
    );
    // (3) already refunded
    expect(text).toContain('That participant has already been refunded.');
    // (4) no stripe charge id — the data defect, addressed to an operator
    expect(text).toContain(
      'That order has no Stripe charge reference, so it cannot be refunded automatically. Escalate this one.',
    );
    // (5) order already carries a refund
    expect(text).toContain(
      'That order already carries a refund. V1 allows one refund per order.',
    );
  });

  it('renders the drop-status sentence on the drop that has not settled', async () => {
    // (6) The drop has not settled — the sentence a naive predicate cannot produce.
    //
    // On its own drop, because it is a verdict about the drop rather than the row. The
    // participant it renders for is otherwise a perfect refund candidate, so this
    // assertion is what proves the page consults the drop and not just `chargeStatus`.
    const { text } = await render(unsettledDropId);

    expect(text).toContain(
      'That drop has not finished settling yet, so its charges cannot be refunded. Try again once it has.',
    );
    // And it is a refusal, not a button: the drop-level guard applies to every row on
    // the drop, so a page that rendered this sentence beside a live Refund button would
    // be describing a button that returns 409.
    expect(text).not.toContain('Refund…');
  });

  it('offers one refund and four sentences on the settled drop', async () => {
    const { text } = await render(refundableDropId);

    // The button is what a human can press; four sentences plus one button is the whole
    // point of computing eligibility server-side. Counted rather than merely searched
    // for, because `toContain` cannot tell one occurrence from five.
    expect([...text.matchAll(/Refund…/g)]).toHaveLength(1);
    expect([...text.matchAll(/No refund available\./g)]).toHaveLength(4);
  });

  it('agrees with refusalFor when called directly, for every participant', async () => {
    // The page must not be its own authority. This recomputes each verdict from the
    // service and compares it to what the page printed — so a page that invented a
    // predicate would have to match `refusalFor` on all five fixtures to pass, which is
    // the property the loader's docblock claims and no other test can see.
    const { html, text } = await render(refundableDropId);

    const rows = await prisma.dropParticipant.findMany({
      where: { dropId: refundableDropId },
      select: {
        id: true,
        qty: true,
        amountCents: true,
        chargeStatus: true,
        customer: { select: { phone: true } },
        order: {
          select: {
            id: true,
            subtotalCents: true,
            platformFeeCents: true,
            stripeChargeId: true,
            refundedCents: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Five on this drop. The count is asserted first so a fixture that silently failed
    // to create a participant cannot make the loop below vacuous.
    expect(rows).toHaveLength(5);

    let refundable = 0;

    for (const row of rows) {
      const verdict = refusalFor({
        id: row.id,
        dropId: refundableDropId,
        qty: row.qty,
        amountCents: row.amountCents,
        chargeStatus: row.chargeStatus,
        dropStatus: 'CAPTURED',
        stripeAccountId: `acct_${PREFIX}`,
        order: row.order,
      });

      const hint = `···${(row.customer.phone ?? '').replace(/\D/g, '').slice(-4)}`;
      const rowText = rowFor(html, hint);

      if (verdict === null) {
        refundable += 1;
        // A null verdict is rendered as a button *and* as no sentence. Both halves,
        // because `refusal: null` reaching the component and the component still
        // printing "No refund available." is a real failure mode in a ternary.
        expect({ hint, offered: rowText.includes('Refund…') }).toEqual({ hint, offered: true });
        expect({ hint, said: rowText.includes('No refund available.') }).toEqual({
          hint,
          said: false,
        });
      } else {
        expect({ hint, sentence: rowText.includes(verdict.publicMessage) }).toEqual({
          hint,
          sentence: true,
        });
      }
    }

    // The header's count is the number of nulls, computed here from the service rather
    // than read off the page — so this is a comparison between two independent
    // derivations, not the page agreeing with itself.
    expect(refundable).toBe(1);
    expect(text).toContain(`${refundable} can be refunded now`);
    expect(text).toContain(`${rows.length} participants`);
  });
});

describe('/admin/drops/[id] — FR-805 on an admin screen', () => {
  it('shows the last four digits and never the number that is stored', async () => {
    const { text } = await render(refundableDropId);

    // The fixture's number really is in `Customer.phone` — this is not a vacuous
    // absence. The page's projection is what keeps it out.
    const stored = await prisma.customer.findFirstOrThrow({
      where: { phone: refundablePhone },
      select: { phone: true },
    });
    expect(stored.phone).toBe(refundablePhone);

    // The full number, and its national form without the +1, must both be absent.
    expect(text).not.toContain(refundablePhone);
    expect(text).not.toContain(refundablePhone.replace('+1', ''));
    // And the last four must be present, or "absent" would pass on a page that showed
    // no hint at all.
    const lastFour = refundablePhone.replace(/\D/g, '').slice(-4);
    expect(text).toContain(`···${lastFour}`);
    // Every rendered hint is exactly four digits behind dots — not a truncated number,
    // not one with a country code.
    for (const hint of hintsOf(text)) {
      expect(hint).toMatch(/^···\d{4}$/);
    }
  });

  it('shows no diner name or email either, because it never reads them', async () => {
    const { text } = await render(refundableDropId);

    // `AdminParticipantRow` has no field that could hold a name or an email — the same
    // argument the organiser page makes about its row type. Asserted rather than assumed:
    // the projection is a promise about a query, and a query is one `select` away from
    // changing.
    expect(text).not.toContain('@example.test');
  });
});

describe('/admin/drops/[id] — the force-fail control at drop scope', () => {
  it('offers it on a settled drop and explains itself on a draft', async () => {
    const settled = await render(refundableDropId);
    expect(settled.text).toContain('Force-fail…');

    const draft = await render(draftDropId);
    expect(draft.text).not.toContain('Force-fail…');
    // Not a silent absence: the sentence names the status and says when it appears.
    expect(draft.text).toContain('Force-fail is not offered for a draft drop.');
    expect(draft.text).toContain('disappears while settlement holds it');
  });

  it('refuses force-fail on a settling drop for the reason it refuses refunds', async () => {
    // `LOCKED` is absent from `FORCE_FAILABLE` and absent from `VOID_SWEEP_STATUSES`,
    // and those are the same judgement from two directions: settlement is mid-flight, so
    // neither cancelling the drop nor refunding one diner can be allowed to race it.
    //
    // Asserted here because the two refusals live in different modules — one a status
    // list in `admin/force-fail.ts`, one `isVoidSweepStatus` in `settlement/` — and the
    // page renders both. If either list gained `LOCKED`, this test fails and names which
    // control reappeared.
    const settling = await render(unsettledDropId);

    expect(settling.text).not.toContain('Force-fail…');
    expect(settling.text).toContain('Force-fail is not offered for a locked drop.');
    // And the row on the same drop refuses a refund, in the other module's sentence.
    expect(settling.text).toContain('That drop has not finished settling yet');
  });

  it('passes the money still out there as the amount the dialog will name', async () => {
    // The dialog is a `useState` branch and never opens in a render, so the number it
    // would show is not in this HTML. What *is* assertable is that the page hands the
    // control `capturedCents` — the money that has not been returned — rather than a
    // gross total, which is the same distinction the list page gets wrong when it uses
    // `subtotal`. Probed by mutating the loader to sum `subtotalCents` instead: this
    // assertion is one of the ones that fails.
    const { text } = await render(refundableDropId);
    expect(text).toContain(`${formatCents(HELD)} still held`);
    // The gross total never appears as the headline: 4375 is not what is still out there.
    expect(text).not.toContain(`${formatCents(GROSS)} still held`);
  });
});

describe('/admin/drops/[id] — a drop that does not exist', () => {
  it('throws the framework’s 404 rather than rendering an empty page', async () => {
    const page = await import('@/app/(admin)/admin/drops/[id]/page');

    // `notFound()` throws a digest-tagged error; Next turns it into a 404 page. Probed
    // rather than assumed: the bare render surface is the *throw*, not a rendered
    // not-found, so the assertion is on the digest.
    await expect(
      page.default({ params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('404s a malformed id rather than 500ing on a database error', async () => {
    const page = await import('@/app/(admin)/admin/drops/[id]/page');

    // Prisma answers `findUnique` with null for a non-uuid string rather than throwing;
    // probed here so the page's `notFound()` covers the mistake an operator makes by
    // editing the URL.
    await expect(
      page.default({ params: Promise.resolve({ id: 'not-a-uuid' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});

describe('/admin/drops/[id] — the refund route behind the page', () => {
  it('refuses a merchant session, so the page cannot be reached by one', async () => {
    const previous = sessionState.session;
    sessionState.session = {
      userId: merchantUserId,
      role: 'MERCHANT',
      mustChangePassword: false,
    };

    try {
      const route = await import('@/app/api/admin/participants/[id]/refund/route');
      const response = await route.POST(
        new NextRequest(
          `http://localhost/api/admin/participants/${caseIds.refundable}/refund`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'probe' }),
          },
        ),
        { params: Promise.resolve({ id: caseIds.refundable ?? '' }) },
      );

      expect(response.status).toBe(403);
    } finally {
      sessionState.session = previous;
    }
  });

  it('refuses an empty reason with a field error rather than moving money', async () => {
    const route = await import('@/app/api/admin/participants/[id]/refund/route');
    const response = await route.POST(
      new NextRequest(`http://localhost/api/admin/participants/${caseIds.refundable}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      }),
      { params: Promise.resolve({ id: caseIds.refundable ?? '' }) },
    );

    // 422 and a named field: the operator is told which box to fix. Reaching this
    // assertion at all is the point — validation runs before Stripe is consulted, so it
    // is provable in an environment with no keys.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors?: Record<string, string> };
    expect(body.fieldErrors?.reason).toBeTruthy();
  });

  it('cannot move money in this environment, and says which knob is missing', async () => {
    // Honest claim. `STRIPE_SECRET_KEY` is absent here, so the route returns 503 before
    // the refund service is reached. The assertion documents *that* — the page can be
    // driven up to the provider boundary and no further in this environment — rather than
    // pretending a refund was created.
    const route = await import('@/app/api/admin/participants/[id]/refund/route');
    const response = await route.POST(
      new NextRequest(`http://localhost/api/admin/participants/${caseIds.refundable}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Diner reported a missing plate.' }),
      }),
      { params: Promise.resolve({ id: caseIds.refundable ?? '' }) },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Stripe is not configured on this environment');

    // And nothing moved: the order is untouched, which is the claim that matters when a
    // request was refused at the boundary.
    const order = await prisma.order.findFirstOrThrow({
      where: { participantId: caseIds.refundable },
      select: { refundedCents: true },
    });
    expect(order.refundedCents).toBe(0);
  });
});

describe('/admin/drops/[id] — nothing writes', () => {
  it('renders without changing a row or refreshing the router', async () => {
    const before = await writeCounts();

    for (const dropId of [refundableDropId, unsettledDropId, draftDropId, returnedDropId]) {
      const view = await render(dropId);
      // The controls refresh the router only after a successful action. A page that did
      // it during render would re-render in a loop.
      expect(view.refreshes).toBe(0);
    }

    expect(await writeCounts()).toEqual(before);
  });
});

/**
 * Global counts, safe *within one process* only: `fileParallelism: false` serialises test
 * files, so nothing else in this run writes between the two calls. Nothing here scopes the
 * counts, so a *second* process is not covered — another `npm run verify` (refused by the
 * residue lock), `prisma studio`, a scratch script, the dev server — and its rows arrive as
 * this file's drift. See the Teardown section of `AGENTS.md`.
 */
async function writeCounts(): Promise<Record<string, number>> {
  // Scoped to this file's fixture namespace — see `src/lib/testing/scoped-counts.ts`.
  return scopedCounts(prisma, fx.scope(), ['orders', 'participants', 'audits', 'ledger']);
}
