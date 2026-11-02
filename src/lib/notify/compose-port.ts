import { logger } from '@/lib/logging/logger';
import { momentLabel } from '@/lib/time/labels';

import {
  cardDeclinedSms,
  dropConfirmedChargedSms,
  dropFailedNoChargeSms,
  dropFailedRefundedSms,
  joinConfirmationSms,
  type NotificationMessage,
  stillFillingSms,
} from './copy';
import type { NotificationSender } from './sender';
import type { NotifyIntent, NotifyPort } from '@/lib/settlement/notify-port';

/**
 * The bridge from "what happened" to "what is said" — FR-408 and FR-506.
 *
 * ## Why this exists as a third module
 *
 * There were two halves and a gap between them. `NotifyIntent` describes an event and
 * carries no words; `NotificationSender` delivers words and knows nothing about
 * events. Something has to turn one into the other, and the temptation is to put that
 * inside the sender — which is how a Twilio file ends up containing the sentence "the
 * drop filled, but your card was declined" and a Stripe file ends up containing
 * another. The bridge is a pure function of an intent, so the wording is testable
 * without a provider and the provider is testable without a database.
 *
 * ## Why `cutoffLabel` and `windowLabel` are injected rather than derived
 *
 * Every intent that names a time carries the `Date`, not a zone. Zones are the
 * merchant's, and the merchant is not on the intent. The two callers therefore supply
 * a `timeZone`:
 *
 *   - settlement: `locked.timezone`, read under the lock;
 *   - the join: `reserved.merchantTimezone`, read in the reservation transaction.
 *
 * Passing it in keeps this module free of database access and makes the zone a
 * required argument rather than a default — a default would silently print the
 * server's zone for every merchant, which reads as correct and is wrong by hours.
 *
 * ## What this module refuses to do
 *
 * It does not retry, does not deduplicate, and does not decide whether a message is
 * worth sending. Those are the sender's and the caller's problems respectively. It
 * maps one intent to one message, or to nothing.
 */

export type ComposedPort = NotifyPort & {
  /** Every message composed in this process, newest last. Diagnostics only. */
  readonly composed: readonly NotificationMessage[];
};

/** Context a caller must supply because it is not on the intent. */
export type ComposeContext = {
  /**
   * The merchant's IANA zone, used when the caller does not supply one per batch.
   *
   * Optional because `notify()` now receives it: a batch belongs to one drop, so the
   * zone travels with the batch rather than with the port. This field remains for the
   * one caller that composes outside a settlement tick — the join path, which has the
   * zone in hand from its reservation and never calls `notify()`.
   */
  readonly timeZone?: string;
  /**
   * Called with messages that are ready to send. Must not throw; the bridge
   * awaits the sender and logs a failure, exactly as `deliver()` does.
   */
  readonly sender: NotificationSender;
  /**
   * Composes but sends nothing. Used by the join path, where the message is built and
   * logged but delivery is out of scope for this slice — and by tests that want to
   * assert the wording without a sender.
   */
  readonly dryRun?: boolean;
};

/**
 * A port that composes every intent into copy and hands the batch to a sender.
 *
 * ## The contract it inherits
 *
 * `NotifyPort.notify` must never throw into the settlement path. This implementation
 * is therefore defensive twice: `compose` returns `null` for an intent it cannot say
 * anything true about, and the whole send is wrapped so a sender that misbehaves
 * cannot turn a successful capture into a failed tick.
 */
export function composingNotifyPort(context: ComposeContext): ComposedPort {
  const composed: NotificationMessage[] = [];

  return {
    composed,

    async notify(intents, notifyContext) {
      const timeZone = notifyContext?.timeZone ?? context.timeZone;

      const messages: NotificationMessage[] = [];

      for (const intent of intents) {
        const message = compose(intent, timeZone);
        if (message) {
          messages.push(message);
          composed.push(message);
        }
      }

      if (messages.length === 0) {
        return;
      }

      if (context.dryRun) {
        // Counts only. A body contains a bearer token and a redemption code.
        logger.info('notification.intent', {
          kind: messages[0]!.kind,
          dropId: intents[0]?.dropId ?? 'unknown',
          count: messages.length,
        });
        return;
      }

      try {
        await context.sender.send(messages);
      } catch (error) {
        // `NotificationSender.send` promises not to throw. If it does, the promise
        // was broken — log it and carry on, because the alternative is a 500 on a
        // drop whose cards have already been charged.
        logger.warn('notification.failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
  };
}

/**
 * One intent → one message, or `null`.
 *
 * `null` means "this intent cannot be said truthfully". Two cases, and they are
 * different kinds of no:
 *
 *   - **A charged intent with no redemption code** — which `buildCapturedIntents`
 *     already filters out.
 *   - **An intent that names a time, with no zone to name it in.** See below.
 *
 * Returning `null` rather than throwing keeps one unsayable intent from costing every
 * other diner in the batch their text.
 *
 * ## Why the zone guard is here and not on the batch
 *
 * It used to be on the batch: `notify()` refused every intent when no zone was
 * supplied. That was wrong in the direction that matters. Three of the five intents —
 * `DROP_CONFIRMED_CARD_DECLINED`, `DROP_FAILED_NO_CHARGE`, `DROP_FAILED_REFUNDED` —
 * name **no time at all**. Refusing them because a *different* intent in the same
 * batch needed a zone meant that a single zone-threading bug would silence exactly the
 * messages FR-306 makes mandatory ("nobody was charged"), while leaving the reassuring
 * ones intact. The guard has to be per-message, so that a missing zone suppresses only
 * what genuinely cannot be said in it.
 *
 * `timeZone` is therefore optional here, and each `case` that formats an instant
 * demands it. A caller with no zone can still tell a diner their card was not charged.
 */
export function compose(
  intent: NotifyIntent,
  timeZone?: string,
): NotificationMessage | null {
  switch (intent.kind) {
    case 'DROP_CONFIRMED_CHARGED':
      return timeZone
        ? dropConfirmedChargedSms({
            chargedCents: intent.chargedCents,
            qty: intent.qty,
            redemptionCode: intent.redemptionCode,
            windowStart: intent.windowStart,
            windowEnd: intent.windowEnd,
            timeZone,
            phone: intent.phone,
            ...(intent.orderUrl ? { orderUrl: intent.orderUrl } : {}),
          })
        : refuseForMissingZone(intent.kind);

    case 'DROP_CONFIRMED_CARD_DECLINED':
      return cardDeclinedSms({ qty: intent.qty, phone: intent.phone });

    case 'DROP_FAILED_NO_CHARGE':
      return dropFailedNoChargeSms({ qty: intent.qty, phone: intent.phone });

    case 'DROP_FAILED_REFUNDED':
      return dropFailedRefundedSms({
        chargedCents: intent.chargedCents,
        qty: intent.qty,
        phone: intent.phone,
      });

    case 'THRESHOLD_REACHED_STILL_FILLING':
      return timeZone
        ? stillFillingSms({
            cutoffLabel: momentLabel(intent.cutoffAt, timeZone),
            phone: intent.phone,
          })
        : refuseForMissingZone(intent.kind);

    default: {
      // Exhaustiveness, so adding a `NotifyIntent` kind without copy is a compile
      // error rather than a message nobody ever sends. This is the guard that keeps
      // "capability built, wired into a channel nobody opened" from recurring in the
      // one place this repo has hit it three times.
      const unreachable: never = intent;
      logger.error('notification.failed', {
        reason: `NO_COPY:${(unreachable as { kind?: string }).kind ?? 'unknown'}`,
      });
      return null;
    }
  }
}

/**
 * A message that names a time cannot be composed without a zone — the server's clock
 * is not the diner's, and a wrong-but-plausible hour is worse than silence. Loud,
 * because the only way to get here is a caller that failed to thread the merchant's
 * zone through, which is a bug rather than a condition.
 */
function refuseForMissingZone(kind: string): null {
  logger.error('notification.failed', { reason: `NO_TIME_ZONE:${kind}` });
  return null;
}

/**
 * FR-408's message, composed on the **join** path rather than at capture.
 *
 * Separate from `compose()` because it is not derived from a `NotifyIntent`: the
 * intent vocabulary describes settlement outcomes, and "you just joined" is not one.
 * Reframing it as an intent would mean a sixth `NotifyIntent` kind that settlement
 * never emits — a union member existing only for the other caller, which is how a
 * shared vocabulary rots.
 *
 * ## The consent gate lives here, not in the composer
 *
 * FR-408's acceptance is "only if consent captured". The join path records consent in
 * the same transaction as the participant row, so the caller knows the answer; the
 * composer must not read a database to decide whether it may speak. This function
 * therefore takes `consented` and returns `null` when it is false — an explicit
 * decision in one place, rather than a missing call site somewhere else.
 *
 * ## Why this is not the same policy as FR-506
 *
 * They are different messages under CASL, not the same message with a different body:
 *
 *   - **This one is marketing-adjacent.** It is optional, arrives before any money
 *     has moved, and the checkbox the diner ticked is the consent it relies on. So it
 *     is gated.
 *   - **FR-506's outcome messages are transactional.** They report a charge, a
 *     decline or a refund — facts about money that already moved. PRD §CASL says
 *     transactional messages are "separate" from consent, and suppressing them would
 *     leave a diner who never ticked a box with a charge and no explanation. So they
 *     are **not** gated on the same flag.
 *
 * Conflating the two would be the worst of both: a diner who opted out of updates
 * still gets charged, so the charge message must arrive; and a diner who opted out
 * should not get a cheerful "you're in".
 */
export function joinConfirmationMessage(args: {
  consented: boolean;
  qty: number;
  amountCents: number;
  cutoffAt: Date;
  timeZone: string;
  orderPath: string;
  orderUrl?: string;
  phone: string;
}): NotificationMessage | null {
  if (!args.consented) {
    return null;
  }

  return joinConfirmationSms({
    qty: args.qty,
    amountCents: args.amountCents,
    cutoffLabel: momentLabel(args.cutoffAt, args.timeZone),
    orderPath: args.orderPath,
    phone: args.phone,
    ...(args.orderUrl ? { orderUrl: args.orderUrl } : {}),
  });
}
