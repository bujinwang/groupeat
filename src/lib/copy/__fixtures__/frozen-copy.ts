import type { GuidanceBucket, IneligibilityReason, PanelState } from '@/lib/guardrail';

/**
 * **Test-only oracle.** The single transcription of the words PRD-sprint1
 * freezes (ARCHITECTURE-sprint1 §7.8).
 *
 * Rules this file exists to enforce:
 *
 * 1. **One key per string, one `// PRD-sprint1 §x.y` tag per block.** When the
 *    PRD changes, this file is edited *first*, then the code is made to match.
 *    That ordering is the whole point: it is the only way to tell "the code
 *    drifted from the spec" apart from "someone edited the code and the test
 *    together".
 * 2. **Imported only by `__tests__/`.** If `guardrail-copy.ts` ever imported it,
 *    the oracle would be asserting the code against itself. Enforced by the
 *    `no-restricted-imports` rule in `eslint.config.mjs`.
 * 3. **`guardrail-copy.test.ts` asserts key-set equality in both directions**
 *    against `PanelState`, so an eighth state with invented copy fails, and a
 *    frozen entry no state can produce fails.
 *
 * Never a snapshot (§7.7): a snapshot records what the code *did*, and `vitest -u`
 * rewrites it in one keystroke. That is exactly how a self-authored string
 * becomes a passing test.
 *
 * Scope note: strings that depend on a *view* (the §5.3 block, the THIN and
 * INFEASIBLE bodies) are templates in the PRD, not literals, so they are
 * asserted inline in the test against the concrete vector they belong to. This
 * file holds the literals: headlines, actions, tones, guidance lines, the two
 * ineligible blocks, the confirmation, and the floor-warning templates.
 */

export type FrozenPanelCopy = {
  tone: 'green' | 'amber' | 'red';
  headline: string;
  /** May contain `{minViablePrice}`; the test substitutes `formatCents()`. */
  actionLabel: string;
};

/** PRD-sprint1 §5.4 (the table) and §5.5 (the copy blocks). */
export const FROZEN_PANEL_COPY: Readonly<Record<PanelState, FrozenPanelCopy>> = {
  // PRD-sprint1 §5.4 row 1
  OK: { tone: 'green', headline: 'This works.', actionLabel: 'Use this price' },
  // PRD-sprint1 §5.4 row 2
  FLOOR: {
    tone: 'green',
    headline: 'This is the lowest price that still works.',
    actionLabel: 'Use this price',
  },
  // PRD-sprint1 §5.4 row 3, §5.5 "THIN"
  THIN: {
    tone: 'amber',
    headline: 'Profitable, but nobody will bite.',
    actionLabel: 'Pick another dish',
  },
  // PRD-sprint1 §5.4 row 4, §5.5 "BELOW_FLOOR". `{minViablePrice}` is money:
  // the PRD shows "[ Use $11.12 instead ]".
  BELOW_FLOOR: {
    tone: 'red',
    headline: 'That price loses you money.',
    actionLabel: 'Use {minViablePrice} instead',
  },
  // PRD-sprint1 §5.4 row 5, §5.5 "INFEASIBLE"
  INFEASIBLE: {
    tone: 'red',
    headline: "This dish can't be a deal at your minimum margin.",
    actionLabel: 'Try another dish',
  },
  // PRD-sprint1 §5.4 row 6, §5.5 "INCOMPLETE_COST_DATA"
  INCOMPLETE_COST_DATA: {
    tone: 'red',
    headline: 'We need your ingredient cost first.',
    actionLabel: 'Add ingredient cost',
  },
  // PRD-sprint1 §5.4 row 7, §5.5 "INVALID_COST_DATA"
  INVALID_COST_DATA: {
    tone: 'red',
    headline: 'Check your numbers.',
    actionLabel: 'Fix the numbers',
  },
};

/**
 * PRD-sprint1 §5.3 — the vector-A block, byte-identical, as logical lines (the
 * box in the PRD wraps them for width; the sentence boundaries are the frozen
 * part).
 */
export const FROZEN_VECTOR_A_BLOCK: readonly string[] = [
  '$11.12 per plate   ·   normally $16.00',
  'They save $4.88  (31% off)',
  'You keep $4.01 per plate after ingredients, packaging, card fees and our fee ($0.89).',
  "That's 25% of your menu price — exactly your minimum.",
  'To break even, 71 of every 100 plates must go to people who would not have eaten here otherwise.',
  "→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.",
];

/** PRD-sprint1 §5.3, "line 7" — the guidance lookup table. */
export const FROZEN_GUIDANCE: Readonly<Record<GuidanceBucket, string>> = {
  CHEAP:
    "→ So run this drop in a slot you're normally empty in. This one is cheap to run — you have some room.",
  MODERATE:
    "→ So run this drop in a slot you're normally empty in, and start with 20 units.",
  TIGHT:
    "→ So run this drop in a slot you're normally empty in. If it fills a busy hour, you lose money.",
  SEVERE:
    "→ Most of these plates must be people who would not have come. Only run this at a time you're normally empty — and consider a cheaper dish instead.",
};

/** PRD-sprint1 §5.5 — the two items that can never be part of a deal. */
export const FROZEN_INELIGIBLE: Readonly<
  Record<IneligibilityReason, { tone: 'red'; headline: string; actionLabel: string; body: string[] }>
> = {
  // PRD-sprint1 §5.5 "Non-batchable item"
  NOT_BATCHABLE: {
    tone: 'red',
    headline: 'This dish is marked as not batchable.',
    actionLabel: 'Edit this dish',
    body: [
      "You've told us you can't make 20 of these at once, so there's no batch to price. Turn batching back on if that's changed.",
    ],
  },
  // PRD-sprint1 §5.5 "Alcohol — containsAlcohol = true"
  CONTAINS_ALCOHOL: {
    tone: 'red',
    headline: "This dish contains alcohol, so it can't be part of a deal.",
    actionLabel: 'Edit this dish',
    body: [
      "Alcohol can't be sold through a GroupEat drop under Alberta's AGLC liquor rules — that's regulation, not something we can switch off.",
      "There's no exception for this dish.",
    ],
  },
};

/** PRD-sprint1 §5.5a — the `containsAlcohol: true → false` confirmation. */
export const FROZEN_ALCOHOL_CONFIRMATION = {
  headline: 'Confirm this dish contains no alcohol.',
  body: ["If it does, it can't be sold through a drop."],
  confirmLabel: 'Yes, this dish has no alcohol',
  cancelLabel: 'Cancel',
} as const;

/**
 * PRD-sprint1 §5.1 — the minimum-margin warning (US-M5), as templates. `{pct}`
 * is an integer percent, `{amount}` is `menuPrice × pct` in money, `{menuPrice}`
 * is the merchant's own highest-priced dish.
 */
export const FROZEN_FLOOR_WARNING = {
  headlineTemplate: 'A {pct}% minimum is very thin.',
  bodyTemplate:
    "At that rate you'd keep {amount} on a {menuPrice} dish. That still has to cover labour and rent — the lower this goes, the more likely a batch ends up costing you money.",
  /** PRD-sprint1 §5.1, the `{menuPrice}` row: fallback only when there are no dishes. */
  fallbackMenuPriceCents: 1600,
} as const;
