import { formatCents } from '@/lib/guardrail';

/**
 * FR-205's hero when a drop has no photo.
 *
 * ## What "generated" means here, precisely
 *
 * The PRD asks the system to generate a hero image alongside the title, description and
 * share message. There is no image model in this deployment, and adding one would put
 * an unverifiable visual claim in front of a diner for every drop. What the server can
 * do deterministically is compose a branded card from facts it already owns: the
 * merchant, the dish, the frozen prices and the pickup window.
 *
 * The result is an SVG data URI, rendered by the same `<img>` element a merchant- or
 * dish-supplied photo would use. It is not a photograph and it is not AI-generated; it
 * is a legible placeholder that looks intentional rather than a broken image, and the
 * merchant can replace it with a URL on the draft form (FR-205's "editable" half).
 *
 * ## Why SVG and not a generated PNG route
 *
 * A route would need its own loader and would have to answer for a draft preview as
 * well as a public drop. A pure function has no route surface, no cache policy and no
 * extra request — the page already has every fact. The data URI is small (a few KB),
 * and the text is escaped, so a merchant cannot inject markup through a dish name.
 *
 * ## What it does not include
 *
 * No participant count, no organiser name, no claim about demand. Only the offer.
 */

/** Longest title line that fits the 1200px card at 56px without wrapping. */
const MAX_TITLE_CHARS = 34;
/** Longest supporting line. */
const MAX_SUPPORTING_CHARS = 68;

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generatedHeroDataUri(args: {
  readonly title: string;
  readonly merchantName: string;
  readonly itemName: string;
  readonly dealPriceCents: number;
  readonly menuPriceCents: number;
  /** A preformatted pickup label in the merchant's zone. */
  readonly pickupLabel: string;
}): string {
  const title = escapeXml(truncate(args.title, MAX_TITLE_CHARS));
  const supporting = escapeXml(
    truncate(`${args.merchantName} · ${args.itemName}`, MAX_SUPPORTING_CHARS),
  );
  const pickup = escapeXml(truncate(args.pickupLabel, MAX_SUPPORTING_CHARS));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#0f7b4f"/><stop offset="1" stop-color="#0b3b2a"/>` +
    `</linearGradient></defs>` +
    `<rect width="1200" height="630" fill="url(#g)"/>` +
    `<text x="64" y="96" fill="#ffffff" opacity="0.78" font-family="system-ui,sans-serif" font-size="30">GroupEat</text>` +
    `<text x="64" y="246" fill="#ffffff" font-family="system-ui,sans-serif" font-size="56" font-weight="700">${title}</text>` +
    `<text x="64" y="306" fill="#ffffff" opacity="0.9" font-family="system-ui,sans-serif" font-size="32">${supporting}</text>` +
    `<text x="64" y="486" fill="#ffffff" font-family="system-ui,sans-serif" font-size="104" font-weight="700">${escapeXml(
      formatCents(args.dealPriceCents),
    )}</text>` +
    `<text x="64" y="548" fill="#ffffff" opacity="0.88" font-family="system-ui,sans-serif" font-size="30">a plate, was ${escapeXml(
      formatCents(args.menuPriceCents),
    )}</text>` +
    `<text x="64" y="598" fill="#ffffff" opacity="0.72" font-family="system-ui,sans-serif" font-size="26">Pickup ${pickup}</text>` +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
