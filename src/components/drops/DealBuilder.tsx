'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, inputClass } from '@/components/ui/Field';

/**
 * The five-question interview (PRD-v1 §9.2 surface 1).
 *
 * ## What this screen decides
 *
 * Nothing about money. It collects four facts the merchant already knows — which
 * day is quiet, which dish batches, what they want out of it, how many they can
 * make — and posts them. Every price, quantity and window in the result comes
 * back from the server.
 *
 * That is why there is no price field here, and why the merchant cannot type a
 * number that becomes a proposal: the cheapest way to keep a model from setting a
 * price is to have no path by which a price is submitted.
 *
 * ## Why the day picker stops at four days
 *
 * A card authorisation lives about seven days, and PRD-v1 §8.3 caps the join
 * window at five from publishing. The server enforces it; the picker's `max` is
 * derived from the same rule so the merchant is not offered a day that will be
 * refused. A client limit that disagrees with the server is a rejected save the
 * merchant cannot explain.
 *
 * ## Why question 3 is a confirmation, not an input
 *
 * §9.2 has the merchant type their ingredient cost. They already did — it is on
 * the dish record, and `publishDrop` refuses a drop whose dish has no cost. Asking
 * again would create a second place a cost figure lives, and two records of one
 * number is the defect class this codebase keeps finding. So the screen shows the
 * figure and links to where it is edited.
 */

export type BuilderDish = {
  id: string;
  name: string;
  menuPriceCents: number;
  foodCostCents: number;
  packagingCents: number;
  batchYield: number;
  minViablePriceCents: number | null;
};

type Archetype = 'QUIET_HOUR' | 'TRIAL' | 'SURPLUS';

type Proposal = {
  archetype: Archetype;
  menuItemId: string;
  dealPriceCents: number;
  menuPriceCents: number;
  minViablePriceCents: number;
  discountPct: number;
  isThinDiscount: boolean;
  minQty: number;
  maxQty: number;
  maxPerCustomer: number;
  windowStart: string;
  windowEnd: string;
  cutoffAt: string;
  rationale: string;
  title: string;
  description: string;
  shareMessage: string;
};

type BuilderResponse = {
  proposals: Proposal[];
  source: 'model' | 'planner';
  promptVersion: string;
  notes: string[];
  aiDraftId: string | null;
};

type Intent = 'FILL_QUIET_HOUR' | 'NEW_CUSTOMERS' | 'EITHER';

type Phase =
  | { kind: 'interview'; step: number }
  | { kind: 'planning' }
  | { kind: 'results'; result: BuilderResponse }
  | { kind: 'failed'; message: string; fieldErrors: Record<string, string> };

const ARCHETYPE_LABEL: Record<Archetype, string> = {
  QUIET_HOUR: 'Fill a quiet hour',
  TRIAL: 'Reach first-timers',
  SURPLUS: 'Use up the batch',
};

/**
 * All three chips are `neutral` on purpose. The badge tones are semantic —
 * `ok` works, `thin` thin discount, `blocked` refused — and an archetype is
 * none of those. Reusing `thin` for the surplus plan would put the "weak deal"
 * colour on a proposal that is not weak; the label text is the difference.
 */
const ARCHETYPE_TONE = 'neutral' as const;

const MAX_DAYS_AHEAD = 4;
const TOTAL_STEPS = 5;

const INTENT_OPTIONS: readonly { value: Intent; label: string; helper: string }[] = [
  {
    value: 'FILL_QUIET_HOUR',
    label: 'Fill a quiet hour',
    helper: 'The kitchen is open and nobody is coming. Anything extra is close to pure profit.',
  },
  {
    value: 'NEW_CUSTOMERS',
    label: 'Get people who have not tried us',
    helper: 'A deeper price and more notice, to reach past your regulars.',
  },
  {
    value: 'EITHER',
    label: 'Not sure — show me both',
    helper: 'You get all three shapes and pick.',
  },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` in the browser's own calendar, which is the merchant's. */
function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `"Thu 2:00 PM – 4:00 PM"`, in the merchant's zone. */
function windowLabel(startIso: string, endIso: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${format.format(new Date(startIso))} – ${format.format(new Date(endIso))}`;
}

function momentLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

export function DealBuilder({
  dishes,
  timeZone,
}: {
  dishes: readonly BuilderDish[];
  /** `Merchant.timezone`, so a label here cannot disagree with the copy. */
  timeZone: string;
}) {
  const router = useRouter();

  const today = useMemo(() => new Date(), []);
  const latestDay = useMemo(
    () => toDateInput(new Date(today.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000)),
    [today],
  );

  const [quietDay, setQuietDay] = useState(() =>
    toDateInput(new Date(today.getTime() + 24 * 60 * 60 * 1000)),
  );
  const [quietHour, setQuietHour] = useState(14);
  const [menuItemId, setMenuItemId] = useState(dishes[0]?.id ?? '');
  const [intent, setIntent] = useState<Intent>('EITHER');
  const [maxQty, setMaxQty] = useState(dishes[0]?.batchYield ?? 20);

  const [phase, setPhase] = useState<Phase>({ kind: 'interview', step: 1 });
  const [usingIndex, setUsingIndex] = useState<number | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const dish = dishes.find((entry) => entry.id === menuItemId) ?? null;

  /**
   * The quiet slot as an instant.
   *
   * Built in the browser so the offset is the merchant's own, then sent as ISO.
   * The server refuses a value without an offset for exactly this reason.
   */
  const quietStartIso = useMemo(() => {
    const [year, month, day] = quietDay.split('-').map(Number);
    const local = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, quietHour, 0, 0, 0);
    return local.toISOString();
  }, [quietDay, quietHour]);

  const fieldErrors = phase.kind === 'failed' ? phase.fieldErrors : {};

  async function plan(): Promise<void> {
    setPhase({ kind: 'planning' });
    setUseError(null);
    try {
      const response = await fetch('/api/merchant/ai/deal-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuItemId, quietStart: quietStartIso, intent, maxQty }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const errors =
          body && typeof body === 'object' && 'fieldErrors' in body
            ? ((body as { fieldErrors?: Record<string, string> }).fieldErrors ?? {})
            : {};
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That could not be planned. Try again.';
        setPhase({ kind: 'failed', message, fieldErrors: errors });
        return;
      }

      setPhase({ kind: 'results', result: body as BuilderResponse });
    } catch {
      setPhase({
        kind: 'failed',
        message: 'We could not reach the server. Check your connection and try again.',
        fieldErrors: {},
      });
    }
  }

  /** Turns a chosen proposal into a real draft, then opens it. */
  async function useProposal(proposal: Proposal, index: number): Promise<void> {
    setUsingIndex(index);
    setUseError(null);
    try {
      const response = await fetch('/api/merchant/drops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menuItemId: proposal.menuItemId,
          title: proposal.title,
          description: proposal.description,
          heroImageUrl: null,
          dealPriceCents: proposal.dealPriceCents,
          minQty: proposal.minQty,
          maxQty: proposal.maxQty,
          maxPerCustomer: proposal.maxPerCustomer,
          windowStart: proposal.windowStart,
          windowEnd: proposal.windowEnd,
          cutoffAt: proposal.cutoffAt,
          aiRationale: proposal.rationale,
        }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : 'That could not be saved. Try again.';
        setUseError(message);
        return;
      }

      const created =
        body && typeof body === 'object' && 'drop' in body
          ? (body as { drop: { id: string } }).drop
          : null;

      router.push(created ? `/merchant/drops/${created.id}` : '/merchant/drops');
      router.refresh();
    } catch {
      setUseError('We could not reach the server. Check your connection and try again.');
    } finally {
      setUsingIndex(null);
    }
  }

  async function copyMessage(text: string, index: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      // Clears itself so the button returns to "Copy" without a second tap.
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  if (phase.kind === 'planning') {
    return (
      <Card>
        <p className="text-sm font-medium">Working out three ways to run this.</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Checking what each one does to your margin on this dish. This takes a few seconds.
        </p>
      </Card>
    );
  }

  if (phase.kind === 'results') {
    const { result } = phase;
    return (
      <div className="space-y-4">
        {result.notes.length > 0 ? (
          <Card>
            <h2 className="text-sm font-semibold">Before you pick</h2>
            <ul className="mt-2 space-y-1">
              {result.notes.map((note) => (
                <li key={note} className="text-sm leading-relaxed text-ink-soft">
                  {note}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {result.proposals.map((proposal, index) => (
          <Card key={`${proposal.archetype}-${index}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Badge tone={ARCHETYPE_TONE}>{ARCHETYPE_LABEL[proposal.archetype]}</Badge>
                <h2 className="mt-2 text-base font-semibold">{proposal.title}</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  {dollars(proposal.dealPriceCents)} a plate · was {dollars(proposal.menuPriceCents)}{' '}
                  · {Math.round(proposal.discountPct * 100)}% off
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold">{dollars(proposal.dealPriceCents)}</p>
                <p className="text-xs text-ink-soft">per plate</p>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-ink-soft">Pickup</dt>
              <dd>{windowLabel(proposal.windowStart, proposal.windowEnd, timeZone)}</dd>
              <dt className="text-ink-soft">Joining closes</dt>
              <dd>{momentLabel(proposal.cutoffAt, timeZone)}</dd>
              <dt className="text-ink-soft">You need</dt>
              <dd>
                {proposal.minQty} orders, up to {proposal.maxQty}
              </dd>
              <dt className="text-ink-soft">Per person</dt>
              <dd>{proposal.maxPerCustomer === 1 ? '1 (trial)' : `up to ${proposal.maxPerCustomer}`}</dd>
            </dl>

            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{proposal.rationale}</p>

            {proposal.isThinDiscount ? (
              <p className="mt-3 rounded-lg border border-thin/30 bg-thin/5 p-3 text-sm text-thin">
                This is a small discount for this dish — there is not much room above your minimum
                margin. Expect it to pull weakly.
              </p>
            ) : null}

            <div className="mt-4 rounded-lg border border-slate-200 bg-surface-muted p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
                Message for the group chat
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{proposal.shareMessage}</p>
              <Button
                variant="quiet"
                className="mt-2 px-0"
                onClick={() => void copyMessage(proposal.shareMessage, index)}
              >
                {copied === index ? 'Copied' : 'Copy message'}
              </Button>
            </div>

            <Button
              className="mt-4 w-full"
              disabled={usingIndex !== null}
              onClick={() => void useProposal(proposal, index)}
            >
              {usingIndex === index ? 'Saving…' : 'Use this one'}
            </Button>
          </Card>
        ))}

        {useError ? (
          <p role="alert" className="text-sm text-blocked">
            {useError}
          </p>
        ) : null}

        <p className="text-xs leading-relaxed text-ink-soft">
          Picking one saves it as a draft — nothing is shown to anyone until you publish it. You can
          change any detail before then.
        </p>

        <Button
          variant="secondary"
          onClick={() => setPhase({ kind: 'interview', step: 1 })}
          disabled={usingIndex !== null}
        >
          Start over
        </Button>
      </div>
    );
  }

  const step = phase.kind === 'interview' ? phase.step : 1;
  const failedMessage = phase.kind === 'failed' ? phase.message : null;

  function go(next: number): void {
    if (next < 1) {
      setPhase({ kind: 'interview', step: 1 });
      return;
    }
    if (next > TOTAL_STEPS) {
      void plan();
      return;
    }
    setPhase({ kind: 'interview', step: next });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
          Question {step} of {TOTAL_STEPS}
        </p>
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: TOTAL_STEPS }, (_, index) => (
            <span
              key={index}
              className={`h-1.5 w-6 rounded-full ${index < step ? 'bg-brand' : 'bg-slate-200'}`}
            />
          ))}
        </div>
      </div>

      <Card>
        {step === 1 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Which day are you quietest?</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                Pick a day in the next {MAX_DAYS_AHEAD} days, and the hour when the kitchen is open
                but the room is empty.
              </p>
            </div>

            <Field id="quietDay" label="Day" error={fieldErrors.quietStart}>
              <input
                id="quietDay"
                type="date"
                value={quietDay}
                min={toDateInput(today)}
                max={latestDay}
                onChange={(event) => setQuietDay(event.target.value)}
                className={inputClass}
              />
            </Field>

            <Field id="quietHour" label="Pickup starts" helper="We suggest a two-hour window.">
              <select
                id="quietHour"
                value={quietHour}
                onChange={(event) => setQuietHour(Number(event.target.value))}
                className={inputClass}
              >
                {Array.from({ length: 12 }, (_, index) => index + 10).map((hour) => (
                  <option key={hour} value={hour}>
                    {hour > 12 ? `${hour - 12}pm` : hour === 12 ? '12pm' : `${hour}am`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">
                Which dish can you make 20 of without it hurting?
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                Only dishes you can make in batches appear here. Alcohol can never be a drop.
              </p>
            </div>

            <Field id="menuItemId" label="Dish" error={fieldErrors.menuItemId}>
              <select
                id="menuItemId"
                value={menuItemId}
                onChange={(event) => {
                  const next = dishes.find((entry) => entry.id === event.target.value);
                  setMenuItemId(event.target.value);
                  if (next) setMaxQty(next.batchYield);
                }}
                className={inputClass}
              >
                {dishes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} — {dollars(entry.menuPriceCents)}, makes {entry.batchYield}
                  </option>
                ))}
              </select>
            </Field>

            {dish && dish.minViablePriceCents === null ? (
              <p className="rounded-lg border border-blocked/30 bg-blocked/5 p-3 text-sm text-blocked">
                This dish cannot be a deal at your minimum margin — the ingredients cost too much
                relative to what you charge. Pick another.
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">What does this dish cost you?</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                This is already on the dish record, so we are not asking you to type it twice. If it
                is wrong, fix it there and come back.
              </p>
            </div>

            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-soft">Ingredients</dt>
                <dd className="font-medium">{dollars(dish?.foodCostCents ?? 0)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-soft">Packaging</dt>
                <dd className="font-medium">{dollars(dish?.packagingCents ?? 0)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1.5">
                <dt className="text-ink-soft">Menu price</dt>
                <dd className="font-medium">{dollars(dish?.menuPriceCents ?? 0)}</dd>
              </div>
            </dl>

            {dish ? (
              <a
                href={`/merchant/items/${dish.id}`}
                className="text-sm text-brand underline underline-offset-4"
              >
                Fix the costs on this dish
              </a>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">What do you want out of this?</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                This only changes the order the plans come back in — you always see all three.
              </p>
            </div>

            <div className="space-y-2">
              {INTENT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`block cursor-pointer rounded-lg border p-3 ${
                    intent === option.value
                      ? 'border-brand bg-brand/5'
                      : 'border-slate-200 bg-surface'
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="intent"
                      value={option.value}
                      checked={intent === option.value}
                      onChange={() => setIntent(option.value)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink">{option.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">
                        {option.helper}
                      </span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">How many can you commit to making?</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                One batch of {dish?.name ?? 'this dish'} is {dish?.batchYield ?? 0}. Nobody is
                charged unless enough people join, so this is simply the most you would cook.
              </p>
            </div>

            <Field
              id="maxQty"
              label="Most you will make"
              helper={dish ? `One batch is ${dish.batchYield}.` : undefined}
              error={fieldErrors.maxQty}
            >
              <input
                id="maxQty"
                type="number"
                min={1}
                max={dish?.batchYield ?? undefined}
                value={maxQty}
                onChange={(event) => setMaxQty(Number(event.target.value))}
                className={inputClass}
              />
            </Field>
          </div>
        ) : null}

        {failedMessage ? (
          <p role="alert" className="mt-4 text-sm text-blocked">
            {failedMessage}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <Button variant="secondary" onClick={() => go(step - 1)}>
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          <Button onClick={() => go(step + 1)} disabled={!menuItemId}>
            {step === TOTAL_STEPS ? 'Show me three plans' : 'Next'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
