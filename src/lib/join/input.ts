import { z } from 'zod';

import { MAX_JOIN_QTY } from './rules';

/**
 * The join request body — the wire format, kept apart from the domain.
 *
 * Same split as `redemption/input.ts`: `rules.ts` decides whether a join may
 * happen and is importable by the browser; this file is what arrives over HTTP.
 * Keeping them apart means a change to the payload shape cannot quietly change a
 * refusal rule.
 *
 * ## What is validated here and what is not
 *
 * Only *shape*: is `qty` an integer in range, is `phone` a non-empty string of
 * plausible length. Every **decision** — whether the drop is open, whether the last
 * plate is gone, whether this number is a reachable one — belongs to `rules.ts` and
 * the service, because those answers need the database and must be unit-testable
 * without one.
 *
 * A `z.string().regex(/^\+1\d{10}$/)` here would be tempting and wrong: a diner
 * types `780-555-0123`, and rejecting that at the schema layer with a 422 and a
 * field error is a worse experience than normalising it. `normalisePhone()` accepts
 * nine formats and refuses junk with one sentence.
 *
 * ## The phone length cap
 *
 * E.164 allows 15 digits; with punctuation and a country prefix a legitimate input
 * can be twice that. 40 characters is generous for a real number and short enough
 * that a paste of a whole page does not reach the normaliser.
 */

const joinSchema = z.object({
  phone: z
    .string()
    .min(1, 'Enter a mobile number we can text.')
    .max(40, 'That is too long for a phone number.'),
  qty: z
    .number()
    .int('Choose a whole number.')
    // The upper bound here is the hard ceiling, not the drop's cap: the drop's own
    // limit needs a database read, and answering "5 is too many for this drop" with
    // its own sentence is better than a schema error that cannot know the drop.
    .max(MAX_JOIN_QTY, `That is more than ${MAX_JOIN_QTY} — check the quantity.`)
    .min(1, 'You have to order at least one.'),
  name: z.string().trim().max(80, 'That name is too long.').optional(),
  /**
   * The consent checkbox.
   *
   * `z.boolean().optional()` rather than a default of `false`, so that "omitted"
   * and "explicitly unticked" stay distinguishable at the wire level even though
   * the service treats both as no consent. A default here would make the two
   * impossible to tell apart in a request log during a CASL review.
   *
   * Absence is not an error: an unticked box is the default state of a checkbox, and
   * refusing the request for it would be refusing the common case.
   */
  consented: z.boolean().optional(),
  /**
   * The `pm_…` id from Stripe.js.
   *
   * ## Why this is `optional` here and required by the port
   *
   * The schema validates *shape*, and there is a legitimate request without a card:
   * a deployment with no `STRIPE_SECRET_KEY` answers 503 before any of this matters,
   * and a fake-backed test has no card to send. What must not happen is the id being
   * **silently dropped** between the wire and the port — which is exactly what
   * happened before slice 2b, and the reason every real join would have thrown
   * "arrived with no paymentMethodId" with the keys configured.
   *
   * So the shape check is loose and the *stripe-like prefix* check is also loose: the
   * real port is the authority on whether it got a usable card, because it is the
   * only layer that knows whether a card is needed at all. A strict `z.string()
   * .startsWith('pm_')` here would be a second, weaker copy of that rule and would
   * make the fake-backed tests carry a fake prefix.
   */
  paymentMethodId: z
    .string()
    .trim()
    .max(255, 'That payment reference is implausibly long.')
    .optional(),
  /**
   * FR-802's attribution token — which organiser's link brought this diner.
   *
   * Optional, and it stays optional at every layer. Attribution is a *record of how
   * somebody arrived*, and a record that can refuse a join is a record that costs the
   * merchant a sale. A malformed or unknown token is therefore ignored by the service,
   * not rejected here: the diner did nothing wrong and cannot fix it.
   *
   * No shape check either — `isShareToken` in `lib/organisers/share-link.ts` is the
   * one place that knows what a token looks like, and a second regex here would be a
   * second copy to keep in step. The length cap only stops a paste of a whole page
   * from reaching the database.
   */
  organiserToken: z.string().trim().max(64).optional(),
});

export type JoinInput = {
  readonly phone: string;
  readonly qty: number;
  readonly name?: string;
  readonly consented?: boolean;
  readonly paymentMethodId?: string;
  /** FR-802. Present only when the diner arrived through an organiser's link. */
  readonly organiserToken?: string;
};

export type ParsedJoin =
  | { ok: true; value: JoinInput }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseJoinInput(raw: unknown): ParsedJoin {
  const parsed = joinSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      // First message wins, matching `errorResponse`'s behaviour: a field with two
      // problems should show the one that comes first, not the last one written.
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const { phone, qty, name, consented, paymentMethodId, organiserToken } = parsed.data;

  return {
    ok: true,
    value: {
      phone,
      qty,
      // Omitted rather than `undefined`-valued so the service's `request.name ?`
      // checks stay honest.
      ...(name && name.length > 0 ? { name } : {}),
      ...(consented === undefined ? {} : { consented }),
      ...(paymentMethodId && paymentMethodId.length > 0 ? { paymentMethodId } : {}),
      ...(organiserToken && organiserToken.length > 0 ? { organiserToken } : {}),
    },
  };
}
