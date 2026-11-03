import { prisma } from '@/lib/db/prisma';

import { refusalFor } from '@/lib/refunds/participant-refund';

/**
 * FR-903's missing half — one drop, with the participants an operator can refund.
 *
 * > `FR-903 | Issue a partial refund on one participant | Ledger adjusted; Stripe
 * > refund created` — PRD-v1.md:550
 *
 * ## Why this is a separate module from `admin-drops.ts`
 *
 * Same reason `admin-drops.ts` is separate from `db/drops.ts`: a different question.
 * The list asks "which drops need attention" and reads one row per drop; this asks
 * "who is in this drop and can I refund them" and reads every participant. Merging
 * them would put a per-participant join behind every list row, and a 100-row page
 * would load a few thousand participant records it never renders.
 *
 * ## Why eligibility is computed here rather than in the page or the component
 *
 * It is not computed here — it is **called** here. `refusalFor` from
 * `refunds/participant-refund.ts` is the same function `issueParticipantRefund`
 * refuses by, so a row cannot render a refund button the service would reject. A
 * second predicate in the UI (`chargeStatus === 'CAPTURED'` and nothing else) would
 * look right and would offer a button on a drop whose status forbids it — the
 * mistake FR-901's `FORCE_FAILABLE` export was built to prevent, one slice earlier.
 *
 * The corollary is that this module imports the refund service, which imports
 * `lib/db/prisma` and `lib/audit/log` — but reaches no provider. Nothing here can
 * move money; it only asks whether money could be moved.
 *
 * ## Why the reason is a sentence and not a boolean
 *
 * `refusalFor` returns an `AppError` whose `publicMessage` is written for an
 * operator: *"That drop has not finished settling yet, so its charges cannot be
 * refunded."* A `canRefund: false` would force the UI to invent its own explanation,
 * and the two would drift the first time a guard was added. The row carries the
 * sentence the server would have thrown, so a greyed-out button explains itself.
 */

export type AdminParticipantRow = {
  readonly id: string;
  readonly qty: number;
  readonly chargeStatus: string;
  /** What this participant was authorised for, in cents. */
  readonly amountCents: number;
  /** What has already been returned against their order. */
  readonly refundedCents: number;
  /** `null` before a capture. A participant with no order has nothing to refund. */
  readonly capturedCents: number | null;
  readonly platformFeeCents: number | null;
  /** Last four of the customer's phone, so an operator can identify a diner out loud. */
  readonly phoneHint: string;
  readonly joinedAt: Date;
  readonly redeemedQty: number;
  /** `null` when the refund may proceed; otherwise the sentence the server would throw. */
  readonly refusal: string | null;
};

export type AdminDropDetail = {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantTimezone: string;
  readonly dealPriceCents: number;
  readonly minQty: number;
  readonly maxQty: number;
  readonly joinedQty: number;
  readonly cutoffAt: Date;
  readonly createdAt: Date;
  readonly participants: readonly AdminParticipantRow[];
  /** Money still out there across refundable orders. */
  readonly capturedCents: number;
  readonly refundedCents: number;
  /** How many rows a refund may be issued against right now. */
  readonly refundableCount: number;
};

/**
 * The phone's last four only.
 *
 * A full number on an admin list is a privacy liability with no operational benefit:
 * the operator is identifying a diner they are already talking to, not dialling them.
 * The `Customer` row keeps the real number; this projection never leaves it.
 */
function phoneHint(phone: string | null): string {
  if (!phone) {
    return '—';
  }
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `···${digits.slice(-4)}` : '—';
}

/**
 * Loads one drop and every participant on it, or `null` when no such drop exists.
 *
 * Returns `null` rather than throwing: the caller is a server component that has to
 * render a 404 page, and an `AppError` for a missing row is the route convention, not
 * the page's. `requireAdmin` has already run by the time this is called.
 */
export async function loadAdminDropDetail(id: string): Promise<AdminDropDetail | null> {
  const drop = await prisma.drop.findUnique({
    where: { id },
    select: {
      id: true,
      publicCode: true,
      title: true,
      status: true,
      merchantId: true,
      dealPriceCents: true,
      minQty: true,
      maxQty: true,
      cutoffAt: true,
      createdAt: true,
      merchant: { select: { name: true, timezone: true, stripeAccountId: true } },
      participants: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          qty: true,
          amountCents: true,
          chargeStatus: true,
          createdAt: true,
          redeemedQty: true,
          customer: { select: { phone: true } },
          order: {
            select: {
              id: true,
              subtotalCents: true,
              platformFeeCents: true,
              stripeChargeId: true,
              refundedCents: true,
            },
          },
        },
      },
    },
  });

  if (!drop) {
    return null;
  }

  let capturedCents = 0;
  let refundedCents = 0;
  let refundableCount = 0;

  const participants: AdminParticipantRow[] = drop.participants.map((participant) => {
    const order = participant.order;
    const stillOutThere = order ? order.subtotalCents - order.refundedCents : null;

    if (order) {
      capturedCents += stillOutThere ?? 0;
      refundedCents += order.refundedCents;
    }

    // The `RefundableParticipant` shape `refusalFor` reads. Built explicitly rather
    // than spread, so a schema change here is a compile error at the one place that
    // has to keep up with it.
    const refusal = refusalFor({
      id: participant.id,
      dropId: drop.id,
      qty: participant.qty,
      amountCents: participant.amountCents,
      chargeStatus: participant.chargeStatus,
      dropStatus: drop.status,
      stripeAccountId: drop.merchant.stripeAccountId,
      order: order
        ? {
            id: order.id,
            subtotalCents: order.subtotalCents,
            platformFeeCents: order.platformFeeCents,
            stripeChargeId: order.stripeChargeId,
            refundedCents: order.refundedCents,
          }
        : null,
    });

    if (refusal === null) {
      refundableCount += 1;
    }

    return {
      id: participant.id,
      qty: participant.qty,
      chargeStatus: participant.chargeStatus,
      amountCents: participant.amountCents,
      refundedCents: order?.refundedCents ?? 0,
      capturedCents: stillOutThere,
      platformFeeCents: order?.platformFeeCents ?? null,
      phoneHint: phoneHint(participant.customer.phone),
      joinedAt: participant.createdAt,
      redeemedQty: participant.redeemedQty,
      refusal: refusal?.publicMessage ?? null,
    };
  });

  return {
    id: drop.id,
    publicCode: drop.publicCode,
    title: drop.title,
    status: drop.status,
    merchantId: drop.merchantId,
    merchantName: drop.merchant.name,
    merchantTimezone: drop.merchant.timezone,
    dealPriceCents: drop.dealPriceCents,
    minQty: drop.minQty,
    maxQty: drop.maxQty,
    joinedQty: drop.participants.reduce((total, participant) => total + participant.qty, 0),
    cutoffAt: drop.cutoffAt,
    createdAt: drop.createdAt,
    participants,
    capturedCents,
    refundedCents,
    refundableCount,
  };
}
