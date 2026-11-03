import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ShareLinkControl } from '@/components/organiser/ShareLinkControl';
import { getSession } from '@/lib/auth/session';
import { listShareableDrops, organiserProfileForUser } from '@/lib/db/share-links';
import { formatCents } from '@/lib/guardrail';
import { publicOrigin } from '@/lib/notify/public-origin';
import { momentLabel } from '@/lib/time/labels';

/**
 * `/organiser` — FR-801, FR-802, FR-805.
 *
 * > `FR-801 | Organiser sees available drops from their merchants | Ranked by
 * > likelyFill (§9.4)` — PRD-v1.md:536
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 * > `FR-805 | Organiser cannot see participant phone numbers | P0 privacy
 * > requirement` — PRD-v1.md:540
 *
 * Journey B's acceptance is the one this page is judged by: *"organiser can go from
 * login to a shareable link in ≤2 taps."* Login lands here, the drop is already listed,
 * so the two taps are "Get share link" and "Copy message" — there is no navigation step
 * between them.
 *
 * ## What replaced the placeholder, and why the placeholder was not harmless
 *
 * The Sprint 1 page said "share links arrive in a later release". That was true, and it
 * was also the whole of M7's organiser surface: an organiser could sign in and reach
 * nothing. Meanwhile `ShareLink` sat in the schema with a token, a click counter, an
 * `organiserId` and **no writer anywhere in the codebase** — the same shape of gap as
 * FR-905's `AiDraft`, from the other direction.
 *
 * ## The missing-profile case, from FR-906
 *
 * An `ORGANISER` account created before that fix has no `OrganiserProfile`. It signs in
 * fine — `role` is what the layout gate reads — and arrives here with nothing behind it.
 * That is not an error state to throw on; it is one sentence and a direction to the
 * team, because the organiser cannot fix it themselves.
 *
 * ## FR-805, structurally
 *
 * This page shows counts. `listShareableDrops` returns a row with no field that could
 * hold a phone number or a name, so there is no projection to get wrong — and the test
 * asserts the serialised rows contain neither the phone nor its last four digits.
 */
export const dynamic = 'force-dynamic';

export default async function OrganiserHomePage() {
  const session = await getSession();
  // The layout already gated the role; this is the second read, because a page must not
  // depend on a parent having done its job.
  const profile = session ? await organiserProfileForUser(session.userId) : null;

  if (!profile) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Your organiser page</h1>
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            Your account is not finished setting up — it has no organiser profile, so
            there is no name to put on a share link. Ask the team to complete it; there is
            nothing you need to do.
          </p>
        </Card>
      </div>
    );
  }

  const drops = await listShareableDrops({ organiserProfileId: profile.id });
  const origin = publicOrigin();

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">Drops you can share</h1>
        <span className="text-xs text-ink-soft">{drops.length} open</span>
      </div>

      <p className="text-xs leading-relaxed text-ink-soft">
        Every drop still taking orders, soonest deadline first. Your link tells the
        restaurant you sent the group — that is how your commission is counted.
      </p>

      <p className="text-xs leading-relaxed text-ink-soft">
        {/* Linked from here rather than only from the nav: the sentence above is the
            first time an organiser is told their commission is counted at all, so the
            place they can read the number belongs on the same screen. */}
        <Link
          href="/commission"
          className="font-medium text-ink underline underline-offset-2 hover:text-ink-soft"
        >
          See what you have earned
        </Link>{' '}
        — your commission for any month, and a CSV you can keep.
      </p>

      {drops.length === 0 ? (
        <Card>
          <p className="text-sm leading-relaxed text-ink-soft">
            Nothing open right now. Drops appear here as soon as a restaurant publishes
            one, so check back later.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {drops.map((drop) => {
            const savingCents = drop.menuPriceCents - drop.dealPriceCents;
            const discountPct =
              drop.menuPriceCents > 0
                ? Math.round((savingCents / drop.menuPriceCents) * 100)
                : 0;
            const met = drop.joinedQty >= drop.minQty;

            return (
              <Card as="li" key={drop.id}>
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{drop.title}</p>
                      <p className="truncate text-xs text-ink-soft">{drop.merchantName}</p>
                      <p className="text-xs text-ink-soft">
                        {drop.pickupAddress ?? 'Pickup address not set'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-sm font-medium tabular-nums">
                        {formatCents(drop.dealPriceCents)}
                      </span>
                      {discountPct > 0 ? (
                        <span className="text-[10px] tabular-nums text-ink-soft">
                          was {formatCents(drop.menuPriceCents)} · {discountPct}% off
                        </span>
                      ) : null}
                      <Badge tone={met ? 'ok' : 'neutral'}>
                        {met ? 'Threshold met' : `${drop.joinedQty} of ${drop.minQty}`}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-xs text-ink-soft">
                    {/* The deadline is the organiser's whole urgency argument, so it is
                        stated in the merchant's zone — the same `momentLabel` the share
                        message uses, so the page and the paste cannot disagree. */}
                    Orders close {momentLabel(drop.cutoffAt, drop.merchantTimezone)} · pick
                    up {momentLabel(drop.windowStart, drop.merchantTimezone)}–
                    {momentLabel(drop.windowEnd, drop.merchantTimezone)}
                  </p>

                  <ShareLinkControl
                    dropId={drop.id}
                    publicCode={drop.publicCode}
                    origin={origin}
                    title={drop.title}
                    merchantName={drop.merchantName}
                    dealPriceCents={drop.dealPriceCents}
                    menuPriceCents={drop.menuPriceCents}
                    minQty={drop.minQty}
                    joinedQty={drop.joinedQty}
                    cutoffAt={drop.cutoffAt}
                    timeZone={drop.merchantTimezone}
                    existingToken={drop.existingToken}
                    existingClicks={drop.existingClicks}
                  />
                </div>
              </Card>
            );
          })}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-ink-soft">
        You see counts only — never who joined, or their phone number. The restaurant has
        that; your commission is on what your link sells, not on who it reaches.
      </p>
    </div>
  );
}
