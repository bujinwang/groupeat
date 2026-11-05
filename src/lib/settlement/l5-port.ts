import type { ConnectedBalanceLine, PlatformBalanceLine } from './l5';

/**
 * The provider seam for L5.
 *
 * The reconciliation arithmetic is pure (`l5.ts`); this is the only place it asks
 * Stripe anything. A fake exists so the nightly job's wiring and failure handling can
 * be tested without a key, exactly as `charge-port.ts` does for settlement.
 */
export type L5ReadArgs = {
  readonly stripeAccountId: string;
  readonly chargeIds: readonly string[];
  readonly refundIds: readonly string[];
};

export type L5ProviderLines = {
  readonly connected: readonly ConnectedBalanceLine[];
  readonly platform: readonly PlatformBalanceLine[];
};

export interface L5Port {
  read(args: L5ReadArgs): Promise<L5ProviderLines>;
}

/** A port whose answer the caller supplies. Tests only. */
export function fakeL5Port(read: (args: L5ReadArgs) => Promise<L5ProviderLines>): L5Port {
  return { read };
}
