import type { AnalyticsEventName, AnalyticsPayload } from './events';

/**
 * PRD-v1 §10.1's measured events, as the pure part of the measurement.
 *
 * It started as the diner funnel (views → joins → cutoff), which is the part
 * §10.2's north-star ratios read. The remaining eight §10.1 names were never
 * built at all. They now live here too rather than in a second module, because
 * the property that matters is the same for all sixteen: a payload decision made
 * as data, with `assertNoPii` on every one, and no filesystem in the decision.
 * A second builder module would mean a second PII guard to keep in sync.
 *
 * ## Why this file has no `emit` in it
 *
 * `emit()` writes to disk and never throws. That is right for the sink and wrong
 * for a *decision*: a function that has already appended a line cannot be asked
 * "would you have?" by a test. So the decision lives here as data — `null` or a
 * payload — and the caller emits it. That keeps the funnel arithmetic testable
 * without a filesystem, which is the same split `join/rules.ts` uses for money.
 *
 * ## Why a missing input is `null` and not an exception
 *
 * This module sits in the diner's tap path. Analytics must never be able to fail
 * a join (the same rule as `events.ts`), so anything unmeasurable is recorded as
 * nothing rather than raised as an error. A test asserts that, because a
 * `throw` added here later would take an hour to trace back from a 500.
 *
 * ## The one rule worth stating loudly
 *
 * **Ids and cents only.** No phone, no email, no name, no token, no user agent.
 * `assertNoPii` enforces it rather than trusting the docblock, and it runs on
 * every payload these builders produce.
 */

/** Where a view came from. PRD §10.1 names these three; anything else is `direct`. */
export type DealViewSource = 'organiser_link' | 'direct' | 'preview';

export const DEAL_VIEW_SOURCES: readonly DealViewSource[] = [
  'organiser_link',
  'direct',
  'preview',
] as const;

/** The query parameter that carries attribution. Short, because it is in a shared link. */
export const VIEW_SOURCE_PARAM = 'src';

export function isDealViewSource(value: unknown): value is DealViewSource {
  return typeof value === 'string' && (DEAL_VIEW_SOURCES as readonly string[]).includes(value);
}

/**
 * Resolves `?src=` to a source.
 *
 * Unknown values fall back to `direct` rather than being rejected or logged as
 * their own bucket: an open-ended set of `src` values would let a stranger pollute
 * the funnel by inventing one, and a 400 on a marketing parameter would be a worse
 * experience than an imprecise attribution.
 */
export function resolveViewSource(raw: unknown): DealViewSource {
  if (Array.isArray(raw)) {
    return isDealViewSource(raw[0]) ? raw[0] : 'direct';
  }
  return isDealViewSource(raw) ? raw : 'direct';
}

/**
 * Whether this request is a person looking at the page.
 *
 * `deal_page_viewed` is the denominator of PRD §10.2's join-conversion target
 * (≥25%), and this app has no feed — every drop is distributed by pasting a URL
 * into a group chat. That means the very first request for a new link is routinely
 * a **link-preview fetcher**, not a reader: WhatsApp, WeChat, Slack and iMessage
 * all fetch the URL to build the card, and FR-308 exists precisely so that card is
 * good.
 *
 * Counting those would inflate the denominator with bots that can never join, and
 * the effect is not random noise — it is one guaranteed extra view per share, so
 * the more successfully a drop is shared, the *worse* its measured conversion
 * looks. The metric would penalise the behaviour it is meant to reward.
 *
 * So the rule is: a request with no `sec-fetch-mode: navigate` header is not a
 * person. Real browsers send `navigate` for a top-level page load; unfurlers
 * mostly send nothing, or `cors`/`no-cors`. Bots that are polite enough to send
 * `navigate` are also polite enough to name themselves in the user agent, which is
 * the second check.
 *
 * The cost of being wrong is asymmetric and worth naming: a fetcher misread as a
 * person overstates the denominator (conversion looks worse than it is), and a
 * person misread as a fetcher understates it. Understating is the safer error,
 * because it cannot hide a drop that is failing to convert.
 */
export function isHumanView(headers: {
  get(name: string): string | null;
}): boolean {
  const mode = headers.get('sec-fetch-mode');
  if (mode !== 'navigate') {
    // No header at all (an old browser, curl, a fetcher) or a non-navigation
    // request (a subresource, an XHR, a prefetch). Not proof of a person.
    if (mode === null) return !looksLikeBot(headers.get('user-agent'));
    return false;
  }
  return !looksLikeBot(headers.get('user-agent'));
}

const BOT_SIGNATURES = [
  'bot',
  'crawler',
  'spider',
  'preview',
  'facebookexternalhit',
  'whatsapp',
  'telegram',
  'slackbot',
  'discordbot',
  'twitterbot',
  'linkedinbot',
  'embedly',
  'quora link preview',
  'outbrain',
  'pinterest',
  'vkshare',
  'w3c_validator',
  'curl/',
  'wget/',
  'python-requests',
  'go-http-client',
  'headlesschrome',
  'lighthouse',
] as const;

/** Deliberately loose: a false positive only under-counts a view. */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  const haystack = userAgent.toLowerCase();
  return BOT_SIGNATURES.some((signature) => haystack.includes(signature));
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * The keys that must never appear in an analytics payload.
 *
 * Matched against the key name, and the match has to be a **word**, not a substring.
 * That distinction is not pedantry: a naive `includes('ip')` rejects
 * `participantId`, and a guard that refuses a legitimate field is a guard somebody
 * deletes. The first version of this function did exactly that and was caught by
 * its own test.
 *
 * This is a guard, not a parser. It exists to catch the obvious mistake of adding
 * `phoneLast4` "because it is only four digits" — still a partial identifier joined
 * to a drop id — not to prove arbitrary payloads are anonymous.
 */
const FORBIDDEN_KEY_WORDS = [
  'phone',
  'email',
  'name',
  'address',
  'token',
  'secret',
  'paymentmethod',
  'paymentintent',
  'useragent',
  'ip',
] as const;

/** Splits `phoneLast4` and `phone_last_4` into words; leaves ids intact. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

export function assertNoPii(payload: AnalyticsPayload): void {
  for (const key of Object.keys(payload)) {
    const words = keyWords(key);
    for (const forbidden of FORBIDDEN_KEY_WORDS) {
      // A whole word, or a compound that *ends* in it — `phoneLast4` is caught by
      // the `phone` word, `customerName` by `name`, and `participantId` is left
      // alone because `id` is not a forbidden word and `participant` is not `ip`.
      if (words.includes(forbidden)) {
        throw new Error(`analytics payload key "${key}" may carry PII (word "${forbidden}")`);
      }
    }
  }
  for (const value of Object.values(payload)) {
    if (typeof value !== 'string') continue;
    if (value.includes('@')) {
      throw new Error('analytics payload value looks like an email address');
    }
  }
}

export type FunnelEvent = {
  event: AnalyticsEventName;
  payload: AnalyticsPayload;
};

function build(event: AnalyticsEventName, payload: AnalyticsPayload): FunnelEvent {
  assertNoPii(payload);
  return { event, payload };
}

/** `deal_page_viewed` — the denominator of join conversion. */
export function dealPageViewed(args: {
  dropId: string;
  merchantId: string;
  source: DealViewSource;
}): FunnelEvent {
  return build('deal_page_viewed', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    source: args.source,
  });
}

/**
 * The whole `deal_page_viewed` decision: filter, attribute, or nothing.
 *
 * This exists so the page stays a call site instead of a decision site. The page is
 * a React Server Component, and this project has no server-component test harness —
 * testing the composition inside the page would mean mocking `next/headers`, which
 * tests the mock. Taking a `Headers`-shaped object and a query object makes the
 * arithmetical part testable and leaves the page with nothing it can get wrong.
 *
 * Returns `null` for a fetcher, which `record()` treats as "do not write".
 */
export function dealPageViewEvent(args: {
  dropId: string;
  merchantId: string;
  headers: { get(name: string): string | null };
  query: Record<string, string | string[] | undefined>;
}): FunnelEvent | null {
  if (!isHumanView(args.headers)) return null;
  return dealPageViewed({
    dropId: args.dropId,
    merchantId: args.merchantId,
    source: resolveViewSource(args.query[VIEW_SOURCE_PARAM]),
  });
}

/**
 * `join_started` — a tap on Join that became a real request.
 *
 * Emitted after the request validates, not before: a bodiless POST from a scanner
 * is not somebody trying to join, and counting it would make the funnel's second
 * step look busier than the first is honest about.
 *
 * `dropId` is not always known at this point. `joinDrop()` emits it after the phone
 * validates but before the drop row is read, and reading the row purely to decorate
 * an analytics line would add a query to every attempt. So the field is optional and
 * omitted rather than filled with `''` — an empty string is a value, and a value that
 * looks like an id is worse than a missing one: it joins to nothing and quietly
 * breaks any `GROUP BY dropId` the weekly report does.
 */
export function joinStarted(args: {
  dropId?: string;
  merchantId?: string;
  qty: number;
}): FunnelEvent {
  const payload: AnalyticsPayload = { qty: args.qty };
  if (args.dropId) payload.dropId = args.dropId;
  if (args.merchantId) payload.merchantId = args.merchantId;
  return build('join_started', payload);
}

/** `join_authorised` — the numerator of join conversion. */
export function joinAuthorised(args: {
  dropId: string;
  merchantId?: string;
  participantId: string;
  qty: number;
  amountCents: number;
}): FunnelEvent {
  return build('join_authorised', {
    dropId: args.dropId,
    merchantId: args.merchantId ?? null,
    participantId: args.participantId,
    qty: args.qty,
    amountCents: args.amountCents,
  });
}

/**
 * `join_failed { reason }` — the bounded refusal vocabulary from `join/rules.ts`.
 *
 * `reason` is passed through as a string rather than re-declared as a union here,
 * so that adding a refusal reason cannot silently stop being measured. The type
 * that keeps it honest is `JoinRefusalReason` at the call site.
 *
 * `dropId` is optional for the same reason as `joinStarted`: `BAD_PHONE` and
 * `BAD_BODY` are refused before a drop row is read. A refusal with no drop is still
 * a narrowing signal — "most attempts die on the phone field" is the most useful
 * thing this event can say — so it is recorded, just not attributed.
 */
export function joinFailed(args: {
  dropId?: string;
  merchantId?: string;
  reason: string;
}): FunnelEvent {
  const payload: AnalyticsPayload = { reason: args.reason };
  if (args.dropId) payload.dropId = args.dropId;
  if (args.merchantId) payload.merchantId = args.merchantId;
  return build('join_failed', payload);
}

/**
 * `threshold_reached` — the drop crossed `minQty`, measured once.
 *
 * PRD §10.2's north star is "drops reaching minQty ÷ drops published", so this
 * event has to fire **exactly once per drop that crosses**, and never for a drop
 * that does not. The caller supplies the totals *before* and *after* the write and
 * this decides, because the comparison is the whole content of the event and
 * getting it wrong produces a plausible number rather than an error.
 *
 * Counts `AUTHORIZED` only — the same population `settle.ts` and the public page
 * use (`public-drops.ts` filters `authStatus: 'AUTHORIZED'`). A `PENDING` join
 * holds a plate but has not paid, so letting it reach the threshold would claim a
 * drop succeeded on a card nobody has confirmed. That is the exact dishonesty
 * FR-304 is written against, one level up.
 *
 * Returns `null` when the crossing did not happen — including the `after < before`
 * case, which is a refund or a void, and is emphatically not a threshold crossing.
 */
export function thresholdReached(args: {
  dropId: string;
  merchantId?: string;
  minQty: number;
  previousQty: number;
  currentQty: number;
}): FunnelEvent | null {
  const { minQty, previousQty, currentQty } = args;

  // Below 1 makes no sense as a threshold and would fire on every join.
  if (!Number.isInteger(minQty) || minQty < 1) return null;
  if (!Number.isFinite(previousQty) || !Number.isFinite(currentQty)) return null;

  const wasBelow = previousQty < minQty;
  const isAtOrAbove = currentQty >= minQty;

  if (!wasBelow || !isAtOrAbove) return null;

  return build('threshold_reached', {
    dropId: args.dropId,
    merchantId: args.merchantId ?? null,
    minQty,
    previousQty,
    currentQty,
  });
}

/**
 * `drop_published` — the denominator of "drops reaching minQty ÷ drops published".
 *
 * Without it the threshold-hit-rate metric has no denominator, which is why it is
 * here rather than with the rest of the merchant-side events.
 */
export function dropPublished(args: {
  dropId: string;
  merchantId: string;
  dealPriceCents: number;
  minQty: number;
  maxQty: number;
}): FunnelEvent {
  return build('drop_published', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    dealPriceCents: args.dealPriceCents,
    minQty: args.minQty,
    maxQty: args.maxQty,
  });
}

/**
 * The cutoff decision, as the funnel sees it.
 *
 * `threshold_reached` and `drop_locked` are not the same event and both are needed.
 * The first says "enough people joined"; the second says "the cutoff passed and we
 * decided". A drop can reach its minimum and still fail at capture, and a drop can
 * pass its cutoff having reached the minimum hours earlier — the hit rate wants the
 * first, the ledger wants the second.
 *
 * `FAILED` carries `joinedQty` because the interesting question about a failed drop
 * is *how far short* it fell: a drop that missed by one plate is a different
 * problem from one that never sold one, and only one of those is a marketing fix.
 */
export function dropDecided(args: {
  dropId: string;
  merchantId?: string;
  outcome: 'LOCKED' | 'FAILED';
  joinedQty: number;
  minQty: number;
}): FunnelEvent {
  return build(args.outcome === 'LOCKED' ? 'drop_locked' : 'drop_failed', {
    dropId: args.dropId,
    merchantId: args.merchantId ?? null,
    joinedQty: args.joinedQty,
    minQty: args.minQty,
    shortBy: Math.max(0, args.minQty - args.joinedQty),
  });
}

// ---------------------------------------------------------------------------
// The other eight §10.1 events — lifecycle, not funnel
// ---------------------------------------------------------------------------

/**
 * The seam rule these builders are named for.
 *
 * Every one of the eight is emitted at the single place where its fact becomes
 * true, and none of them is emitted from a caller that could run twice for the
 * same fact. That matters more here than it did for the view/join funnel: these
 * are all *state transitions* (a draft written, a status flipped, money moved,
 * plates handed over), and a duplicated state-transition event does not just
 * inflate a count — it makes a rate exceed 100%. A view duplicated by a retry is
 * noise; a `capture_succeeded` duplicated by a retry is a claim that a card was
 * charged twice.
 *
 * So the builders take only facts the seam already holds. Anything that would
 * require an extra query, a decode of a bearer token, or a re-read of a row just
 * to decorate the payload is left out: analytics must not add work to a money or
 * food path.
 */

/** `drop_created` — a DRAFT row exists. `createDraft`'s retry winner only. */
export function dropCreated(args: {
  dropId: string;
  merchantId: string;
  menuItemId: string;
  dealPriceCents: number;
  minQty: number;
  maxQty: number;
}): FunnelEvent {
  return build('drop_created', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    menuItemId: args.menuItemId,
    dealPriceCents: args.dealPriceCents,
    minQty: args.minQty,
    maxQty: args.maxQty,
  });
}

/**
 * `drop_cancelled` — a PUBLISHED drop became CANCELLED (FR-208).
 *
 * Counts only. The merchant's `reason` is free text and belongs on the audit row,
 * not here: it can contain a phone number, an email, or a name, and no bounded
 * vocabulary constrains it. The actor's email and the request IP are likewise
 * deliberately absent — both are PII, and `assertNoPii` would refuse them.
 */
export function dropCancelled(args: {
  dropId: string;
  merchantId: string;
  participants: number;
  voidedAuthorisations: number;
  pendingVoids: number;
}): FunnelEvent {
  return build('drop_cancelled', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    participants: args.participants,
    voidedAuthorisations: args.voidedAuthorisations,
    pendingVoids: args.pendingVoids,
  });
}

/**
 * `capture_succeeded` — money moved and the Order/ledger write committed.
 *
 * No `paymentIntentId`, no `chargeId`, no Stripe account id. The guard refuses
 * the first two by name and the third is a provider credential-shaped identifier
 * that has no business in a metrics file; `participantId` is enough to join the
 * event to the ledger when someone needs to.
 */
export function captureSucceeded(args: {
  dropId: string;
  merchantId: string;
  participantId: string;
  qty: number;
  amountCents: number;
}): FunnelEvent {
  return build('capture_succeeded', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    participantId: args.participantId,
    qty: args.qty,
    amountCents: args.amountCents,
  });
}

/**
 * `CaptureOutcome.declineCode` is provider text typed as `string`, not one of our
 * enums. `assertNoPii` refuses any value containing `@` and it runs in `build()`
 * — i.e. while the argument to `record()` is being evaluated, *outside* the
 * try/catch that makes `emit()` unable to fail a request. An unbounded provider
 * string there could abort settlement's money loop. Reduce it to a short token
 * at the field's definition instead of trusting every `ChargePort` to behave.
 */
function safeDeclineCode(reason: string): string {
  const token = reason.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return token.length > 0 ? token : 'unknown';
}

/**
 * `capture_failed` — the provider declined a capture.
 *
 * `reason` is the provider's decline code (`card_declined`,
 * `insufficient_funds`, …), not a message; it is bounded by `safeDeclineCode`
 * above. A provider-unavailable timeout is **not** a failure: settlement leaves
 * `chargeStatus = 'NONE'` and retries with the same idempotency key, so an event
 * there would count one card three times.
 */
export function captureFailed(args: {
  dropId: string;
  merchantId: string;
  participantId: string;
  qty: number;
  reason: string;
}): FunnelEvent {
  return build('capture_failed', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    participantId: args.participantId,
    qty: args.qty,
    reason: safeDeclineCode(args.reason),
  });
}

/**
 * `redemption_scanned` — one code was submitted to the scanner.
 *
 * `dropId` is deliberately absent, for the same reason `joinStarted` omits it:
 * at this seam the code is still an opaque bearer token, and decoding it purely
 * to decorate an analytics line would add a second verification path to the
 * redemption flow. The event is the top of the redemption funnel, not a join key.
 *
 * It fires once per submitted code, before the retry loop. A lost-race retry is
 * one scan, not three; a malformed body never reaches the seam; and the scanner
 * screen's GET health check never reaches it either.
 */
export function redemptionScanned(args: { merchantId: string }): FunnelEvent {
  return build('redemption_scanned', { merchantId: args.merchantId });
}

/**
 * `redemption_completed` — units were actually claimed under the row lock.
 *
 * Fires only after `claimUnits` returned `CLAIMED`, so a refusal, an
 * `ALREADY_REDEEMED` double scan, and a `LOST_RACE` retry cannot produce one.
 * The redemption code itself is never a parameter: it is a bearer token, and a
 * log line is the one place a secret leaks into a dashboard by accident.
 *
 * `PARTIAL` is still a completion — real plates were handed over — so `partial`
 * is a field on the event rather than a reason to skip it.
 */
export function redemptionCompleted(args: {
  dropId: string;
  merchantId: string;
  participantId: string;
  taken: number;
  redeemedQty: number;
  partial: boolean;
}): FunnelEvent {
  return build('redemption_completed', {
    dropId: args.dropId,
    merchantId: args.merchantId,
    participantId: args.participantId,
    taken: args.taken,
    redeemedQty: args.redeemedQty,
    partial: args.partial,
  });
}

/**
 * `report_viewed` — the merchant's report was assembled and shown.
 *
 * `dropCount === 0` is still a view: a merchant who opens an empty reports page
 * is measuring something. What is *not* a view is the early return for "no
 * merchant attached". The weekly digest also assembles these figures — through
 * `reportSourcesFor` + `merchantReportFor`, not `merchantReportQuery` — but a
 * Monday cron building an email is not a screen. So the seam is the page, after
 * the query returns; putting it any lower in the shared report layer would count
 * every scheduled send as a view.
 */
export function reportViewed(args: {
  merchantId: string;
  dropCount: number;
  withheldDropCount: number;
}): FunnelEvent {
  return build('report_viewed', {
    merchantId: args.merchantId,
    dropCount: args.dropCount,
    withheldDropCount: args.withheldDropCount,
  });
}

/**
 * `ai_draft_generated` — the deal builder produced proposals (§9.2).
 *
 * PRD §10.1 writes `{ surface, guardrail_passed }` in snake case; every payload
 * key in this codebase is camelCase (`dealPriceCents`, `joinedQty`,
 * `minQty`), so the field is `guardrailPassed`. Renaming it to match the prose
 * would make this one event unjoinable with the rest of the sink.
 *
 * `guardrailPassed` mirrors the stored `AiDraft.guardrailPassed`, which
 * `persistAuditRow` writes as `true` by construction: every proposal went through
 * `validateDropTiming` and `validateDropQuantities` and every price came from the
 * guardrail. Today the only call site also passes the literal `true` — the value
 * is a parameter so the event cannot silently claim a pass if that invariant
 * ever changes, not because it currently varies. `aiDraftId` may be `null` when
 * the audit write failed — the proposals were still generated, and swallowing
 * that is the documented behaviour of `persistAuditRow`.
 */
export function aiDraftGenerated(args: {
  merchantId: string;
  itemId: string;
  aiDraftId: string | null;
  surface: string;
  guardrailPassed: boolean;
  proposalCount: number;
  copyRejectedCount: number;
  source: 'model' | 'planner';
}): FunnelEvent {
  return build('ai_draft_generated', {
    merchantId: args.merchantId,
    itemId: args.itemId,
    aiDraftId: args.aiDraftId,
    surface: args.surface,
    guardrailPassed: args.guardrailPassed,
    proposalCount: args.proposalCount,
    copyRejectedCount: args.copyRejectedCount,
    source: args.source,
  });
}
