import { logger } from '@/lib/logging/logger';

/**
 * FR-506's seam — design §3.5.
 *
 * Nothing is sent in this slice: `resend` is installed and deliberately unused
 * until a provider is chosen. The seam exists so that adding email or SMS later is
 * **one new file** rather than an edit to settlement, and so the obligation ADR-003
 * puts on the join path ("still filling until {cutoff}") has somewhere to live.
 * That emitter now exists (`joinDrop`, step 6); what is still missing is a sender.
 *
 * ## The one rule the port must keep
 *
 * `notify()` must never throw into the settlement path. Failure to notify is not
 * failure to charge, and conflating them would strand a settled drop in `LOCKED` —
 * a drop whose money has moved, whose page says "charging cards now", and which
 * will be retried forever because a message could not be sent.
 */

export type NotifyIntent =
  | {
      readonly kind: 'DROP_CONFIRMED_CHARGED';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      /** What the diner's card was debited. Gross. See §11.1. */
      readonly chargedCents: number;
      readonly qty: number;
      readonly redemptionCode: string;
      /**
       * Where the diner can see the code without typing it.
       *
       * A `v1.<body>.<sig>` redemption code is about 200 characters, so the SMS
       * cannot contain it and expect anybody to enter it at a counter. This is the
       * link the message carries instead — a read-only page holding a token that is
       * **not** the code (see `lib/participant/access.ts` for why those are two
       * different keys).
       *
       * Optional because it needs a public base URL, which only the caller knows.
       * A sender that does not have one must send something that works rather than
       * a link to `localhost`; the type makes that a visible decision.
       */
      readonly orderUrl?: string;
      readonly windowStart: Date;
      readonly windowEnd: Date;
    }
  | {
      readonly kind: 'DROP_CONFIRMED_CARD_DECLINED';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly qty: number;
    }
  | {
      readonly kind: 'DROP_FAILED_NO_CHARGE';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly qty: number;
    }
  | {
      readonly kind: 'DROP_FAILED_REFUNDED';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly chargedCents: number;
      readonly qty: number;
    }
  /**
   * ADR-003's copy obligation. Emitted by the **join** path when `minQty` is first
   * crossed — not by this job. `joinDrop` step 6 is the emitter; see the note on
   * exactly-once there. Nothing delivers it yet (D-5).
   */
  | {
      readonly kind: 'THRESHOLD_REACHED_STILL_FILLING';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly qty: number;
      readonly cutoffAt: Date;
    };

/**
 * Context the port needs to turn an intent into words, supplied per call.
 *
 * ## Why this is an argument and not a field on every intent
 *
 * The charged and still-filling messages both name a **time**, and a time is only
 * meaningful in a zone. The zone is the **merchant's**, so it is not a property of
 * the event — it is a property of who is being told.
 *
 * Putting `timeZone` on the intents would mean:
 *
 *   - the same value repeated on five union members and at every construction site,
 *     including the two that name no time at all;
 *   - and settlement reading a merchant row it has already read, or threading a value
 *     through three layers to avoid doing so.
 *
 * Instead the caller supplies it once per batch, which is honest about what it is:
 * the same fact for every diner in one drop's settlement.
 */
export type NotifyContext = {
  /**
   * The merchant's IANA zone. Used to name a pickup window or a cutoff.
   *
   * Required on the interface but **optional** for an implementation that produces no
   * prose: `noopNotifyPort` counts and logs, so it genuinely does not care. Making it
   * required everywhere would force every test that asserts "the seam fired" to
   * invent a zone, which is noise around an assertion that has nothing to do with
   * time.
   */
  readonly timeZone?: string;
};

export interface NotifyPort {
  /** Must never throw into the settlement path. See the note above. */
  notify(intents: readonly NotifyIntent[], context?: NotifyContext): Promise<void>;
}

/**
 * The only implementation in this slice.
 *
 * Logs `notification.intent` with `{ kind, dropId, count }` and nothing else — no
 * phone, no code. That is enough to prove the seam fires, and it is the whole of
 * FR-506 here.
 */
export function noopNotifyPort(): NotifyPort {
  return {
    async notify(intents) {
      // Grouped by kind so a tick that settles 40 participants writes two lines,
      // not forty. Counts only: the intent carries a phone number and a bearer
      // token, neither of which may reach a log (§11.7).
      const byKind = new Map<string, { dropId: string; count: number }>();
      for (const intent of intents) {
        const key = `${intent.kind}:${intent.dropId}`;
        const existing = byKind.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          byKind.set(key, { dropId: intent.dropId, count: 1 });
        }
      }
      for (const [key, value] of byKind) {
        logger.info('notification.intent', {
          kind: key.slice(0, key.indexOf(':')),
          dropId: value.dropId,
          count: value.count,
        });
      }
    },
  };
}
