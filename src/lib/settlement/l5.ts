/**
 * L5 — the two-account reconciliation (ADR-004 §3.2).
 *
 * > L5: `Σ CHARGE + Σ REFUND + Σ card fees == connected-account balance delta`;
 * > and `Σ PLATFORM_FEE + Σ ADJUSTMENT == Σ application_fee`
 *
 * Pure: every amount arrives as an argument, no Stripe and no clock. The provider
 * read lives in `l5-port.ts`; this file is the arithmetic and the refusal.
 *
 * ## Why the card fee is an input, not a recomputation
 *
 * `cardFeeAt()` is our model of Stripe's fee. L5 must compare against the fee Stripe
 * actually reported, because the two differ on multi-unit charges — the model charges
 * the 30¢ fixed component once per *order*, Stripe charges it once per *charge*, which
 * is the same thing here, but the percentage rounding still belongs to Stripe. ADR-004
 * §6.1 says a nightly job that recomputes the fee will page someone for a rounding
 * model. So `feeCents` comes from the balance transaction and is signed the way Stripe
 * reports it (negative on a charge).
 *
 * ## Why the account is derived and not a column
 *
 * ADR-004's open item asked for a field naming each entry's account before this job was
 * written. Under ADR-001's direct charges the mapping is total and fixed by type:
 * `CHARGE`/`REFUND` are connected-account events, `PLATFORM_FEE`/`ADJUSTMENT` are
 * platform events. A column would duplicate that function and could disagree with it;
 * the job derives it here, once, and the tests pin the mapping.
 */

export type L5EntryType =
  | 'CHARGE'
  | 'REFUND'
  | 'PLATFORM_FEE'
  | 'ORGANISER_COMMISSION'
  | 'ADJUSTMENT';

export type L5LedgerEntry = {
  readonly type: L5EntryType;
  /** Signed: CHARGE positive, REFUND/ADJUSTMENT negative. */
  readonly amountCents: number;
};

/** One Stripe balance transaction, connected account. `feeCents` is signed. */
export type ConnectedBalanceLine = {
  readonly id: string;
  readonly kind: 'charge' | 'refund';
  readonly amountCents: number;
  readonly feeCents: number;
};

/** One `application_fee` balance transaction, platform account. */
export type PlatformBalanceLine = {
  readonly id: string;
  readonly kind: 'application_fee';
  readonly amountCents: number;
};

export type L5Check = {
  readonly name: 'CONNECTED_BALANCE' | 'PLATFORM_APPLICATION_FEES';
  readonly ok: boolean;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly differenceCents: number;
};

export type L5Result = {
  readonly ok: boolean;
  readonly checks: readonly L5Check[];
  /** The connected-account total of our entries, before Stripe's fee. */
  readonly ledgerConnectedCents: number;
  /** The platform total of our entries, net of reversals. */
  readonly ledgerPlatformCents: number;
  /** Σ Stripe's signed card fees on the connected account. */
  readonly stripeFeeCents: number;
};

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function check(args: {
  name: L5Check['name'];
  expectedCents: number;
  actualCents: number;
}): L5Check {
  const differenceCents = args.expectedCents - args.actualCents;
  return {
    name: args.name,
    ok: differenceCents === 0,
    expectedCents: args.expectedCents,
    actualCents: args.actualCents,
    differenceCents,
  };
}

/**
 * The two L5 identities for one drop.
 *
 * `connected` must contain the charge and refund balance transactions attributable to
 * this drop; `platform` the application-fee transactions. A line from another drop is
 * the caller's bug and will show up as a difference, which is why the service scopes
 * the read by the drop's own charge and refund ids.
 */
export function reconcileL5(args: {
  entries: readonly L5LedgerEntry[];
  connected: readonly ConnectedBalanceLine[];
  platform: readonly PlatformBalanceLine[];
}): L5Result {
  const ledgerConnectedCents = sum(
    args.entries
      .filter((entry) => entry.type === 'CHARGE' || entry.type === 'REFUND')
      .map((entry) => entry.amountCents),
  );
  const ledgerPlatformCents = sum(
    args.entries
      .filter((entry) => entry.type === 'PLATFORM_FEE' || entry.type === 'ADJUSTMENT')
      .map((entry) => entry.amountCents),
  );

  const stripeFeeCents = sum(args.connected.map((line) => line.feeCents));
  const connectedActual = sum(args.connected.map((line) => line.amountCents + line.feeCents));
  const platformActual = sum(args.platform.map((line) => line.amountCents));

  const checks: L5Check[] = [
    check({
      name: 'CONNECTED_BALANCE',
      // What our entries plus Stripe's own fee say the merchant's balance moved by.
      expectedCents: ledgerConnectedCents + stripeFeeCents,
      actualCents: connectedActual,
    }),
    check({
      name: 'PLATFORM_APPLICATION_FEES',
      expectedCents: ledgerPlatformCents,
      actualCents: platformActual,
    }),
  ];

  return {
    ok: checks.every((entry) => entry.ok),
    checks,
    ledgerConnectedCents,
    ledgerPlatformCents,
    stripeFeeCents,
  };
}
