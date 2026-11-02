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
