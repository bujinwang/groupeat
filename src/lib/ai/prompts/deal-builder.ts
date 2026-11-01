import type { ProposalArchetype } from '../plan';

/**
 * The deal-builder prompt — versioned in a file, never in the database
 * (PRD-v1 §9.4).
 *
 * ## What the model is and is not asked for
 *
 * It is asked for four sentences per proposal. It is not asked for a price, a
 * quantity, a date, or a discount. The numbers arrive as a **fact sheet** —
 * already formatted, already checked against the guardrail — and the model's job
 * is to write around them without changing them. `copy-lint.ts` then verifies
 * that `$13.10` came back as `$13.10`.
 *
 * That is the whole design of this prompt: give the model nothing to compute, so
 * that "the model never computes money" is a property of the input rather than a
 * hope about the output.
 *
 * ## Why the draft copy is included
 *
 * Each proposal ships with planner-authored copy. The model is told to improve
 * it, not to start from nothing. Two consequences: the output is anchored on
 * sentences that already pass the linter, and if the model returns something
 * unusable the fallback is a *rewrite of a rewrite*, not a blank.
 *
 * ## Changing this file
 *
 * §9.4 requires a test run against 10 stored fixtures before deploy. The version
 * string is recorded on every `AiDraft` row, so a complaint about copy can be
 * traced to the exact prompt that produced it. Bump it whenever the wording
 * below changes — including a change to one example, because the examples are
 * part of the instruction.
 */

export const DEAL_BUILDER_PROMPT_VERSION = 'deal-builder/2026-11-01.1';

/** One proposal, as the prompt presents it. Labels are pre-formatted strings. */
export type PromptProposal = {
  archetype: ProposalArchetype;
  priceLabel: string;
  menuPriceLabel: string;
  discountLabel: string;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
  slotLabel: string;
  closesLabel: string;
  draft: {
    title: string;
    description: string;
    shareMessage: string;
    rationale: string;
  };
};

export type PromptArgs = {
  merchantName: string;
  dishName: string;
  proposals: readonly PromptProposal[];
};

/**
 * The system message.
 *
 * Written as constraints, not as a persona. A persona invites the model to be
 * creative about the facts; constraints do not.
 */
export const DEAL_BUILDER_SYSTEM_PROMPT = [
  'You write short pickup-offer copy for a restaurant that is selling one dish in a batch.',
  'The audience is a group chat: people who already know the restaurant and will decide in ten seconds.',
  '',
  'Hard rules:',
  '- Output JSON only. No prose, no code fences, no explanation.',
  '- Use only the facts given. Never invent an ingredient, a certification, a health benefit, an award, or a guarantee.',
  '- Copy every price, time, percentage and quantity exactly as given in the facts. Do not reformat, round, or recalculate them.',
  '- Never write a number that is not in the facts.',
  '- No health claims, no superlatives ("best", "perfect", "ultimate"), no promises ("guaranteed", "risk-free").',
  '- Plain language. No marketing adjectives. Write the way a restaurant owner texts a regular customer.',
  '- Do not mention a platform, an app, a fee, or a discount percentage unless the facts contain it.',
  '',
  'Length limits, in characters:',
  '- title: 60',
  '- description: 300',
  '- shareMessage: 140',
  '- rationale: 300',
].join('\n');

/**
 * The user message: the fact sheet, then the shape to return.
 *
 * `archetype` is carried through so the response can be matched back to a
 * proposal; without it, a model that reorders the array would attach the wrong
 * copy to the wrong price.
 */
export function buildDealBuilderUserMessage(args: PromptArgs): string {
  const { merchantName, dishName, proposals } = args;

  const factSheets = proposals.map((proposal) => ({
    archetype: proposal.archetype,
    restaurant: merchantName,
    dish: dishName,
    price: proposal.priceLabel,
    normalMenuPrice: proposal.menuPriceLabel,
    discount: proposal.discountLabel,
    pickupWindow: proposal.slotLabel,
    joiningCloses: proposal.closesLabel,
    minimumOrders: proposal.minQty,
    maximumOrders: proposal.maxQty,
    limitPerPerson: proposal.maxPerCustomer,
    currentDraft: proposal.draft,
  }));

  return [
    'Facts for each offer, then the draft copy to improve.',
    '',
    JSON.stringify({ offers: factSheets }, null, 2),
    '',
    'Return exactly this shape, with one entry per offer above and the same archetype values:',
    '{"proposals":[{"archetype":"QUIET_HOUR|TRIAL|SURPLUS","title":"...","description":"...","shareMessage":"...","rationale":"..."}]}',
    '',
    'Write for the reader, not for the merchant:',
    '- title: what the dish is and when to collect it.',
    '- description: the pickup window, the deadline, and the fact that nobody is charged unless the minimum is met.',
    '- shareMessage: written to be pasted into a group chat by the organiser. It must include the price, the pickup window, the minimum, and a call to reply.',
    '- rationale: one or two sentences telling the merchant why this offer is shaped the way it is.',
  ].join('\n');
}
