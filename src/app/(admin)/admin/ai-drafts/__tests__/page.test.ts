import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/admin/ai-drafts` and `/admin/ai-drafts/[id]` rendered — gap 12(c), FR-905.
 *
 * > `FR-905 | View raw AI drafts and guardrail results | For debugging merchant
 * > complaints` — PRD-v1.md:552
 *
 * ## Why this is one suite for two pages
 *
 * Gap 12(c)'s checklist item is a claim about both at once: *"confirm the newest row is
 * the most recent run, that the 'from $X' figure matches the cheapest proposal on the
 * detail page"*. That sentence is a **link between two renders**, and no test of either
 * page alone can make it. So both are rendered here, from the same rows, and the
 * cross-page assertion is the one this file exists for.
 *
 * ## What the loader's own suite already proves, and what this adds
 *
 * `lib/db/__tests__/admin-ai-drafts.test.ts` covers the query: ordering, the merchant
 * filter, the floor read from the proposals rather than from `inputJson`, the orphaned
 * merchant, malformed JSON, and that nothing writes. None of that is repeated here.
 *
 * What a loader test cannot see is the screen. Every decision on these two pages is made
 * in JSX from data the loader test has already approved, and each has a plausible wrong
 * version that returns identical data:
 *
 *   1. **"from $X" is the lowest *allowed* price.** The list could print
 *      `menuPriceCents`, or the floor, or the dearer proposal, and satisfy every loader
 *      assertion. The fixture makes all four figures distinct so only one can pass.
 *   2. **`guardrailPassed` is described, not celebrated.** The column is a constant
 *      `true`; a green badge beside it would present a tautology as a result. The loader
 *      test asserts the value is stored honestly — a different claim from the page
 *      declining to dress it up.
 *   3. **The orphan sentence, the filter banner and both empty states are reachable.**
 *      A loader returns `null` for a missing merchant; only a render proves the page says
 *      "Merchant no longer on file" rather than rendering an empty heading.
 *
 * ## The kind of bug these assert against
 *
 * Not a wrong number — a right number in the wrong place. The `/admin/commission` slice
 * found that `toContain` cannot tell you which row it found, and this file inherits the
 * lesson: the per-row figures are asserted **per row**, located by the draft's own detail
 * link, so a page that gathered every figure into one footer would fail here.
 *
 * ## Fixtures are shaped by `persistAuditRow`, not by the schema
 *
 * `inputJson` and `outputJson` are `Json` columns, so Postgres accepts anything. These
 * fixtures use the shape `persistAuditRow` actually writes — `answers`, `fees`, the four
 * costs and `floorPctOfMenu` in; `source`, `proposals`, `copyRejected` out — because a
 * fixture the column permits but the writer never produces describes a system that does
 * not exist. That mistake cost gap 12(b) six assertions.
 *
 * ## What is mocked
 *
 * `server-only`, and nothing else. Neither page reads a session or mounts a client
 * component, so `renderToHtml` is enough — no router context is needed, unlike
 * `/admin/drops` and `/admin/drops/[id]`.
 */

vi.mock('server-only', () => ({}));

const { prisma } = await import('@/lib/db/prisma');
const { settlementFixtures } = await import('@/lib/settlement/__tests__/settlement-fixtures');
const { formatCents } = await import('@/lib/guardrail');

const PREFIX = `aig${Date.now().toString(36).slice(-5)}`;
const fx = settlementFixtures(PREFIX);

const HOUR = 60 * 60 * 1000;

/**
 * The four prices in play, all distinct.
 *
 * A complaint is almost always about a price, and these pages print several. If any two
 * were equal, "the row says $10.50" would pass against the wrong one: 1600 is the menu
 * price, 1200 and 1050 are the two proposals, 1150 is the floor.
 */
const MENU_PRICE = 1600;
const LUNCH_PRICE = 1200;
const BULK_PRICE = 1050;
const FLOOR = 1150;

/** The draft every list assertion is built around. */
let richDraftId = '';
/** A run the copy linter refused two fields of. */
let rejectedDraftId = '';
/** A run that stored no proposals at all — the empty state, and no floor. */
let emptyDraftId = '';
/** A row whose merchant no longer exists. */
let orphanDraftId = '';
/** A row for a second merchant, so the filter has something to exclude. */
let foreignDraftId = '';

let merchantId = '';
let merchantName = '';
let otherMerchantName = '';

const draftIds: string[] = [];

/** The shape `persistAuditRow` writes into `inputJson`. */
function inputJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answers: { quietStart: '2026-11-02T18:00:00.000Z', maxQty: 40, intent: 'fill_quiet_hours' },
    fees: { platformFeePct: 0.08, platformFeeFloorCents: 60, platformFeeCapCents: 200 },
    floorPctOfMenu: 0.25,
    menuPriceCents: MENU_PRICE,
    foodCostCents: 480,
    packagingCents: 80,
    ...overrides,
  };
}

/** The shape `persistAuditRow` writes into `outputJson`. */
function outputJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'planner',
    proposals: [
      {
        archetype: 'WEEKDAY_LUNCH',
        dealPriceCents: LUNCH_PRICE,
        menuPriceCents: MENU_PRICE,
        minViablePriceCents: FLOOR,
        discountPct: 0.25,
        isThinDiscount: false,
        minQty: 4,
        maxQty: 40,
        title: 'Lunch, cheaper',
        rationale: 'Fills a quiet Tuesday.',
      },
      {
        archetype: 'BULK',
        dealPriceCents: BULK_PRICE,
        menuPriceCents: MENU_PRICE,
        minViablePriceCents: FLOOR,
        discountPct: 0.34,
        // Set on exactly one of the two, so a page that badged every proposal or none
        // would fail the count assertion in the detail suite.
        isThinDiscount: true,
        minQty: 6,
        maxQty: 40,
        title: 'Feed the team',
        rationale: 'Bigger batch, better price.',
      },
    ],
    copyRejected: [],
    ...overrides,
  };
}

async function draft(args: {
  merchantId?: string;
  input?: unknown;
  output?: unknown;
  createdAt?: Date;
}): Promise<string> {
  const row = await prisma.aiDraft.create({
    data: {
      merchantId: args.merchantId ?? merchantId,
      surface: 'merchant_builder',
      promptVersion: 'deal-builder-v1',
      inputJson: (args.input ?? inputJson()) as never,
      outputJson: (args.output ?? outputJson()) as never,
      guardrailPassed: true,
      createdAt: args.createdAt ?? new Date(),
    },
    select: { id: true },
  });
  draftIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  merchantId = await fx.merchant(`acct_${PREFIX}a`);
  const otherMerchantId = await fx.merchant(`acct_${PREFIX}b`);

  const merchants = await prisma.merchant.findMany({
    where: { id: { in: [merchantId, otherMerchantId] } },
    select: { id: true, name: true },
  });
  merchantName = merchants.find((merchant) => merchant.id === merchantId)?.name ?? '';
  otherMerchantName = merchants.find((merchant) => merchant.id === otherMerchantId)?.name ?? '';
  // Read back rather than assumed from the fixture's naming convention: the assertion
  // below is about the page printing the row's merchant, and a hardcoded prefix would
  // make it a test of the fixture helper instead.
  expect(merchantName).not.toBe('');
  expect(otherMerchantName).not.toBe('');

  // Well-separated instants, and deliberately not in creation order, so "newest first"
  // has to fail on the `orderBy` rather than on ties or on insert order.
  emptyDraftId = await draft({
    createdAt: new Date(Date.now() - 4 * HOUR),
    output: outputJson({ proposals: [] }),
  });
  orphanDraftId = await draft({
    merchantId: `gone-${PREFIX}`,
    createdAt: new Date(Date.now() - 3 * HOUR),
  });
  rejectedDraftId = await draft({
    createdAt: new Date(Date.now() - 2 * HOUR),
    output: outputJson({
      copyRejected: [
        { archetype: 'BULK', field: 'title', kind: 'SUPERLATIVE', detail: '“best” is a claim.' },
        { archetype: 'BULK', field: 'shareMessage', kind: 'PRICE_CLAIM', detail: 'No price in copy.' },
      ],
    }),
  });
  richDraftId = await draft({ createdAt: new Date(Date.now() - 1 * HOUR) });
  foreignDraftId = await draft({
    merchantId: otherMerchantId,
    createdAt: new Date(Date.now() - 30 * 60 * 1000),
  });
});

afterAll(async () => {
  if (draftIds.length > 0) {
    await prisma.aiDraft.deleteMany({ where: { id: { in: draftIds } } }).catch(() => undefined);
  }
  await fx.cleanup();
});

/** Render the list, optionally scoped to a merchant. */
async function renderList(merchantIdFilter?: string): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/ai-drafts/page');
  const html = await renderToHtml(
    await page.default({
      searchParams: Promise.resolve(
        merchantIdFilter === undefined ? {} : { merchantId: merchantIdFilter },
      ),
    }),
  );
  return { html, text: textOf(html) };
}

/** Render one draft's detail page. */
async function renderDetail(id: string): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/ai-drafts/[id]/page');
  const html = await renderToHtml(await page.default({ params: Promise.resolve({ id }) }));
  return { html, text: textOf(html) };
}

/**
 * The `<li>` of the list row that links to one draft, as text.
 *
 * Row-scoped for the reason the other page suites record: each row prints several
 * figures and a `toContain` over the whole page cannot say which row one came from. The
 * detail href is the row's only unique identifier in the markup.
 */
function rowFor(html: string, draftId: string): string {
  for (const match of html.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    if (match[0].includes(`/admin/ai-drafts/${draftId}`)) {
      return textOf(match[0]);
    }
  }
  throw new Error(`No <li> links to ${draftId}`);
}

/** Every dollar figure visible in a passage, in document order. */
function centsIn(text: string): string[] {
  return [...text.matchAll(/\$[\d,]+\.\d{2}/g)].map((match) => match[0]);
}

describe('/admin/ai-drafts — the list', () => {
  it('puts the newest run first, because the screen is opened on a phone call', async () => {
    const { html } = await renderList();
    // `matchAll` over an alternation-free group still types the capture as optional under
    // `noUncheckedIndexedAccess`, so the ids are collected with a filter rather than a map
    // into a `string[]`.
    const order = [...html.matchAll(/href="\/admin\/ai-drafts\/([0-9a-f-]{36})"/g)]
      .map((match) => match[1])
      .filter((id): id is string => id !== undefined);

    // Position, not mere presence. A reversed `orderBy` would still contain every id, and
    // a `toContain` on each would pass — which is exactly the assertion that proves
    // nothing about ordering.
    const position = (id: string) => order.indexOf(id);
    for (const id of [richDraftId, orphanDraftId, rejectedDraftId, emptyDraftId, foreignDraftId]) {
      expect(position(id)).toBeGreaterThanOrEqual(0);
    }

    // The expected order is derived from the stored `createdAt`, not retyped. The first
    // version of this test hardcoded a sequence that contradicted its own fixtures and
    // failed on the middle comparison — a fixture mistake, not a page defect, and one
    // that a derived expectation cannot repeat.
    const stored = await prisma.aiDraft.findMany({
      where: { id: { in: order } },
      select: { id: true, createdAt: true },
    });
    const expected = [...stored]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => row.id);

    expect(order).toEqual(expected);
  });

  it('names the merchant on each row, and says so plainly when the merchant is gone', async () => {
    const { html, text } = await renderList();

    // Two different sentences for two different facts. A row whose merchant vanished is
    // still the record of what the model was asked, so it lists; an empty heading would
    // read as a rendering fault instead.
    expect(rowFor(html, orphanDraftId)).toContain('Merchant no longer on file');
    expect(rowFor(html, richDraftId)).toContain(merchantName);

    // And a banner explains the state rather than leaving the operator to infer it from
    // one row. Reachable because `AiDraft.merchantId` has no foreign key.
    expect(text).toContain('belongs to a merchant that no longer exists');
  });

  it('leads each row with the lowest price the guardrail allowed', async () => {
    const { html } = await renderList();
    const row = rowFor(html, richDraftId);

    // 1050 — the cheaper of the two proposals. Not the menu price, not the floor, and
    // not the other proposal; all four are distinct in this fixture, so this can only
    // pass on the right one.
    expect(row).toContain(`from ${formatCents(BULK_PRICE)}`);
    expect(row).not.toContain(`from ${formatCents(LUNCH_PRICE)}`);
    expect(row).not.toContain(`from ${formatCents(MENU_PRICE)}`);
    expect(row).not.toContain(`from ${formatCents(FLOOR)}`);

    // A run with no proposals says so instead of printing "$0.00", which would read as a
    // price rather than as an absence of one.
    expect(rowFor(html, emptyDraftId)).toContain('no price');
    expect(rowFor(html, emptyDraftId)).not.toContain('$0.00');
  });

  it('counts proposals and the copy fields the linter refused, per row', async () => {
    const { html } = await renderList();

    const rich = rowFor(html, richDraftId);
    expect(rich).toContain('2 proposals');
    // No refusal line at all when nothing was refused, rather than "0 copy fields".
    expect(rich).not.toContain('refused');

    const rejected = rowFor(html, rejectedDraftId);
    expect(rejected).toContain('2 copy fields refused');
    // Singular and plural are different strings, and one rejection is the common case.
    expect(rejected).not.toContain('2 copy field refused');
  });

  it('scopes to one merchant from the link, and offers the way back', async () => {
    const scoped = await renderList(merchantId);
    const hrefs = [...scoped.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

    expect(scoped.text).toContain(`Showing ${merchantName} only.`);
    expect(rowFor(scoped.html, richDraftId)).toContain(merchantName);
    expect(hrefs).not.toContain(`/admin/ai-drafts/${foreignDraftId}`);

    // "Show every merchant" is an absolute path, and it is what makes the filter
    // reversible. A relative href would resolve against the current path and leave the
    // operator on a page showing the same merchant.
    expect(hrefs).toContain('/admin/ai-drafts');

    // Unscoped, the foreign row appears — so the exclusion above is the `where` clause
    // and not an accident of fixture ordering.
    const every = await renderList();
    expect(rowFor(every.html, foreignDraftId)).toContain(otherMerchantName);
  });

  it('says which merchant it is showing, and degrades when there are none', async () => {
    // `merchantName` comes from the first row, so an empty result has no name to show.
    // The banner still has to render — otherwise a filter on a merchant with no runs
    // would look like an unscoped list.
    const nothing = await renderList(`none-${PREFIX}`);
    expect(nothing.text).toContain('Showing one merchant only.');
    expect(nothing.text).toContain('This merchant has no AI runs yet.');
  });

  it('describes what “guardrail passed” is instead of ticking it', async () => {
    const { html, text } = await renderList();

    // No row renders the column at all. A tick beside a constant is the one thing the
    // module docblock says this screen must not do, so its absence per row is the claim
    // — a badge added later would fail here.
    expect(rowFor(html, richDraftId)).not.toMatch(/guardrail/i);

    // The footnote is what remains, and it says what the column is.
    expect(text).toContain('That column is a constant');
    expect(text).toContain('not a check that ran and reported');
  });
});

describe('/admin/ai-drafts/[id] — one run in full', () => {
  it('leads with the guardrail’s inputs, as numbers rather than JSON', async () => {
    const { text } = await renderDetail(richDraftId);

    // The order a complaint is answered in: the floor percentage and the costs that
    // produced the floor, before any prose or any proposal.
    expect(text).toContain('The guardrail’s inputs');
    expect(text).toContain('Minimum margin');
    expect(text).toContain('25%');
    expect(text).toContain(formatCents(MENU_PRICE));
    expect(text).toContain(formatCents(480));
    expect(text).toContain(formatCents(80));
    expect(text).toContain('Floor this produced');
    expect(text).toContain(formatCents(FLOOR));

    // Evidence before conclusions: the inputs card precedes the proposals.
    expect(text.indexOf('Floor this produced')).toBeLessThan(text.indexOf('Proposals'));
  });

  it('renders a dash, not a zero, when the run recorded no floor', async () => {
    const { text } = await renderDetail(emptyDraftId);

    // A run with no proposals has no floor, and `$0.00` would be a claim about price.
    // The sentence says why rather than leaving an unexplained dash behind.
    expect(text).toContain('—');
    expect(text).toContain('No floor is recorded here because the run stored no proposals');
    expect(text).toContain('No proposals were stored');
    expect(text).not.toContain('$0.00');
  });

  it('lists each proposal with its own price, discount and quantity bounds', async () => {
    const { text } = await renderDetail(richDraftId);

    expect(text).toContain('Lunch, cheaper');
    expect(text).toContain('Feed the team');
    expect(text).toContain(formatCents(LUNCH_PRICE));
    expect(text).toContain(formatCents(BULK_PRICE));
    // `isThinDiscount` is set on exactly one of the two fixtures.
    expect([...text.matchAll(/\bThin\b/g)]).toHaveLength(1);
    // Both proposals carry min/max, so the sentence must render for each.
    expect(text).toContain('Needs 4, up to 40.');
    expect(text).toContain('Needs 6, up to 40.');
  });

  it('shows the rejected copy only when there is some, with the reason for each', async () => {
    const rejected = await renderDetail(rejectedDraftId);
    expect(rejected.text).toContain('Copy the linter refused (2)');
    expect(rejected.text).toContain('SUPERLATIVE');
    expect(rejected.text).toContain('“best” is a claim.');
    expect(rejected.text).toContain('PRICE_CLAIM');
    // The field each rejection belongs to, which is what makes it actionable.
    expect(rejected.text).toContain('shareMessage');

    // Absent entirely on a run with none: a heading over an empty list reads as a
    // rendering fault rather than as "nothing was refused".
    const clean = await renderDetail(richDraftId);
    expect(clean.text).not.toContain('Copy the linter refused');
  });

  it('states the stored guardrail value and what it does not mean', async () => {
    const { text } = await renderDetail(richDraftId);

    // The value is reported as stored (`true`) and immediately qualified. This is the
    // page's most important refusal: the column is a schema fact, not a result.
    expect(text).toContain('Stored as');
    expect(text).toContain('true');
    expect(text).toContain('That value is a constant for every row, not a result');
    expect(text).toContain('Treat the inputs above as the evidence');
  });

  it('keeps both raw payloads verbatim, pretty-printed and readable', async () => {
    const { html } = await renderDetail(richDraftId);

    // The JSON is the fallback for a field the page does not lift, so it has to be the
    // stored value rather than a re-serialisation of what the page chose to read.
    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: richDraftId },
      select: { inputJson: true, outputJson: true },
    });

    // The contents of the two `<pre>` blocks, decoded.
    //
    // Read out of the HTML and parsed back, rather than compared as strings. Two reasons,
    // both learned from the first run of this test:
    //   - React escapes `"` as `&quot;`, so a substring match against the serialised JSON
    //     fails even though the page is correct.
    //   - Prisma does not preserve key order through a `Json` column, so the pretty-
    //     printed text is not byte-identical to `JSON.stringify(stored.inputJson, null,
    //     2)` either. Comparing parsed objects asserts *no field was dropped*, which is
    //     the claim; comparing strings would assert an ordering the database never
    //     promised.
    const pres = [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g)].map((match) =>
      (match[1] ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&'),
    );

    // Three blocks on this page: the merchant's answers, then raw input, then raw output.
    expect(pres).toHaveLength(3);
    expect(JSON.parse(pres[1] ?? 'null')).toEqual(stored.inputJson);
    expect(JSON.parse(pres[2] ?? 'null')).toEqual(stored.outputJson);

    // And pretty-printed. A single 4 KB line would be present and unreadable, which is the
    // whole reason the page shows it at all rather than hiding it behind a copy button.
    expect(pres[2]).toContain('\n');

    // Both summaries render, so the blocks are reachable rather than merely present.
    expect(textOf(html)).toContain('Raw input (verbatim)');
    expect(textOf(html)).toContain('Raw output (verbatim)');
  });

  it('names the merchant, the surface and the prompt version in the heading', async () => {
    const { text } = await renderDetail(richDraftId);

    expect(text).toContain(merchantName);
    expect(text).toContain('merchant_builder');
    expect(text).toContain('deal-builder-v1');
  });

  it('renders an orphaned draft’s detail page without the word “null” in the heading', async () => {
    // Found by probe O. The list has always rendered "Merchant no longer on file" for a
    // vanished merchant, and the loader suite covers that `merchantName` is null — but no
    // test had ever *rendered the detail page* for an orphan. Replacing
    // `draft.merchantName ?? 'Merchant no longer on file'` with a bare
    // `draft.merchantName` left every test green.
    //
    // That mutation is not hypothetical in effect: React renders `null` as nothing, so
    // the heading would collapse to an empty `<h1>` and the operator would see a page
    // with no merchant at all — on the one screen whose whole purpose is to answer
    // "which merchant complained". The row that reaches it is the normal case for an old
    // draft, because `AiDraft.merchantId` has no foreign key.
    const { text } = await renderDetail(orphanDraftId);

    expect(text).toContain('Merchant no longer on file');
    // The literal string `null` must not appear. This is the assertion the mutation above
    // fails, and it is a string comparison rather than a truthiness check on purpose:
    // React renders the *value* `null` as nothing, but a template literal that produced
    // the word would render it as text.
    expect(text).not.toContain('null');

    // The rest of the run is still readable — the merchant vanishing does not erase what
    // the model was asked, which is the reason this row is kept at all.
    expect(text).toContain('deal-builder-v1');
    expect(text).toContain(formatCents(BULK_PRICE));
  });

  it('404s a draft that does not exist rather than rendering an empty page', async () => {
    const page = await import('@/app/(admin)/admin/ai-drafts/[id]/page');

    // `notFound()` throws a digest-tagged error; the bare render surface is the throw, so
    // the assertion is on the digest rather than on a rendered not-found.
    await expect(
      page.default({ params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('404s a malformed id rather than 500ing on a database error', async () => {
    const page = await import('@/app/(admin)/admin/ai-drafts/[id]/page');

    // The mistake an operator makes by editing the URL. Prisma answers null rather than
    // throwing for a non-uuid string.
    await expect(
      page.default({ params: Promise.resolve({ id: 'not-a-uuid' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});

describe('/admin/ai-drafts — the list and the detail agree', () => {
  it('shows the same lowest price on the row and as the cheapest proposal', async () => {
    // This is gap 12(c)'s checklist sentence, and the reason both pages share a file:
    // "confirm the 'from $X' figure matches the cheapest proposal on the detail page".
    // Neither page alone can make this claim, so both are rendered from the same row.
    const list = await renderList(merchantId);
    const detail = await renderDetail(richDraftId);

    const rowFigure = rowFor(list.html, richDraftId).match(/from (\$[\d,]+\.\d{2})/)?.[1];
    expect(rowFigure).toBe(formatCents(BULK_PRICE));

    // The detail page renders both proposal prices, so the row's figure is one of
    // several there — which is why the comparison is against the stored minimum rather
    // than against "appears somewhere on the page".
    expect(centsIn(detail.text)).toContain(rowFigure);
    expect(centsIn(detail.text)).toContain(formatCents(LUNCH_PRICE));

    // And the row's figure is the minimum of the stored proposals, computed here rather
    // than read off either page — so this is not the page agreeing with itself.
    const stored = await prisma.aiDraft.findUniqueOrThrow({
      where: { id: richDraftId },
      select: { outputJson: true },
    });
    const proposals = (stored.outputJson as { proposals: { dealPriceCents: number }[] }).proposals;
    expect(rowFigure).toBe(formatCents(Math.min(...proposals.map((p) => p.dealPriceCents))));
  });

  it('counts the same proposals on both, so a row cannot summarise a run the detail denies', async () => {
    const list = await renderList(merchantId);
    const detail = await renderDetail(richDraftId);

    expect(rowFor(list.html, richDraftId)).toContain('2 proposals');
    expect(detail.text).toContain('2 proposals');

    // A run with nothing in it says "0 proposals" on the row and explains itself on the
    // detail page. Neither page prints a count it cannot substantiate.
    const emptyRow = rowFor(list.html, emptyDraftId);
    const emptyDetail = await renderDetail(emptyDraftId);
    expect(emptyRow).toContain('0 proposals');
    expect(emptyDetail.text).toContain('No proposals were stored');
  });
});

describe('/admin/ai-drafts — nothing writes', () => {
  it('leaves every draft row exactly as it found it, on both pages', async () => {
    // A row whose first read is this test's own, for the reason the loader suite records:
    // a snapshot taken after an earlier test's read would miss a write that had already
    // happened.
    const untouched = await draft({
      createdAt: new Date(Date.now() - 5 * HOUR),
      output: outputJson({ source: 'model' }),
    });
    const before = await prisma.aiDraft.findUniqueOrThrow({ where: { id: untouched } });

    await renderList();
    await renderList(merchantId);
    await renderDetail(untouched);

    const after = await prisma.aiDraft.findUniqueOrThrow({ where: { id: untouched } });
    // The whole record, not one column. The row is the exhibit in a merchant dispute, so
    // a page that touched it would be editing its own evidence.
    expect(after).toEqual(before);
  });
});
