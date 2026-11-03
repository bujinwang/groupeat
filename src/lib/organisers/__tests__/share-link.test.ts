import { describe, expect, it } from 'vitest';

import {
  DEAL_VIEW_SOURCES,
  VIEW_SOURCE_PARAM,
  isDealViewSource,
} from '@/lib/analytics/funnel';

import {
  ORGANISER_LINK_SOURCE,
  SHARE_TOKEN_BYTES,
  SHARE_TOKEN_LENGTH,
  SHARE_TOKEN_PARAM,
  isShareToken,
  shareMessageFor,
  shareUrlFor,
} from '../share-link';

/**
 * FR-802's pure half — the URL, the message, and the token shape.
 *
 * ## What these tests protect
 *
 *   1. **The link and the funnel agree.** `?src=` is a closed set of three values in
 *      `funnel.ts`, deliberately not extensible so a stranger cannot pollute the
 *      funnel. If the share link emitted a value outside that set, every organiser
 *      view would classify as `direct` — the organiser's contribution would vanish
 *      from the only metric that shows it, and nothing would error.
 *   2. **The message never invents a claim.** It quotes the two prices that are
 *      already on the deal page and a deadline that is already real. A generated
 *      message is still a claim when an organiser forwards it.
 *   3. **The message cannot name a person.** FR-805. There is no field on the input
 *      that could carry one, and the test pins that the rendered text contains no
 *      count-derived name-like content.
 */

const CUTOFF = new Date('2026-11-05T23:00:00.000Z');
const TOKEN = 'abcdefghijklmnopqrstuv';

function message(overrides: Partial<Parameters<typeof shareMessageFor>[0]> = {}) {
  return shareMessageFor({
    title: 'Tuesday lunch bowl',
    merchantName: 'Kaffa Roasters',
    dealPriceCents: 1200,
    menuPriceCents: 1600,
    minQty: 20,
    joinedQty: 8,
    cutoffAt: CUTOFF,
    timeZone: 'America/Edmonton',
    url: 'https://groupeat.example/d/ABC123?src=organiser_link&o=abc',
    ...overrides,
  });
}

describe('shareUrlFor', () => {
  it('carries a source the funnel actually recognises', () => {
    const url = shareUrlFor({ publicCode: 'ABC123', token: TOKEN, origin: 'https://groupeat.example' });

    // The drift guard. `ORGANISER_LINK_SOURCE` is a string literal on one side and a
    // union member on the other; this is the only place they are compared.
    expect(isDealViewSource(ORGANISER_LINK_SOURCE)).toBe(true);
    expect(DEAL_VIEW_SOURCES).toContain(ORGANISER_LINK_SOURCE);
    expect(url).toContain(`${VIEW_SOURCE_PARAM}=${ORGANISER_LINK_SOURCE}`);
  });

  it('carries the token in its own parameter, not folded into src', () => {
    // Folding it into `src` would turn a three-value closed set into an open one —
    // exactly what the `resolveViewSource` comment forbids.
    const url = shareUrlFor({ publicCode: 'ABC123', token: TOKEN, origin: 'https://groupeat.example' });

    expect(url).toContain(`${SHARE_TOKEN_PARAM}=${TOKEN}`);
    expect(isDealViewSource(url.split('src=')[1]?.split('&')[0])).toBe(true);
  });

  it('builds an absolute URL from a public origin', () => {
    expect(shareUrlFor({ publicCode: 'ABC123', token: TOKEN, origin: 'https://groupeat.example' })).toBe(
      `https://groupeat.example/d/ABC123?src=organiser_link&o=${TOKEN}`,
    );
  });

  it('falls back to a relative path rather than guessing a host', () => {
    // `APP_URL` unset (a fresh checkout, a test run) or rejected (not https, not
    // public). Guessing would put `http://localhost:3000` into a WeChat message and
    // look correct on the machine that produced it — the worst property a broken link
    // can have.
    expect(shareUrlFor({ publicCode: 'ABC123', token: TOKEN, origin: undefined })).toBe(
      `/d/ABC123?src=organiser_link&o=${TOKEN}`,
    );
  });

  it('escapes a public code rather than trusting it', () => {
    const url = shareUrlFor({ publicCode: 'A B/C', token: TOKEN, origin: undefined });
    expect(url).toContain('/d/A%20B%2FC?');
  });
});

describe('isShareToken', () => {
  it('accepts a 22-character base64url string', () => {
    expect(isShareToken(TOKEN)).toBe(true);
    // Both base64url-only characters that a plain base64 alphabet would reject.
    expect(isShareToken('abc-_DEF0123456789abcd')).toBe(true);
  });

  it('rejects everything else before it can reach a query', () => {
    // The point of the shape check: `?o=<script>` costs a regex, not a database read.
    for (const value of [
      '',
      'short',
      'abcdefghijklmnopqrstuvw', // 23
      'abcdefghijklmnopqrstu', // 21
      'abcdefghijklmnopqrstu!', // bad character
      'abcdefghijklmnopqrstu+',
      null,
      undefined,
      42,
      ['abcdefghijklmnopqrstuv'],
    ]) {
      expect(isShareToken(value)).toBe(false);
    }
  });

  it('matches the length the generator produces', () => {
    // 16 bytes base64url-encoded without padding is 22 characters. If either number
    // changes, the generator's own assertion and this one both fire.
    expect(SHARE_TOKEN_LENGTH).toBe(Math.ceil((SHARE_TOKEN_BYTES * 4) / 3));
  });
});

describe('shareMessageFor', () => {
  it('quotes the two real prices and the real discount', () => {
    const text = message();

    expect(text).toContain('$12.00');
    expect(text).toContain('$16.00');
    // (1600 - 1200) / 1600 = 25%
    expect(text).toContain('25% off');
  });

  it('says how many are needed and by when, before the threshold', () => {
    const text = message({ joinedQty: 8, minQty: 20 });

    expect(text).toContain('8 of 20 needed');
    // The deadline comes from `momentLabel` in the merchant's own zone, not the
    // server's: 2026-11-05T23:00Z is Thursday 5:00 PM MST, because Edmonton is UTC−6
    // in November. An implementation using the server's zone would say Friday.
    expect(text).toContain('Thursday 5:00 PM');
  });

  it('changes the sentence once the threshold is met instead of going stale', () => {
    // "We need 20" after the drop is locked reads as a bug to everyone who taps it.
    const text = message({ joinedQty: 20, minQty: 20 });

    expect(text).toContain('It’s on');
    expect(text).toContain('20 plates so far');
    expect(text).not.toContain('needed');
  });

  it('says "plate" for one, because a group chat notices', () => {
    expect(message({ joinedQty: 1, minQty: 1 })).toContain('1 plate so far');
  });

  it('omits the discount when there is none, rather than printing 0% off', () => {
    const text = message({ dealPriceCents: 1600, menuPriceCents: 1600 });

    expect(text).toContain('$16.00');
    expect(text).not.toContain('% off');
    expect(text).not.toContain('instead of');
  });

  it('survives a zero menu price without dividing by zero', () => {
    const text = message({ dealPriceCents: 0, menuPriceCents: 0 });
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });

  it('is four lines, because it is pasted next to other people’s messages', () => {
    expect(message().split('\n')).toHaveLength(4);
  });

  it('names the dish, the restaurant, and the link', () => {
    const text = message();

    expect(text).toContain('Tuesday lunch bowl');
    expect(text).toContain('Kaffa Roasters');
    expect(text).toContain('https://groupeat.example/d/ABC123');
  });

  it('contains no participant information of any kind', () => {
    // FR-805, as a property of the text rather than of the query. The input type has no
    // field that could carry a name or a phone; this asserts the rendered output too,
    // because a future template could add one from somewhere else.
    const text = message({ joinedQty: 7 });

    expect(text).not.toMatch(/\+1\d{10}/);
    expect(text).not.toMatch(/@/);
    // A count is a number, not a person.
    expect(text).toContain('7 of 20');
  });
});
