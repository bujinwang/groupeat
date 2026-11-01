import { ImageResponse } from 'next/og';

import { formatCents } from '@/lib/guardrail';
import { getPublicDrop } from '@/lib/public/public-drops';

/**
 * FR-308's 1200×630 preview — **the** P0 launch blocker.
 *
 * "A broken link preview kills distribution." There is no feed and no discovery:
 * a drop spreads because somebody pastes a URL into WhatsApp or WeChat, and the
 * only thing the other forty people in that group see before deciding to tap is
 * this image. So it carries the three facts that make the decision — what, how
 * much, when — at a size legible on a phone thumbnail.
 *
 * ## Why the numbers are formatted here rather than passed in
 *
 * `formatCents` is the same function the page uses, and `getPublicDrop` is the
 * same query. A preview that disagrees with the page it previews is worse than no
 * preview: it is a price the merchant never agreed to, rendered by us.
 *
 * ## Why a missing drop still answers 200 with a card
 *
 * The page 404s for a draft or an unknown code; this endpoint does not. Two
 * reasons. WhatsApp caches a failed image fetch and then renders a bare URL with
 * no card at all, which for a drop that *failed to run* is the worst outcome —
 * the diner is looking at a link that says nothing about whether they were
 * charged. And the card is the same bytes for a draft as for a code that was never
 * issued, so the 200 reveals nothing about which codes exist.
 *
 * ## Why no custom font
 *
 * A webfont means a fetch at render time, which is a dependency that fails in a
 * way nobody notices until a preview goes grey in a group chat. The default font
 * is unglamorous and always available. This is a business card, not a poster.
 */

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'A GroupEat batch order';

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ publicCode: string }>;
}) {
  const { publicCode } = await params;
  const drop = await getPublicDrop(publicCode);

  if (!drop) {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#14181f',
            color: '#ffffff',
            fontSize: 56,
          }}
        >
          This drop is not available
        </div>
      ),
      { ...size },
    );
  }

  const pickup = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: drop.timeZone,
  }).format(drop.windowStart);

  // A restaurant named after its own dish would otherwise print "Beef Bowl" twice
  // in one image. The dish name is the headline, so the merchant label is the one
  // that goes.
  const showMerchant = drop.merchantName.trim().toLowerCase() !== drop.itemName.trim().toLowerCase();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0f7b4f',
          color: '#ffffff',
          padding: 64,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30 }}>
          <span>{showMerchant ? drop.merchantName : ''}</span>
          <span style={{ opacity: 0.75 }}>GroupEat</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 44, opacity: 0.85 }}>{drop.itemName}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 8 }}>
            <span style={{ fontSize: 132, fontWeight: 700, lineHeight: 1 }}>
              {formatCents(drop.dealPriceCents)}
            </span>
            <span style={{ fontSize: 40, marginLeft: 16, marginBottom: 14, opacity: 0.85 }}>
              a plate, was {formatCents(drop.menuPriceCents)}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', fontSize: 34 }}>
          <span>Pickup {pickup}</span>
          <span style={{ opacity: 0.85, marginTop: 8 }}>
            {drop.minQty} orders or nobody is charged
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
