/**
 * Which origin goes into a link a diner receives — and why this is not `originOf`.
 *
 * ## The two questions, and why they are not the same
 *
 * `api/merchant/stripe/onboard` derives its return URL from the **incoming
 * request** (`Host` + `x-forwarded-proto`). That is correct there: the merchant is
 * sitting in a browser, the browser just talked to this host, and sending them back
 * to the host they came from is exactly right.
 *
 * A notification link is a different question. It is built by a **job**, not by a
 * diner's browser. The `Host` on that request is whatever header the scheduler
 * happened to send — a container name, an internal address, an IP, or nothing at
 * all. Deriving the link from it produces exactly the failure this project has
 * already written down once: a link that says `localhost`, delivered to a phone.
 *
 * So the rule here is the opposite one: **an explicit origin, or no link.** Never a
 * guess. A message carrying the code and no link is strictly better than a message
 * carrying a broken one — the diner can still show the code, and nobody has to
 * explain why their order page does not open.
 *
 * ## Why the env var is not `NEXT_PUBLIC_*`
 *
 * It is only ever read on the server, in a job. A `NEXT_PUBLIC_` prefix would
 * inline the deployment's origin into every client bundle for no benefit and one
 * small cost: the origin becomes part of the browser payload, so a preview
 * deployment and its staging sibling can disagree about what they are. `APP_URL`,
 * read from `env`, keeps it where it is used.
 *
 * ## Why a bad value is refused rather than trimmed into shape
 *
 * `APP_URL` ends up in a link a stranger taps. `localhost`, `127.0.0.1` and a bare
 * hostname are all *valid* URLs and all *wrong* as a public origin, and every one of
 * them fails in the same silent way: the message sends, the link 404s, and nothing
 * logs. So this validates loudly at the point of use and returns `undefined` — which
 * the caller treats as "no link", the safe answer — while logging once so the
 * misconfiguration is visible before a diner finds it.
 */

import { env } from '@/lib/config';
import { logger } from '@/lib/logging/logger';

/**
 * Hostnames that can never be a public origin.
 *
 * `localhost` and the loopback literals are the obvious ones. `.local` is mDNS and
 * only resolves on the same LAN, which is the shape of mistake a developer makes
 * testing on a phone. A bare IP is excluded separately in `validate`.
 */
const NON_PUBLIC_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * A validated absolute origin, or `undefined`.
 *
 * Exported for the test: the interesting behaviour is the refusals, and they are
 * pure string work that does not deserve a database.
 */
export function validatePublicOrigin(
  raw: string | undefined,
): { origin: string } | { reason: PublicOriginRefusal } {
  // Trimmed before the emptiness test, not after. A blank value and an absent one
  // mean the same thing to an operator, and `optionalString()` in `config.ts`
  // already collapses `APP_URL=` to `undefined` — so `''` and `'   '` must not
  // disagree about which refusal they produce.
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    return { reason: 'UNSET' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { reason: 'NOT_A_URL' };
  }

  // A link in an SMS is tapped, and an SMS cannot carry a `http://` link to a
  // production site without the platform warning about it — and, more concretely,
  // a diner's token would cross the network in clear text.
  if (url.protocol !== 'https:') {
    return { reason: 'NOT_HTTPS' };
  }

  if (NON_PUBLIC_HOSTS.has(url.hostname)) {
    return { reason: 'NOT_PUBLIC' };
  }

  // A bare IPv4 address is not a public origin for a customer-facing link: it has no
  // certificate that matches, so `https:` there fails anyway.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) {
    return { reason: 'NOT_PUBLIC' };
  }

  if (url.hostname.endsWith('.local')) {
    return { reason: 'NOT_PUBLIC' };
  }

  // Path, query and fragment are dropped rather than honoured. `APP_URL` names a
  // deployment root; a deployment served under a path prefix is not supported by the
  // routing in this app (`/d/:code` is absolute), and silently keeping the prefix
  // would produce links that 404 while looking correct.
  return { origin: url.origin };
}

export type PublicOriginRefusal =
  | 'UNSET'
  | 'NOT_A_URL'
  | 'NOT_HTTPS'
  | 'NOT_PUBLIC';

let warned = false;

/**
 * The origin to put in notification links, or `undefined`.
 *
 * Logs once per process when it is set but unusable, because that is a deployment
 * mistake that would otherwise be completely invisible: the messages still send,
 * the jobs still pass, and only the diner sees a dead link.
 */
export function publicOrigin(): string | undefined {
  const result = validatePublicOrigin(env.APP_URL);
  if ('origin' in result) {
    return result.origin;
  }
  if (result.reason === 'UNSET') {
    // Not a warning. A fresh checkout, a test run and a local dev loop all
    // legitimately have no public origin, and the outcome (no link) is correct.
    return undefined;
  }
  if (!warned) {
    warned = true;
    logger.warn('notify.public_origin_rejected', { reason: result.reason });
  }
  return undefined;
}
