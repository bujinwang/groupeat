import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';

/**
 * FR-505 — the redemption code. Design §10, §12 Q4.
 *
 * A short string a diner shows at the counter, verifiable **offline** by the
 * scanner that M6 will build. It is a bearer token: whoever holds it can claim
 * the food. So it goes into the participant row and the notification intent, and
 * never into a log line (§11.7).
 *
 * ## Why not a JWT
 *
 * `jose` is installed and unused here on purpose. A JWT carries an algorithm
 * header, a key id, and a claims vocabulary — a superset of what is needed, and a
 * superset that has to be parsed and validated. This token has exactly one
 * verifier and three claims, so it is `HMAC-SHA256` over a base64url body with a
 * version prefix: 40 lines, no parser, nothing to downgrade.
 *
 * ## The key
 *
 * Derived from `JWT_SECRET` via HKDF-SHA256 with a fixed `info` string, so there
 * is **no new required env var** and the session key is not used directly for a
 * second purpose. `REDEMPTION_SECRET` overrides it when set, which is the
 * documented upgrade path: rotating `JWT_SECRET` invalidates every printed code,
 * and in production that is worth being able to avoid.
 *
 * The consequence of *not* overriding is real and is logged once at first use in
 * production: codes printed today stop verifying the day someone rotates the
 * session secret. There is no way to discover that after the fact, so it is
 * announced at the moment the first code is signed.
 */

export type RedemptionPayload = {
  readonly participantId: string;
  readonly dropId: string;
  readonly qty: number;
};

const VERSION = 'v1';
const HKDF_SALT = 'groupeat/redemption-code';
const HKDF_INFO = 'groupeat/redemption-code/v1';
const KEY_BYTES = 32;

/** HKDF-SHA256 over the session secret. Exported for the derivation test. */
export function deriveRedemptionSecret(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

let warnedAboutDerivation = false;

/**
 * The HMAC key in force.
 *
 * `REDEMPTION_SECRET` if set (used verbatim — it is a key, not a password, and
 * hashing it again would only make rotation harder to reason about), otherwise
 * the HKDF derivation.
 */
export function redemptionSecret(): Buffer {
  const override = env.REDEMPTION_SECRET;
  if (override) {
    return Buffer.from(override, 'utf8');
  }
  if (env.NODE_ENV === 'production' && !warnedAboutDerivation) {
    warnedAboutDerivation = true;
    logger.warn('redemption.secret_derived', { reason: 'no_override' });
  }
  return deriveRedemptionSecret(env.JWT_SECRET);
}

function sign(body: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * `v1.<base64url(JSON payload)>.<base64url(HMAC)>`.
 *
 * `secret` is a parameter so a test can prove that a code signed with a different
 * key does not verify. Production callers omit it.
 */
export function signRedemptionCode(
  payload: RedemptionPayload,
  secret: Buffer = redemptionSecret(),
): string {
  // Only the three fields are serialised, in this order. A payload that grew an
  // `email` because a caller spread a row into it would be a PII leak into a
  // token that is shown on a phone screen.
  const body = Buffer.from(
    JSON.stringify({
      participantId: payload.participantId,
      dropId: payload.dropId,
      qty: payload.qty,
    }),
    'utf8',
  ).toString('base64url');

  const signed = `${VERSION}.${body}`;
  return `${signed}.${sign(signed, secret)}`;
}

/**
 * The payload, or `null`.
 *
 * `null` for every failure — a malformed code, a wrong version, a bad signature, a
 * payload that is not the shape we signed. The scanner has exactly one thing to
 * do with a code it cannot verify (refuse it), and a discriminated error type
 * would tempt a caller into treating one of the failures as recoverable.
 */
export function verifyRedemptionCode(
  code: string,
  secret: Buffer = redemptionSecret(),
): RedemptionPayload | null {
  const parts = code.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [version, body, signature] = parts;
  if (
    version === undefined ||
    body === undefined ||
    signature === undefined ||
    version !== VERSION ||
    body.length === 0 ||
    signature.length === 0
  ) {
    return null;
  }

  const expected = Buffer.from(sign(`${version}.${body}`, secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  // `timingSafeEqual` throws on unequal lengths, so the length is checked first —
  // and the length of an HMAC is not a secret.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return null;
  }
  const candidate = decoded as Record<string, unknown>;
  const { participantId, dropId, qty } = candidate;
  if (typeof participantId !== 'string' || participantId.length === 0) {
    return null;
  }
  if (typeof dropId !== 'string' || dropId.length === 0) {
    return null;
  }
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
    return null;
  }

  // Rebuilt field by field rather than returned as parsed: the signature covers
  // the bytes we signed, and a caller must not receive a field we did not sign.
  return { participantId, dropId, qty };
}
