import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emit, resolveAnalyticsPath } from '@/lib/analytics/events';

/**
 * S1-017 — the append-only analytics sink.
 *
 * Two properties matter and both are tested here: one JSON object per line, and
 * **no PII** (AC-12). A third matters for the write path: `emit()` must never
 * throw, because analytics is not allowed to fail a merchant's save.
 */

let dir: string;
let path: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'groupeat-analytics-'));
  path = join(dir, 'nested', 'events.jsonl');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('S1-017 · one JSON object per line, appended', () => {
  it('creates the directory and writes a parseable line', () => {
    expect(emit('guardrail_evaluated', { itemId: 'item-1', isBelowFloor: false }, { path })).toBe(
      true,
    );

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record.event).toBe('guardrail_evaluated');
    expect(record.itemId).toBe('item-1');
    expect(record.isBelowFloor).toBe(false);
    expect(typeof record.ts).toBe('string');
  });

  it('appends rather than overwrites', () => {
    emit('guardrail_violation', { itemId: 'item-1', submittedPriceCents: 500 }, { path });
    emit('food_cost_implausible', { itemId: 'item-2', warning: 'FOOD_COST_IMPLAUSIBLY_LOW' }, {
      path,
    });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] as string).event).toBe('food_cost_implausible');
  });

  it('carries ids and cents only — no email, phone or name', () => {
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toMatch(/@/);
    expect(raw.toLowerCase()).not.toContain('email');
    expect(raw.toLowerCase()).not.toContain('phone');
    expect(raw.toLowerCase()).not.toContain('password');
  });
});

describe('S1-017 · emit never breaks a caller', () => {
  it('returns false instead of throwing when the path cannot be written', () => {
    // A path under a file (not a directory) cannot be created.
    const impossible = join(path, 'events.jsonl');
    expect(() => emit('guardrail_evaluated', { itemId: 'x' }, { path: impossible })).not.toThrow();
    expect(emit('guardrail_evaluated', { itemId: 'x' }, { path: impossible })).toBe(false);
  });

  it('honours ANALYTICS_LOG_PATH and resolves it against cwd', () => {
    const previous = process.env.ANALYTICS_LOG_PATH;
    process.env.ANALYTICS_LOG_PATH = 'var/analytics/events.jsonl';
    try {
      expect(resolveAnalyticsPath()).toBe(join(process.cwd(), 'var/analytics/events.jsonl'));
      expect(resolveAnalyticsPath('/tmp/absolute.jsonl')).toBe('/tmp/absolute.jsonl');
    } finally {
      if (previous === undefined) {
        delete process.env.ANALYTICS_LOG_PATH;
      } else {
        process.env.ANALYTICS_LOG_PATH = previous;
      }
    }
  });
});
