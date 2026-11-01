'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/Button';

/**
 * FR-102 — "Set up payouts", the button that leaves the app.
 *
 * Two states that matter:
 *   - the click **navigates**, so the button must show pending while it does;
 *   - a 503 (`STRIPE_NOT_CONFIGURED`) is an operational fact and gets a plain
 *     sentence, not "something went wrong" — a merchant who reads that will
 *     email support about a broken product rather than a missing key.
 */

type StartState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'error'; message: string };

export function StartOnboardingButton({
  label,
  returnState,
}: {
  label: string;
  /** `return` or `refresh`, so the page can explain what just happened. */
  returnState: 'return' | 'refresh' | 'start';
}) {
  const [state, setState] = useState<StartState>({ kind: 'idle' });

  async function start(): Promise<void> {
    setState({ kind: 'starting' });
    try {
      const response = await fetch('/api/merchant/stripe/onboard', { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'We could not start payout setup. Try again.';
        setState({ kind: 'error', message });
        return;
      }

      const url =
        body && typeof body === 'object' && 'url' in body
          ? String((body as { url?: string }).url)
          : null;

      if (!url) {
        setState({ kind: 'error', message: 'Stripe did not return a setup link. Try again.' });
        return;
      }

      // Full navigation, not a fetch: Stripe hosts the flow.
      window.location.assign(url);
    } catch {
      setState({
        kind: 'error',
        message: 'We could not reach the server. Check your connection and try again.',
      });
    }
  }

  const verb =
    returnState === 'start'
      ? label
      : returnState === 'refresh'
        ? 'Start again'
        : 'Continue payout setup';

  return (
    <div className="space-y-3">
      <Button onClick={() => void start()} disabled={state.kind === 'starting'}>
        {state.kind === 'starting' ? 'Opening Stripe…' : verb}
      </Button>
      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-blocked">
          {state.message}
        </p>
      ) : null}
      <p className="text-xs leading-relaxed text-ink-soft">
        You&apos;ll finish this on Stripe&apos;s site. GroupEat never sees your bank details.
      </p>
    </div>
  );
}
