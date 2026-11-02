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
  'settlement.tick_refused': { reason: 'no_provider' | 'unauthorized' | 'not_configured' };
  'notification.intent': { kind: string; dropId: string; count: number };
  /**
   * A `NotifyPort` threw, and settlement carried on. Failure to notify is not
   * failure to charge (§3.5); this event is the only trace of the loss.
   */
  'notification.failed': { reason: string };
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
