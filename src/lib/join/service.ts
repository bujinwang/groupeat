import { joinAuthorised, joinFailed, joinStarted, thresholdReached } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { DEFAULT_PLAN_TIME_ZONE } from '@/lib/ai/plan';
import { prisma } from '@/lib/db/prisma';
import { resolveShareToken } from '@/lib/db/share-links';
import { normalisePublicCode } from '@/lib/drops/public-code';
import { logger } from '@/lib/logging/logger';
import { orderPath, orderUrl } from '@/lib/participant/order-link';
import { joinConfirmationMessage } from '@/lib/notify/compose-port';
import { type NotificationMessage } from '@/lib/notify/copy';
import { publicOrigin } from '@/lib/notify/public-origin';
import { momentLabel } from '@/lib/time/labels';
import { feesFromSnapshot } from './fees';
import { resolveDropView } from '@/lib/public/drop-view';
import { platformFeeCentsForOrder } from '@/lib/settlement/platform-fee';
import { type NotifyIntent, noopNotifyPort, type NotifyPort } from '@/lib/settlement/notify-port';

import {
  type JoinPaymentPort,
  isJoinProviderUnavailable,
  joinKey,
} from './payment-port';
import {
  availableQty,
  checkQty,
  dollars,
  type JoinRefusalReason,
  normalisePhone,
  phoneLast4,
  refusalFromBlocked,
  resolveJoinMoney,
} from './rules';

/**
 * The join service — FR-401…FR-407. One row, one lock, two transactions.
 *
 * ## The shape, and why it is two transactions rather than one
 *
 * The obvious implementation is a single transaction that locks the drop, checks
 * capacity, inserts the row and calls the provider. It is wrong, and the reason is
 * already written down in `settle.ts`: **do not make a network call while holding a
 * row lock.** A provider that takes 20 seconds to time out would hold the drop row
 * for 20 seconds, and every other diner joining that drop queues behind it. On a
 * popular drop that is a self-inflicted outage whose symptom is "joining is slow",
 * misdiagnosed as a database problem.
 *
 * So:
 *
 *  1. **Reserve** (transaction 1): lock the drop, sum what is sold, refuse or insert
 *     a `PENDING` participant. Commit. Short, and this is where every race is
 *     decided.
 *  2. **Authorise** (no lock held): ask the provider for a hold, keyed on the
 *     participant id.
 *  3. **Record** (transaction 2): `PENDING → AUTHORIZED`, or `→ FAILED`.
 *
 * ## Why `PENDING` counts against capacity but not toward the threshold
 *
 * A `PENDING` row means "this person has a plate reserved and we are asking their
 * bank". If capacity counted only `AUTHORIZED`, ten diners could start joining a
 * drop with four plates left, all ten would pass the check, and the drop would
 * oversell by six. So capacity includes `PENDING`.
 *
 * The threshold is different: `settle.ts` counts only `AUTHORIZED`, and it is right
 * to. A crashed join must not help a drop reach its minimum. The two readings
 * disagree on purpose, and each is the safe one for its own question.
 *
 * The cost of the choice is a stale `PENDING` holding one plate until it is
 * resolved. The cost of the alternative is a diner paying for food promised to
 * someone else.
 *
 * ## Why `server-only` is not imported
 *
 * Same reason as `db/prisma.ts`, `settlement/settle.ts` and `redemption/redeem.ts`:
 * it throws outside a React Server Component graph, which would make every test in
 * `service.test.ts` impossible. The boundary is enforced by the fact that no
 * `'use client'` file imports this module — checked in `rules.purity.test.ts`.
 */

export type JoinServiceDeps = {
  /** The money seam. The real port in production; the fake in tests. */
  readonly paymentPort: JoinPaymentPort;
  /**
   * The notification seam. Defaults to the no-op port, which logs the intent and
   * sends nothing — so FR-408's message is still unsent (D-5), but the *obligation*
   * ADR-003 puts on this path now has an emitter that a provider can be plugged
   * into without touching this function.
   */
  readonly notify?: NotifyPort;
  /**
   * Delivers FR-408's join confirmation — the "you're in" message.
   *
   * ## Why this is not `notify`
   *
   * `NotifyPort` speaks `NotifyIntent`, and that vocabulary describes **settlement
   * outcomes**. "You just joined" is not one: see `compose-port.ts`, which builds
   * this message from its own arguments rather than from an intent, precisely so the
   * shared union does not grow a sixth member that settlement never emits.
   *
   * So the confirmation gets its own seam. It takes a finished message, not an
   * intent, because the composing has already happened here — the zone, the cutoff
   * label and the consent decision are all facts this function holds and a sender
   * does not.
   *
   * ## Why the route supplies it
   *
   * Same reason the route supplies `paymentPort`: it is the layer that knows the
   * deployment. Resolving a provider inside the domain would put a Twilio token in
   * the module graph of a function that unit tests call directly.
   *
   * Absent means "composed but not delivered" — logged, never silently dropped. That
   * is the state this slice was in before the seam existed, except that nothing was
   * composed at all.
   */
  readonly confirm?: (message: NotificationMessage) => Promise<void>;
  /** Injected so a test can pin the clock. Defaults to now. */
  readonly now?: Date;
};

export type JoinRequest = {
  /** `Drop.publicCode` — the bearer token in the URL. */
  readonly publicCode: string;
  /** Digits as typed. Normalised here, so no caller has to remember the format. */
  readonly phone: string;
  readonly qty: number;
  readonly name?: string;
  /**
   * Whether the diner ticked the consent box.
   *
   * Absent means `false`. An unticked box is not consent, and defaulting the other
   * way would be a CASL problem dressed as a convenience.
   */
  readonly consented?: boolean;
  /**
   * FR-802 — the organiser's share token, when the diner arrived through their link.
   *
   * Optional, and it stays optional all the way down. Attribution records how somebody
   * arrived; a record that can refuse a join is a record that costs the merchant a
   * sale. An unknown, malformed, or foreign token is resolved to `null` and the diner
   * joins exactly as they would have without it.
   */
  readonly organiserToken?: string;
  /**
   * The `pm_…` id from Stripe.js, created in the browser.
   *
   * ## Why this field was missing until 2b, and what that cost
   *
   * Slice 2a built the domain and the API against a fake, and the fake never needed
   * a card. The real port *does* — it throws `JoinProviderUnavailableError` when
   * this is absent, precisely so that shipping 2b without wiring the card through
   * would fail loudly rather than create an unconfirmable intent.
   *
   * That guard worked, but it exposed the gap one layer late: nothing in the wire
   * format carried a `pm_`, so with keys configured **every** real join would have
   * thrown before reaching Stripe. This is the cheapest possible version of that
   * bug — no money moved, no customer saw it — and it is the reason the live run
   * matters more than the fake does.
   *
   * Optional because a fake-backed test has no card, and because a `PAYMENTS_NOT_
   * CONFIGURED` deployment never reaches the port. The real port refuses absent,
   * which is the check that counts.
   */
  readonly paymentMethodId?: string;
  /** Recorded only when supplied. Never logged. */
  readonly ipAddress?: string;
};

/** The fields of a join that may leave the service. No phone number, ever, in full. */
export type JoinSuccess = {
  readonly ok: true;
  readonly participantId: string;
  readonly dropId: string;
  readonly qty: number;
  readonly amountCents: number;
  /** `"$26.20"` — formatted once, here (CONTRIBUTING.md). */
  readonly amountLabel: string;
  readonly phoneLast4: string;
  /**
   * The row's real state, not an assumption.
   *
   * `PENDING` is returned when this call found an existing join whose authorisation
   * never resolved — a crashed earlier attempt. Reporting that as `AUTHORIZED`
   * would tell a diner their card is held when nobody knows.
   */
  readonly status: 'AUTHORIZED' | 'PENDING';
  /** True when this call found an existing join rather than creating one. */
  readonly alreadyJoined: boolean;
  readonly minQty: number;
  readonly maxQty: number;
  readonly cutoffAt: Date;
  /**
   * `"Thursday 1:00 PM"` in the merchant's zone — the words for `cutoffAt`.
   *
   * Added because the confirmation screen was already reading `cutoffLabel` and
   * nothing produced it, so it printed "people join by **undefined**". The field was
   * declared client-side in 2b and never sent; the client cast the response to its
   * own type, so `tsc` had no way to object. See `join/wire.ts`.
   *
   * Authored here rather than in the component because the zone is the merchant's:
   * a browser would format in the diner's, which is wrong for anyone travelling or
   * on a phone set to another country.
   */
  readonly cutoffLabel: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** ADR-003: the drop already has its minimum, so the copy drops the condition. */
  readonly isConfirmedAlready: boolean;
  /**
   * Where this diner can find their own order later — the path, not an absolute URL.
   *
   * ## Why this exists
   *
   * Before this field, a diner who joined got a confirmation screen and **nothing
   * else**. The redemption code is minted at capture and lives on `/d/:code/mine`,
   * which needs a bearer token — and that token was only ever composed inside the
   * settlement job, for a text message that no sender delivers. So a diner who closed
   * the tab had no route back to their own order: not a bookmarkable URL, not a link
   * on the page, nothing. The one page that answers "did my card get charged, and what
   * is my code" was reachable only from a message that does not exist.
   *
   * That is the same shape as the pickup-transition defect: a capability built, wired
   * into a channel that was never opened, and therefore invisible from every angle
   * except the diner's.
   *
   * ## Why a path rather than an absolute URL
   *
   * The diner is on the deployment's origin already. A relative path cannot say
   * `localhost` and cannot disagree with `APP_URL`. The absolute form still matters
   * for SMS, and both are built by `orderPath`/`orderUrl` in
   * `participant/order-link.ts`, so the two cannot drift.
   *
   * It is returned on a **success** and on an **already-joined** success alike: a
   * diner who refreshes has the same need to get back as one who just joined.
   */
  readonly orderPath: string;
};

export type JoinFailure = {
  readonly ok: false;
  readonly reason: JoinRefusalReason;
  /** The HTTP status the route should use. */
  readonly status: 400 | 402 | 404 | 409 | 422 | 500 | 503;
};

export type JoinResult = JoinSuccess | JoinFailure;

function fail(reason: JoinRefusalReason, status: JoinFailure['status']): JoinFailure {
  return { ok: false, reason, status };
}

/**
 * Records a refusal in the funnel.
 *
 * The log line and the funnel event are written from the same `reason` string on
 * purpose: a refusal reason added to `rules.ts` is then measured automatically,
 * rather than needing a second hand-maintained list here that would silently omit
 * it. Analytics is not allowed to break the refusal path, and `record`/`emit`
 * cannot throw.
 */
function recordRefusal(reason: JoinRefusalReason, dropId?: string): void {
  record(joinFailed({ dropId, reason }));
}

/**
 * A refusal raised inside the transaction so that it rolls back.
 *
 * An exception for control flow, and the reason is mechanical: `return` inside a
 * Prisma interactive transaction **commits** it, so a refused join that returned
 * early would commit whatever it had already written — a `Customer` row, say, for a
 * join that never happened. Throwing is the only way to both refuse and roll back,
 * and this class carries the refusal so the caller gets a value rather than a stack
 * trace.
 */
class JoinRefused extends Error {
  readonly result: JoinFailure;
  /**
   * Which drop, when it is known.
   *
   * `NOT_FOUND` is thrown before a drop row exists, so the field is optional and
   * the refusal is still measured — just not attributable to a drop, which is
   * correct: there is no drop it happened to.
   */
  readonly dropId?: string;

  constructor(result: JoinFailure, dropId?: string) {
    super(`join refused: ${result.reason}`);
    this.name = 'JoinRefused';
    this.result = result;
    this.dropId = dropId;
  }
}

type Reserved = {
  readonly participantId: string;
  readonly dropId: string;
  /** For analytics only — never rendered, never part of the response. */
  readonly merchantId: string;
  readonly qty: number;
  readonly amountCents: number;
  readonly platformFeeCents: number;
  readonly stripeAccountId: string | null;
  /**
   * The browser's `pm_…`, carried from the request to the port.
   *
   * Held on the reservation rather than re-read from `request` at the call site so
   * that the two paths which build a `Reserved` (fresh join, existing join) both have
   * to say what they are doing. An existing join answers without touching a card, and
   * `null` there is the honest value rather than a forgotten field.
   */
  readonly paymentMethodId: string | null;
  readonly minQty: number;
  readonly maxQty: number;
  readonly cutoffAt: Date;
  /**
   * The merchant's IANA zone, carried so the response can name the cutoff in the
   * kitchen's local time rather than the server's or the diner's.
   *
   * Read through the `Merchant` relation in the same transaction that already reads
   * the merchant's `stripeAccountId`, so it costs no extra round trip.
   */
  readonly merchantTimezone: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly isConfirmedAlready: boolean;
  /** `false` when an existing live join was found and nothing was created. */
  readonly newlyCreated: boolean;
  readonly existingStatus: 'AUTHORIZED' | 'PENDING' | null;
};

export async function joinDrop(
  request: JoinRequest,
  deps: JoinServiceDeps,
): Promise<JoinResult> {
  const now = deps.now ?? new Date();
  const notify = deps.notify ?? noopNotifyPort();

  /**
   * The code, normalised once, before anything reads it — and why it is bound here
   * rather than at the route.
   *
   * `joinDrop` looks the drop up exactly **once**, inside the transaction, with a raw
   * `SELECT … FOR UPDATE` that holds the lock. That single read is the reason this
   * cannot be left to the caller: `FOR UPDATE` locks the row it *matches*, so a request
   * carrying a lowercased code or a trailing slash would lock nothing, fall through to
   * `NOT_FOUND`, and report a valid drop as nonexistent. That is the same 404 a diner
   * sees for a mistyped code, so it would never have been reported as a bug — it would
   * have looked like a dead offer.
   *
   * The code is also read **four more times after the lookup**, and not for matching:
   * three `orderPath()` calls and one `orderUrl()` call compose the link that goes into
   * the confirmation SMS. Those are the ones a "normalise at the edge" would leave
   * broken in a way that is easy to miss, because the join still *succeeds* — it just
   * mints `/d/abc2345/mine` for a drop whose canonical URL is `/d/ABC2345`. Two URLs
   * for one order: the link in the message disagrees with the link on the page, share
   * counts split, and a lowercased code ends up in transaction logs.
   *
   * So the normalised value is bound to `request` once, at the top, and every read in
   * this function — the lock and the four link compositions — uses it by construction
   * rather than by each call site remembering.
   */
  const publicCode = normalisePublicCode(request.publicCode);
  request = { ...request, publicCode };

  // --------------------------------------------------------------- 1. Input
  //
  // Cheap refusals before opening a transaction. Normalising the phone here also
  // means the participant row and the `ConsentRecord` cannot disagree about its
  // format — the record must reference the same string the texts will go to.
  const phone = normalisePhone(request.phone);
  if (!phone.ok) {
    logger.info('join.refused', { reason: 'BAD_PHONE' });
    recordRefusal('BAD_PHONE');
    return fail('BAD_PHONE', 422);
  }

  // `join_started` — somebody with a valid request tried to join. Emitted here
  // rather than at the route so that the funnel's second step means "a real
  // attempt", not "a request arrived": a bodiless POST from a scanner is not a
  // diner, and counting it would make the funnel busy in a way that is not true.
  // No `merchantId` yet — the drop has not been read, and reading it here to
  // decorate a log line would be a second query on every attempt.
  record(joinStarted({ qty: request.qty }));

  // -------------------------------------------------- 2. Reserve, under the lock
  let reserved: Reserved;

  try {
    reserved = await prisma.$transaction(async (tx) => {
      /**
       * The lock.
       *
       * `FOR UPDATE` on the **drop** row, not on participant rows, because capacity
       * is a sum over participants: locking a participant would lock nothing the
       * next joiner reads. Serialising joins per drop is the guarantee needed and
       * costs nothing at this scale.
       *
       * Under READ COMMITTED (Prisma's Postgres default) the row is re-read after
       * the lock is won, so the values below are the committed ones — the same
       * idiom, and the same reason, as `cutoff-decision.ts`.
       */
      const locked = await tx.$queryRaw<
        {
          id: string;
          merchantId: string;
          status: string;
          dealPriceCents: number;
          minQty: number;
          maxQty: number;
          maxPerCustomer: number;
          cutoffAt: Date;
          windowStart: Date;
          windowEnd: Date;
          guardrailSnapshot: unknown;
        }[]
      >`
        SELECT "id", "merchantId", "status"::text AS "status", "dealPriceCents", "minQty",
               "maxQty", "maxPerCustomer", "cutoffAt", "windowStart", "windowEnd",
               "guardrailSnapshot"
          FROM "Drop"
         WHERE "publicCode" = ${request.publicCode}
           FOR UPDATE`;

      const drop = locked[0];
      if (!drop || drop.status === 'DRAFT') {
        // A draft and a nonexistent code answer identically, on purpose: a guessed
        // code must not reveal that an unpublished drop exists.
        throw new JoinRefused(fail('NOT_FOUND', 404));
      }

      // Sold = committed or being committed. `PENDING` included; see the docblock.
      const soldRows = await tx.$queryRaw<{ sold: number }[]>`
        SELECT COALESCE(SUM("qty"), 0)::int AS "sold"
          FROM "DropParticipant"
         WHERE "dropId" = ${drop.id}
           AND "authStatus" IN ('PENDING', 'AUTHORIZED')`;
      const soldQty = Number(soldRows[0]?.sold ?? 0);

      // The quantity limit for this request: the drop's cap, clamped, and never
      // more than what is left.
      const limit = availableQty({
        maxPerCustomer: drop.maxPerCustomer,
        remaining: drop.maxQty - soldQty,
      });
      const qtyCheck = checkQty(request.qty, limit);

      // The drop's own state machine, taken from `drop-view.ts` rather than
      // re-derived. Passing it the same numbers the page used is what stops the
      // button and the API disagreeing about whether the door is open.
      const view = resolveDropView({
        status: drop.status,
        minQty: drop.minQty,
        maxQty: drop.maxQty,
        cutoffAt: drop.cutoffAt,
        windowStart: drop.windowStart,
        windowEnd: drop.windowEnd,
        joinedQty: soldQty,
        now,
      });

      // An existing live join answers before the quantity check does: a person who
      // already holds four plates asking for one more should hear "you are already
      // in", not "you asked for too many". The customer upsert has to happen first
      // to know who this is, which is why it precedes both checks.
      const customer = await tx.customer.upsert({
        where: { phone: phone.e164 },
        create: { phone: phone.e164, ...(request.name ? { name: request.name } : {}) },
        update: request.name ? { name: request.name } : {},
        select: { id: true },
      });

      const existing = await tx.dropParticipant.findUnique({
        where: { dropId_customerId: { dropId: drop.id, customerId: customer.id } },
        select: { id: true, qty: true, amountCents: true, authStatus: true },
      });

      // Read once, above the branch, because **both** exits need the same two facts.
      //
      // The time zone is needed even on the already-joined path: that response also
      // carries `cutoffLabel`, and a diner who refreshes must see the same sentence
      // as one who just joined. Reading it inside each branch is how one of the two
      // ends up with a defaulted or missing zone — the shape of bug that produced the
      // "undefined" cutoff in the first place.
      //
      // It is one statement either way, and this is inside a transaction holding
      // `FOR UPDATE` on the drop, so it is also the cheaper of the two arrangements.
      const merchant = await tx.merchant.findUnique({
        where: { id: drop.merchantId },
        select: { stripeAccountId: true, timezone: true },
      });
      // A missing merchant row is impossible (the FK is enforced), but `??` rather
      // than `!` means a broken assumption degrades to the default zone instead of
      // throwing inside the reservation and turning a join into a 500.
      const merchantTimezone = merchant?.timezone ?? DEFAULT_PLAN_TIME_ZONE;

      if (existing && existing.authStatus !== 'FAILED') {
        // The double-submit case. Answer with the join they already have rather
        // than putting a second hold on their card. `@@unique([dropId, customerId])`
        // is the schema half of this rule; this is the behaviour half.
        if (existing.authStatus === 'AUTHORIZED' || existing.authStatus === 'PENDING') {
          return {
            participantId: existing.id,
            dropId: drop.id,
            merchantId: drop.merchantId,
            qty: existing.qty,
            amountCents: existing.amountCents,
            platformFeeCents: 0,
            stripeAccountId: null,
            // No card is touched on an existing join — the early return skips the
            // port entirely — so `null` here is a statement, not a default.
            paymentMethodId: null,
            minQty: drop.minQty,
            maxQty: drop.maxQty,
            cutoffAt: drop.cutoffAt,
            merchantTimezone,
            windowStart: drop.windowStart,
            windowEnd: drop.windowEnd,
            isConfirmedAlready: view.thresholdMet,
            newlyCreated: false,
            existingStatus: existing.authStatus,
          };
        }
        // VOIDED / EXPIRED: the drop is past its cutoff, so `view` will already have
        // refused above. Belt and braces — treat it as closed rather than reviving it.
        throw new JoinRefused(fail('CLOSED', 409), drop.id);
      }

      // The drop's own state, and whether *this quantity* fits in what is left.
      // Checked before the per-customer cap, because "this one is full" and "you
      // asked for one too many" are different sentences and the first is the one a
      // diner on a sold-out drop needs to read.
      const blockedReason = refusalFromBlocked(
        view.joinBlockedReason,
        request.qty,
        drop.maxQty - soldQty,
      );
      if (blockedReason !== null) {
        throw new JoinRefused(fail(blockedReason, 409), drop.id);
      }

      if (!qtyCheck.ok) {
        // Past this point the drop has room, so the only remaining objection is the
        // per-customer cap.
        throw new JoinRefused(fail('BAD_QTY', 422), drop.id);
      }

      // ---- Money. Authored here and nowhere else (ADR-002).
      const fees = feesFromSnapshot(drop.guardrailSnapshot);
      if (fees === null) {
        // Logged as a data error with the drop id, because it is one: a published
        // drop whose snapshot this build cannot read.
        logger.error('join.pricing_unavailable', { dropId: drop.id });
        throw new JoinRefused(fail('PRICE_UNAVAILABLE', 500), drop.id);
      }

      // Per unit, then multiplied — ADR-004 §4, via the one function that
      // implements it. Qty is a positive integer here because `checkQty` passed.
      const platformFeeCents = platformFeeCentsForOrder({
        qty: request.qty,
        dealPriceCents: drop.dealPriceCents,
        fees,
      });

      const money = resolveJoinMoney({
        qty: request.qty,
        dealPriceCents: drop.dealPriceCents,
        platformFeeCents,
      });
      if (!money.ok) {
        logger.error('join.pricing_unavailable', { dropId: drop.id });
        throw new JoinRefused(fail('PRICE_UNAVAILABLE', 500), drop.id);
      }

      // Consent, written in the same transaction as the join: a consent record that
      // can exist without the join it belongs to, or vice versa, is a record nobody
      // can rely on in a CASL dispute.
      if (request.consented === true) {
        await tx.consentRecord.create({
          data: {
            phone: phone.e164,
            basis: 'EXPRESS',
            source: 'drop_join',
            ...(request.ipAddress ? { ipAddress: request.ipAddress } : {}),
          },
          select: { id: true },
        });
      }

      /**
       * Attribution, resolved in the same transaction as the participant row so the
       * link and the row cannot disagree.
       *
       * The token is scoped to *this* drop by `resolveShareToken`, so a link from
       * another drop credits nobody. That check is what stops a single shared link
       * from being pasted onto every drop in the corridor to farm commission (FR-804
       * pays on this number).
       *
       * Deliberately not wrapped in a try/catch that hides everything: the resolver
       * already returns `null` for every bad input, and a genuine database failure
       * inside the transaction *should* roll the join back rather than write a
       * participant whose attribution is silently wrong.
       */
      const shareLink = request.organiserToken
        ? await resolveShareToken({ token: request.organiserToken, dropId: drop.id })
        : null;

      const participant = existing
        ? // A previous attempt was declined. Reuse the row: it keeps one person's
          // history in one place and keeps the unique index honest.
          await tx.dropParticipant.update({
            where: { id: existing.id },
            data: {
              qty: request.qty,
              amountCents: money.money.amountCents,
              platformFeeCents: money.money.platformFeeCents,
              authStatus: 'PENDING',
              chargeStatus: 'NONE',
              paymentIntentId: null,
              redeemedQty: 0,
              redeemedAt: null,
              redeemedByUserId: null,
              // Attribution follows the join that *succeeded*. The reused row is a
              // declined attempt, so crediting the link that produced that attempt
              // rather than this one would pay the wrong person. Absent a token the
              // original attribution is left alone — `undefined` means "do not touch".
              ...(shareLink ? { shareLinkId: shareLink.shareLinkId } : {}),
            },
            select: { id: true },
          })
        : await tx.dropParticipant.create({
            data: {
              dropId: drop.id,
              customerId: customer.id,
              qty: request.qty,
              amountCents: money.money.amountCents,
              platformFeeCents: money.money.platformFeeCents,
              authStatus: 'PENDING',
              chargeStatus: 'NONE',
              shareLinkId: shareLink?.shareLinkId ?? null,
            },
            select: { id: true },
          });

      // One read, two fields: the Connect account for the charge and the time zone
      // for the words. (`merchant` was fetched above, before the already-joined
      // branch, because both exits need the zone.)
      const stripeAccountId = merchant?.stripeAccountId ?? null;

      return {
        participantId: participant.id,
        dropId: drop.id,
        merchantId: drop.merchantId,
        qty: request.qty,
        amountCents: money.money.amountCents,
        platformFeeCents: money.money.platformFeeCents,
        stripeAccountId,
        paymentMethodId: request.paymentMethodId ?? null,
        minQty: drop.minQty,
        maxQty: drop.maxQty,
        cutoffAt: drop.cutoffAt,
        merchantTimezone,
        windowStart: drop.windowStart,
        windowEnd: drop.windowEnd,
        isConfirmedAlready: view.thresholdMet,
        newlyCreated: true,
        existingStatus: null,
      };
    });
  } catch (error) {
    if (error instanceof JoinRefused) {
      logger.info('join.refused', { reason: error.result.reason });
      // One place for all six in-transaction refusals (not found, closed, blocked,
      // bad qty, price unavailable) rather than a call beside each `throw` — the
      // `reason` travels on the error, so a seventh throw added later is measured
      // without anyone remembering to add a line here.
      recordRefusal(error.result.reason, error.dropId);
      return error.result;
    }
    throw error;
  }

  // An existing join: nothing to authorise, and nothing new to log.
  if (!reserved.newlyCreated && reserved.existingStatus !== null) {
    logger.info('join.already_joined', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      status: reserved.existingStatus,
    });
    return {
      ok: true,
      participantId: reserved.participantId,
      dropId: reserved.dropId,
      qty: reserved.qty,
      amountCents: reserved.amountCents,
      amountLabel: dollars(reserved.amountCents),
      phoneLast4: phoneLast4(phone.e164),
      status: reserved.existingStatus,
      alreadyJoined: true,
      // A diner who refreshes has the same need to get back as one who just joined.
      orderPath: orderPath({
        publicCode: request.publicCode,
        participantId: reserved.participantId,
        dropId: reserved.dropId,
      }),
      minQty: reserved.minQty,
      maxQty: reserved.maxQty,
      cutoffAt: reserved.cutoffAt,
      cutoffLabel: momentLabel(reserved.cutoffAt, reserved.merchantTimezone),
      windowStart: reserved.windowStart,
      windowEnd: reserved.windowEnd,
      isConfirmedAlready: reserved.isConfirmedAlready,
    };
  }

  // -------------------------------------- 3. Authorise, with no lock held
  if (reserved.stripeAccountId === null) {
    // A merchant who has not finished Connect onboarding cannot take a card. Mark
    // the reserved row failed rather than leaving a `PENDING` that will never
    // resolve, and release the plate.
    await markFailed(reserved.participantId);
    logger.info('join.refused', { reason: 'PAYMENTS_NOT_CONFIGURED', dropId: reserved.dropId });
    recordRefusal('PAYMENTS_NOT_CONFIGURED', reserved.dropId);
    return fail('PAYMENTS_NOT_CONFIGURED', 503);
  }

  let outcome;
  try {
    outcome = await deps.paymentPort.createJoinAuthorisation({
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      stripeAccountId: reserved.stripeAccountId,
      amountCents: reserved.amountCents,
      platformFeeCents: reserved.platformFeeCents,
      currency: 'cad',
      idempotencyKey: joinKey(reserved.participantId),
      // Present only when the browser sent one. Omitted rather than passed as
      // `undefined` so the port's `if (!request.paymentMethodId)` check fires on
      // absence exactly as it reads, and so a logging middleware that serialises
      // the request cannot distinguish "no card" from "a card id of undefined".
      ...(reserved.paymentMethodId ? { paymentMethodId: reserved.paymentMethodId } : {}),
    });
  } catch (error) {
    if (isJoinProviderUnavailable(error)) {
      // The state is UNKNOWN: the hold may or may not exist. Leave the row
      // `PENDING` on purpose — it holds the plate, so the diner is not told they
      // have food they might not, and reconciliation resolves it by idempotency
      // key rather than by guessing.
      logger.warn('join.payment_unavailable', {
        dropId: reserved.dropId,
        participantId: reserved.participantId,
        reason: error.reason,
      });
      recordRefusal('PAYMENT_UNAVAILABLE', reserved.dropId);
      return fail('PAYMENT_UNAVAILABLE', 503);
    }
    throw error;
  }

  // -------------------------------------------------- 4. Record the answer
  //
  // The row is matched by id **and** by the `PENDING` state it was left in. If a
  // concurrent request already resolved it, or a unique constraint rejected the
  // write, the update matches nothing — and `updateMany` reports that as `count: 0`
  // instead of throwing. A hold with no row recording it is the worst outcome
  // available here, so a missing row is treated as a failure the caller can see
  // rather than a success with a log line.
  if (outcome.status === 'DECLINED') {
    await markFailed(reserved.participantId);
    logger.info('join.declined', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
      declineCode: outcome.declineCode,
    });
    recordRefusal('PAYMENT_DECLINED', reserved.dropId);
    return fail('PAYMENT_DECLINED', 402);
  }

  const recorded = await prisma.$transaction(async (tx) => {
    // The drop row is locked for the same reason the reserve transaction locks it:
    // the before/after totals below are only meaningful if no other join can flip
    // a participant in between reading them and flipping ours. There is no network
    // call here — the provider has already answered — so the lock is held for two
    // statements, which is the whole cost.
    await tx.$queryRaw`SELECT "id" FROM "Drop" WHERE "id" = ${reserved.dropId} FOR UPDATE`;

    const before = await thresholdTotal(tx, reserved.dropId);

    const updated = await tx.dropParticipant.updateMany({
      where: { id: reserved.participantId, authStatus: 'PENDING' },
      data: {
        authStatus: 'AUTHORIZED',
        paymentIntentId: outcome.paymentIntentId,
      },
    });

    const after = updated.count === 1 ? before + reserved.qty : before;

    return { count: updated.count, before, after };
  });

  if (recorded.count !== 1) {
    // The card is held but the row is not ours. Logged with the intent id so the
    // money can be traced and released by hand or by M8's reconciliation; the diner
    // is told the truth (nothing is confirmed) rather than that they are in.
    logger.error('join.record_failed', {
      dropId: reserved.dropId,
      participantId: reserved.participantId,
    });
    recordRefusal('PAYMENT_UNAVAILABLE', reserved.dropId);
    return fail('PAYMENT_UNAVAILABLE', 503);
  }

  logger.info('join.authorised', {
    dropId: reserved.dropId,
    participantId: reserved.participantId,
    qty: reserved.qty,
    amountCents: reserved.amountCents,
    platformFeeCents: reserved.platformFeeCents,
  });

  // ------------------------------------------------ 5. The funnel (§10.1)
  //
  // `join_authorised` is the numerator of PRD §10.2's join-conversion target, so
  // it is emitted on the one path where a hold genuinely exists. A `PENDING` row is
  // not a join; the authorisation is.
  record(
    joinAuthorised({
      dropId: reserved.dropId,
      merchantId: reserved.merchantId,
      participantId: reserved.participantId,
      qty: reserved.qty,
      amountCents: reserved.amountCents,
    }),
  );

  // The crossing is decided by `thresholdReached` from the totals the transaction
  // just read, on the same population `settle.ts` and the public page use —
  // `AUTHORIZED` only, because a `PENDING` row holds a plate it has not paid for.
  // Passing both totals rather than a boolean keeps the "exactly once" logic in one
  // testable place: the builder returns `null` unless this authorisation is the one
  // that took the drop from below its minimum to at or past it.
  const crossing = thresholdReached({
    dropId: reserved.dropId,
    merchantId: reserved.merchantId,
    minQty: reserved.minQty,
    previousQty: recorded.before,
    currentQty: recorded.after,
  });
  record(crossing);

  // ------------------------------------------------ 6. The one boundary (§4.8)
  //
  // ADR-003 puts a *copy* obligation on the join path: the diner who takes the drop
  // over its minimum must be told the drop is going ahead but still filling. The
  // `THRESHOLD_REACHED_STILL_FILLING` intent was declared in `notify-port.ts` with
  // no emitter, on the stated grounds that it would be visible to whoever wrote the
  // join path. This is that emitter.
  //
  // It fires only on the crossing — the same `null`-unless-exactly-once rule as the
  // funnel event — so 20 diners joining a 20-plate minimum produce one message, not
  // one per join. Sending it to everybody on every join would be 20 texts that say
  // the same thing, which is how an SMS channel gets muted.
  //
  // ## Why it is fire-and-forget
  //
  // Notification must never fail a join (§3.5). The hold is already real at this
  // point and the participant row is `AUTHORIZED`; a failure to send a courtesy
  // message cannot be allowed to 503 a diner whose card has been successfully held.
  // `deliverNotify` swallows and logs, exactly like settlement's `deliver`.
  // ## Why it is awaited rather than fire-and-forget
  //
  // It used to be `void deliverNotify(...)`. On a long-lived server that is merely
  // sloppy; on the deployment this ships to it is a dropped message. A serverless
  // invocation is frozen when the response is returned, so a promise nobody awaited
  // may never settle — the text is composed, the log line says it was attempted, and
  // no diner receives anything. `deliverNotify` absorbs every failure, so awaiting
  // cannot turn a sent hold into a 503.
  if (crossing) {
    await deliverNotify(notify, [
      {
        kind: 'THRESHOLD_REACHED_STILL_FILLING',
        dropId: reserved.dropId,
        participantId: reserved.participantId,
        phone: phone.e164,
        qty: reserved.qty,
        cutoffAt: reserved.cutoffAt,
      },
    ], reserved.merchantTimezone);
  }

  // ------------------------------------------- 7. FR-408 — the confirmation
  //
  // The message this build has never been able to send. Everything it needs is
  // already in `reserved` and `request`, so it is composed here rather than looked up
  // again, and the consent gate is a parameter of `joinConfirmationMessage` — an
  // explicit decision in one place rather than a missing call site.
  //
  // `publicOrigin()` returns `undefined` when `APP_URL` is unset or is not a public
  // https origin, in which case the message carries `orderPath` instead of a URL. An
  // explicit origin or no link — never a guess.
  const origin = publicOrigin();
  const orderHref = origin
    ? orderUrl({
        baseUrl: origin,
        publicCode: request.publicCode,
        participantId: reserved.participantId,
        dropId: reserved.dropId,
      })
    : undefined;

  const confirmation = joinConfirmationMessage({
    consented: request.consented === true,
    qty: reserved.qty,
    amountCents: reserved.amountCents,
    cutoffAt: reserved.cutoffAt,
    timeZone: reserved.merchantTimezone,
    orderPath: orderPath({
      publicCode: request.publicCode,
      participantId: reserved.participantId,
      dropId: reserved.dropId,
    }),
    // Omitted rather than passed as `undefined`, so the composer's `orderUrl?` is
    // absent by construction rather than present-and-falsy.
    ...(orderHref ? { orderUrl: orderHref } : {}),
    phone: phone.e164,
  });

  if (confirmation && deps.confirm) {
    try {
      await deps.confirm(confirmation);
    } catch (error) {
      // Same rule as every other notification on this path: a courtesy message must
      // not fail a join whose card has already been held (§3.5).
      logger.warn('notification.failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  } else if (confirmation) {
    // Composed, no seam. Logged with the kind and nothing else — the body carries a
    // bearer token and the diner's amount, neither of which may reach a log (§11.7).
    logger.info('notification.seam_missing', { kind: confirmation.kind });
  }

  return {
    ok: true,
    participantId: reserved.participantId,
    dropId: reserved.dropId,
    qty: reserved.qty,
    amountCents: reserved.amountCents,
    amountLabel: dollars(reserved.amountCents),
    phoneLast4: phoneLast4(phone.e164),
    status: 'AUTHORIZED',
    alreadyJoined: false,
    // The route a diner takes back to this order. Composed here rather than in the
    // component so the token is signed server-side and the client never sees a
    // signing key, and so this link and the one in the notification are built by the
    // same function.
    orderPath: orderPath({
      publicCode: request.publicCode,
      participantId: reserved.participantId,
      dropId: reserved.dropId,
    }),
    minQty: reserved.minQty,
    maxQty: reserved.maxQty,
    cutoffAt: reserved.cutoffAt,
    cutoffLabel: momentLabel(reserved.cutoffAt, reserved.merchantTimezone),
    windowStart: reserved.windowStart,
    windowEnd: reserved.windowEnd,
    isConfirmedAlready: reserved.isConfirmedAlready,
  };
}

/**
 * Notification must never fail a join — the same rule settlement's `deliver` keeps.
 *
 * A courtesy SMS for a drop that just crossed its minimum is the least important
 * thing in this function, and the participant's card is already held by the time it
 * is attempted. Letting a provider timeout produce a 503 here would tell a diner
 * their join failed while a hold sits on their card, which is the worst of both
 * answers.
 */
async function deliverNotify(
  notify: NotifyPort,
  intents: readonly NotifyIntent[],
  /**
   * The merchant's zone, so the sentence can name the cutoff locally.
   *
   * The confirmation's own zone is baked in at composition; this one reaches the
   * composer through the port's per-batch context. Both come from
   * `reserved.merchantTimezone`.
   */
  timeZone?: string,
): Promise<void> {
  if (intents.length === 0) {
    return;
  }
  try {
    await notify.notify(intents, timeZone ? { timeZone } : {});
  } catch (error) {
    logger.warn('notification.failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Marks a reserved row failed, releasing no capacity-visible plate.
 *
 * `FAILED` is excluded from the capacity sum in the reserve transaction, so this
 * frees the plate for the next diner. It is written in its own statement rather than
 * in a transaction because it is a single-row update whose only requirement is that
 * it happens at all.
 */
async function markFailed(participantId: string): Promise<void> {
  await prisma.dropParticipant.update({
    where: { id: participantId },
    data: { authStatus: 'FAILED' },
    select: { id: true },
  });
}

/**
 * Plates on a drop that count toward its **threshold**.
 *
 * `AUTHORIZED` only. This is deliberately a different population from the one the
 * reserve transaction sums for **capacity**, which includes `PENDING` — the two
 * questions have different safe answers and conflating them produces a specific,
 * plausible-looking bug:
 *
 *   - Capacity must include `PENDING`, or a drop oversells by the number of joins
 *     in flight.
 *   - The threshold must exclude `PENDING`, or a join whose card was never
 *     authorised helps a drop "reach" its minimum, and a drop that reached its
 *     minimum is a drop whose diners get charged.
 *
 * It matches `public-drops.ts` (`authStatus: 'AUTHORIZED'`) and `settle.ts`
 * (FR-501), so the number a diner sees, the number that decides the cutoff, and the
 * number the funnel reports are the same number.
 */
async function thresholdTotal(
  tx: { $queryRaw: typeof prisma.$queryRaw },
  dropId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ total: number }[]>`
    SELECT COALESCE(SUM("qty"), 0)::int AS "total"
      FROM "DropParticipant"
     WHERE "dropId" = ${dropId}
       AND "authStatus" = 'AUTHORIZED'`;
  return Number(rows[0]?.total ?? 0);
}
