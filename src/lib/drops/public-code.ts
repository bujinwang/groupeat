import { randomInt } from 'node:crypto';

/**
 * `Drop.publicCode` — the short, human-transcribable slug in `/d/{publicCode}`.
 *
 * ## Why a hand-written alphabet
 *
 * A public code gets read out loud, copied off a screenshot, and typed on a
 * phone. So the alphabet omits every character that survives none of those:
 *
 *   - `0` and `O` — the classic pair, which turns a shared link into "it says the
 *     drop doesn't exist".
 *   - `1`, `I` and `L` — same failure, three characters deep, because a
 *     sans-serif `1` is a bare vertical stroke.
 *   - `U` — excluded so a generated code cannot accidentally spell a word
 *     (the Crockford convention). Costs one symbol out of 31 and removes a
 *     category of support ticket nobody wants to read out to a customer.
 *
 * **Both members of each confusable pair are removed**, not one. That choice is
 * what makes `normalisePublicCode()` below honest: there is no lookalike to map
 * onto, so nothing has to be guessed on the user's behalf.
 *
 * 30 characters over 8 positions is 30^8 ≈ 6.6 × 10^11 codes. At a million
 * drops the birthday-collision probability is ~0.07%, which the unique index on
 * `publicCode` catches and the retry loop in `createDraft()` handles.
 *
 * ## Why `node:crypto` and not `Math.random`
 *
 * A public code is a bearer token: anybody holding the URL can view the deal.
 * `Math.random()` output is predictable from a handful of observations, which
 * would let someone enumerate other merchants' unpublished drops. `randomInt`
 * is cryptographically secure and rejection-samples internally, so it also
 * avoids the modulo bias a naive `% alphabet.length` would introduce.
 *
 * This module therefore requires the Node runtime. It is not imported by
 * middleware or by any client component.
 */

/** No `0`/`O`, no `1`/`I`/`L`, no `U`. Thirty symbols. See above. */
export const PUBLIC_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Long enough to be unguessable, short enough to type. */
export const PUBLIC_CODE_LENGTH = 8;

/** A single attempt. Callers writing to the database retry on collision. */
export function generatePublicCode(): string {
  let code = '';
  for (let index = 0; index < PUBLIC_CODE_LENGTH; index += 1) {
    code += PUBLIC_CODE_ALPHABET[randomInt(PUBLIC_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Shape check for an incoming code, before it reaches a database query.
 *
 * Rejecting a malformed code early is not only an optimisation: it means a
 * request with an arbitrary string in the path never becomes a `findUnique` on
 * attacker-controlled input, and the 404 for "wrong shape" is identical to the
 * 404 for "not found", so the two cannot be told apart.
 */
export function isWellFormedPublicCode(value: string): boolean {
  if (value.length !== PUBLIC_CODE_LENGTH) {
    return false;
  }
  for (const character of value) {
    if (!PUBLIC_CODE_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Normalises what a person pasted or typed into a candidate code.
 *
 * Deliberately does **not** map lookalike characters. Because the alphabet
 * excludes both `0`/`O` and all of `1`/`I`/`L`, a stored code can never contain
 * any of them — so mapping a typed `O` to a `0` would mean inventing a character
 * that cannot exist. Guessing here would produce a code that fails the shape
 * check in a way the user cannot diagnose.
 *
 * What it does do is strip the noise that pasting actually produces: surrounding
 * whitespace, lowercase, and the separators people add when transcribing
 * (`ABC-123` or `ABC 123`). A full URL is also accepted, because the most common
 * way to arrive at a code page is by pasting the link.
 */
export function normalisePublicCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    return '';
  }

  // Drop a query string and a fragment first: `/d/CODE?o=token#top`.
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  const segments = withoutQuery.split('/').filter((segment) => segment !== '');

  // If the path names the deal route (`/d/CODE`, or a full URL ending in one),
  // the code is the segment *after* the last `d`. Taking the last segment
  // instead would return `"D"` for a bare `/d/`, which is a route prefix, not a
  // code — and it passes a length check for nobody but still reaches the
  // database as a lookup.
  const lastRouteIndex = segments.map((segment) => segment.toLowerCase()).lastIndexOf('d');
  const candidate =
    lastRouteIndex >= 0 ? (segments[lastRouteIndex + 1] ?? '') : (segments.at(-1) ?? '');

  return candidate.replace(/[\s-]/g, '').toUpperCase();
}
