import { describe, expect, it } from 'vitest';

import {
  extractJsonObject,
  forbiddenKeysIn,
  parseCopyResponse,
} from '../schema';

/**
 * Parsing a model's reply.
 *
 * The cases here are the shapes a chat model actually returns: JSON wrapped in
 * prose, JSON in a fenced block, JSON with a brace inside a string, and JSON that
 * contains keys the contract forbids. The last one is the point of the file —
 * `parseCopyResponse` must *drop* a price, and `forbiddenKeysIn` must still be able
 * to see that one was offered, because that rate is the evidence for ADR-002.
 */

const VALID = {
  proposals: [
    {
      archetype: 'TRIAL',
      title: 'Beef Bowl — first try, Tuesday',
      description: 'Pickup Tuesday 2pm–4pm. Joining closes Tuesday 11am.',
      shareMessage: 'Golden Dragon: Beef Bowl at $13.10 a plate, pickup Tuesday 2pm–4pm.',
      rationale: 'Deepest price, one per person.',
    },
  ],
};

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads through a fenced code block and prose', () => {
    const reply = ['Here you go:', '```json', '{"a":1}', '```', 'Hope that helps.'].join('\n');
    expect(extractJsonObject(reply)).toEqual({ a: 1 });
  });

  it('keeps a brace that lives inside a string', () => {
    // A naive brace counter truncates here and produces an unparseable fragment.
    expect(extractJsonObject('{"title":"Beef {bowl}"}')).toEqual({ title: 'Beef {bowl}' });
  });

  it('keeps an escaped quote inside a string', () => {
    expect(extractJsonObject('{"title":"He said \\"hi\\""}')).toEqual({ title: 'He said "hi"' });
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeNull();
  });

  it('returns null for a truncated object', () => {
    expect(extractJsonObject('{"a": {"b": 1}')).toBeNull();
  });
});

describe('parseCopyResponse', () => {
  it('accepts the contract', () => {
    const parsed = parseCopyResponse(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proposals[0]?.archetype).toBe('TRIAL');
  });

  it('reports a missing object rather than throwing', () => {
    const parsed = parseCopyResponse('no json here');
    expect(parsed).toMatchObject({ ok: false, reason: 'no_json' });
  });

  it('names the offending field when the shape is wrong', () => {
    const parsed = parseCopyResponse(
      JSON.stringify({ proposals: [{ archetype: 'NOPE', title: 'x' }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid_shape');
    expect(parsed.detail).toContain('archetype');
  });

  it('rejects an over-long title before it reaches the linter', () => {
    const parsed = parseCopyResponse(
      JSON.stringify({
        proposals: [{ ...VALID.proposals[0], title: 'x'.repeat(61) }],
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it('drops a price the model tried to set, and keeps the raw so the attempt is visible', () => {
    const withPrice = {
      proposals: [{ ...VALID.proposals[0], dealPriceCents: 999, minQty: 1 }],
    };

    const parsed = parseCopyResponse(JSON.stringify(withPrice));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The schema stripped it: nothing downstream can read a model-set price.
    expect(parsed.value.proposals[0]).not.toHaveProperty('dealPriceCents');
    expect(parsed.value.proposals[0]).not.toHaveProperty('minQty');

    // The raw reply still has it, which is how the rate gets measured.
    expect(forbiddenKeysIn(parsed.raw)).toEqual(['dealPriceCents', 'minQty']);
  });
});

describe('forbiddenKeysIn', () => {
  it('finds keys nested inside arrays', () => {
    expect(forbiddenKeysIn({ proposals: [{ windowStart: 'x' }, { price: 1 }] })).toEqual([
      'price',
      'windowStart',
    ]);
  });

  it('returns nothing for a clean reply', () => {
    expect(forbiddenKeysIn(VALID)).toEqual([]);
  });
});
