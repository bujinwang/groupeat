import { emit } from './events';
import type { FunnelEvent } from './funnel';

/**
 * Writes a funnel event produced by `./funnel.ts`.
 *
 * The split exists because the two halves answer different questions. `funnel.ts`
 * decides *what happened* — pure, testable, no filesystem. This decides *what to
 * do when recording it fails*, which is the same answer everywhere: nothing.
 * Analytics has never been allowed to fail a diner's tap or a merchant's save, so
 * a sink error is logged by `emit` and swallowed here rather than propagated.
 *
 * `null` is accepted because several builders return it to mean "this did not
 * happen" (`thresholdReached` on a drop that did not cross). Callers pass the
 * result straight through without an `if`, which is the point: a nullable return
 * that the caller must unwrap invites the caller to invent a default event.
 */
export function record(event: FunnelEvent | null): void {
  if (!event) return;
  emit(event.event, event.payload);
}
