import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from '../unique-violation';

/**
 * Contract tests for the shared predicate's *redemption* policy.
 *
 * The sibling `drops-unique-violation.test.ts` pins the `publicCode` retry's
 * historical contract, including its permissive missing-target fallback. This
 * file pins the decisions the redemption call site adds on top of the same
 * implementation: a compound key must be reported in full, matching is
 * case-sensitive, and an unreported target is not evidence of a replay.
 */
const SCAN_KEY = ['participantId', 'scanId'] as const;
const STRICT = { missingTarget: 'not-ours' } as const;
const P2002 = { code: 'P2002' } as const;

describe('isUniqueViolation — shared predicate, strict policy', () => {
  it('accepts the compound scan key reported as an array', () => {
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: ['participantId', 'scanId'] } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(true);
  });

  it('accepts the compound name reported as one string', () => {
    // Some connectors flatten the index name; both columns are still legible.
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: 'participantId_scanId' } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(true);
  });

  it('does not accept a string target naming only part of a compound key', () => {
    // The string branch must apply the same "every field" rule as the array
    // branch. A substring hit on one column is not the whole index.
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: 'participantId_only' } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(false);

    // Positive control: a flattened string naming BOTH columns is ours. Without
    // it, rejecting every string target would satisfy the assertion above.
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: 'participantId_scanId' } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(true);
  });

  it('rejects a foreign constraint whose target names no scan-key field', () => {
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: ['id'] } }, SCAN_KEY, STRICT),
    ).toBe(false);
  });

  it('rejects a half-reported compound key', () => {
    // A single column is not the key. "Any field matched" would let a different
    // unique index on `participantId` be reported as a replay.
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: ['participantId'] } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(false);
  });

  it('does not match a different spelling of a field', () => {
    expect(
      isUniqueViolation(
        { code: 'P2002', meta: { target: ['ParticipantId', 'scanId'] } },
        SCAN_KEY,
        STRICT,
      ),
    ).toBe(false);
  });

  it('rejects a P2002 with no target because REPLAYED is a positive claim', () => {
    expect(isUniqueViolation(P2002, SCAN_KEY, STRICT)).toBe(false);
    expect(isUniqueViolation({ code: 'P2002', meta: {} }, SCAN_KEY, STRICT)).toBe(
      false,
    );
  });

  it('rejects a malformed target shape under the strict policy', () => {
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: 7 } }, SCAN_KEY, STRICT),
    ).toBe(false);
  });

  it('keeps the permissive default for the publicCode retry', () => {
    expect(isUniqueViolation(P2002, 'publicCode')).toBe(true);
    expect(isUniqueViolation({ code: 'P2002', meta: { target: 7 } }, 'publicCode')).toBe(
      true,
    );
  });

  it('does not treat a non-P2002 or a non-object as a violation', () => {
    expect(isUniqueViolation({ code: 'P2003' }, SCAN_KEY, STRICT)).toBe(false);
    expect(isUniqueViolation(null, SCAN_KEY, STRICT)).toBe(false);
  });
});
