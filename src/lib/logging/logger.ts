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
  'item.saved': { actorId: string; itemId: string; merchantId: string };
  'item.validation_failed': { actorId: string; merchantId: string; issueCount: number };
  'item.not_found': { actorId: string; merchantId: string };
  'floor.changed': { actorId: string; merchantId: string; fromPct: number; toPct: number };
  'auth.login_succeeded': { userId: string; role: string };
  'auth.login_failed': { reason: 'unknown_email' | 'bad_password' | 'rate_limited' };
  'auth.password_changed': { userId: string };
  'guardrail.evaluated': { itemId: string; state: string; minViablePriceCents: number | null };
  'analytics.write_failed': { event: string; reason: string };
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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
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
