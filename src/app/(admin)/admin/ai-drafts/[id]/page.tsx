import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { loadAdminDraft } from '@/lib/db/admin-ai-drafts';
import { formatCents } from '@/lib/guardrail';
import { momentLabel } from '@/lib/time/labels';

/**
 * `/admin/ai-drafts/[id]` — one AI run, in full.
 *
 * > `FR-905 | View raw AI drafts and guardrail results | For debugging merchant
 * > complaints` — PRD-v1.md:552
 *
 * ## The order of the page is the order of the argument
 *
 * A complaint is answered by the **inputs**, so they come first and are rendered as
 * numbers, not as JSON: the floor percentage, the menu price, the food and packaging
 * costs, and the floor those produced. If the merchant says "it told me nine dollars",
 * the operator reads the inputs, sees the floor, and can either agree ("our arithmetic
 * put the floor at $9.40, and the plan respects it") or disagree and escalate.
 *
 * The proposals come next, then the rejected copy, and the raw JSON last. That order is
 * deliberate: the JSON is the fallback for a field this page does not lift, and putting
 * it first is how a debugging screen becomes unreadable.
 *
 * ## What this page refuses to claim
 *
 * It does not say the guardrail "passed". `guardrailPassed` is `true` by construction
 * — see `admin-ai-drafts.ts` — and printing a green tick beside it would present a
 * tautology as a result. The page states the stored value, then states what it means.
 */

export const dynamic = 'force-dynamic';

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-200/60 py-1 last:border-0">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="text-xs font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function centsOrDash(value: number | null): string {
  return value === null ? '—' : formatCents(value);
}

export default async function AdminDraftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const draft = await loadAdminDraft(id);

  if (!draft) {
    notFound();
  }

  const { inputs } = draft;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/ai-drafts" className="text-xs text-ink-soft underline underline-offset-2">
          ← All AI drafts
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {draft.merchantName ?? 'Merchant no longer on file'}
            </h1>
            <p className="text-xs text-ink-soft">
              {draft.surface} · {draft.promptVersion} ·{' '}
              {momentLabel(draft.createdAt, 'America/Edmonton')}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={draft.source === 'model' ? 'ok' : 'neutral'}>
              {draft.source ?? 'unknown'}
            </Badge>
            <span className="text-xs tabular-nums text-ink-soft">
              {draft.proposalCount} {draft.proposalCount === 1 ? 'proposal' : 'proposals'}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-semibold">The guardrail’s inputs</h2>
        <dl>
          <Fact
            label="Minimum margin"
            value={
              inputs.floorPctOfMenu === null ? '—' : `${Math.round(inputs.floorPctOfMenu * 100)}%`
            }
          />
          <Fact label="Menu price" value={centsOrDash(inputs.menuPriceCents)} />
          <Fact label="Ingredient cost" value={centsOrDash(inputs.foodCostCents)} />
          <Fact label="Container cost" value={centsOrDash(inputs.packagingCents)} />
          <Fact label="Floor this produced" value={centsOrDash(inputs.minViablePriceCents)} />
        </dl>
        {inputs.minViablePriceCents === null ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            No floor is recorded here because the run stored no proposals — and the floor
            travels on the proposal, not on the run. It is recomputable from the costs and
            the margin above with <code className="font-mono">minViablePrice</code>.
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            The floor travels with each proposal rather than with the run, so this is the
            lowest floor any proposal in this run was checked against.
          </p>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">The merchant’s answers</h2>
        {draft.answers ? (
          <pre className="overflow-x-auto rounded-lg bg-surface-muted p-2 text-[11px] leading-relaxed">
            {JSON.stringify(draft.answers, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-ink-soft">
            This row does not carry the interview answers — the shape predates them, or
            another surface wrote it.
          </p>
        )}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Proposals</h2>
        {draft.proposals.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-soft">
              No proposals were stored. That itself is the answer to some complaints: the
              run produced nothing because the dish could not carry a viable discount.
            </p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {draft.proposals.map((proposal, index) => (
              <Card as="li" key={`${proposal.archetype}-${index}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{proposal.title || proposal.archetype}</p>
                    <p className="text-xs text-ink-soft">{proposal.archetype}</p>
                    {proposal.rationale ? (
                      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                        {proposal.rationale}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs tabular-nums font-medium">
                      {centsOrDash(proposal.dealPriceCents)}
                    </span>
                    {proposal.menuPriceCents !== null && proposal.dealPriceCents !== null ? (
                      <span className="text-[10px] text-ink-soft">
                        was {formatCents(proposal.menuPriceCents)}
                        {proposal.discountPct !== null
                          ? ` · ${Math.round(proposal.discountPct * 100)}% off`
                          : ''}
                      </span>
                    ) : null}
                    {proposal.isThinDiscount ? <Badge tone="thin">Thin</Badge> : null}
                  </div>
                </div>
                {proposal.minQty !== null && proposal.maxQty !== null ? (
                  <p className="mt-1 text-xs text-ink-soft">
                    Needs {proposal.minQty}, up to {proposal.maxQty}.
                  </p>
                ) : null}
              </Card>
            ))}
          </ul>
        )}
      </div>

      {draft.rejections.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold">
            Copy the linter refused ({draft.rejections.length})
          </h2>
          <p className="mb-2 text-xs leading-relaxed text-ink-soft">
            Each field is accepted or rejected on its own, so a good title survives a bad
            share message. This is the record of what was dropped and why — it is the most
            likely explanation for “the wording was odd”.
          </p>
          <ul className="space-y-2">
            {draft.rejections.map((rejection, index) => (
              <Card as="li" key={`${rejection.field}-${index}`}>
                <p className="text-xs font-medium">
                  {rejection.field} · <span className="font-mono">{rejection.kind}</span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  {rejection.detail}
                </p>
                <p className="mt-1 text-[10px] text-ink-soft">{rejection.archetype}</p>
              </Card>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <h2 className="mb-1 text-sm font-semibold">“Guardrail passed”</h2>
        <p className="text-xs leading-relaxed text-ink-soft">
          Stored as{' '}
          <span className="font-mono font-semibold">{String(draft.guardrailPassed)}</span>.
          That value is a constant for every row, not a result: nothing unvalidated can be
          written at all, so there has never been a row where it was false. Treat the
          inputs above as the evidence and this column as a schema fact.
        </p>
      </Card>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-ink-soft">
          Raw input (verbatim)
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-2 text-[11px] leading-relaxed">
          {draft.inputJson}
        </pre>
      </details>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-ink-soft">
          Raw output (verbatim)
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-2 text-[11px] leading-relaxed">
          {draft.outputJson}
        </pre>
      </details>
    </div>
  );
}
