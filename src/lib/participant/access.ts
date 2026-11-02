import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/config';

/**
 * How a diner gets back to their own order, with no account — FR-408's link target.
 *
 * ## The problem this solves, stated exactly
 *
 * A diner joins with a phone number and no password. After the cutoff their card
 * is charged and a redemption code is minted. That code has to reach them, and the
 * page it lives on has to be reachable by somebody who has no session, no cookie,
 * and no account — from a link in an SMS, possibly on a different device from the
 * one they joined on.
 *
 * So the page needs a bearer token in the URL. The obvious candidate is the
 * redemption code itself, and using it would be a mistake worth spelling out:
 *
 *   - **The redemption code is the food.** Whoever holds it can collect the order
 *     at the counter. Putting it in an SMS link means it lands in a message
 *     archive, a link-preview fetcher's logs, and a browser history. That is a
 *     bearer credential sprayed across three systems that were not designed to
 *     hold one.
 *   - **This token is not the food.** It grants *read* access to a page. The page
 *     renders the redemption code, but only while the drop is in a state where the
 *     code is legitimately the diner's to see, and the page can be rate-limited and
 *     revoked without invalidating a printed code.
 *   - **Different key, different blast radius.** These are derived from the session
 *     secret with different HKDF `info` strings, so a leak of one derivation does
 *     not yield the other. Reusing one string for both would make the separation
 *     decorative.
 *
 * ## Why it has no expiry
 *
 * The token carries no timestamp, and the page enforces the window instead
 * (`windowEnd` is already read to render pickup details, so the check costs
 * nothing). Putting an expiry in the token would mean the *crypto* needs a clock,
 * which makes verification untestable without freezing time, and it would still not
 * be the real rule — the real rule is "the pickup window has not closed", and that
 * depends on the drop, not on when the link was minted.
 *
 * The consequence, stated plainly: a leaked link keeps working after pickup ends.
 * What it shows is a page for food that has already been collected, and the code on
 * it is refused by the scanner. The exposure is a name, a quantity and a phone's
 * last four digits — which is why this is acceptable, and why those are the only
 * fields the page is allowed to read.
 */

export type ParticipantAccessPayload = {
  readonly participantId: string;
  readonly dropId: string;
};

const VERSION = 'p1';
const HKDF_SALT = 'groupeat/participant-access';
const HKDF_INFO = 'groupeat/participant-access/v1';
const KEY_BYTES = 32;

/**
 * HKDF-SHA256 over the session secret, under a *different* `info` than the
 * redemption code's derivation. Exported for the separation test.
 */
export function deriveParticipantAccessSecret(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/**
 * The HMAC key in force.
 *
 * `PARTICIPANT_ACCESS_SECRET` overrides the derivation, mirroring
 * `REDEMPTION_SECRET`. Not a new required variable: a fresh checkout has one secret
 * and derives both keys from it.
 */
export function participantAccessSecret(): Buffer {
  const override = env.PARTICIPANT_ACCESS_SECRET;
  if (override) {
    return Buffer.from(override, 'utf8');
  }
  return deriveParticipantAccessSecret(env.JWT_SECRET);
}

function sign(body: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * `p1.<base64url({participantId,dropId})>.<base64url(HMAC)>`.
 *
 * `secret` is a parameter so a test can prove a token signed with another key does
 * not verify, and so the redemption key can be shown to fail against it.
 */
export function signParticipantAccess(
  payload: ParticipantAccessPayload,
  secret: Buffer = participantAccessSecret(),
): string {
  // Two fields, serialised explicitly. A caller that spreads a row into this would
  // otherwise put a phone number into a URL that ends up in a message log.
  const body = Buffer.from(
    JSON.stringify({ participantId: payload.participantId, dropId: payload.dropId }),
    'utf8',
  ).toString('base64url');

  const signed = `${VERSION}.${body}`;
  return `${signed}.${sign(signed, secret)}`;
}

/**
 * The payload, or `null` — never a discriminated error.
 *
 * Same reasoning as `verifyRedemptionCode`: the page has exactly one thing to do
 * with a token it cannot verify (render a refusal), and a typed failure would tempt
 * a caller into treating one of them as recoverable.
 */
export function verifyParticipantAccess(
  token: string,
  secret: Buffer = participantAccessSecret(),
): ParticipantAccessPayload | null {
  const parts = token.split('.');
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
  const { participantId, dropId } = candidate;
  if (typeof participantId !== 'string' || participantId.length === 0) {
    return null;
  }
  if (typeof dropId !== 'string' || dropId.length === 0) {
    return null;
  }

  // Rebuilt field by field: the signature covers what we signed, and a caller must
  // not receive a field that was not signed.
  return { participantId, dropId };
}
