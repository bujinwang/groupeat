import { describe, expect, it } from 'vitest';

import { generatedHeroDataUri } from '../generated-hero';

/**
 * FR-205's generated hero, as data.
 *
 * The page-level test proves the `<img>` is there; this proves what is inside it: the
 * offer, the frozen prices, and escaping that a merchant cannot break out of.
 */

function svgOf(uri: string): string {
  expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  return decodeURIComponent(uri.slice('data:image/svg+xml;charset=utf-8,'.length));
}

describe('generatedHeroDataUri', () => {
  it('carries the title, the dish, the prices and the pickup label', () => {
    const svg = svgOf(
      generatedHeroDataUri({
        title: 'Beef Bowl Thursday',
        merchantName: 'Copper Kettle',
        itemName: 'Beef Bowl',
        dealPriceCents: 1112,
        menuPriceCents: 1600,
        pickupLabel: 'Thursday, 5:00 PM – 7:00 PM',
      }),
    );

    expect(svg).toContain('Beef Bowl Thursday');
    expect(svg).toContain('Copper Kettle');
    expect(svg).toContain('$11.12');
    expect(svg).toContain('$16.00');
    expect(svg).toContain('Pickup Thursday, 5:00 PM');
  });

  it('escapes merchant text so a dish name cannot inject markup', () => {
    const svg = svgOf(
      generatedHeroDataUri({
        title: '<script>alert(1)</script>',
        merchantName: 'A & B',
        itemName: 'Bowl',
        dealPriceCents: 1000,
        menuPriceCents: 1200,
        pickupLabel: 'Today',
      }),
    );

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('A &amp; B');
  });

  it('truncates rather than overflowing the card', () => {
    const svg = svgOf(
      generatedHeroDataUri({
        title: 'A'.repeat(100),
        merchantName: 'M',
        itemName: 'I',
        dealPriceCents: 1000,
        menuPriceCents: 1200,
        pickupLabel: 'Today',
      }),
    );

    expect(svg).toContain('…');
    expect(svg).not.toContain('A'.repeat(50));
  });
});
