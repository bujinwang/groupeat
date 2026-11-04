/**
 * Structured logging — one JSON object per line on stdout.
 *
 * `no-console` is an ESLint error (AC-12), so this is the only place the process
 * writes to stdout. Two guarantees:
 *
 *   1. **Typed events.** `LogEventMap` declares the fields each event may carry.
 *      No event type has an `email`, `phone`, `name`, password or token field, so
 *      PII cannot be logged by accident — it does not type-check.
 *   2. **Redaction.** `redact()` scrubs anything that looks like an address or a
 *      credential at runtime, for the cases the type system cannot see.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEventMap = {
  'app.started': { runtime: string };
  'app.config_invalid': { issueCount: number };
  'user.created': { actorId: string; userId: string; role: string };
  'user.duplicate_email': { actorId: string };
  'merchant.created': { actorId: string; merchantId: string };
  /**
   * FR-906. `profileId` is logged alongside `userId` because the profile is the row
   * that used to be missing: a log line naming only the account would record a
   * success that the defect also recorded.
   */
  'organiser.created': { actorId: string; userId: string; profileId: string };
  'organiser.profile_backfilled': { actorId: string; userId: string; profileId: string };
  /**
   * FR-802. A share link was minted — on a tap that actually inserted the row.
   *
   * No `actorId`: the actor is the organiser themselves, and `organiserProfileId`
   * already names them.
   *
   * ## Why it is emitted conditionally, and what `source` is for
   *
   * It used to fire on *every* tap, including the second one that found the link the
   * first tap made — so the event named a creation that had not happened, and "how many
   * links did Sam make this week" counted taps. `ensureShareLink` now reports whether it
   * inserted, and the two callers emit this only when it did.
   *
   * A tap that finds an existing link emits `organiser.share_link_reused` instead. Not
   * because the tap is uninteresting — it is the half of the "2 taps max" flow that
   * actually gets a link shared — but because the two facts are different questions and
   * one event name cannot answer both without a field the reader must remember to check.
   *
   * `source` is the entry point: `action` for `/organiser`'s form, `api` for
   * `POST /api/organiser/drops/:id/share`. It is here because gap 18 added the second
   * one, and "which interface are organisers actually using" is the only question a
   * route that exists purely for a future client can be judged by.
   */
  'organiser.share_link_created': {
    organiserProfileId: string;
    dropId: string;
    source: 'action' | 'api';
  };
  /** FR-802. A tap found the link this organiser already had. Same fields, same reason. */
  'organiser.share_link_reused': {
    organiserProfileId: string;
    dropId: string;
    source: 'action' | 'api';
  };
  'merchant.pickup_updated': { actorId: string; merchantId: string; addressSet: boolean; instructionsSet: boolean };
  'stripe.onboarding_started': { actorId: string; merchantId: string; reusedAccount: boolean };
  'stripe.account_synced': { merchantId: string; state: string; changed: boolean };
  'stripe.webhook_rejected': { reason: 'bad_signature' | 'unknown_account' | 'not_configured' };
  'stripe.webhook_processed': { eventType: string; merchantId: string; state: string };
  'item.saved': { actorId: string; itemId: string; merchantId: string };
  'item.validation_failed': { actorId: string; merchantId: string; issueCount: number };
  'item.not_found': { actorId: string; merchantId: string };
  'drop.draft_created': { actorId: string; dropId: string; merchantId: string; itemId: string };
  'drop.draft_updated': { actorId: string; dropId: string; merchantId: string };
  'drop.validation_failed': { actorId: string; merchantId: string; issueCount: number };
  'drop.publish_refused': {
    actorId: string;
    dropId: string;
    reason:
      | 'NOT_DRAFT'
      | 'PRICE_BELOW_FLOOR'
      | 'ITEM_INELIGIBLE'
      | 'INVALID_TIMING'
      | 'INVALID_QUANTITIES'
      | 'PAYOUTS_NOT_READY';
  };
  'drop.published': { actorId: string; dropId: string; merchantId: string; dealPriceCents: number };
  'floor.changed': { actorId: string; merchantId: string; fromPct: number; toPct: number };
  'auth.login_succeeded': { userId: string; role: string };
  'auth.login_failed': { reason: 'unknown_email' | 'bad_password' | 'rate_limited' };
  'auth.password_changed': { userId: string };
  'guardrail.evaluated': { itemId: string; state: string; minViablePriceCents: number | null };
  /**
   * M3. `source` is `planner` when no model copy survived — which is the normal
   * state on a machine with no `AI_API_KEY`, and is not a failure.
   */
  'ai.proposals_generated': {
    merchantId: string;
    itemId: string;
    source: 'model' | 'planner';
    proposalCount: number;
    promptVersion: string;
  };
  /**
   * The model was not used, and why. `no_key` is expected in development; a rate
   * of `timeout` or `invalid_shape` above a few percent is the signal that the
   * prompt or the provider changed.
   */
  'ai.copy_fallback': {
    reason: 'no_key' | 'timeout' | 'http_error' | 'bad_response' | 'no_json' | 'invalid_shape';
  };
  /**
   * The model returned a key it must not set — a price, a quantity, a window.
   * The schema drops it, so this is a measurement, not an incident: it is the
   * empirical test of ADR-002's premise that asking for a price gains nothing.
   */
  'ai.model_set_money': { keys: string };
  'ai.draft_persist_failed': { reason: string };
  'analytics.write_failed': { event: string; reason: string };
  'api.unhandled_error': { route: string; reason: string };

  // -----------------------------------------------------------------------
  // M5 — the cutoff job (design §11.7).
  //
  // No event below has a `phone`, `name` or `code` field. That is not an
  // oversight: the redemption code is a bearer token (whoever holds it eats),
  // and `redact()` would scrub the first two by key name anyway. Ids and counts
  // only.
  // -----------------------------------------------------------------------
  'cutoff.drop_decided': {
    dropId: string;
    merchantId: string;
    outcome: 'LOCKED' | 'FAILED';
    joinedQty: number;
    minQty: number;
  };
  'settlement.participant_captured': {
    dropId: string;
    participantId: string;
    amountCents: number;
    platformFeeCents: number;
  };
  'settlement.participant_declined': { dropId: string; participantId: string; declineCode: string };
  'settlement.participant_voided': { dropId: string; participantId: string };
  'settlement.drop_settled': {
    dropId: string;
    capturedQty: number;
    declinedQty: number;
    chargedCents: number;
  };
  'settlement.drop_failed': {
    dropId: string;
    reason: 'BELOW_THRESHOLD' | 'BELOW_CAPTURE_TOLERANCE';
    refundedCents: number;
  };
  'settlement.stalled': { dropId: string; lockedForMs: number; pendingParticipants: number };
  /**
   * A drop's pickup clock moved: `CAPTURED → PICKUP_OPEN` or
   * `PICKUP_OPEN → COMPLETED` (`pickup-window.ts`).
   *
   * Not an incident, and logged at `info`, but it is the *only* evidence that
   * redemption became possible for a drop. Without it, "why was this diner refused
   * at the counter" is a question with no log to answer it — and the transition
   * from `CAPTURED` is precisely the one that was missing for the whole of M5.
   */
  'settlement.pickup_transition': { dropId: string; from: string; to: string };
  /**
   * A void the provider could not answer: a diner's authorisation is still held on
   * a drop whose own status is already correct, and it will be retried from the
   * queue in `findDropsAwaitingVoid`. Not `settlement.stalled`, which means a drop
   * stuck in `LOCKED` with the money unmoved — a different incident with a
   * different response. Logged from inside the sweep, so no caller can drop it.
   */
  'settlement.void_pending': { dropId: string; pendingParticipants: number };
  /**
   * `SettlementIntegrityError` (§11.4): our data or our state is wrong. Logged at
   * `error`, that drop stops, the tick continues with the others, on-call is paged.
   * `check` names which invariant failed — `AMOUNT_MISMATCH`,
   * `MISSING_PAYMENT_INTENT`, `MISSING_STRIPE_ACCOUNT` or `LEDGER_MISMATCH`.
   */
  'settlement.integrity_error': { dropId: string; check: string };
  'settlement.batch_truncated': { dropsProcessed: number; participantsProcessed: number };
  /**
   * A provider call came back "try later". The participant stays
   * `chargeStatus = 'NONE'` and the next tick retries with the same idempotency
   * key. A rate of these above a few percent is the signal that Stripe is having a
   * bad day, not that we are.
   */
  'settlement.provider_unavailable': { reason: string; operation: string };
  /**
   * A full refund reversed a different amount of our application fee than the
   * order's fee.
   *
   * This should be rare and it is always worth a look: `refundKey` is
   * participant-scoped, so a full refund of that charge ought to return the whole
   * fee. When it does not, either Stripe's proportional model disagrees with the
   * ledger's full-refund assumption or the order's fee was never right. The ledger
   * records what Stripe reported regardless — the warning exists so the difference
   * is visible rather than silently absorbed into `platformFeeCents`.
   */
  'settlement.application_fee_reversal_unexpected': {
    dropId: string;
    participantId: string;
    orderPlatformFeeCents: number;
    reversedCents: number;
    outcome: string;
  };
  'settlement.tick_refused': { reason: 'no_provider' | 'unauthorized' | 'not_configured' };
  /**
   * An admin refunded one participant (FR-903). `outcome` distinguishes a refund
   * this call created from one a previous attempt had already landed — the second
   * is not a failure, and an operator reading the log should be able to tell.
   *
   * No audit table exists in V1. FR-902 and FR-904 both need one, and this line is
   * the interim record rather than a claim that FR-903's sibling requirements are
   * met: it has no retention guarantee and it is not queryable by participant.
   */
  'admin.participant_refunded': {
    actorId: string;
    participantId: string;
    dropId: string;
    refundedCents: number;
    platformFeeReversedCents: number;
    outcome: string;
    reason: string | null;
  };
  /** A refund was asked for and refused, with the sentence the operator was shown. */
  'admin.refund_refused': { actorId: string; participantId: string; reason: string };
  /**
   * One row landed in the audit trail (`lib/audit/log.ts`).
   *
   * The row is the record; this line is the same event in the stream an operator is
   * already watching, and neither replaces the other. `actorUserId` is `'deleted'`
   * when the actor's `User` row no longer exists — the email on the row survives that,
   * which is the whole reason it is denormalised.
   */
  'audit.written': {
    auditId: string;
    action: string;
    targetType: string;
    targetId: string;
    actorUserId: string;
  };
  /**
   * FR-902 — a drop was force-failed and everybody refunded.
   *
   * `previousStatus` is in it because the same endpoint covers a drop that had
   * captured and one that had not, and an operator reading the log needs to know which
   * without joining to the audit table.
   */
  'admin.drop_force_failed': {
    actorId: string;
    dropId: string;
    previousStatus: string;
    refundedParticipants: number;
    refundedCents: number;
    /** Participants an FR-903 refund had already returned before this call ran. */
    alreadyRefundedParticipants: number;
    voidedAuthorisations: number;
    pendingVoids: number;
  };
  /** FR-902 asked for and refused, `reason` being the refusal kind. */
  'admin.force_fail_refused': { actorId: string; dropId: string; reason: string };
  /**
   * FR-208 — a merchant called off their own published drop.
   *
   * `voidedAuthorisations` counts releases, not money: a merchant cancellation happens
   * before the cutoff, so nothing was ever captured and no refund exists. An operator
   * reading this expecting a refund figure is looking at the wrong endpoint.
   */
  'drops.cancelled': {
    actorId: string;
    dropId: string;
    merchantId: string;
    participants: number;
    voidedAuthorisations: number;
    pendingVoids: number;
  };
  /** FR-208 asked for and refused, `reason` being the refusal kind. */
  'drops.cancel_refused': { actorId: string; dropId: string; reason: string };
  /**
   * FR-208's CAS lost to the cutoff tick: the drop moved `PUBLISHED` → `LOCKED`
   * between the read and the write, so settlement is capturing and the cancellation
   * was refused.
   *
   * Logged at `info` and kept separate from `drops.cancel_refused` because it is not a
   * merchant mistake — it is two background-safe writers meeting at a boundary, and it
   * is the only evidence that the race actually happened in production.
   */
  'drops.cancel_lost_race': {
    actorId: string;
    dropId: string;
    expected: string;
    actual: string;
  };
  /**
   * FR-208 threw rather than refusing cleanly — i.e. a condition the guard did not
   * model. `reason` is the error's `name`, which is enough to tell a missing Stripe
   * key from a lost CAS from a database fault without logging a message that might
   * carry a merchant id.
   */
  'drops.cancel_failed': { route: string; reason: string };
  /**
   * FR-902 called on a drop that was already `CANCELLED`. Not an error — a retried
   * request is the normal way this is reached — but it must be visible, because the
   * alternative reading is "the refund ran twice".
   */
  'admin.force_fail_noop': { actorId: string; dropId: string };
  /**
   * A participant already refunded by hand before the drop was called off. Their
   * ledger rows are the truth and no second refund is attempted; a logged count keeps
   * the totals reconcilable against the audit row's intended amount.
   */
  'admin.force_fail_skipped_refunded': {
    actorId: string;
    dropId: string;
    participantId: string;
    refundedCents: number;
  };
  /**
   * FR-904 — an admin began borrowing a merchant owner's session.
   *
   * The log line and the audit row are written for the same event, as with every
   * other audited action: the row is the record, this is what an operator watching
   * the stream sees. `targetEmail` is the merchant's, not the admin's — that is the
   * account being viewed, and it is what a support engineer will search for later.
   */
  'admin.impersonation_started': {
    actorId: string;
    merchantUserId: string;
    merchantId: string;
    auditId: string;
    expiresAt: string;
  };
  'admin.impersonation_ended': {
    actorId: string;
    impersonatedUserId: string;
    startAuditId: string;
    auditId: string;
  };
  /** FR-904 asked for and refused, `reason` being the refusal kind. */
  'admin.impersonation_refused': {
    actorId: string;
    merchantUserId: string;
    reason: string;
  };
  /**
   * A write was attempted from a borrowed session and refused by
   * `refuseIfImpersonating`. Logged because it is not only a UI slip: it means some
   * entry point reached the write gate, and knowing which one tells us whether a
   * button is wrongly enabled or a route is wrongly called.
   */
  'auth.impersonation_write_refused': {
    actorUserId: string;
    impersonatedUserId: string;
    path: string;
  };
  /**
   * The ledger's unique index on `(orderId, type)` rejected a second refund row.
   * Reached only through the §4.2 window or a race the CAS did not close; the money
   * at Stripe is already back, so it is reported rather than retried.
   */
  'admin.refund_ledger_conflict': { participantId: string; dropId: string };
  'notification.intent': { kind: string; dropId: string; count: number };
  /**
   * A production deployment rendered a public drop page with no usable `APP_URL`,
   * so there is no origin to build the share card against
   * (`lib/metadata/social-card.ts`).
   *
   * Logged at `error` and separate from `notify.public_origin_rejected` because the
   * consequence is different and so is the reader: notifications degrade to "no
   * link" and the message still works, while this means every share of every drop
   * previews with **no image at all** — the funnel FR-308 exists to protect. It was
   * silent before, because Next suppresses its own warning for `opengraph-image` in
   * development and emits nothing in production for a static metadata route.
   *
   * `UNSET` is in the union here and deliberately absent from
   * `notify.public_origin_rejected`: that path returns early on an absent value
   * because "no link" is its safe answer, while this one treats a production
   * deployment with no `APP_URL` as the mistake it is. Same validation, different
   * absent-policy — which is the whole reason the two states are not one.
   */
  'metadata.public_origin_missing': {
    reason: 'UNSET' | 'NOT_A_URL' | 'NOT_HTTPS' | 'NOT_PUBLIC';
  };
  /**
   * `APP_URL` is set but cannot be used as a public origin, so notifications carry
   * no link (`notify/public-origin.ts`). Logged once per process because the failure
   * is otherwise completely silent: the message sends, the job passes, and only the
   * diner sees a dead link.
   */
  'notify.public_origin_rejected': {
    reason: 'NOT_A_URL' | 'NOT_HTTPS' | 'NOT_PUBLIC';
  };
  /**
   * A `NotifyPort` threw, and settlement carried on. Failure to notify is not
   * failure to charge (§3.5); this event is the only trace of the loss.
   */
  'notification.failed': { reason: string };
  // -----------------------------------------------------------------------
  // D-5 — the sender (FR-408, FR-506 delivery).
  //
  // The same PII rule as everywhere else, and it bites harder here than anywhere:
  // a notification body contains a **bearer token** (the participant-access link)
  // and, in the charged message, the **redemption code**. Neither may appear in any
  // field below. That is why every event here carries a `kind` and counts and never
  // a message, a body, a phone or a provider's response text — several of Twilio's
  // error bodies echo the message back.
  // -----------------------------------------------------------------------
  /**
   * No provider credentials, so nothing was sent. `warn`, once per batch, with
   * counts: the normal state of a keyless deployment, and the one fact an operator
   * must be able to see without reading code.
   */
  'notification.not_sent': {
    reason: 'NOT_CONFIGURED';
    total: number;
    kinds: Record<string, number>;
  };
  /**
   * A message was composed and there was nowhere to send it — no delivery function
   * was supplied to the join path.
   *
   * Separate from `notification.not_sent` because the cause is different in kind: not
   * "this deployment has no provider credentials" but "this call site did not wire a
   * sender". The first is a supported mode; the second is a wiring bug, and the whole
   * reason this slice exists is that it is the bug this codebase keeps producing.
   * `kind` is the only field — the body carries a bearer token and an amount.
   */
  'notification.seam_missing': { kind: string };
  /** Some credentials but not all — almost always a typo in a deployment secret. */
  'notification.sender_unconfigured': { missing: string[] };
  /** A batch completed with at least one failure. Carries counts, never bodies. */
  'notification.send_failed': { sent: number; failed: number };
  /**
   * A composed body exceeded the channel limit. Logged as `error` because it is a
   * composer bug, not a delivery one — and because the alternative (truncating)
   * would cut a redemption code in half, which scans as valid and is not.
   */
  'notification.too_long': { kind: string; length: number; limit: number };
  /**
   * The provider answered with an error. `code` is Twilio's numeric code, which is
   * the only part of its response safe to record — the prose can contain the message.
   */
  'notification.provider_error': { status: number; code: number | null; kind: string };
  /** One message left the building. Counts only. */
  'notification.sent': { kind: string };
  /** Could not reach the provider. Error *name* only, never the message. */
  'notification.network_error': { kind: string; error: string };
  /**
   * The redemption-code key is derived from `JWT_SECRET` because
   * `REDEMPTION_SECRET` is unset. Logged once, at first use, in production only:
   * the consequence (rotating the session secret invalidates printed codes) is
   * invisible after the fact.
   */
  'redemption.secret_derived': { reason: 'no_override' };

  // -----------------------------------------------------------------------
  // M6 — the pickup counter (FR-601…FR-605).
  //
  // The same rule as M5, and it is load-bearing here: the scanned string is the
  // diner's food. It is a bearer token, so it never appears in any field below,
  // and `refuse()` in `redeem.ts` does not accept it as a parameter at all.
  // -----------------------------------------------------------------------
  /**
   * Units changed hands. `partial` means the counter handed over fewer plates than
   * the scan asked for, because a concurrent scan had already taken some.
   */
  'redemption.redeemed': {
    dropId: string;
    participantId: string;
    taken: number;
    redeemedQty: number;
    qty: number;
    partial: boolean;
  };
  /**
   * A scan found nothing left to take. `afterRetries` distinguishes the ordinary
   * double scan (one read, zero remaining) from the contended case where the row
   * moved under every attempt — the second is a contention signal, the first is a
   * queue.
   */
  'redemption.already_redeemed': { dropId: string; participantId: string; afterRetries?: boolean };
  /**
   * A code was refused. The reason is the union from `rules.ts` — a bounded
   * vocabulary, not free text, so a rate per reason is a usable metric. Never the
   * code, never the diner's name.
   */
  'redemption.refused': { reason: string; dropId?: string; participantId?: string };
  /**
   * A claim lost a race and the row is being re-read. Expected in small numbers at
   * a busy counter; sustained, it means two staff are scanning the same orders and
   * the screen should be telling them so.
   */
  'redemption.retry': { attempt: number; maxAttempts: number };
  /** The pickup table was opened — the batch face of FR-604. */
  'redemption.manifest_viewed': { dropId: string; merchantId: string; orders: number; plates: number };

  // -----------------------------------------------------------------------
  // M4 slice 2c — the diner's own order page (`/d/:publicCode/mine`).
  //
  // The same rule again, and it matters more here than anywhere: the page is
  // reached with a bearer token in the query string. Neither the token nor the
  // redemption code it renders may appear in a log line — the token grants read
  // access to one order, and the code buys food.
  // -----------------------------------------------------------------------
  /**
   * A `?t=` token failed to verify.
   *
   * `publicCode` only, because it names the page rather than the person, and a
   * wave of these is the signal worth seeing: either a messaging app is truncating
   * links (the copy on the page says so) or somebody is guessing.
   */
  'participant.order_link_invalid': { publicCode: string };
  /**
   * The order page rendered a decided drop. `phase` is the bounded vocabulary from
   * `order-view.ts`, so "how many diners are looking at a failed drop" is a count
   * rather than a guess. No participant id: the token already identifies them and
   * this event does not need to.
   */
  'participant.order_viewed': { publicCode: string; phase: string };

  // -----------------------------------------------------------------------
  // M4 — the join path. The same rule as M5 and M6 applies and is load-bearing
  // here: **a phone number never appears in any field below.** These events are
  // what a rate-per-reason metric is built from, so `reason` is the bounded
  // vocabulary from `join/rules.ts` and never free text.
  // -----------------------------------------------------------------------
  /**
   * A card was held. `amountCents` and `platformFeeCents` are recorded because
   * the pair is the join path's whole money claim, and a reconciliation question
   * ("did every authorised row store the fee the snapshot said?") has to be
   * answerable from the log rather than by re-reading a row that may since have
   * been overwritten.
   */
  'join.authorised': {
    dropId: string;
    participantId: string;
    qty: number;
    amountCents: number;
    platformFeeCents: number;
  };
  /**
   * The same person submitted the same drop again. Expected and benign — a double
   * tap — but a sustained rate means the confirm screen is not giving feedback and
   * the fix is in the UI, not the API.
   */
  'join.already_joined': {
    dropId: string;
    participantId: string;
    status: 'AUTHORIZED' | 'PENDING';
  };
  /** A join was refused. `reason` is the union from `join/rules.ts`. */
  'join.refused': { reason: string; dropId?: string };
  /** The provider refused the card. Terminal for this attempt; retry with another card. */
  'join.declined': { dropId: string; participantId: string; declineCode: string };
  /**
   * The provider could not answer, so whether a hold exists is **unknown**. The
   * row is left `PENDING` deliberately; this event is how a burst of them is
   * spotted rather than discovered at the cutoff.
   */
  'join.payment_unavailable': {
    dropId?: string;
    participantId?: string;
    reason: string;
    /** Which provider call failed, for a port-level failure with no row context yet. */
    operation?: string;
  };
  /**
   * A published drop whose frozen snapshot this build cannot read, or whose stored
   * price is not a usable integer. A data error, logged with the drop id so it can
   * be found without a customer complaint.
   */
  'join.pricing_unavailable': { dropId: string };
  /**
   * A hold exists at the provider but no row records it. The worst available
   * outcome on this path, and it should never occur: the second transaction matches
   * the participant by id **and** by its `PENDING` state, so a lost row means the
   * row moved underneath us. The money has to be traced by intent id, which is why
   * the log line is an error rather than a warning.
   */
  'join.record_failed': { dropId: string; participantId: string };
};

export type LogEventName = keyof LogEventMap;

type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Keys that must never appear in a log line, whatever their value. */
const REDACTED_KEYS = new Set([
  'email',
  'phone',
  'name',
  'displayname',
  'password',
  'passwordhash',
  'token',
  'jwt',
  'authorization',
  'cookie',
  'secret',
  'apikey',
]);

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Replaces PII-looking keys and values with `[redacted]`. */
export function redact(fields: LogFields): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      safe[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && EMAIL_LIKE.test(value)) {
      safe[key] = '[redacted]';
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function write(level: LogLevel, event: LogEventName, fields: LogFields): void {
  // Spread the caller's fields FIRST: a field named `event` or `level` must not be
  // able to rewrite the identity of the log line (this actually happened — the
  // `analytics.write_failed` event carries an `event` field naming the event that
  // failed to write).
  const line = JSON.stringify({
    ...redact(fields),
    ts: new Date().toISOString(),
    level,
    event,
  });
  process.stdout.write(`${line}\n`);
}

/**
 * `logger.info|warn|error(event, fields)`.
 *
 * Ids and counts only. If a future event genuinely needs a human-readable label,
 * it goes in the event name, not in a free-text field.
 */
export const logger = {
  info<E extends LogEventName>(event: E, fields: LogEventMap[E]): void {
    write('info', event, fields as LogFields);
  },
  warn<E extends LogEventName>(event: E, fields: LogEventMap[E]): void {
    write('warn', event, fields as LogFields);
  },
  error<E extends LogEventName>(event: E, fields: LogEventMap[E]): void {
    write('error', event, fields as LogFields);
  },
  redact,
};
