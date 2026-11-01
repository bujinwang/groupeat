# ADR-002 — Who authors a deal's price: the model or the server

**Status:** Accepted
**Date:** 2026-11-01
**Supersedes:** PRD-v1 §9.2 output contract (the `dealPriceCents` / `minQty` / `maxQty` / window fields in the model's response)
**Blocks:** nothing — M3 slice 3 ships on this decision
**Related:** ADR-001 (the other place a PRD recommendation contradicted the arithmetic that had already shipped)

---

## 1. The decision

**The server authors every number in a proposal. The model authors only the words.**

`plan.ts` produces three complete, publishable proposals — price, quantities,
window, cutoff — deterministically from the guardrail. A model may then rewrite
four string fields per proposal: `title`, `description`, `shareMessage`,
`rationale`. Nothing else. The response schema (`schema.ts`) strips any other key,
so a price a model sends does not survive validation, and the attempt is logged
(`ai.model_set_money`) so the rate is measurable.

## 2. Why the PRD's contract is wrong

PRD-v1 §9.2 specifies a model response containing `dealPriceCents`, `minQty`,
`maxQty`, `windowStart`, `windowEnd`, and then a mandatory post-validation step
that clamps `dealPriceCents` up to `minViablePrice`.

That post-validation step is the proof the contract does not work. Consider what
it does when the model answers `900` on a dish whose floor is `1112`:

1. The server replaces `900` with `1112`.
2. The number the merchant sees is `1112`.
3. `1112` is what `minViablePrice()` returns for that dish — always, for every
   model, on every run.

The model's price was never an input. It was a value that was going to be
discarded. What it *did* contribute was a set of ways to be wrong that now need
handling:

| Model output | Post-validation required | What it costs |
|---|---|---|
| `dealPriceCents: 900` (below floor) | clamp up, log violation | a violation log that will fire on most calls, permanently |
| `dealPriceCents: 2400` (above menu) | reject proposal | an entire proposal lost to a pricing error |
| `maxQty: 40` on a dish that yields 10 | reject proposal | same |
| `windowEnd` before `windowStart` | reject proposal | same |

Four failure modes, all of them created by asking a language model a question with
an arithmetic answer that the server already had.

### 2.1 The PRD contradicts itself, and the principles win

§9.1 states the rule plainly:

> 1. **The model never computes money.** All prices, fees and contributions come
>    from §7.
> 2. **The model never sets a price.** It proposes; the deterministic slider
>    enforces.

§9.2 then asks it to set a price. The principles are correct and the contract is
not, so the contract loses. This is the same shape as ADR-001, where §17's
recommended mechanism contradicted the fee arithmetic §8 had already fixed.

## 3. What replaced it

### 3.1 The planner is the product

`plan.ts` is pure, has no I/O, and produces three proposals from:

- the dish (menu price, batch yield, ingredient and packaging cost),
- the merchant's floor,
- the quiet slot the merchant named,
- how many they said they can make,
- what they said they want out of it.

Every price it emits comes from `minViablePrice()`. Every proposal is then run
through `validateDropTiming` and `validateDropQuantities` — the same functions
`publishDrop` runs — so a proposal that could not publish is never shown.

The three archetypes differ **structurally**, not cosmetically:

| Archetype | Price | Minimum | Per person | Notice |
|---|---|---|---|---|
| `QUIET_HOUR` | floor + 40% of the floor-to-menu gap | highest | 4 | 3h |
| `TRIAL` | at the floor | high | **1** | 12h |
| `SURPLUS` | at the floor | lowest | 2 | 2h |

Three price points on one shape would be a menu with one dish on it. Three
different commitments is a decision.

### 3.2 The model gets a fact sheet, not a question

The prompt hands the model pre-formatted strings — `"$13.10"`, `"Tuesday
2pm–4pm"`, `"Tuesday 11am"` — and instructs it to reuse them verbatim. It is never
asked to format `1310` into a price, because formatting is the step where a number
becomes a different number.

`copy-lint.ts` then verifies what came back:

- **Every `$N.NN` in the copy must equal the deal price or the menu price.**
- **Every percentage must be within one point of the real discount.**
- Banned terms per §15.3: health claims, unsubstantiated superlatives, guarantees,
  and scarcity claims the system did not generate (FR-304 owns scarcity, from the
  real counter).
- Column lengths.

A violation costs one field, not the proposal: the planner's copy for that field
stands, and the rejection is reported. The merchant always sees three internally
consistent proposals.

### 3.3 "New customers" is called `TRIAL` on purpose

The strategy doc's third archetype is "Social Unlock (new customers, **must be
new-customer-gated**)". Nothing in the V1 schema can enforce that gate.
`maxPerCustomer: 1` limits a stock-up; it does not identify a first-timer.

So the archetype is named for the mechanism it actually has, and its rationale
says "one per person", not "new customers only". Naming it after a gate we do not
have would be the same class of error as a snapshot built from the wrong
contribution figure — a label that reads correctly and is false.

**Before this archetype is marketed as acquisition, a `firstOrderOnly` gate must
exist on `Drop` and be enforced at join.**

## 4. Consequences

**Good.**

- The feature works with no model at all. That is the current state of this
  repository (no `AI_API_KEY`), so the whole path is exercised end to end today
  rather than after a key arrives.
- There is no AI failure mode that returns an error to a merchant. Down, slow,
  malformed, wrong price, banned word — each degrades to planner copy, and the
  response says `source: "planner"`.
- The prompt is short and cannot drift into arithmetic, because it has no
  arithmetic to do.

**Costs.**

- The copy is templated until a model rewrites it. On a machine with no key, three
  proposals read like a form letter. Acceptable: the numbers are right, and the
  merchant is going to edit the words anyway.
- Adding a genuinely new archetype is now a code change in `plan.ts`, not a prompt
  change. That is deliberate — an archetype is a structural bet about what the
  merchant commits to, and those should be reviewed.

## 5. Open questions this does not settle

1. **The 70.6% incrementality assumption is still unvalidated.** The planner can
   guarantee a merchant does not lose money per plate; it cannot guarantee anyone
   joins. The go/no-go metric in the strategy doc (>70% of drops hitting threshold)
   is still the only thing that decides whether any of this works.
2. **`QUIET_HOUR`'s 40% share is a guess.** It is the one number in the planner
   that is a product opinion rather than a constraint. It should be tuned against
   real fill rates, and it is a single constant in `plan.ts` so that tuning is one
   edit.
3. **The five-day cap constrains the quiet slot to four days out.** A merchant
   whose quiet day is a weekly market six days away cannot plan it here yet. That
   is correct behaviour, not a bug — but it will be the first complaint.
