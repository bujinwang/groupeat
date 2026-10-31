import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAlcoholFlagChange } from '@/lib/items/record';

/**
 * S1-025 / S1-017 — the alcohol flag's audit trail.
 *
 * Liquor licence liability sits with the merchant, so an AGLC question ("who
 * cleared this flag, and when?") has to be answerable from the append-only stream.
 * Both directions are recorded; creating a dish is not a transition.
 *
 * The sink's path is redirected through `ANALYTICS_LOG_PATH`, so this test never
 * writes to the developer's `var/analytics/events.jsonl`.
 */

let dir: string;
let path: string;
let previousPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'groupeat-alcohol-'));
  path = join(dir, 'events.jsonl');
  previousPath = process.env.ANALYTICS_LOG_PATH;
  process.env.ANALYTICS_LOG_PATH = path;
});

afterAll(() => {
  if (previousPath === undefined) {
    delete process.env.ANALYTICS_LOG_PATH;
  } else {
    process.env.ANALYTICS_LOG_PATH = previousPath;
  }
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const base = {
  itemId: 'item-1',
  merchantId: 'merchant-1',
  actorUserId: 'user-1',
};

describe('S1-025 · item_alcohol_flag_changed', () => {
  it('records true → false', () => {
    recordAlcoholFlagChange({ ...base, from: true, to: false });

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('item_alcohol_flag_changed');
    expect(events[0]?.from).toBe(true);
    expect(events[0]?.to).toBe(false);
    expect(events[0]?.itemId).toBe('item-1');
    expect(events[0]?.merchantId).toBe('merchant-1');
    expect(events[0]?.actorUserId).toBe('user-1');
    expect(typeof events[0]?.changedAt).toBe('string');
  });

  it('records false → true as well', () => {
    // Adding the flag only makes the dish safer to exclude, but the trail still
    // has to show who added it.
    recordAlcoholFlagChange({ ...base, from: false, to: true });

    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[1]?.from).toBe(false);
    expect(events[1]?.to).toBe(true);
  });

  it('records nothing when the flag did not change', () => {
    recordAlcoholFlagChange({ ...base, from: true, to: true });
    recordAlcoholFlagChange({ ...base, from: false, to: false });

    expect(readEvents()).toHaveLength(2);
  });

  it('carries no PII — ids and booleans only', () => {
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toMatch(/@/);
    expect(raw.toLowerCase()).not.toContain('email');
    expect(raw.toLowerCase()).not.toContain('name');
  });
});
