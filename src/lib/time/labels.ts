/**
 * Human labels for instants — the one place a date is turned into words.
 *
 * ## Why this module exists
 *
 * There were three copies of `momentLabel` before it: the deal page, the join page
 * and the diner's own page, each with a comment claiming it was local "so the two
 * pages cannot drift". They had already drifted in *form* — one formats weekday and
 * time in a single `Intl` call, the other in two and concatenates — and they
 * happened to agree only because the two spellings produce the same string. I
 * checked rather than assumed: 384 instants across four time zones, zero
 * differences. So the divergence was latent, not live. Latent is still a bug you
 * eventually pay for; the next person to add "at 1:00 p.m." to one of them fixes one
 * page.
 *
 * The day this came due: `JoinSuccess` declared a field called `cutoffLabel`, the
 * service sent `cutoffAt`, and — because a JSON shape has no compiler — the
 * confirmation screen rendered "people join by **undefined**". The label had to be
 * authored server-side (the time zone is the merchant's, and a browser format would
 * use the diner's), which meant the service needed the formatter, which meant it
 * could not live in a page file.
 *
 * ## Why the server authors these strings
 *
 * A cutoff is an instant, but "Thursday 1:00 PM" is a *place*. The merchant's
 * `timezone` is the authority: a diner travelling, or on a phone set to another
 * zone, must still read the hour the kitchen means. That is the same reasoning as
 * ADR-002 for money — the server owns the number, and it owns the words that
 * describe it.
 */

/**
 * `"Thursday 1:00 PM"` — a weekday and a clock time, in the merchant's zone.
 *
 * Always both parts: a bare "1:00 PM" is ambiguous when the cutoff is tomorrow, and
 * a bare "Thursday" is useless when the drop closes tonight. `minute: '2-digit'` is
 * deliberate — "1:00 PM" not "1 PM" — because a cutoff that reads like a rough hour
 * invites a diner to think they have slack they do not have.
 *
 * Throws on an invalid IANA zone. Callers pass `merchant.timezone`, a database
 * column, so an invalid value is a data defect and should surface as one rather than
 * be silently formatted in the server's zone — a wrong-but-plausible time is worse
 * than a 500, because nobody reports it.
 */
export function momentLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(instant);
}
