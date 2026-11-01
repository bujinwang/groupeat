import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { StartOnboardingButton } from '@/components/merchant/StartOnboardingButton';
import { requireMerchant } from '@/lib/auth/authorize';
import { primaryMerchantId } from '@/lib/db/items';
import { getMerchant } from '@/lib/db/merchants';
import { onboardingMessage, type OnboardingAssessment } from '@/lib/payments/onboarding';
import { readOnboarding, syncOnboarding } from '@/lib/payments/onboarding-service';

/**
 * `/merchant/payouts` — FR-102's merchant-facing surface.
 *
 * ## The `?state=return` decision, and why it does not write
 *
 * When Stripe sends the merchant back, the page **does** re-read Stripe and
 * persist the result (`syncOnboarding`), because that is the only way the screen
 * they land on can tell the truth. But that is gated on the explicit `state`
 * query parameter, not on every render.
 *
 * So: an ordinary visit to `/merchant/payouts` is a pure read, and only a return
 * from Stripe writes. A page that flips `Merchant.status` on every anonymous GET
 * makes a status change impossible to attribute later.
 *
 * The webhook is still the authority. This page is the fast path, and it degrades
 * to a stale-but-honest read if the webhook is late.
 */

export const dynamic = 'force-dynamic';

const STATE_TONE: Record<
  OnboardingAssessment['state'],
  { label: string; tone: 'ok' | 'thin' | 'blocked' | 'neutral' }
> = {
  NOT_STARTED: { label: 'Not set up', tone: 'neutral' },
  INCOMPLETE: { label: 'Incomplete', tone: 'thin' },
  ACTION_REQUIRED: { label: 'Stripe needs something', tone: 'blocked' },
  RESTRICTED: { label: 'Paused', tone: 'blocked' },
  READY: { label: 'Ready', tone: 'ok' },
};

export default async function MerchantPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { merchantIds } = await requireMerchant();
  const merchantId = await primaryMerchantId(merchantIds);
  const merchant = await getMerchant(merchantId);

  if (!merchant) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  const params = await searchParams;
  const returnedFromStripe = params.state === 'return' || params.state === 'refresh';

  // Only a return from Stripe writes. `syncOnboarding` re-reads Stripe first, so
  // a stale webhook cannot leave the merchant looking at the wrong answer.
  const assessment = returnedFromStripe
    ? await syncOnboarding({ merchantId }).catch(() => null)
    : await readOnboarding({ merchantId }).catch(() => null);

  const tone = assessment ? STATE_TONE[assessment.state] : STATE_TONE.NOT_STARTED;
  const ready = assessment?.state === 'READY';

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Payouts</h1>

      {returnedFromStripe && !assessment ? (
        // The Stripe read failed (network, bad key). Say so rather than implying
        // "not set up", which would send the merchant round the loop again.
        <Card>
          <p className="text-sm text-blocked">
            We could not reach Stripe to check your status. Your setup is not lost — reload this
            page in a moment.
          </p>
        </Card>
      ) : null}

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{merchant.name}</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              {assessment
                ? onboardingMessage(assessment)
                : 'Checking your payout status…'}
            </p>
          </div>
          <Badge tone={tone.tone}>{tone.label}</Badge>
        </div>

        {ready ? (
          <p className="mt-4 rounded-lg border border-ok/30 bg-ok/5 p-3 text-sm leading-relaxed text-ink">
            Payouts are working. You can run a deal.
          </p>
        ) : (
          <div className="mt-4">
            <StartOnboardingButton
              label="Set up payouts"
              returnState={returnedFromStripe ? 'return' : 'start'}
            />
          </div>
        )}

        {assessment && assessment.outstandingRequirements.length > 0 ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-surface-muted p-3">
            <p className="text-xs font-medium text-ink">Stripe is waiting on:</p>
            <ul className="mt-1 space-y-0.5">
              {assessment.outstandingRequirements.map((requirement) => (
                <li key={requirement} className="text-xs text-ink-soft">
                  {requirement}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-ink-soft">
              These open on Stripe&apos;s site when you continue setup.
            </p>
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Why this is needed before a deal</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          A deal authorises each diner&apos;s card at the moment they join, and charges it only if
          enough people join. Money moves from their card to your account directly, which means
          Stripe has to know who you are before any of that can happen.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          You are the seller of record for every deal you run. GroupEat takes a fee; the food, the
          tax and the customer relationship are yours.
        </p>
      </Card>
    </div>
  );
}
