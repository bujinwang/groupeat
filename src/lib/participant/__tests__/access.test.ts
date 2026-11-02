import 'dotenv/config';

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  deriveRedemptionSecret,
  signRedemptionCode,
  verifyRedemptionCode,
} from '@/lib/settlement/redemption-code';

import {
  deriveParticipantAccessSecret,
  signParticipantAccess,
  verifyParticipantAccess,
} from '../access';

/**
 * FR-408's link token — the thing in the diner's SMS.
 *
 * ## What is actually at stake here
 *
 * This token grants read access to a page that renders a redemption code. The
 * redemption code is the food. So the single most important assertion in this file
 * is not the round-trip — it is that a *redemption code* does not verify as an
 * *access token*, and vice versa. If those two ever shared a key, the separation
 * argued for in the module docblock would be decorative, and a link forwarded in a
 * group chat would be a claim on somebody's lunch.
 *
 * The rest of the file is refusals: a flipped signature character, a truncated
 * token, a forged body, a payload that grew a field.
 */

const PAYLOAD = { participantId: 'p-1', dropId: 'd-1' };
const SESSION = 'a-test-session-secret-of-sufficient-length';
const SECRET = deriveParticipantAccessSecret(SESSION);

/** Any token signed with the real key, for the shape tests — the signature is good. */
function signedBody(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`p1.${body}`).digest('base64url');
  return `p1.${body}.${signature}`;
}

describe('sign and verify', () => {
  it('round-trips exactly the two fields it signs', () => {
    const token = signParticipantAccess(PAYLOAD, SECRET);

    expect(verifyParticipantAccess(token, SECRET)).toEqual({
      participantId: 'p-1',
      dropId: 'd-1',
    });
    expect(Object.keys(verifyParticipantAccess(token, SECRET) ?? {}).sort()).toEqual([
      'dropId',
      'participantId',
    ]);
  });

  it('is urlsafe without escaping', () => {
    // The token goes in a query string. A `+` or `/` from standard base64 would be
    // decoded as a space or a path separator by enough intermediaries to matter,
    // and the failure would look like "the link works when I paste it but not from
    // the SMS".
    const token = signParticipantAccess(PAYLOAD, SECRET);

    expect(encodeURIComponent(token)).toBe(token);
    expect(token).toMatch(/^p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('does not serialise a field it was not asked to sign', () => {
    // The realistic accident: a caller spreads a participant row into the payload
    // and the phone number ends up base64 — not encrypted — in a URL that reaches a
    // message log.
    const token = signParticipantAccess(
      { ...PAYLOAD, phone: '+14035551234' } as unknown as typeof PAYLOAD,
      SECRET,
    );

    const body = Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8');
    expect(body).not.toContain('4035551234');
    expect(verifyParticipantAccess(token, SECRET)).toEqual(PAYLOAD);
  });

  it('is stable for the same payload, so a re-send can rebuild the same link', () => {
    // `orderUrl` mints its token from ids alone, with no timestamp and no nonce.
    // That is what lets a job reconstruct the exact link it sent yesterday without
    // storing one. If this ever gains a random component, that property dies
    // silently.
    expect(signParticipantAccess(PAYLOAD, SECRET)).toBe(signParticipantAccess(PAYLOAD, SECRET));
  });
});

describe('the refusals', () => {
  it('returns null when one signature character is flipped', () => {
    const token = signParticipantAccess(PAYLOAD, SECRET);
    const parts = token.split('.');
    const signature = parts[2] ?? '';
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

    expect(verifyParticipantAccess(`${parts[0]}.${parts[1]}.${flipped}`, SECRET)).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    const token = signParticipantAccess(
      PAYLOAD,
      deriveParticipantAccessSecret('a-different-session-secret-entirely'),
    );

    expect(verifyParticipantAccess(token, SECRET)).toBeNull();
  });

  it('returns null for a truncated token', () => {
    const token = signParticipantAccess(PAYLOAD, SECRET);

    expect(verifyParticipantAccess(token.slice(0, -1), SECRET)).toBeNull();
    expect(verifyParticipantAccess(token.slice(0, 10), SECRET)).toBeNull();
  });

  it('returns null for a body swapped for another participant', () => {
    // The attack the signature exists to stop: take your own valid token and edit
    // the participant id. The signature covers the body, so this must fail.
    const mine = signParticipantAccess({ participantId: 'p-1', dropId: 'd-1' }, SECRET);
    const theirs = signParticipantAccess({ participantId: 'p-2', dropId: 'd-1' }, SECRET);

    const parts = mine.split('.');
    const stolenBody = theirs.split('.')[1] ?? '';
    expect(verifyParticipantAccess(`${parts[0]}.${stolenBody}.${parts[2]}`, SECRET)).toBeNull();
  });

  it('returns null for a payload whose signature is valid but shape is not', () => {
    // Signed with the real key on purpose: the signature is genuine and the only
    // thing standing between the caller and a malformed row is the field check.
    expect(verifyParticipantAccess(signedBody({ participantId: 'p-1' }), SECRET)).toBeNull();
    expect(verifyParticipantAccess(signedBody({ dropId: 'd-1' }), SECRET)).toBeNull();
    expect(verifyParticipantAccess(signedBody({ participantId: '', dropId: 'd-1' }), SECRET)).toBeNull();
    expect(verifyParticipantAccess(signedBody({ participantId: 7, dropId: 'd-1' }), SECRET)).toBeNull();
    expect(verifyParticipantAccess(signedBody(['p-1', 'd-1']), SECRET)).toBeNull();
    expect(verifyParticipantAccess(signedBody(null), SECRET)).toBeNull();
  });

  it('returns null for a body that is not JSON, even with a good signature', () => {
    const body = Buffer.from('not json at all', 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`p1.${body}`).digest('base64url');

    expect(verifyParticipantAccess(`p1.${body}.${signature}`, SECRET)).toBeNull();
  });

  it('returns null for every malformed shape', () => {
    for (const bad of ['', '.', 'p1', 'p1.', 'p1..', 'p1.body', 'p2.x.y', 'v1.x.y', 'a.b.c.d']) {
      expect(verifyParticipantAccess(bad, SECRET)).toBeNull();
    }
  });
});

describe('the keys are separate', () => {
  it('derives a different key than the redemption code does', () => {
    // Both are HKDF over the same session secret. If the `info` strings ever
    // converged, the two keys would be identical and this test would fail — which
    // is the entire point of it.
    expect(deriveParticipantAccessSecret(SESSION).equals(deriveRedemptionSecret(SESSION))).toBe(
      false,
    );
  });

  it('does not accept a redemption code as an access token', () => {
    // The load-bearing assertion of the file. A redemption code is the food; an
    // access token is a read. They must not be interchangeable, and this is the
    // direction that would leak food: a code pasted into a URL must not open a page.
    const code = signRedemptionCode(
      { participantId: 'p-1', dropId: 'd-1', qty: 2 },
      deriveRedemptionSecret(SESSION),
    );

    expect(verifyParticipantAccess(code, SECRET)).toBeNull();
  });

  it('does not accept an access token as a redemption code', () => {
    // The reverse direction, and the one the scanner would hit: a forwarded SMS
    // link must not satisfy the counter's verification.
    const token = signParticipantAccess(PAYLOAD, SECRET);

    expect(verifyRedemptionCode(token, deriveRedemptionSecret(SESSION))).toBeNull();
  });
});
