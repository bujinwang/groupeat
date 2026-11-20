/**
 * Whether the deal page may offer a Join button.
 *
 * ## Why this is a function and not a boolean
 *
 * It was a single `const JOIN_FLOW_READY = false` for two slices, and that was fine
 * while the reason was uniform: there was no join page, so there was nothing to link
 * to. Slice 2b changed the shape of the problem. There are now **two independent
 * ways to be unready**, and they are not the same kind of thing:
 *
 *   1. **Capability** — this deployment has no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
 *      so no card form can render. Knowable from configuration, and it is knowable
 *      *now*.
 *   2. **Evidence** — the *in-app* join flow has been driven end to end against
 *      Stripe at least once: a diner's tap → `AUTHORIZED` → no `CHARGE` row → the
 *      confirmation renders. Not knowable from configuration at all; it is a claim
 *      about history.
 *
 * Dated correction — 2026-11-07: item 2 used to read "the payments path has been
 * exercised against Stripe at least once … `join/real-payment-port.ts` has never run
 * against the real API, and no card has been held". That is no longer true of the
 * *ports*: `scripts/verify-stripe.ts` held a test-mode card through
 * `join/real-payment-port.ts`, then captured and refunded it through
 * `real-charge-port.ts`. What remained unproven at that point was the end-to-end path
 * above — that script calls the ports directly and writes no app DB row.
 * `JOIN_FLOW_PROVEN_LIVE` therefore stays `false`, for that narrower reason.
 * (**Superseded by the correction below** — the app route has since been driven, so the
 * "writes no app DB row" clause no longer describes the state of the evidence.)
 *
 * Dated correction — 2026-11-07 (latest): the *app-route server layer* is now also proven —
 * `scripts/verify-join-app.ts` drives the real `POST /api/public/drops/[code]/join` route, which
 * runs `joinDrop` and writes `Customer` + `ConsentRecord` + `DropParticipant(AUTHORIZED)` rows
 * plus the confirmation body. `JOIN_FLOW_PROVEN_LIVE` still stays `false`, because neither script
 * exercises the genuine browser diner tap (DOM `JoinForm` → Stripe.js `paymentMethodId` → SMS).
 *
 * A single boolean conflates them, and the cost of conflating them is asymmetric and
 * silent: a deployment *with* keys looks ready even though nothing has ever been
 * proven, so the flag gets flipped for the wrong reason and the button starts
 * promising a working card form on the strength of a fake. Keeping them separate
 * means the capability gate can flip itself the moment a key appears, while the
 * evidence gate stays shut until somebody runs the live check — and the disabled
 * copy can say which one is closed.
 *
 * ## Why "proven live" is a constant someone must set
 *
 * It cannot be derived. There is no runtime signal that distinguishes "this build has
 * been tested against Stripe" from "this build has not" — the app behaves identically
 * either way, which is the whole reason the distinction matters. So it is a human
 * assertion, and the honest thing is to make it look like one.
 */

export type JoinGateInput = {
  /** The offer itself is joinable — open, not sold out, not failed. */
  readonly canJoin: boolean;
  /** A publishable key exists, so a card form can render. */
  readonly stripeConfigured: boolean;
  /**
   * A diner's tap has been driven end to end through the app against Stripe:
   * `AUTHORIZED`, no `CHARGE` row, and the confirmation rendered. A port-level
   * verification (2026-11-07) is *not* sufficient — see the docblock above.
   */
  readonly provenLive: boolean;
};

export type JoinGate = {
  /** Whether to render the button as a link. */
  readonly offerJoin: boolean;
  /**
   * Why not, when not. `null` when the button is offered.
   *
   * `'DROP'` is not returned — a drop that cannot be joined is a property of the
   * drop, and the deal page already has its own copy for that (`SOLD_OUT`,
   * `FAILED`, closed). This function only answers the question the drop cannot:
   * whether *we* can take a join right now.
   */
  readonly blockedBy: 'PAYMENTS' | 'UNPROVEN' | null;
};

export function resolveJoinGate(input: JoinGateInput): JoinGate {
  if (!input.canJoin) {
    // The button is not offered, and the reason is the drop, not this build. The
    // deal page renders its own wording for that case and must keep doing so.
    return { offerJoin: false, blockedBy: null };
  }

  // Capability first: it is the reason a diner can verify for themselves, and the
  // more specific of the two. Telling someone "not taking joins yet" when the truth
  // is "this server cannot take a card" would be technically true and useless.
  if (!input.stripeConfigured) {
    return { offerJoin: false, blockedBy: 'PAYMENTS' };
  }

  if (!input.provenLive) {
    return { offerJoin: false, blockedBy: 'UNPROVEN' };
  }

  return { offerJoin: true, blockedBy: null };
}
