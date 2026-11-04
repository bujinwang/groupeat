import { Card } from '@/components/ui/Card';
import { PickupForm } from '@/components/merchant/PickupForm';
import { DigestConsentForm } from '@/components/merchant/DigestConsentForm';
import { floorWarningCopy } from '@/lib/copy/guardrail-copy';
import { requireMerchant } from '@/lib/auth/authorize';
import { digestSettingsFor } from '@/lib/db/digest';
import { highestMenuPriceCents } from '@/lib/db/items';
import { getMerchant } from '@/lib/db/merchants';
import { FLOOR_WARN_THRESHOLD, formatCents, roundHalfUp } from '@/lib/guardrail';

/**
 * `/merchant/settings` — minimum margin (read-only here) and pickup details
 * (editable, FR-103).
 *
 * Two product rules are enforced by what this page *does not* do:
 *
 *   1. **The floor is not editable here.** Q-4: a merchant who lowers their floor
 *      to "make the deal work" has defeated the guardrail. The only path to a
 *      lower floor is the INFEASIBLE escape hatch or their GroupEat contact,
 *      behind a confirmation that names the consequence. Raising it is safe and
 *      allowed, but it is not offered on this screen either — this page states
 *      the number, it does not invite editing it.
 *   2. **The warning appears only here, and only under 15%.** It must never
 *      appear on first login, on the dish screen, in the panel, as a modal, a
 *      toast or an email — a warning shown before the merchant has a reason to
 *      care teaches them to dismiss warnings.
 *
 * Pickup is the exception to the read-only rule, and it is a different resource
 * on a different route (`PATCH /api/merchant/pickup`) precisely so that editing
 * an address cannot carry a floor change along with it.
 *
 * ## FR-704's consent lives here, and only owners see the control
 *
 * The weekly digest is a preference, not a money field, so it belongs on the page a
 * merchant visits to change their account's behaviour. The form is rendered only when
 * the membership row says OWNER; a manager sees the rule in words instead. The role is
 * re-read in the action rather than trusted from this render — a server action is a
 * public endpoint, and "the button was only shown to owners" is not a gate.
 */

export const dynamic = 'force-dynamic';

export default async function MerchantSettingsPage() {
  const { session, merchantIds } = await requireMerchant();
  const merchantId = merchantIds[0];

  if (!merchantId) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  const [merchant, highest, digest] = await Promise.all([
    getMerchant(merchantId),
    highestMenuPriceCents(merchantIds),
    digestSettingsFor({ merchantId, userId: session.userId }),
  ]);

  if (!merchant) {
    return <p className="text-sm text-ink-soft">No merchant is attached to this account.</p>;
  }

  // PRD-sprint1 §5.1: the example uses the merchant's own highest-priced dish, and
  // falls back to $16.00 only when they have none.
  const exampleMenuPriceCents = highest ?? 1600;
  const floorCents = roundHalfUp(exampleMenuPriceCents * merchant.floorPctOfMenu);
  const floorPercent = roundHalfUp(merchant.floorPctOfMenu * 100);
  const isThin = merchant.floorPctOfMenu < FLOOR_WARN_THRESHOLD;
  const warning = isThin ? floorWarningCopy({ pct: merchant.floorPctOfMenu, menuPriceCents: exampleMenuPriceCents }) : null;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card>
        <h2 className="text-sm font-semibold">Your minimum margin</h2>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{floorPercent}%</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          The least you&apos;ll accept per plate on a batch order, as a share of your menu price. At{' '}
          {floorPercent}%, a {formatCents(exampleMenuPriceCents)} dish must leave you at least{' '}
          {formatCents(floorCents)} per plate.
        </p>

        {warning ? (
          <div className="mt-4 rounded-lg border border-thin/30 bg-thin/5 p-3">
            <p className="text-sm font-medium text-thin">{warning.headline}</p>
            {warning.body.map((line) => (
              <p key={line} className="mt-1 text-sm leading-relaxed text-ink-soft">
                {line}
              </p>
            ))}
          </div>
        ) : null}

        <p className="mt-4 text-xs leading-relaxed text-ink-soft">
          This is not editable here. Moving it either way goes through your GroupEat contact — that
          is deliberate, so the number cannot drift while you are pricing a deal. If a dish cannot be
          a deal at your minimum, the dish screen explains the two ways out.
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Pickup</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Shown on every deal page, so a diner can find you without asking.
        </p>
        <div className="mt-3">
          <PickupForm
            initialAddress={merchant.pickupAddress}
            initialInstructions={merchant.pickupInstructions}
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Weekly email</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          A short Monday summary of the week that closed. Sent only to owners who ask
          for it, and only while the box below is ticked.
        </p>
        <div className="mt-3">
          {digest?.role === 'OWNER' ? (
            <DigestConsentForm initialOptIn={digest.digestOptIn} />
          ) : (
            // FR-704's acceptance is about owners. A manager or staff member can see
            // that the digest exists, but the box is an owner decision; rendering a
            // disabled checkbox would still read as "you could change this if you
            // clicked harder", so the sentence explains the rule instead.
            <p className="text-sm leading-relaxed text-ink-soft">
              Only an owner can change this setting.
              {digest?.digestOptIn ? ' The weekly digest is currently on.' : ' The weekly digest is currently off.'}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
