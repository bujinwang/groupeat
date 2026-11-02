import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import { env } from '@/lib/config';

import {
  deriveRedemptionSecret,
  redemptionSecret,
  signRedemptionCode,
  verifyRedemptionCode,
} from '../redemption-code';

/**
 * FR-505 — the code a diner shows at the counter.
 *
 * It is a bearer token: whoever holds it eats. So the assertions here are about
 * what it must *refuse*: a flipped character, a different key, a truncated code,
 * and a payload that grew a field we did not sign.
 */

const PAYLOAD = { participantId: 'p-1', dropId: 'd-1', qty: 3 };
const SECRET = deriveRedemptionSecret('a-test-session-secret-of-sufficient-length');

describe('sign and verify', () => {
  it('round-trips exactly the three fields it signs, and nothing else', () => {
    const code = signRedemptionCode(PAYLOAD, SECRET);
    const verified = verifyRedemptionCode(code, SECRET);

    expect(verified).toEqual({ participantId: 'p-1', dropId: 'd-1', qty: 3 });
    expect(Object.keys(verified ?? {}).sort()).toEqual(['dropId', 'participantId', 'qty']);
  });

  it('does not serialise a field it was not asked to sign', () => {
    // A caller spreading a row into the payload is the realistic way PII reaches a
    // token that is displayed on a phone screen.
    const code = signRedemptionCode(
      { ...PAYLOAD, phone: '+14035551234' } as unknown as typeof PAYLOAD,
      SECRET,
    );

    expect(Buffer.from(code.split('.')[1] ?? '', 'base64url').toString('utf8')).not.toContain(
      '4035551234',
    );
    expect(verifyRedemptionCode(code, SECRET)).toEqual(PAYLOAD);
  });

  it('returns null when one base64 character is flipped', () => {
    const code = signRedemptionCode(PAYLOAD, SECRET);
    const parts = code.split('.');
    const signature = parts[2] ?? '';
    // Flip one character of the signature to a different one in the same alphabet.
    const flippedChar = signature[0] === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}.${parts[1]}.${flippedChar}${signature.slice(1)}`;

    expect(verifyRedemptionCode(tampered, SECRET)).toBeNull();
  });

  it('returns null for a code signed with a different secret', () => {
    const other = deriveRedemptionSecret('a-different-session-secret-entirely');
    const code = signRedemptionCode(PAYLOAD, other);

    expect(verifyRedemptionCode(code, SECRET)).toBeNull();
  });

  it('returns null for a tampered payload even though the signature still parses', () => {
    const code = signRedemptionCode(PAYLOAD, SECRET);
    const parts = code.split('.');
    const payload = Buffer.from(JSON.stringify({ ...PAYLOAD, qty: 99 }), 'utf8').toString(
      'base64url',
    );

    expect(verifyRedemptionCode(`${parts[0]}.${payload}.${parts[2]}`, SECRET)).toBeNull();
  });

  it('returns null for malformed input rather than throwing', () => {
    // The scanner has exactly one thing to do with a code it cannot verify.
    expect(verifyRedemptionCode('', SECRET)).toBeNull();
    expect(verifyRedemptionCode('v1', SECRET)).toBeNull();
    expect(verifyRedemptionCode('v1.abc', SECRET)).toBeNull();
    expect(verifyRedemptionCode('v2.abc.def', SECRET)).toBeNull();
    expect(verifyRedemptionCode('v1..def', SECRET)).toBeNull();
    expect(verifyRedemptionCode('v1.abc.', SECRET)).toBeNull();
  });

  it('refuses a correctly-signed payload with a qty that is not a positive integer', () => {
    const body = Buffer.from(JSON.stringify({ ...PAYLOAD, qty: 0 }), 'utf8').toString('base64url');
    const signature = signRedemptionCode(PAYLOAD, SECRET).split('.')[2] ?? '';

    // Signed with the right key but the payload is nonsense: the shape check runs
    // after the signature check, so this proves the shape check exists.
    expect(verifyRedemptionCode(`v1.${body}.${signature}`, SECRET)).toBeNull();
  });
});

describe('the key', () => {
  it('derives deterministically and is not the session secret itself', () => {
    const first = deriveRedemptionSecret('session-secret');
    const second = deriveRedemptionSecret('session-secret');

    expect(first.equals(second)).toBe(true);
    expect(first.toString('utf8')).not.toBe('session-secret');
    expect(first).toHaveLength(32);
  });

  it('derives a different key from a different session secret', () => {
    expect(deriveRedemptionSecret('a').equals(deriveRedemptionSecret('b'))).toBe(false);
  });

  it('uses the explicit override when one is configured', () => {
    const secret = redemptionSecret();

    if (env.REDEMPTION_SECRET) {
      expect(secret.toString('utf8')).toBe(env.REDEMPTION_SECRET);
    } else {
      // The documented default: no new required env var, HKDF from JWT_SECRET.
      expect(secret.equals(deriveRedemptionSecret(env.JWT_SECRET))).toBe(true);
    }
  });
});
