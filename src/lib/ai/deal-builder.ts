import { aiDraftGenerated } from '@/lib/analytics/funnel';
import { record } from '@/lib/analytics/record-funnel';
import { prisma } from '@/lib/db/prisma';
import { findItem } from '@/lib/db/items';
import { getFloor } from '@/lib/db/merchants';
import { AppError } from '@/lib/errors';
import { DEFAULT_FEES, validateItemCosts, type CompleteGuardrailInput } from '@/lib/guardrail';
import { logger } from '@/lib/logging/logger';

import { lintCopy, type CopyField, type CopyViolation } from './copy-lint';
import type { DealBuilderAnswers } from './input';
import { planProposals, proposalFacts, DEFAULT_PLAN_TIME_ZONE, type PlannedProposal } from './plan';
import {
  DEAL_BUILDER_PROMPT_VERSION,
  DEAL_BUILDER_SYSTEM_PROMPT,
  buildDealBuilderUserMessage,
  type PromptProposal,
} from './prompts/deal-builder';
import {
  createUnavailablePort,
  isAiUnavailable,
  type CompletionPort,
} from './port';
import { forbiddenKeysIn, parseCopyResponse, type CopyProposal } from './schema';

/**
 * The deal-builder orchestration — PRD-v1 §9.2 surface 1.
 *
 * ## The order, and why it is this order
 *
 *   1. **Eligibility and cost data**, from the database. A dish that cannot be a
 *      drop is refused before anything is planned, so no screen ever shows a
 *      proposal for an item the publish path would reject.
 *   2. **The plan**, from `plan.ts`. This produces complete, publishable
 *      proposals with planner-authored copy. At this point the merchant has
 *      something usable.
 *   3. **The model**, if there is one, and only for copy. Every failure mode
 *      (no key, timeout, HTTP error, unparseable JSON, a banned term, a wrong
 *      price) leaves step 2's output in place.
 *   4. **The audit row**, written whatever happened.
 *
 * The consequence worth stating plainly: **this feature has no failure mode that
 * returns an error to the merchant because of the AI.** The only errors are about
 * their dish.
 *
 * ## Why the model's copy is merged per field, not per proposal
 *
 * If the model writes a good `title` and a `shareMessage` containing "30% off" on
 * an 18% deal, throwing the whole proposal away loses three good fields to punish
 * one. So each field is accepted or rejected on its own, and `copyRejected`
 * reports exactly which. The proposal on screen is always internally consistent —
 * every field either came from the planner or passed the linter.
 */

export type CopyRejection = {
  archetype: string;
  field: CopyField;
  kind: CopyViolation['kind'];
  detail: string;
};

export type DealBuilderResult = {
  proposals: PlannedProposal[];
  /** `model` when at least one field came back from the model. */
  source: 'model' | 'planner';
  promptVersion: string;
  /** Merchant-facing explanations of anything adjusted or skipped. */
  notes: string[];
  /** Every field the model wrote that the linter refused. */
  copyRejected: CopyRejection[];
  /** The `AiDraft` row, when it could be written. */
  aiDraftId: string | null;
};

export type BuildDealProposalsArgs = {
  merchantIds: readonly string[];
  answers: DealBuilderAnswers;
  now: Date;
  /** Test seam. Omitted in production, where the real port is resolved lazily. */
  port?: CompletionPort;
};

/**
 * Resolves the port.
 *
 * The dynamic `import('./real-port')` is load-bearing: `real-port.ts` imports
 * `server-only`, which throws when evaluated outside a React Server Component
 * graph — including under Vitest. A static import here would make this whole
 * module untestable, and the tests would then be written against the fake only,
 * which is how the fee-bearer defect in Sprint 2 survived 141 green tests.
 */
async function resolvePort(injected?: CompletionPort): Promise<CompletionPort> {
  if (injected) return injected;

  const real = await import('./real-port');
  if (!real.isCopyModelConfigured()) {
    return createUnavailablePort('no_key');
  }
  return real.createRealCompletionPort();
}

/** Loads the dish and the merchant floor, and refuses an ineligible dish. */
async function loadEligibleDish(merchantIds: readonly string[], menuItemId: string) {
  const item = await findItem(merchantIds, menuItemId);
  if (!item) {
    throw AppError.notFound('That dish could not be found.');
  }

  // FR-104 / AGLC: alcohol can never be in a drop. Checked here as well as in the
  // new-drop page, because this route takes an id from the body.
  if (item.containsAlcohol) {
    throw AppError.validation(
      { menuItemId: 'This dish contains alcohol, which cannot be sold as a drop in Alberta.' },
      'This dish cannot be a drop.',
    );
  }
  if (!item.isBatchable) {
    throw AppError.validation(
      { menuItemId: 'This dish is marked as not batchable.' },
      'This dish cannot be a drop.',
    );
  }
  if (item.archivedAt !== null) {
    throw AppError.validation(
      { menuItemId: 'This dish has been archived.' },
      'This dish cannot be a drop.',
    );
  }

  const costIssues = validateItemCosts({
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    batchYield: item.batchYield,
    prepMinutes: item.prepMinutes,
  });
  if (costIssues.length > 0) {
    throw AppError.validation(
      { menuItemId: 'This dish has a cost problem. Fix the dish, then plan a drop from it.' },
      'This dish cannot be a drop until its costs are fixed.',
    );
  }

  const floorPctOfMenu = await getFloor(item.merchantId);

  const guardrail: CompleteGuardrailInput = {
    ...DEFAULT_FEES,
    menuPriceCents: item.menuPriceCents,
    foodCostCents: item.foodCostCents,
    packagingCents: item.packagingCents,
    floorPctOfMenu,
  };

  return { item, guardrail };
}

/** Builds the prompt's view of each proposal. */
function toPromptProposals(proposals: readonly PlannedProposal[]): PromptProposal[] {
  return proposals.map((proposal) => {
    const facts = proposalFacts(proposal);
    return {
      archetype: proposal.archetype,
      priceLabel: facts.priceLabel,
      menuPriceLabel: facts.menuPriceLabel,
      discountLabel: facts.discountLabel,
      minQty: proposal.minQty,
      maxQty: proposal.maxQty,
      maxPerCustomer: proposal.maxPerCustomer,
      slotLabel: facts.slotLabel,
      closesLabel: facts.closesLabel,
      draft: {
        title: proposal.title,
        description: proposal.description,
        shareMessage: proposal.shareMessage,
        rationale: proposal.rationale,
      },
    };
  });
}

const COPY_FIELDS: readonly CopyField[] = ['title', 'description', 'shareMessage', 'rationale'];

/**
 * Merges model copy into the planner's proposals, field by field.
 *
 * Returns the proposals to show and the rejections to report. Never throws: a
 * model that returns nonsense is an expected condition, not an error.
 */
function mergeCopy(args: {
  proposals: readonly PlannedProposal[];
  modelCopy: readonly CopyProposal[];
}): { proposals: PlannedProposal[]; rejected: CopyRejection[]; usedModel: boolean } {
  const byArchetype = new Map(args.modelCopy.map((entry) => [entry.archetype, entry]));
  const rejected: CopyRejection[] = [];
  let usedModel = false;

  const merged = args.proposals.map((proposal) => {
    const candidate = byArchetype.get(proposal.archetype);
    if (!candidate) {
      // The model skipped this archetype. Its planner copy stands, silently:
      // there is nothing wrong to report and nothing to fix.
      return proposal;
    }

    const next: PlannedProposal = { ...proposal };
    const accepted: Partial<Record<CopyField, string>> = {};

    for (const field of COPY_FIELDS) {
      const text = candidate[field];
      const violations = lintCopy({ [field]: text }, {
        dealPriceCents: proposal.dealPriceCents,
        menuPriceCents: proposal.menuPriceCents,
      });

      if (violations.length > 0) {
        for (const violation of violations) {
          rejected.push({
            archetype: proposal.archetype,
            field,
            kind: violation.kind,
            detail: violation.detail,
          });
        }
        continue;
      }

      accepted[field] = text;
      usedModel = true;
    }

    return { ...next, ...accepted };
  });

  return { proposals: merged, rejected, usedModel };
}

/**
 * Asks the model to rewrite the copy. Returns `null` on any failure.
 *
 * One call for all three proposals rather than three calls: the copy for the
 * three should read as a set, and three round trips would triple the latency
 * budget for no gain.
 */
async function requestModelCopy(args: {
  port: CompletionPort;
  merchantName: string;
  dishName: string;
  proposals: readonly PlannedProposal[];
}): Promise<CopyProposal[] | null> {
  const user = buildDealBuilderUserMessage({
    merchantName: args.merchantName,
    dishName: args.dishName,
    proposals: toPromptProposals(args.proposals),
  });

  let text: string;
  try {
    text = await args.port.complete({
      system: DEAL_BUILDER_SYSTEM_PROMPT,
      user,
      maxOutputTokens: 900,
    });
  } catch (error) {
    if (isAiUnavailable(error)) {
      logger.warn('ai.copy_fallback', { reason: error.reason });
      return null;
    }
    // An unexpected throw from a port is still not the merchant's problem.
    logger.warn('ai.copy_fallback', { reason: 'http_error' });
    return null;
  }

  const parsed = parseCopyResponse(text);
  if (!parsed.ok) {
    logger.warn('ai.copy_fallback', { reason: parsed.reason });
    return null;
  }

  // Not enforcement — the schema already stripped them — but the rate at which
  // models try to set a price is the empirical test of ADR-002's premise, and it
  // can only be measured against the reply *before* validation.
  const forbidden = forbiddenKeysIn(parsed.raw);
  if (forbidden.length > 0) {
    logger.warn('ai.model_set_money', { keys: forbidden.join(',') });
  }

  return parsed.value.proposals;
}

/**
 * Plans a drop and, where a model is available, has its copy rewritten.
 *
 * Throws only `AppError`s that are about the merchant's dish or their quiet slot.
 */
export async function buildDealProposals(
  args: BuildDealProposalsArgs,
): Promise<DealBuilderResult> {
  const { item, guardrail } = await loadEligibleDish(args.merchantIds, args.answers.menuItemId);

  const merchant = await prisma.merchant.findUnique({
    where: { id: item.merchantId },
    select: { name: true, timezone: true },
  });
  // One read, one value. The placeholder the planner needs for its copy is applied at
  // the one place that needs it, below.
  //
  // The first version of this kept two variables — `merchantName` with a placeholder for
  // the planner, `auditedMerchantName` without one for the audit row — and a probe set
  // the second to `'Your restaurant'` with every test still green. No assertion could
  // have caught it: `item.merchantId` is a foreign key, so `loadEligibleDish` cannot
  // return an item whose merchant is missing, so neither `??` branch is reachable from
  // any fixture. Unreachable defensive code that two variables can disagree about is a
  // defect waiting for a reader; one variable cannot disagree with itself.
  const merchantName = merchant?.name ?? null;

  const plan = planProposals({
    dish: {
      id: item.id,
      name: item.name,
      menuPriceCents: item.menuPriceCents,
      batchYield: item.batchYield,
    },
    guardrail,
    quietStart: new Date(args.answers.quietStart),
    maxQtyAsked: args.answers.maxQty,
    intent: args.answers.intent,
    // The planner writes copy *to* the merchant, so it needs a name to address; the audit
    // row records a fact and gets `null` rather than a placeholder. Same read, two
    // different requirements — and the placeholder is applied here, at the one call site
    // that wants it, rather than carried in a variable the audit path could accidentally
    // share.
    merchantName: merchantName ?? 'Your restaurant',
    now: args.now,
    // The merchant's own zone, not the server's. `Merchant.timezone` defaults to
    // America/Edmonton, so V1 is one value — but the column exists, and reading
    // it means a merchant in another province does not get copy in Alberta time.
    timeZone: merchant?.timezone ?? DEFAULT_PLAN_TIME_ZONE,
  });

  if (!plan.ok) {
    // The refusal is a fact about their dish or their chosen day, so it belongs
    // on the field they can change — a 422 with a sentence, not a 500.
    const field = plan.refusal === 'WINDOW_TOO_FAR' ? 'quietStart' : 'menuItemId';
    throw AppError.validation({ [field]: plan.message }, plan.message);
  }

  const port = await resolvePort(args.port);
  const modelCopy = await requestModelCopy({
    port,
    // Same reason as `planProposals` above: the prompt addresses the merchant.
    merchantName: merchantName ?? 'Your restaurant',
    dishName: item.name,
    proposals: plan.proposals,
  });

  const merged: { proposals: PlannedProposal[]; rejected: CopyRejection[]; usedModel: boolean } =
    modelCopy
      ? mergeCopy({ proposals: plan.proposals, modelCopy })
      : { proposals: plan.proposals, rejected: [], usedModel: false };

  const source: 'model' | 'planner' = merged.usedModel ? 'model' : 'planner';

  logger.info('ai.proposals_generated', {
    merchantId: item.merchantId,
    itemId: item.id,
    source,
    proposalCount: merged.proposals.length,
    promptVersion: DEAL_BUILDER_PROMPT_VERSION,
  });

  const aiDraftId = await persistAuditRow({
    merchantId: item.merchantId,
    merchantName,
    answers: args.answers,
    guardrail,
    result: merged.proposals,
    rejected: merged.rejected,
    source,
  });

  // Emitted after the audit-row attempt whatever it returned: the proposals were
  // generated either way, and `persistAuditRow` is explicitly allowed to fail
  // without refusing the merchant. No answers, no prompt copy, no merchant or
  // dish name — ids, counts, and the two fields §10.1 names.
  record(
    aiDraftGenerated({
      merchantId: item.merchantId,
      itemId: item.id,
      aiDraftId,
      surface: 'merchant_builder',
      guardrailPassed: true,
      proposalCount: merged.proposals.length,
      copyRejectedCount: merged.rejected.length,
      source,
    }),
  );

  return {
    proposals: merged.proposals,
    source,
    promptVersion: DEAL_BUILDER_PROMPT_VERSION,
    notes: plan.notes,
    copyRejected: merged.rejected,
    aiDraftId,
  };
}

/**
 * Writes the `AiDraft` audit row (PRD-v1 §9.1.3).
 *
 * A failure here is logged and swallowed. The row exists so a merchant complaint
 * about wording can be answered months later; refusing to show the proposals
 * because the audit write failed would trade a future inconvenience for a
 * present one. The log line is the alarm.
 *
 * ## Why the row carries a copy of the merchant's name
 *
 * `AiDraft.merchantId` is a `SetNull` foreign key, so deleting a merchant leaves the
 * row standing with no pointer to its subject. That is deliberate — the row is evidence
 * and must outlive the thing it is about — but it would leave the admin screen with
 * nothing but a uuid to show. So the name is captured here, at write time, exactly as
 * `AuditLog` captures `actorEmail`: it records what the merchant was *called* when the
 * run happened, and renaming the merchant afterwards does not rewrite it.
 *
 * `merchantName` is `null` rather than a placeholder when the row is missing, which is
 * the same situation `loadEligibleDish` would already have refused — kept as `null` so
 * a hypothetical row that reached here cannot record "Your restaurant" as a fact.
 */
async function persistAuditRow(args: {
  merchantId: string;
  merchantName: string | null;
  answers: DealBuilderAnswers;
  guardrail: CompleteGuardrailInput;
  result: readonly PlannedProposal[];
  rejected: readonly CopyRejection[];
  source: 'model' | 'planner';
}): Promise<string | null> {
  try {
    const row = await prisma.aiDraft.create({
      data: {
        merchantId: args.merchantId,
        merchantName: args.merchantName,
        surface: 'merchant_builder',
        promptVersion: DEAL_BUILDER_PROMPT_VERSION,
        inputJson: {
          answers: args.answers,
          fees: DEFAULT_FEES,
          floorPctOfMenu: args.guardrail.floorPctOfMenu,
          menuPriceCents: args.guardrail.menuPriceCents,
          foodCostCents: args.guardrail.foodCostCents,
          packagingCents: args.guardrail.packagingCents,
        },
        outputJson: {
          source: args.source,
          proposals: args.result,
          copyRejected: args.rejected,
        },
        // True by construction: every proposal went through `validateDropTiming`
        // and `validateDropQuantities`, and every price came from the guardrail.
        // If this were ever false the row would be the evidence.
        guardrailPassed: true,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    logger.warn('ai.draft_persist_failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}
