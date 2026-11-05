import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countAnalyticsEvents } from '../read-counts';

/**
 * The dashboard's one non-Postgres read.
 *
 * A missing file, a malformed line and an unrelated event must all be non-events for
 * the counter — the page's zero denominator is how "no data" is shown.
 */
describe('countAnalyticsEvents', () => {
  it('counts only the requested events, ignoring malformed and unrelated lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groupeat-analytics-'));
    const path = join(dir, 'events.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({ event: 'deal_page_viewed', ts: 'x' }),
        JSON.stringify({ event: 'join_authorised', ts: 'x' }),
        JSON.stringify({ event: 'drop_published', ts: 'x' }),
        'not json',
        JSON.stringify({ event: 'deal_page_viewed', ts: 'y' }),
      ].join('\n'),
      'utf8',
    );

    const counts = await countAnalyticsEvents(['deal_page_viewed', 'join_authorised'], path);
    expect(counts).toEqual({ deal_page_viewed: 2, join_authorised: 1 });
  });

  it('returns zeros when the sink does not exist', async () => {
    const counts = await countAnalyticsEvents(
      ['deal_page_viewed', 'join_authorised'],
      join(tmpdir(), 'groupeat-no-such-sink.jsonl'),
    );
    expect(counts).toEqual({ deal_page_viewed: 0, join_authorised: 0 });
  });
});
