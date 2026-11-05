/**
 * The one HTML escaper for interpolated email values.
 *
 * Shared by the digest and the owner invitation rather than copied: a second
 * implementation is a second place to forget a character, and the merchant name and
 * drop title are operator-entered strings that reach both messages.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
