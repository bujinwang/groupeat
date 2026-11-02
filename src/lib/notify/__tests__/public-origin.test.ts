import 'dotenv/config';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validatePublicOrigin } from '@/lib/notify/public-origin';

/**
 * Which origins are allowed into a diner's link, and which are refused.
 *
 * ## Why this file is nothing but refusals
 *
 * The happy path is one line — `url.origin` from a valid https URL — and a test
 * that asserts it proves very little. The behaviour that matters is what happens
 * when `APP_URL` is set to something that *parses* but cannot work: `localhost`,
 * `127.0.0.1`, a LAN address, a bare hostname. Every one of those is a valid URL
 * and every one fails identically in production — the SMS sends, the link 404s,
 * the job passes, nothing logs. There is no error to notice. So the refusal list is
 * the specification, and each case here is one mistake an operator can make.
 *
 * ## What this is not
 *
 * `APP_URL` is operator-set deployment config, not user input. These checks exist
 * to catch a mistake loudly at the point of use, not to defend against an attacker
 * who already controls the environment. A hostname that merely *resolves* to a
 * loopback address — `127.0.0.1.nip.io`, say — passes, and that is a deliberate
 * non-goal: chasing DNS rebinding in a config validator would be security theatre
 * that also breaks legitimate wildcard-DNS deployments.
 */

function refusal(raw: string | undefined): string {
  const result = validatePublicOrigin(raw);
  if ('origin' in result) {
    throw new Error(`expected a refusal, got origin ${result.origin}`);
  }
  return result.reason;
}

function origin(raw: string | undefined): string {
  const result = validatePublicOrigin(raw);
  if ('reason' in result) {
    throw new Error(`expected an origin, got refusal ${result.reason}`);
  }
  return result.origin;
}

describe('an origin that can carry a link', () => {
  it('keeps an https origin as given', () => {
    expect(origin('https://groupeat.example')).toBe('https://groupeat.example');
  });

  it('keeps an explicit port, because the deployment may not be on 443', () => {
    // Dropping the port would point the link at whatever happens to answer on 443 —
    // a different service, or nothing.
    expect(origin('https://groupeat.example:8443')).toBe('https://groupeat.example:8443');
  });

  it('drops a trailing slash, a path, a query and a fragment', () => {
    // `origin` names a deployment root. The routing in this app is absolute
    // (`/d/:code/mine`), so a path prefix cannot be honoured — and silently keeping
    // one would produce links that look right and 404.
    expect(origin('https://groupeat.example/')).toBe('https://groupeat.example');
    expect(origin('https://groupeat.example/app/')).toBe('https://groupeat.example');
    expect(origin('https://groupeat.example?x=1')).toBe('https://groupeat.example');
    expect(origin('https://groupeat.example#top')).toBe('https://groupeat.example');
  });

  it('normalises case and surrounding whitespace', () => {
    // A `.env` value pasted from a dashboard often arrives with a trailing newline.
    expect(origin('  https://GroupEat.Example \n')).toBe('https://groupeat.example');
  });

  it('does not refuse a subdomain that merely ends in "local.example"', () => {
    // The `.local` check must be on the full suffix, not a substring: a legitimate
    // domain containing the word would otherwise be unusable.
    expect(origin('https://local.example')).toBe('https://local.example');
  });
});

describe('an origin that cannot carry a link', () => {
  it('treats absent and blank as the same thing', () => {
    // `optionalString()` in `config.ts` turns `APP_URL=` into `undefined`, so the
    // blank cases only reach here when the function is called directly. They must
    // still agree with the absent case: an operator who wrote `APP_URL=   ` has an
    // unset variable, not a malformed one, and the two refusals drive different
    // behaviour (silence vs a warning).
    expect(refusal(undefined)).toBe('UNSET');
    expect(refusal('')).toBe('UNSET');
    expect(refusal('   ')).toBe('UNSET');
  });

  it('refuses a bare hostname, which is the mistake that looks correct', () => {
    // `APP_URL=groupeat.example` reads fine and is not a URL. Relative resolution
    // would depend on the consumer, so this refuses rather than guessing a scheme.
    expect(refusal('groupeat.example')).toBe('NOT_A_URL');
    expect(refusal('groupeat')).toBe('NOT_A_URL');
  });

  it('refuses http, because the link carries a bearer token', () => {
    // The `?t=` token grants read access to one diner's order. Over http it crosses
    // the network in clear text. This is the reason for the check, not SMS platform
    // warnings — those are a symptom.
    expect(refusal('http://groupeat.example')).toBe('NOT_HTTPS');
    expect(refusal('http://groupeat.example:3000')).toBe('NOT_HTTPS');
  });

  it('refuses any non-https scheme rather than assuming it is a hostname', () => {
    expect(refusal('ftp://groupeat.example')).toBe('NOT_HTTPS');
    // `new URL('groupeat.example:3000')` parses — protocol `groupeat.example:`.
    // Without the https check this would return an origin no browser can open.
    expect(refusal('groupeat.example:3000')).toBe('NOT_HTTPS');
  });

  it('refuses loopback, which is the link-a-coworker-never-receives case', () => {
    expect(refusal('https://localhost')).toBe('NOT_PUBLIC');
    expect(refusal('https://localhost:3000')).toBe('NOT_PUBLIC');
    expect(refusal('https://127.0.0.1')).toBe('NOT_PUBLIC');
    expect(refusal('https://0.0.0.0')).toBe('NOT_PUBLIC');
    expect(refusal('https://[::1]')).toBe('NOT_PUBLIC');
  });

  it('refuses any bare IPv4 address, not just the loopback range', () => {
    // A bare IP has no certificate that matches, so `https:` there fails on the
    // diner's phone even when the address is reachable. Refusing all of them is
    // simpler than deciding which ranges are "internal".
    expect(refusal('https://192.168.1.50')).toBe('NOT_PUBLIC');
    expect(refusal('https://10.0.0.5:8443')).toBe('NOT_PUBLIC');
    expect(refusal('https://8.8.8.8')).toBe('NOT_PUBLIC');
  });

  it('refuses mDNS, which only resolves on the developer\'s own LAN', () => {
    // The shape of the mistake here is a developer testing on their phone: the link
    // works for them and for nobody else.
    expect(refusal('https://macbook.local')).toBe('NOT_PUBLIC');
    expect(refusal('https://GroupEat.Local:3000')).toBe('NOT_PUBLIC');
  });
});

describe('publicOrigin() against the environment', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns the validated origin when APP_URL is usable', async () => {
    vi.stubEnv('APP_URL', 'https://groupeat.example/');
    const { publicOrigin } = await import('@/lib/notify/public-origin');
    expect(publicOrigin()).toBe('https://groupeat.example');
  });

  it('returns undefined without warning when APP_URL is unset', async () => {
    // Not a warning: a fresh checkout, a test run and a local dev loop all
    // legitimately have no public origin, and "no link" is the correct outcome.
    vi.stubEnv('APP_URL', '');
    const { publicOrigin } = await import('@/lib/notify/public-origin');
    const { logger } = await import('@/lib/logging/logger');
    const warn = vi.spyOn(logger, 'warn');

    expect(publicOrigin()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, naming the reason, when APP_URL is set but unusable', async () => {
    // This is the whole visibility story for a misconfigured deployment: the job
    // passes either way, so this log line is the only evidence.
    vi.stubEnv('APP_URL', 'http://groupeat.example');
    const { publicOrigin } = await import('@/lib/notify/public-origin');
    const { logger } = await import('@/lib/logging/logger');
    const warn = vi.spyOn(logger, 'warn');

    expect(publicOrigin()).toBeUndefined();
    expect(publicOrigin()).toBeUndefined();
    expect(publicOrigin()).toBeUndefined();

    // Once per process, not once per drop — a tick settling forty diners builds
    // forty links, and forty identical warnings is how a log gets ignored.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('notify.public_origin_rejected', { reason: 'NOT_HTTPS' });
  });
});
