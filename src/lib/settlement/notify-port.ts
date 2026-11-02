import { logger } from '@/lib/logging/logger';

/**
 * FR-506's seam — design §3.5.
 *
 * Nothing is sent in this slice: `resend` is installed and deliberately unused
 * until a provider is chosen. The seam exists so that adding email or SMS later is
 * **one new file** rather than an edit to settlement, and so the obligation ADR-003
 * puts on the join path ("still filling until {cutoff}") has somewhere to live
 * before anyone writes it.
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
   * crossed — not by this job, and not by anything in this slice. The type exists
   * so the obligation is visible to whoever writes the join path, instead of being
   * rediscovered from an ADR. There is no emitter yet; that is deliberate.
   */
  | {
      readonly kind: 'THRESHOLD_REACHED_STILL_FILLING';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly qty: number;
      readonly cutoffAt: Date;
    };

export interface NotifyPort {
  /** Must never throw into the settlement path. See the note above. */
  notify(intents: readonly NotifyIntent[]): Promise<void>;
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
