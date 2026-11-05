import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AddMerchantMemberForm } from '@/components/admin/AddMerchantMemberForm';
import { FloorEditor } from '@/components/admin/FloorEditor';
import { ImpersonateControl } from '@/components/admin/ImpersonateControl';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { getMerchant, listMerchantMembers } from '@/lib/db/merchants';
import { countDraftsForMerchant } from '@/lib/db/admin-ai-drafts';
import { highestMenuPriceCents, listItems } from '@/lib/db/items';
import { evaluateItem } from '@/lib/items/evaluate';
import { formatCents } from '@/lib/guardrail';
import { panelCopy } from '@/lib/copy/guardrail-copy';
import { ineligibleCopy } from '@/lib/copy/guardrail-copy';

/**
 * `/admin/merchants/:id` — pickup details, the minimum-margin editor, a
 * read-only view of each dish's evaluation (US-A2), and FR-904's way into a
 * merchant's own view.
 *
 * The floor editor is the admin's job, not the merchant's: PRD-sprint1 Q-4 keeps
 * it out of the merchant's first session so a merchant cannot lower the floor to
 * "make the deal work".
 *
 * ## Why impersonation starts from this page and not the users list
 *
 * The admin arrives here knowing *which merchant* has the problem, usually because the
 * merchant told them. The control lists that merchant's people, so the choice is between
 * the accounts that could actually be on the phone instead of every user in the system.
 */

export const dynamic = 'force-dynamic';

export default async function AdminMerchantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const merchant = await getMerchant(id);
  if (!merchant) {
    notFound();
  }

  const merchantIds = [merchant.id];
  const [items, highest, members, draftCount] = await Promise.all([
    listItems(merchantIds),
    highestMenuPriceCents(merchantIds),
    listMerchantMembers(merchant.id),
    countDraftsForMerchant(merchant.id),
  ]);

  // PRD-sprint1 §5.1: the dollar example uses the merchant's own highest-priced
  // dish, and falls back to $16.00 only when they have none.
  const exampleMenuPriceCents = highest ?? 1600;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/users" className="text-sm text-ink-soft underline underline-offset-4">
          ← Users
        </Link>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">{merchant.name}</h1>
          <Badge tone={merchant.status === 'ACTIVE' ? 'ok' : 'neutral'}>{merchant.status}</Badge>
        </div>
        <p className="text-xs text-ink-soft">/{merchant.slug}</p>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        <FloorEditor
          merchantId={merchant.id}
          floorPctOfMenu={merchant.floorPctOfMenu}
          pickupAddress={merchant.pickupAddress}
          pickupInstructions={merchant.pickupInstructions}
          exampleMenuPriceCents={exampleMenuPriceCents}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">People</h2>
        <p className="mb-3 text-xs leading-relaxed text-ink-soft">
          Staff can scan and redeem; managers can run the merchant surface; owners can
          also change this list. Accounts are created on the Users page first.
        </p>
        <ul className="mb-4 space-y-1">
          {members.map((member) => (
            <li key={member.merchantUserId} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{member.email}</span>
              <Badge tone={member.role === 'STAFF' ? 'neutral' : 'ok'}>{member.role}</Badge>
            </li>
          ))}
        </ul>
        {members.length === 0 ? (
          <p className="mb-4 text-sm text-ink-soft">Nobody is attached to this merchant yet.</p>
        ) : null}
        <AddMerchantMemberForm merchantId={merchant.id} />
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">View as this merchant</h2>
        <ImpersonateControl
          merchantId={merchant.id}
          candidates={members.map((member) => ({
            merchantUserId: member.merchantUserId,
            email: member.email,
            name: member.name,
            role: member.role,
          }))}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">AI runs</h2>
        <p className="mb-2 text-xs leading-relaxed text-ink-soft">
          {/* FR-905 exists for exactly this conversation: a merchant phones about the
              wording or the price they were given, and the answer is in the row. */}
          What the deal builder proposed for this merchant, with the guardrail inputs that
          produced it.
        </p>
        <Link
          href={`/admin/ai-drafts?merchantId=${merchant.id}`}
          className="text-xs font-medium underline underline-offset-2 hover:text-brand"
        >
          {draftCount === 0
            ? 'No runs yet — open the list'
            : `Open ${draftCount} ${draftCount === 1 ? 'run' : 'runs'}`}
        </Link>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Dishes ({items.length})</h2>
        <ul className="space-y-2">
          {items.map((item) => {
            const evaluation = evaluateItem({ item, floorPctOfMenu: merchant.floorPctOfMenu });
            const copy = evaluation.ineligible
              ? ineligibleCopy(evaluation.ineligible)
              : panelCopy(evaluation.state, evaluation.view);
            const lowest = evaluation.view?.minViablePriceCents ?? null;

            return (
              <Card as="li" key={item.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium">{item.name}</p>
                  <span className="shrink-0 text-sm">{formatCents(item.menuPriceCents)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {lowest === null
                    ? copy.headline
                    : `Lowest deal price ${formatCents(lowest)}`}
                </p>
              </Card>
            );
          })}
        </ul>
        {items.length === 0 ? (
          <p className="text-sm text-ink-soft">This merchant has no dishes yet.</p>
        ) : null}
      </section>
    </div>
  );
}
