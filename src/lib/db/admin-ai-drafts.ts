import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/prisma';

/**
 * FR-905 — the raw AI drafts, for answering a merchant's complaint.
 *
 * > `FR-905 | View raw AI drafts and guardrail results | For debugging merchant
 * > complaints` — PRD-v1.md:552
 *
 * ## Why this exists, in the merchant's words
 *
 * "It told me to sell at $9." That sentence is either (a) the guardrail computing a
 * floor from costs the merchant actually entered, (b) the merchant misremembering
 * which dish, or (c) a real defect. Without the inputs there is no way to tell, and
 * the merchant is told "we'll look into it" — which is what this screen replaces.
 * `AiDraft` has recorded the answer since M3; nothing ever read it back.
 *
 * ## `guardrailPassed` is a constant, and this module says so
 *
 * `persistAuditRow` writes `guardrailPassed: true` **by construction** — every proposal
 * it stores has already been through `validateDropTiming` and `validateDropQuantities`,
 * and every price came from the guardrail. So the column is not an observation of a
 * check that ran; it is a statement that the row could not exist otherwise.
 *
 * That distinction matters on this screen and almost nowhere else. An operator who
 * reads "guardrail passed: yes" and takes it as evidence would be reasoning from a
 * tautology. So the loader returns the raw column *and* a sentence explaining what it
 * is, and the page renders the sentence next to the value rather than a green badge.
 * The real guardrail evidence is in `inputJson` — the floor percentage, the menu price,
 * and the costs the floor was computed from — and that is what this module lifts out to
 * the top of the row instead of leaving it buried in JSON.
 *
 * ## Why the JSON is typed loosely
 *
 * `AiDraft.inputJson`/`outputJson` are `Json` columns holding whatever that prompt
 * version wrote. A strict parser here would break the screen for every historical row
 * the moment a prompt version changed — and the screen exists precisely to look at old
 * rows. So the shapes are read defensively into optional fields, and the page always
 * has the raw JSON to fall back on. Nothing in this module writes.
 *
 * ## The merchant's name: recorded, not joined
 *
 * `AiDraft.merchantId` is a `SetNull` foreign key, and the row also stores the merchant's
 * name as it stood when the run happened. So the name on this screen comes from the row
 * itself, and it is a **snapshot** — renaming a merchant does not rewrite what the audit
 * record says it was called. That is the same choice `AuditLog` makes with `actorEmail`,
 * and for the same reason: the row is evidence, and evidence does not update itself.
 *
 * Two cases the snapshot does not cover, and what happens instead:
 *
 *   1. **Rows written before the column existed.** Their `merchantName` is `null`, and
 *      taking that at face value would print "Merchant no longer on file" for a merchant
 *      that is very much on file — a false statement about a live account, on the screen
 *      built to answer complaints. So a row with no recorded name falls back to a live
 *      lookup, one `findMany` for the whole page rather than a join per row.
 *   2. **A row whose merchant was deleted before the column was populated.** Both are
 *      `null`, and there is nothing left to name. The pages say "Merchant no longer on
 *      file", which is then true.
 *
 * `merchantId` is `string | null` for the third case — a merchant deleted *after* the
 * row was written. `SetNull` is what makes the row survive, so a null id means "this
 * merchant is gone" rather than "this id is unknown", and the pages can state the first
 * without hedging about the second.
 *
 * > The previous version of this module argued the opposite — no `@relation`, name by
 * > second query, `merchantId` a bare string — on the grounds that choosing `onDelete`
 * > was a decision for a slice *about* retention. This is that slice. The reasoning is
 * > recorded in the migration that added the constraint and in `docs/PROGRESS.md`.
 */

/** The fields worth lifting out of `inputJson`. All optional: a version may not have them. */
export type DraftGuardrailInputs = {
  readonly floorPctOfMenu: number | null;
  readonly menuPriceCents: number | null;
  readonly foodCostCents: number | null;
  readonly packagingCents: number | null;
  /** The floor the guardrail computed, in cents. `null` on rows that predate it. */
  readonly minViablePriceCents: number | null;
};

export type DraftProposalSummary = {
  readonly archetype: string;
  readonly dealPriceCents: number | null;
  readonly menuPriceCents: number | null;
  readonly discountPct: number | null;
  readonly isThinDiscount: boolean;
  /** The floor this proposal was checked against. The run's floor is the minimum. */
  readonly minViablePriceCents: number | null;
  readonly minQty: number | null;
  readonly maxQty: number | null;
  readonly title: string;
  readonly rationale: string;
};

export type DraftRejection = {
  readonly archetype: string;
  readonly field: string;
  readonly kind: string;
  readonly detail: string;
};

export type AdminDraftRow = {
  readonly id: string;
  /**
   * `null` once the merchant is deleted.
   *
   * `SetNull` on the foreign key is what makes this row outlive its merchant, so a
   * `null` id is the *normal* state of an old row rather than a data fault.
   */
  readonly merchantId: string | null;
  /**
   * The merchant's name as recorded when the run happened, or — for rows written before
   * that column existed — its name today. `null` only when both are unavailable.
   *
   * A snapshot rather than a live lookup, so the row keeps saying what the merchant was
   * called at the time. See the module docblock.
   */
  readonly merchantName: string | null;
  readonly surface: string;
  readonly promptVersion: string;
  readonly createdAt: Date;
  /** The stored column. A constant `true` by construction — see the module docblock. */
  readonly guardrailPassed: boolean;
  /** `model` when any copy field came back from the model, else `planner`. */
  readonly source: string | null;
  readonly proposalCount: number;
  readonly rejectionCount: number;
  /** The cheapest price the guardrail allowed across this run's proposals, in cents. */
  readonly lowestDealPriceCents: number | null;
};

export type AdminDraftDetail = AdminDraftRow & {
  readonly inputs: DraftGuardrailInputs;
  readonly proposals: readonly DraftProposalSummary[];
  readonly rejections: readonly DraftRejection[];
  /** Verbatim, because a complaint may be about a field this module does not lift. */
  readonly inputJson: string;
  readonly outputJson: string;
  /** The merchant's own answers to the interview, when the row carries them. */
  readonly answers: Readonly<Record<string, unknown>> | null;
};

const DRAFT_SELECT = {
  id: true,
  merchantId: true,
  merchantName: true,
  surface: true,
  promptVersion: true,
  inputJson: true,
  outputJson: true,
  guardrailPassed: true,
  accepted: true,
  createdAt: true,
} satisfies Prisma.AiDraftSelect;

type DraftRecord = Prisma.AiDraftGetPayload<{ select: typeof DRAFT_SELECT }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The guardrail's cost inputs.
 *
 * `minViablePriceCents` is **not** in `inputJson` — `persistAuditRow` stores the four
 * costs and the floor percentage and nothing else. The floor is carried per proposal
 * (`PlannedProposal.minViablePriceCents`), so it is read from the proposals; a run that
 * produced none has no floor to report, and the page says so rather than guessing.
 *
 * Reading `root.minViablePriceCents` here would type-check, always return `null`, and
 * quietly make the screen's most important number a permanent dash.
 */
function readInputs(input: unknown, proposals: readonly DraftProposalSummary[]): DraftGuardrailInputs {
  const root = asRecord(input);
  return {
    floorPctOfMenu: num(root?.floorPctOfMenu),
    menuPriceCents: num(root?.menuPriceCents),
    foodCostCents: num(root?.foodCostCents),
    packagingCents: num(root?.packagingCents),
    minViablePriceCents: proposals.reduce<number | null>(
      (lowest, proposal) =>
        proposal.minViablePriceCents === null
          ? lowest
          : lowest === null || proposal.minViablePriceCents < lowest
            ? proposal.minViablePriceCents
            : lowest,
      null,
    ),
  };
}

function readAnswers(input: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(input)?.answers);
}

function readProposals(output: unknown): DraftProposalSummary[] {
  const list = asRecord(output)?.proposals;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((entry) => {
    const proposal = asRecord(entry);
    if (!proposal) {
      return [];
    }
    return [
      {
        archetype: str(proposal.archetype),
        dealPriceCents: num(proposal.dealPriceCents),
        menuPriceCents: num(proposal.menuPriceCents),
        discountPct: num(proposal.discountPct),
        isThinDiscount: proposal.isThinDiscount === true,
        minViablePriceCents: num(proposal.minViablePriceCents),
        minQty: num(proposal.minQty),
        maxQty: num(proposal.maxQty),
        title: str(proposal.title),
        rationale: str(proposal.rationale),
      },
    ];
  });
}

function readRejections(output: unknown): DraftRejection[] {
  const list = asRecord(output)?.copyRejected;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((entry) => {
    const rejection = asRecord(entry);
    if (!rejection) {
      return [];
    }
    return [
      {
        archetype: str(rejection.archetype),
        field: str(rejection.field),
        kind: str(rejection.kind),
        detail: str(rejection.detail),
      },
    ];
  });
}

/**
 * Live merchant names for the ids whose row carries no recorded name.
 *
 * This is a **fallback**, not the primary source. Every row written since the
 * `merchantName` column was added carries its own snapshot, and this function is never
 * called for those. It exists for the rows already in the table: their `merchantName` is
 * `null`, and reporting that as "merchant no longer on file" would be a false statement
 * about a live account on the screen that exists to answer complaints.
 *
 * One `findMany` for the whole page rather than a join per row: the ids are deduplicated
 * first, and a page of fifty rows usually resolves to a handful of merchants.
 */
async function liveMerchantNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) {
    return new Map();
  }
  const merchants = await prisma.merchant.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
}

/**
 * The name to print for one row.
 *
 * Recorded first, live second, `null` last — in that order, because each step is a
 * weaker claim than the one before it. The recorded name is what the merchant was called
 * when the run happened; the live name is what it is called now; `null` is the honest
 * answer when neither exists.
 */
function resolveName(
  draft: { merchantId: string | null; merchantName: string | null },
  live: Map<string, string>,
): string | null {
  if (draft.merchantName !== null) {
    return draft.merchantName;
  }
  return draft.merchantId === null ? null : (live.get(draft.merchantId) ?? null);
}

function toRow(draft: DraftRecord, live: Map<string, string>): AdminDraftRow {
  const proposals = readProposals(draft.outputJson);
  const rejections = readRejections(draft.outputJson);
  const output = asRecord(draft.outputJson);
  const dealPrices = proposals
    .map((proposal) => proposal.dealPriceCents)
    .filter((cents): cents is number => cents !== null);
  return {
    id: draft.id,
    merchantId: draft.merchantId,
    merchantName: resolveName(draft, live),
    surface: draft.surface,
    promptVersion: draft.promptVersion,
    createdAt: draft.createdAt,
    guardrailPassed: draft.guardrailPassed,
    source: typeof output?.source === 'string' ? output.source : null,
    proposalCount: proposals.length,
    rejectionCount: rejections.length,
    // The number a merchant complaint is usually about, so the list carries it: "it
    // told me to sell at $9" is answered by the row without opening it.
    lowestDealPriceCents: dealPrices.length === 0 ? null : Math.min(...dealPrices),
  };
}

/**
 * The list, newest first.
 *
 * Newest first is not cosmetic: this screen is almost always opened minutes after a
 * merchant phones, so the row being looked for is at the top. Newest-last would put it
 * on page four of eight.
 */
export async function listAdminDrafts(args: {
  merchantId?: string | null;
  limit?: number;
} = {}): Promise<AdminDraftRow[]> {
  const drafts = await prisma.aiDraft.findMany({
    where: args.merchantId ? { merchantId: args.merchantId } : {},
    orderBy: { createdAt: 'desc' },
    take: args.limit ?? 50,
    select: DRAFT_SELECT,
  });

  // Only the rows that need it — an implementation that always fetched names would hide
  // the fact that the recorded column can satisfy the page on its own.
  const needingNames = drafts.filter((draft) => draft.merchantName === null);
  const live = await liveMerchantNames(needingNames.map((draft) => draft.merchantId));
  return drafts.map((draft) => toRow(draft, live));
}

/** One draft, with the JSON parsed where it can be and kept verbatim regardless. */
export async function loadAdminDraft(id: string): Promise<AdminDraftDetail | null> {
  const draft = await prisma.aiDraft.findUnique({ where: { id }, select: DRAFT_SELECT });
  if (!draft) {
    return null;
  }

  const live = await liveMerchantNames([draft.merchantId]);
  const proposals = readProposals(draft.outputJson);
  return {
    ...toRow(draft, live),
    inputs: readInputs(draft.inputJson, proposals),
    proposals,
    rejections: readRejections(draft.outputJson),
    // Pretty-printed rather than compact: the reader is a human comparing two numbers,
    // and a single 4 KB line is not readable on any screen.
    inputJson: JSON.stringify(draft.inputJson, null, 2),
    outputJson: JSON.stringify(draft.outputJson, null, 2),
    answers: readAnswers(draft.inputJson),
  };
}

/** How many drafts exist for a merchant, so a link can say whether opening is worth it. */
export async function countDraftsForMerchant(merchantId: string): Promise<number> {
  return prisma.aiDraft.count({ where: { merchantId } });
}
