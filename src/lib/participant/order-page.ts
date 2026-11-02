import { prisma } from '@/lib/db/prisma';
import { formatCents } from '@/lib/guardrail';
import { logger } from '@/lib/logging/logger';
import { phoneLast4 } from '@/lib/redemption/rules';

import { signParticipantAccess, verifyParticipantAccess } from './access';
import { type OrderView, resolveOrderView } from './order-view';

/**
 * Reading one diner's order — the only unauthenticated read of a participant row.
 *
 * ## Scope comes from the token, not from the query
 *
 * The caller supplies `(publicCode, token)`. The token names a participant and a
 * drop; both are checked against the row that is then loaded, and a mismatch is a
 * 404 rather than a 403. That ordering matters: if this module loaded the
 * participant *then* checked the drop, a stolen token would work across drops for
 * any participant id an attacker could guess. `verify` first, then a single query
 * whose `where` includes both ids.
 *
 * ## What is not selected
 *
 * No phone, no email, no card, no payment intent, no customer id. Only the four
 * things the page renders: the quantity, the plates collected, the code's *existence*
 * (read as `redemptionCode` but never returned unless `resolveOrderView` says so),
 * and the drop's window and title. The phone is selected solely to compute its last
 * four digits, in this function, and then dropped — the same minimisation
 * `manifest.ts` uses for the staff screen, applied to the diner's own view.
 */

export type OrderPage = {
  readonly view: OrderView;
  readonly drop: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: string;
  };
  readonly pickup: {
    readonly merchantName: string;
    readonly address: string | null;
    readonly instructions: string | null;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly timeZone: string;
  };
  readonly qty: number;
  readonly phoneLast4: string;
  readonly amountLabel: string;
  readonly minQty: number;
};

/**
 * `null` for every failure — a bad token, a drop that does not match, a participant
 * that no longer exists.
 *
 * The page has exactly one thing to do with a failure (render "this link is not
 * valid"), and a discriminated result would tempt a caller into distinguishing
 * "wrong drop" from "bad signature", which is exactly the oracle an attacker wants.
 */
export async function loadOrderPage(
  publicCode: string,
  token: string,
  now: Date,
): Promise<OrderPage | null> {
  const payload = verifyParticipantAccess(token);
  if (!payload) {
    return null;
  }

  const row = await prisma.dropParticipant.findFirst({
    where: {
      id: payload.participantId,
      dropId: payload.dropId,
      drop: { publicCode },
    },
    select: {
      id: true,
      qty: true,
      redeemedQty: true,
      authStatus: true,
      chargeStatus: true,
      amountCents: true,
      redemptionCode: true,
      customer: { select: { phone: true } },
      drop: {
        select: {
          id: true,
          publicCode: true,
          title: true,
          status: true,
          minQty: true,
          windowStart: true,
          windowEnd: true,
          cutoffAt: true,
          merchant: {
            select: {
              name: true,
              timezone: true,
              pickupAddress: true,
              pickupInstructions: true,
            },
          },
          participants: {
            where: { authStatus: 'AUTHORIZED' },
            select: { qty: true },
          },
        },
      },
    },
  });

  if (!row) {
    return null;
  }

  const joinedQty = row.drop.participants.reduce((sum, p) => sum + p.qty, 0);

  const view = resolveOrderView({
    dropStatus: row.drop.status,
    chargeStatus: row.chargeStatus,
    authStatus: row.authStatus,
    qty: row.qty,
    redeemedQty: row.redeemedQty,
    redemptionCode: row.redemptionCode,
    windowStart: row.drop.windowStart,
    windowEnd: row.drop.windowEnd,
    now,
    minQty: row.drop.minQty,
    joinedQty,
  });

  return {
    view,
    drop: {
      publicCode: row.drop.publicCode,
      title: row.drop.title,
      status: row.drop.status,
    },
    pickup: {
      merchantName: row.drop.merchant.name,
      address: row.drop.merchant.pickupAddress,
      instructions: row.drop.merchant.pickupInstructions,
      windowStart: row.drop.windowStart,
      windowEnd: row.drop.windowEnd,
      timeZone: row.drop.merchant.timezone,
    },
    qty: row.qty,
    phoneLast4: phoneLast4(row.customer.phone),
    // Formatted by the one money formatter, not by `(cents / 100).toFixed(2)`. A
    // second rounding rule is a second answer on a boundary, and this project has
    // already been bitten by exactly that (CONTRIBUTING.md: money is a type
    // signature). Same helper as the join path, so the figure a diner was shown
    // when they joined and the figure here cannot disagree.
    amountLabel: formatCents(row.amountCents),
    minQty: row.drop.minQty,
  };
}

/**
 * The absolute URL a notification links to.
 *
 * Takes the participant **id**, not the row, because the token is derived from ids
 * alone — which is what makes the same link reproducible from the job that sends it
 * and from any later re-send, without storing a token anywhere.
 *
 * `baseUrl` is passed in rather than read from env: this module is used by a job
 * that may run behind a proxy, and the origin that ends up in a diner's SMS has to
 * be the public one, which only the caller knows. A hardcoded origin is the classic
 * way a link lands on `localhost` in production.
 */
export function orderUrl(args: {
  baseUrl: string;
  publicCode: string;
  participantId: string;
  dropId: string;
}): string {
  const token = signParticipantAccess({
    participantId: args.participantId,
    dropId: args.dropId,
  });
  const base = args.baseUrl.replace(/\/+$/, '');
  return `${base}/d/${encodeURIComponent(args.publicCode)}/mine?t=${encodeURIComponent(token)}`;
}

/** Logged when a token fails to verify, so a wave of them is visible. */
export function logInvalidToken(publicCode: string): void {
  logger.warn('participant.order_link_invalid', { publicCode });
}
