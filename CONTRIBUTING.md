# Contributing to GroupEat

## One rule that has already prevented three defects

**Any sentence that contains a monetary figure is a type signature.**

The field name you feed into it does not matter; the sentence itself tells you
which figure is correct. Changing the sentence without checking the figure, or
changing the figure without checking the sentence, will produce a bug that
passes every test — because the test asserts the code against itself, not against
the sentence.

### The rule

| What the sentence says | Which figure | Why |
|---|---|---|
| Mentions "our fee" | **Fee-inclusive** (`netContributionCents`) | The fee is part of the transaction being described. |
| Does **not** mention "our fee" | **Fee-exclusive** (`walkInContributionCents`) | The transaction happens without us; charging our fee in the sentence would describe something that never occurs. |

### A concrete example

The panel's deal-price line (§5.3):

> "You keep $4.01 per plate after ingredients, packaging, card fees **and our fee** ($0.89)."

This sentence names the fee → it must quote `netContributionCents`.

The INFEASIBLE copy (§5.5):

> "At full price ($9.00) you keep -$0.36 per plate after ingredients, packaging and card fees."

This sentence does **not** name the fee → it must quote `walkInContributionCents`.

A global find-and-replace on "and our fee" would falsify one of these while
turning every test green. **The only reliable guard is to read the sentence.**

### When this rule applies

This rule applies to **any sentence that contains a monetary figure**, not only
to guardrail copy. Receipts, commission statements, public deal pages, and
organiser payouts all contain amounts, and the same trap exists in every one of
them: two figures that differ by a fee, and a sentence that either names the fee
or does not.

### If you are renaming a field

1. Read every sentence that renders that field.
2. If the sentence changes, check whether the figure should change with it.
3. If the figure changes, check whether the sentence should change with it.
4. When in doubt, ask the PM — do not guess.

---

*This file is a guard, not a guideline. Ignoring it has produced two defects in
two days, both caught only because someone read the rendered HTML rather than
the test output.*
