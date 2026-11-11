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
    }
  /**
   * FR-902 — a drop was called off and the money went back.
   *
   * A distinct pair from `DROP_FAILED_REFUNDED`/`DROP_FAILED_NO_CHARGE` rather than
   * reusing them, because the two events are not the same claim: `FAILED` reports a
   * shortfall and `CANCELLED` reports a decision. A diner on a drop that had thirty
   * orders and was called off must not be told it failed to reach its minimum —
   * that would be a false statement about demand, attached to a true statement about
   * their money, in the one message they will re-read when looking for the refund.
   *
   * Which of the two a participant gets is decided by whether an `Order` row exists,
   * the same `hadCaptures` discriminator the public page uses.
   */
  | {
      readonly kind: 'DROP_CANCELLED_REFUNDED';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly chargedCents: number;
      readonly qty: number;
    }
  | {
      readonly kind: 'DROP_CANCELLED_NO_CHARGE';
      readonly dropId: string;
      readonly participantId: string;
      readonly phone: string;
      readonly qty: number;
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

/**
 * Hand a batch to a port and record that it was sent — the **one** place that does
 * either. Every caller of `NotifyPort` in this codebase must go through it.
 *
 * ## The defect it exists to prevent, measured twice
 *
 * `notification.intent` used to be emitted only *by a port*: `noopNotifyPort` counts,
 * and `composingNotifyPort` logs one line per batch **in `dryRun` only**
 * (`compose-port.ts:113-121`). Production wires `composingNotifyPort` with a live
 * sender and `dryRun` off — it sends the messages and logs **nothing**. Measured on
 * that shape, before this helper existed:
 *
 *   | path | real port | noop port |
 *   |---|---|---|
 *   | `settle` capture | **0** | 1 |
 *   | `settle` fail (tolerance) | **0** | 1 |
 *   | `run-tick` phase 8 (threshold) | 1 | **2** |
 *   | `drops/cancel.ts` | **0** | 1 |
 *   | `admin/force-fail.ts` | **0** | 1 |
 *
 * The first three rows were fixed by inlining this logic in settlement's private
 * `deliver`. That fix was **not durable**: the same defect was still present at the two
 * cancel sites, and re-measuring after the settle fix showed `delivered=1`,
 * `notification.intent` lines **0** for both — confirmed against a real drop with a
 * real `composingNotifyPort`-shaped silent port, not inferred from reading the code.
 *
 * So the logic lives here, next to the interface it belongs to, and the cell that
 * matters is the **real-port column**: a settled, cancelled or force-failed drop has
 * told real diners real news and the log must say so whether or not the configured
 * port happens to log.
 *
 * ## Why `deliver`-time and not port-time
 *
 * The record is a property of **who called**, not of whether a message was sent. A port
 * is deployment configuration — swapped for a fake in tests, for a logging no-op when no
 * provider is configured, for a live sender in production — and the obligation to
 * record cannot depend on which one is installed. Putting it in the port also makes it
 * impossible to test: the test would assert against the same object that produces the
 * line.
 *
 * ## Grouped, never per participant
 *
 * Keyed `${kind}:${dropId}`, so a drop that both captured some diners and failed the rest
 * writes two lines rather than one per diner, and two different drops never merge. The
 * values are real ids — an earlier `run-tick` draft logged `dropId: 'tick'`, which sends
 * an operator looking for a drop that does not exist.
 *
 * ## No line on a throw
 *
 * A failed send returns early after logging `notification.failed`. Reporting a message
 * as sent that was not is the same class of lie in the other direction, and it is what
 * `run-tick` phase 8's `continue` exists to prevent.
 *
 * ## The known cost
 *
 * `noopNotifyPort` counts for its own reasons, so with a noop port each batch is
 * recorded twice. That is accepted: a noop port is not a shipped configuration — every
 * production route injects `composingNotifyPort` — and a duplicate line in a test is
 * cheaper than a silent one in production. The alternative, teaching this function which
 * ports log, would put port identity into the contract to save a line nobody reads twice.
 *
 * Counts and ids only: the intent carries a phone number and a bearer token, neither of
 * which may reach a log (§11.7).
 */
export async function deliver(
  notify: NotifyPort,
  intents: readonly NotifyIntent[],
  /**
   * The merchant's zone, so a message can name a pickup window or a cutoff in the
   * kitchen's local time. Supplied here because this is the layer that holds the
   * locked drop — the port cannot know it, and an intent is an event, not a place.
   */
  timeZone?: string,
): Promise<void> {
  if (intents.length === 0) {
    return;
  }

  const byKind = new Map<string, { kind: string; dropId: string; count: number }>();
  for (const intent of intents) {
    const key = `${intent.kind}:${intent.dropId}`;
    const existing = byKind.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKind.set(key, { kind: intent.kind, dropId: intent.dropId, count: 1 });
    }
  }

  try {
    await notify.notify(intents, timeZone ? { timeZone } : {});
  } catch (error) {
    logger.warn('notification.failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return;
  }

  for (const { kind, dropId, count } of byKind.values()) {
    logger.info('notification.intent', { kind, dropId, count });
  }
}
