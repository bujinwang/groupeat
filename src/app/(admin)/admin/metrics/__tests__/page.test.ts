import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ userId: 'admin-1', role: 'ADMIN', mustChangePassword: false }),
}));

const metrics = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/db/metrics', () => ({
  loadNorthStarMetrics: async () => metrics.current,
}));

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/admin/metrics` rendered — §10.2's eight labels, their values and the denominators.
 *
 * The arithmetic is `north-star.test.ts`; this suite proves the page does not drop a
 * metric, does not render a null as `0%`, and keeps each rate beside the counts that
 * produced it.
 */

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

const VALUES = {
  thresholdHitRate: ratio(2, 3),
  medianFillRate: 1.15,
  medianHoursToFirstPublish: 4.2,
  joinConversion: ratio(10, 100),
  organiserShareRate: ratio(2, 3),
  redemptionRate: ratio(15, 20),
  repeatParticipantRate: ratio(1, 2),
  newCustomerShare: ratio(2, 3),
};

const EMPTY = {
  thresholdHitRate: ratio(0, 0),
  medianFillRate: null,
  medianHoursToFirstPublish: null,
  joinConversion: ratio(0, 0),
  organiserShareRate: ratio(0, 0),
  redemptionRate: ratio(0, 0),
  repeatParticipantRate: ratio(0, 0),
  newCustomerShare: ratio(0, 0),
};

async function render(): Promise<{ html: string; text: string }> {
  const page = await import('@/app/(admin)/admin/metrics/page');
  const html = await renderToHtml(await page.default());
  return { html, text: textOf(html) };
}

describe('/admin/metrics', () => {
  it('renders every north-star metric with its value and counts', async () => {
    metrics.current = VALUES;
    const { text } = await render();

    expect(text).toContain('Threshold hit rate');
    expect(text).toContain('67%');
    expect(text).toContain('2 / 3');
    expect(text).toContain('Median fill rate');
    expect(text).toContain('1.15×');
    expect(text).toContain('Time to first publish');
    expect(text).toContain('4.2 h');
    expect(text).toContain('Join conversion');
    expect(text).toContain('10%');
    expect(text).toContain('Organiser share rate');
    expect(text).toContain('Redemption rate');
    expect(text).toContain('75%');
    expect(text).toContain('Repeat participant rate');
    expect(text).toContain('50%');
    expect(text).toContain('New-customer share');
  });

  it('says not measured for empty denominators instead of printing 0%', async () => {
    metrics.current = EMPTY;
    const { text } = await render();

    expect(text).toContain('Not measured yet');
    // The zero counts are still shown, so an operator can tell "no data" from a bug.
    expect(text).toContain('0 / 0');
  });
});
