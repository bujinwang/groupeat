import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { listAdminDrafts } from '@/lib/db/admin-ai-drafts';
import { formatCents } from '@/lib/guardrail';
import { momentLabel } from '@/lib/time/labels';

/**
 * `/admin/ai-drafts` — FR-905, the merchant-complaint screen.
 *
 * > `FR-905 | View raw AI drafts and guardrail results | For debugging merchant
 * > complaints` — PRD-v1.md:552
 *
 * ## Why this is a list and not a search box
 *
 * V1 has 5–15 merchants in one corridor. A search box would be a second thing to build
 * and a second thing to be wrong; the newest 50 rows with the merchant named on each is
 * enough to answer "what did it tell them on Tuesday". A filter arrives with the volume
 * that would justify one.
 *
 * ## What the operator is actually here to see
 *
 * Not the prose. The merchant's complaint is nearly always about a **number** — "it
 * told me to sell at $9" — so each row leads with the lowest deal price the guardrail
 * allowed, then how many proposals were rejected by the copy linter. The prose is on
 * the detail page, where it can be read in full next to the inputs that produced it.
 *
 * ## Why `guardrailPassed` is not a green badge here
 *
 * Because it is `true` for every row by construction (`persistAuditRow` states the
 * reason: nothing unvalidated can reach storage). A tick beside a tautology reads as
 * evidence and is not. The list shows it as the stored value with a footnote; the
 * detail page explains what it does and does not mean.
 */
export const dynamic = 'force-dynamic';

const SURFACE_LABEL: Record<string, string> = {
  merchant_builder: 'Deal builder',
  organiser_assistant: 'Organiser assistant',
};

export default async function AdminDraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ merchantId?: string }>;
}) {
  const query = await searchParams;
  const merchantId = query.merchantId ?? null;
  const drafts = await listAdminDrafts({ merchantId });

  const withRejections = drafts.filter((draft) => draft.rejectionCount > 0).length;
  const merchantName = drafts[0]?.merchantName ?? null;
  // Keyed on the *pointer*, not on the name. Since the row records the merchant's name at
  // write time, a draft whose merchant has been deleted still has a name to show — so
  // counting unnameable rows would undercount exactly the case the banner exists for.
  // `merchantId === null` is `onDelete: SetNull` firing, and means one thing only.
  const orphans = drafts.filter((draft) => draft.merchantId === null).length;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">AI drafts</h1>
        <span className="text-xs text-ink-soft">
          {drafts.length} shown{drafts.length >= 50 ? ' (newest 50)' : ''}
        </span>
      </div>

      {merchantId ? (
        <p role="status" className="rounded-lg border border-thin/40 bg-thin/5 p-2 text-xs text-ink-soft">
          {/* The merchant detail page links here with a filter, so an operator arriving
              from a complaint sees that merchant's runs rather than the whole table. */}
          Showing {merchantName ?? 'one merchant'} only.{' '}
          <Link href="/admin/ai-drafts" className="underline underline-offset-2">
            Show every merchant
          </Link>
          .
        </p>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-soft">
        Every deal-builder run, with the numbers the guardrail produced. Newest first,
        because this screen is usually opened minutes after a merchant calls.
        {withRejections > 0
          ? ` ${withRejections} of these had copy the linter refused — that is normal and is recorded per field.`
          : ''}
      </p>

      {orphans > 0 ? (
        <p role="status" className="rounded-lg border border-thin/40 bg-thin/5 p-2 text-xs text-ink-soft">
          {/* `onDelete: SetNull` on the merchant relation, so a deleted merchant blanks the
              id and leaves the row. The row is still the record of what the model was
              told, so it stays — and it still names the merchant, because the name was
              recorded when the run happened rather than looked up today. */}
          {orphans} of these {orphans === 1 ? 'belongs' : 'belong'} to a merchant that has
          since been deleted. The run is kept because it is still the record of what the
          model was asked and answered.
        </p>
      ) : null}

      {drafts.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-soft">
            {merchantId
              ? 'This merchant has no AI runs yet.'
              : 'No AI runs yet. A row appears here every time a merchant asks for deal proposals, including when the model is unconfigured and the planner wrote everything.'}
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {drafts.map((draft) => (
            <Card as="li" key={draft.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <Link
                      href={`/admin/ai-drafts/${draft.id}`}
                      className="underline underline-offset-2 hover:text-brand"
                    >
                      {draft.merchantName ?? 'Merchant no longer on file'}
                    </Link>
                  </p>
                  <p className="text-xs text-ink-soft">
                    {SURFACE_LABEL[draft.surface] ?? draft.surface} · {draft.promptVersion} ·{' '}
                    {momentLabel(draft.createdAt, 'America/Edmonton')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs font-medium tabular-nums">
                    {draft.lowestDealPriceCents === null
                      ? 'no price'
                      : `from ${formatCents(draft.lowestDealPriceCents)}`}
                  </span>
                  <span className="flex items-center gap-1 text-xs tabular-nums text-ink-soft">
                    <Badge tone={draft.source === 'model' ? 'ok' : 'neutral'}>
                      {draft.source ?? 'unknown'}
                    </Badge>
                    {draft.proposalCount}{' '}
                    {draft.proposalCount === 1 ? 'proposal' : 'proposals'}
                  </span>
                  {draft.rejectionCount > 0 ? (
                    <span className="text-[10px] tabular-nums text-ink-soft">
                      {draft.rejectionCount} copy {draft.rejectionCount === 1 ? 'field' : 'fields'} refused
                    </span>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-ink-soft">
        <span className="font-medium">On “guardrail passed”.</span> That column is a
        constant <code className="font-mono">true</code> for every stored row, because
        only validated proposals can be written at all. It is a statement about what
        storage accepts, not a check that ran and reported. The real evidence is the
        floor percentage and the cost inputs on each draft’s own page.
      </p>
    </div>
  );
}
