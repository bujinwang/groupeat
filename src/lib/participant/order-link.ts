import { signParticipantAccess } from './access';

/**
 * Where a diner's own order lives — the one place the link is composed.
 *
 * ## Why this is a separate module from `order-page.ts`
 *
 * `order-page.ts` reads the database. The confirmation screen needs a link the
 * moment a join succeeds, and so does a text message six hours later; neither of
 * them should have to import a Prisma client to get one. Splitting the string work
 * out means the link can be built anywhere, and — more importantly — there is
 * exactly **one** function that decides what a valid link looks like.
 *
 * ## Why a path, and not only an absolute URL
 *
 * These are two different questions and they have two different answers, which is
 * the mistake this module exists to prevent.
 *
 *   - **In the browser**, a relative path is right. The diner is already on the
 *     deployment's origin; `/d/CODE/mine?t=…` cannot say `localhost`, cannot
 *     disagree with `APP_URL`, and cannot be wrong about the scheme. An absolute
 *     URL there would be strictly worse and would make the confirmation depend on
 *     deployment config that has nothing to do with the page the diner is looking at.
 *   - **In an SMS**, an absolute URL is required, and it has to be an origin the
 *     diner's phone can reach — which is `APP_URL`, validated in
 *     `notify/public-origin.ts`, or no link at all (never a guess).
 *
 * So the path is the primitive and the absolute form is the path with a prefix
 * attached. `orderUrl` is that prefix, and it exists for the job that sends the SMS.
 *
 * ## What the path must never contain
 *
 * The redemption code. The `?t=` token grants *read* access to one diner's page; the
 * code is the food (see `access.ts`). Composing both in one string is the mistake
 * that would be invisible in review, so `order-link.test.ts` asserts the two never
 * appear together.
 */

/**
 * The path portion of a diner's order link, token included.
 *
 * `publicCode` and the token are both percent-encoded. Neither can contain a
 * character that needs it today — the code is `[A-Z0-9]` and the token is
 * base64url — but encoding is the difference between "cannot happen" and "cannot
 * break the URL if it does", and a `+` or `/` slipping into a future token format
 * would silently truncate the value a `URLSearchParams` read back.
 */
export function orderPath(args: {
  publicCode: string;
  participantId: string;
  dropId: string;
}): string {
  const token = signParticipantAccess({
    participantId: args.participantId,
    dropId: args.dropId,
  });
  return `/d/${encodeURIComponent(args.publicCode)}/mine?t=${encodeURIComponent(token)}`;
}

/**
 * The absolute URL a notification links to.
 *
 * Takes the participant **id**, not the row, because the token is derived from ids
 * alone — which is what makes the same link reproducible from the job that sends it
 * and from any later re-send, without storing a token anywhere.
 *
 * `baseUrl` is passed in rather than read from env: this is used by a job that may
 * run behind a proxy, and the origin that ends up in a diner's SMS has to be the
 * public one, which only the caller knows. A hardcoded origin is the classic way a
 * link lands on `localhost` in production. The validation of that origin is
 * `notify/public-origin.ts`, and a diner's message carries no link at all rather
 * than a broken one.
 */
export function orderUrl(args: {
  baseUrl: string;
  publicCode: string;
  participantId: string;
  dropId: string;
}): string {
  // Trailing slashes trimmed because `APP_URL` is operator-supplied and
  // `https://x.example/` is what half of them will write. A double slash here would
  // produce `/d//d/…` — a 404 from a link that looks correct.
  const base = args.baseUrl.replace(/\/+$/, '');
  return `${base}${orderPath(args)}`;
}
