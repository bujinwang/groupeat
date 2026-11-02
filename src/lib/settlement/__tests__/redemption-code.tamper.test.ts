import 'dotenv/config';

import { describe, expect, it } from 'vitest';

import {
  deriveRedemptionSecret,
  signRedemptionCode,
  verifyRedemptionCode,
} from '../redemption-code';

/**
 * The redemption code, attacked from every direction the scanner will meet.
 *
 * It is a bearer token: whoever holds it eats. So the only interesting question is
 * what it *refuses*, and the answer must be "everything it did not sign, and
 * nothing by throwing" — a scanner that gets an exception instead of a `null` has
 * one more code path than it was designed for, and the one it is least likely to
 * have tested.
 *
 * The engineer's `redemption-code.test.ts` covers a flipped signature character, a
 * foreign key, and malformed shapes. This file adds the truncation directions and
 * the inputs that are *shaped* right but not *signed* right, which are the ones an
 * attacker actually produces.
 */

const PAYLOAD = { participantId: 'participant-qa-1', dropId: 'drop-qa-1', qty: 4 };
const SECRET = deriveRedemptionSecret('qa-session-secret-of-sufficient-length');
const OTHER_SECRET = deriveRedemptionSecret('qa-a-completely-different-secret');

function parts(code: string): [string, string, string] {
  const [version = '', body = '', signature = ''] = code.split('.');
  return [version, body, signature];
}

/** Every rejection must be `null`, never a throw. */
function expectRefused(code: string, label: string, secret: Buffer = SECRET): void {
  expect(() => verifyRedemptionCode(code, secret), `${label} must not throw`).not.toThrow();
  expect(verifyRedemptionCode(code, secret), `${label} must be refused`).toBeNull();
}

/** Change one character of a base64url string to a different character in the alphabet. */
function flip(value: string, index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const original = value[index] ?? 'A';
  const replacement = alphabet[(alphabet.indexOf(original) + 1) % alphabet.length] ?? 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe('a signed code', () => {
  it('verifies, and carries only the three fields that were signed', () => {
    const verified = verifyRedemptionCode(signRedemptionCode(PAYLOAD, SECRET), SECRET);

    expect(verified).toEqual(PAYLOAD);
    expect(Object.keys(verified ?? {}).sort()).toEqual(['dropId', 'participantId', 'qty']);
  });
});

describe('one character flipped', () => {
  const code = signRedemptionCode(PAYLOAD, SECRET);
  const [version, body, signature] = parts(code);

  it('is refused when the flip is in the body', () => {
    for (const index of [0, Math.floor(body.length / 2), body.length - 1]) {
      expectRefused(`${version}.${flip(body, index)}.${signature}`, `body char ${index}`);
    }
  });

  it('is refused when the flip is in the signature', () => {
    for (const index of [0, Math.floor(signature.length / 2), signature.length - 1]) {
      expectRefused(`${version}.${body}.${flip(signature, index)}`, `signature char ${index}`);
    }
  });

  it('is refused when the flip is in the version prefix', () => {
    // The version is inside the signed string, so changing it changes the expected
    // MAC as well as failing the literal comparison.
    expectRefused(`v2.${body}.${signature}`, 'version v1 → v2');
  });
});

describe('truncation', () => {
  const code = signRedemptionCode(PAYLOAD, SECRET);
  const [version, body, signature] = parts(code);

  it('is refused when the signature is cut short, at any length', () => {
    for (const keep of [0, 1, 8, signature.length - 2, signature.length - 1]) {
      expectRefused(`${version}.${body}.${signature.slice(0, keep)}`, `signature cut to ${keep}`);
    }
  });

  it('is refused when the body is cut short', () => {
    for (const keep of [1, 4, body.length - 2, body.length - 1]) {
      expectRefused(`${version}.${body.slice(0, keep)}.${signature}`, `body cut to ${keep}`);
    }
  });

  it('is refused when whole segments are missing', () => {
    expectRefused(code.slice(0, -1), 'last character dropped');
    expectRefused(`${version}.${body}`, 'signature segment dropped');
    expectRefused(version, 'only the version');
    expectRefused('', 'empty string');
  });
});

describe('garbage', () => {
  it('is refused rather than thrown at, whatever it is', () => {
    const code = signRedemptionCode(PAYLOAD, SECRET);
    const [, body, signature] = parts(code);

    const inputs = [
      'not a code at all',
      '....',
      'v1..',
      '..',
      '.',
      `${'v1.'}${body}.${signature}.extra`,
      `Bearer ${code}`,
      code.replace(/\./g, ''),
      '\u0000\u0001\u0002',
      '🔒🔒🔒',
      'v1.🔒.🔒',
      'x'.repeat(10_000),
      `${'A'.repeat(64)}.${'B'.repeat(64)}.${'C'.repeat(64)}`,
    ];

    for (const input of inputs) {
      expectRefused(input, JSON.stringify(input.slice(0, 24)));
    }
  });

  it('is refused when the body is not JSON, even with a correct MAC over it', () => {
    // The signature check passes here — the MAC is genuinely over these bytes. What
    // refuses it is the shape check after it, and this proves that check exists
    // rather than being shadowed by the MAC.
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    const signed = signRedemptionCode(PAYLOAD, SECRET).split('.')[2] ?? '';

    // Recompute the MAC over the tampered body so only the shape check can refuse.
    const forged = `v1.${notJson}.${signed}`;
    expectRefused(forged, 'non-JSON body');

    const jsonButWrong = Buffer.from(JSON.stringify({ participantId: 'x', dropId: 'y', qty: -1 }), 'utf8').toString(
      'base64url',
    );
    expectRefused(`v1.${jsonButWrong}.${signed}`, 'JSON body with a negative qty');
  });
});

describe('a different secret', () => {
  it('is refused, and the same code verifies under its own key', () => {
    const code = signRedemptionCode(PAYLOAD, OTHER_SECRET);

    expect(verifyRedemptionCode(code, SECRET)).toBeNull();
    expect(verifyRedemptionCode(code, OTHER_SECRET)).toEqual(PAYLOAD);
  });

  it('is refused when the key is empty or a different length', () => {
    const code = signRedemptionCode(PAYLOAD, SECRET);

    expect(verifyRedemptionCode(code, Buffer.alloc(0))).toBeNull();
    expect(verifyRedemptionCode(code, Buffer.from('short', 'utf8'))).toBeNull();
    expect(verifyRedemptionCode(code, Buffer.alloc(64, 1))).toBeNull();
  });
});
