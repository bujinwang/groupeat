import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertNoPii,
  DEAL_VIEW_SOURCES,
  dealPageViewed,
  dealPageViewEvent,
  dropDecided,
  dropPublished,
  isDealViewSource,
  isHumanView,
  joinAuthorised,
  joinFailed,
  joinStarted,
  looksLikeBot,
  resolveViewSource,
  thresholdReached,
  VIEW_SOURCE_PARAM,
} from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';

/**
 * PRD-v1 §10.1's funnel — the pure half.
 *
 * The builders decide *what happened* and are tested with no filesystem; the sink
 * is tested once, at the end, through `record`. That split is the point of the
 * module, so the majority of these tests never touch disk.
 *
 * The assertions are written against literals rather than against other functions
 * in the module: a test that asks `thresholdReached` twice and compares the answers
 * agrees with itself no matter what the rule is.
 */

describe('§10.1 · view attribution', () => {
  it('passes through each source the PRD names', () => {
    for (const source of DEAL_VIEW_SOURCES) {
      expect(resolveViewSource(source)).toBe(source);
    }
    expect(DEAL_VIEW_SOURCES).toEqual(['organiser_link', 'direct', 'preview']);
  });

  it('falls back to direct for anything unrecognised', () => {
    // An open-ended bucket set would let a stranger invent a source and pollute
    // the funnel; a 400 on a marketing parameter would be worse than imprecision.
    expect(resolveViewSource(undefined)).toBe('direct');
    expect(resolveViewSource('')).toBe('direct');
    expect(resolveViewSource('ORGANISER_LINK')).toBe('direct');
    expect(resolveViewSource('../../etc/passwd')).toBe('direct');
    expect(resolveViewSource('email')).toBe('direct');
  });

  it('takes the first value when the parameter is repeated', () => {
    expect(resolveViewSource(['preview', 'direct'])).toBe('preview');
    expect(resolveViewSource(['nonsense', 'preview'])).toBe('direct');
    expect(resolveViewSource([])).toBe('direct');
  });

  it('exposes the parameter name the links will carry', () => {
    // If this changes, every link already in a group chat loses its attribution
    // silently — nothing errors, the `source` bucket just becomes all `direct`.
    expect(VIEW_SOURCE_PARAM).toBe('src');
    expect(isDealViewSource('organiser_link')).toBe(true);
    expect(isDealViewSource('direct ')).toBe(false);
  });
});

describe('§10.1 · a link-preview fetcher is not a reader', () => {
  const headers = (entries: Record<string, string>) => ({
    get: (name: string) => entries[name.toLowerCase()] ?? null,
  });

  it('counts a top-level navigation by a person', () => {
    expect(
      isHumanView(
        headers({
          'sec-fetch-mode': 'navigate',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        }),
      ),
    ).toBe(true);
  });

  it('does not count a real preview fetcher', () => {
    // These are the actual user agents the distribution channel uses. WhatsApp and
    // WeChat are the two that matter: this is how the link reaches a diner.
    const fetchers = [
      'WhatsApp/2.23.20.0 A',
      'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
      'TelegramBot (like TwitterBot)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Twitterbot/1.0',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
      'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embedly.com/)',
      'curl/8.7.1',
      'python-requests/2.31.0',
      'Go-http-client/1.1',
    ];

    for (const agent of fetchers) {
      // Some send `navigate` as well, which is exactly why the UA check exists.
      expect(isHumanView(headers({ 'sec-fetch-mode': 'navigate', 'user-agent': agent }))).toBe(
        false,
      );
    }
  });

  it('does not count a request with no navigation mode', () => {
    // A subresource, an XHR, or a prefetch. A real browser sends `navigate` for the
    // page itself, so this is not a person reading the offer.
    expect(
      isHumanView(headers({ 'sec-fetch-mode': 'cors', 'user-agent': 'Mozilla/5.0' })),
    ).toBe(false);
    expect(
      isHumanView(headers({ 'sec-fetch-mode': 'no-cors', 'user-agent': 'Mozilla/5.0' })),
    ).toBe(false);
  });

  it('does not count a request with no user agent at all', () => {
    expect(isHumanView(headers({ 'sec-fetch-mode': 'navigate' }))).toBe(false);
    expect(isHumanView(headers({}))).toBe(false);
  });

  it('counts an older browser that sends no sec-fetch-mode but looks human', () => {
    // Being wrong here under-counts a view, which is the safe direction: it cannot
    // hide a drop that is failing to convert.
    expect(isHumanView(headers({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/90.0' }))).toBe(
      true,
    );
  });

  it('treats a missing user agent as a bot', () => {
    expect(looksLikeBot(null)).toBe(true);
    expect(looksLikeBot(undefined)).toBe(true);
    expect(looksLikeBot('')).toBe(true);
    expect(looksLikeBot('Mozilla/5.0 (Macintosh) Chrome/130.0')).toBe(false);
  });
});

describe('§10.1 · threshold_reached fires exactly once', () => {
  const base = { dropId: 'drop-1', minQty: 5 };

  it('fires on the join that crosses the minimum', () => {
    const event = thresholdReached({ ...base, previousQty: 4, currentQty: 5 });
    expect(event?.event).toBe('threshold_reached');
    expect(event?.payload).toMatchObject({
      dropId: 'drop-1',
      minQty: 5,
      previousQty: 4,
      currentQty: 5,
    });
  });

  it('fires when the crossing overshoots, as a multi-plate join does', () => {
    const event = thresholdReached({ ...base, previousQty: 2, currentQty: 6 });
    expect(event?.event).toBe('threshold_reached');
  });

  it('does not fire while still below', () => {
    expect(thresholdReached({ ...base, previousQty: 2, currentQty: 3 })).toBeNull();
  });

  it('does not fire again on the join after the crossing', () => {
    // This is the "exactly once" property. A drop that reached 5 and then goes to 6
    // must not report two crossings, or the hit rate exceeds 100%.
    expect(thresholdReached({ ...base, previousQty: 5, currentQty: 6 })).toBeNull();
  });

  it('does not fire when already past and staying past', () => {
    expect(thresholdReached({ ...base, previousQty: 9, currentQty: 10 })).toBeNull();
  });

  it('does not fire on a decrease, which is a void and not a crossing', () => {
    // A refund or a void must never be mistaken for reaching the threshold, even
    // though `currentQty >= minQty` may still hold. `after < before` is not a join.
    expect(thresholdReached({ ...base, previousQty: 6, currentQty: 5 })).toBeNull();
    expect(thresholdReached({ ...base, previousQty: 5, currentQty: 4 })).toBeNull();
  });

  it('refuses a nonsensical threshold rather than firing on every join', () => {
    expect(thresholdReached({ ...base, minQty: 0, previousQty: 0, currentQty: 1 })).toBeNull();
    expect(thresholdReached({ ...base, minQty: -3, previousQty: -4, currentQty: 1 })).toBeNull();
    expect(thresholdReached({ ...base, minQty: 2.5, previousQty: 1, currentQty: 3 })).toBeNull();
  });

  it('refuses non-finite totals', () => {
    expect(
      thresholdReached({ ...base, minQty: 5, previousQty: Number.NaN, currentQty: 5 }),
    ).toBeNull();
    expect(
      thresholdReached({ ...base, minQty: 5, previousQty: 4, currentQty: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });

  it('treats a one-plate minimum as crossed from zero', () => {
    expect(
      thresholdReached({ ...base, minQty: 1, previousQty: 0, currentQty: 1 })?.event,
    ).toBe('threshold_reached');
  });
});

describe('§10.1 · the cutoff outcome is two different events', () => {
  it('reports LOCKED and FAILED as distinct names', () => {
    expect(
      dropDecided({ dropId: 'd', outcome: 'LOCKED', joinedQty: 6, minQty: 5 }).event,
    ).toBe('drop_locked');
    expect(dropDecided({ dropId: 'd', outcome: 'FAILED', joinedQty: 2, minQty: 5 }).event).toBe(
      'drop_failed',
    );
  });

  it('records how far short a failed drop fell', () => {
    // "Missed by one" and "sold nothing" are different problems and only one of them
    // is a marketing fix. The subtraction is asserted against a literal.
    expect(
      dropDecided({ dropId: 'd', outcome: 'FAILED', joinedQty: 2, minQty: 5 }).payload,
    ).toMatchObject({ joinedQty: 2, minQty: 5, shortBy: 3 });
    expect(
      dropDecided({ dropId: 'd', outcome: 'FAILED', joinedQty: 0, minQty: 1 }).payload,
    ).toMatchObject({ shortBy: 1 });
  });

  it('never reports a negative shortfall on a locked drop', () => {
    expect(
      dropDecided({ dropId: 'd', outcome: 'LOCKED', joinedQty: 9, minQty: 5 }).payload,
    ).toMatchObject({ shortBy: 0 });
  });
});

describe('§10.1 · no PII can reach the stream', () => {
  it('rejects a key that names an identifier', () => {
    for (const key of ['phoneLast4', 'customerPhone', 'email', 'customerName', 'address', 'token']) {
      expect(() => assertNoPii({ [key]: 'x' })).toThrow(/PII/);
    }
  });

  it('matches whole words, so participantId is not caught by "ip"', () => {
    // The first version of the guard used `includes('ip')` and rejected
    // `participantId`, which is a required field on two of these events. A guard
    // that refuses a legitimate field is a guard the next person deletes, taking the
    // genuine checks with it. This asserts the fix, not just the absence of a crash.
    expect(() => assertNoPii({ participantId: 'p1' })).not.toThrow();
    expect(() => assertNoPii({ ip: '1.2.3.4' })).toThrow(/PII/);
    expect(() => assertNoPii({ client_ip: '1.2.3.4' })).toThrow(/PII/);
    expect(() => assertNoPii({ clientIp: '1.2.3.4' })).toThrow(/PII/);
    expect(() => assertNoPii({ description: 'fine' })).not.toThrow();
  });

  it('rejects a value that looks like an email', () => {
    expect(() => assertNoPii({ note: 'someone@example.com' })).toThrow(/email/);
  });

  it('does not reject an id merely for containing ten digits', () => {
    // A cuid such as `ckx1234567890` has a ten-digit run and is not a phone number.
    // Rejecting it would have made every real event throw, which the suite caught.
    expect(() => assertNoPii({ dropId: 'ckx1234567890' })).not.toThrow();
    expect(() => assertNoPii({ participantId: 'cm3k2j4h50000abcd123456789' })).not.toThrow();
  });

  it('allows ids, cents and enums', () => {
    expect(() =>
      assertNoPii({ dropId: 'ckx1234567890', amountCents: 1310, reason: 'BAD_QTY', source: null }),
    ).not.toThrow();
  });

  it('is applied by every builder, not just available', () => {
    // The guard is worthless if a builder can bypass it. Each of these takes a
    // string that would be a plausible thing to add later and puts it in a field
    // name that must be refused.
    expect(() => joinFailed({ dropId: 'd', reason: 'x' })).not.toThrow();
    const hostile = 'oops@example.com';
    expect(() => joinFailed({ dropId: hostile, reason: 'x' })).toThrow(/email/);
    expect(() => joinStarted({ dropId: hostile, qty: 1 })).toThrow(/email/);
    expect(() => joinAuthorised({ dropId: hostile, participantId: 'p', qty: 1, amountCents: 100 }))
      .toThrow(/email/);
    expect(() => dealPageViewed({ dropId: hostile, merchantId: 'm', source: 'direct' })).toThrow(
      /email/,
    );
  });
});

describe('§10.1 · the payloads carry what the metric needs', () => {
  it('deal_page_viewed names the drop and the source', () => {
    expect(dealPageViewed({ dropId: 'd1', merchantId: 'm1', source: 'organiser_link' })).toEqual({
      event: 'deal_page_viewed',
      payload: { dropId: 'd1', merchantId: 'm1', source: 'organiser_link' },
    });
  });

  it('join_authorised carries the money claim, in integer cents', () => {
    const { payload } = joinAuthorised({
      dropId: 'd1',
      merchantId: 'm1',
      participantId: 'p1',
      qty: 2,
      amountCents: 2620,
    });
    expect(payload).toMatchObject({ qty: 2, amountCents: 2620, participantId: 'p1' });
    expect(Number.isInteger(payload.amountCents)).toBe(true);
  });

  it('omits dropId rather than writing an empty string when the drop is unknown', () => {
    // An empty string is a value that looks like an id: it joins to nothing and
    // silently breaks a GROUP BY. A missing key is honest.
    const { payload } = joinStarted({ qty: 1 });
    expect(payload).not.toHaveProperty('dropId');
    expect(payload).not.toHaveProperty('merchantId');
    expect(payload.qty).toBe(1);
  });

  it('keeps dropId when it is known', () => {
    expect(joinStarted({ dropId: 'd1', qty: 2 }).payload).toMatchObject({ dropId: 'd1', qty: 2 });
  });

  it('drop_published carries the denominator’s fields', () => {
    expect(
      dropPublished({ dropId: 'd1', merchantId: 'm1', dealPriceCents: 1310, minQty: 5, maxQty: 20 })
        .payload,
    ).toMatchObject({ minQty: 5, maxQty: 20, dealPriceCents: 1310 });
  });
});

describe('§10.1 · the page’s whole decision, in one testable call', () => {
  const headers = (entries: Record<string, string>) => ({
    get: (name: string) => entries[name.toLowerCase()] ?? null,
  });
  const reader = headers({
    'sec-fetch-mode': 'navigate',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1',
  });

  it('emits for a person, with the attributed source', () => {
    expect(
      dealPageViewEvent({
        dropId: 'd1',
        merchantId: 'm1',
        headers: reader,
        query: { src: 'organiser_link' },
      }),
    ).toEqual({
      event: 'deal_page_viewed',
      payload: { dropId: 'd1', merchantId: 'm1', source: 'organiser_link' },
    });
  });

  it('still emits for a person with no attribution, as direct', () => {
    const event = dealPageViewEvent({ dropId: 'd1', merchantId: 'm1', headers: reader, query: {} });
    expect(event?.payload.source).toBe('direct');
  });

  it('emits nothing for a fetcher, whatever the source says', () => {
    // The property that makes the metric honest: a share must not add a viewer.
    expect(
      dealPageViewEvent({
        dropId: 'd1',
        merchantId: 'm1',
        headers: headers({
          'user-agent': 'WhatsApp/2.23.20.0 A',
          'sec-fetch-mode': 'navigate',
        }),
        query: { src: 'organiser_link' },
      }),
    ).toBeNull();
  });

  it('survives a missing query parameter entirely', () => {
    // `searchParams` is typed as possibly-undefined per key; a destructured read of a
    // missing key must not throw on the one page a stranger sees first.
    const event = dealPageViewEvent({
      dropId: 'd1',
      merchantId: 'm1',
      headers: reader,
      query: { src: undefined },
    });
    expect(event?.payload.source).toBe('direct');
  });
});

describe('§10.1 · the sink accepts the new names and still never throws', () => {
  let dir: string;
  let path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'groupeat-funnel-'));
    path = join(dir, 'events.jsonl');
    const previous = process.env.ANALYTICS_LOG_PATH;
    process.env.ANALYTICS_LOG_PATH = path;
    expect(previous === undefined || typeof previous === 'string').toBe(true);
  });

  afterAll(() => {
    delete process.env.ANALYTICS_LOG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a funnel event through record()', () => {
    record(dealPageViewed({ dropId: 'd-write', merchantId: 'm-write', source: 'preview' }));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    expect(last.event).toBe('deal_page_viewed');
    expect(last.source).toBe('preview');
    expect(typeof last.ts).toBe('string');
  });

  it('accepts a null event without writing one', () => {
    const before = readFileSync(path, 'utf8').trim().split('\n').length;
    record(null);
    const after = readFileSync(path, 'utf8').trim().split('\n').length;
    expect(after).toBe(before);
  });
});
