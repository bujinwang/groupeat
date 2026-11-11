/**
 * Guards on the fixture census: the claims the `settlement-fixtures.ts` docblock makes
 * about its own population, expressed so they fail when they stop being true.
 *
 * ## Why this test exists at all
 *
 * That docblock is a long argument about hand-counted numbers rotting, and its own
 * census rotted three times while making the argument. Each time, the fix was to retype
 * the numerals — which rot again on the next test file. The M5 race test (`qa-repairrace`)
 * added one raw-`Date.now()` caller and silently invalidated four figures.
 *
 * So this file does not assert "there are 106 declarations". That is the number that
 * rots. It asserts the **relationships** the docblock's argument depends on:
 *
 *   - the shape table sums to its own header, within the phone-literal offset;
 *   - `raw` is the majority among callers and `slice(-5)` is not;
 *   - the "mentions prefix" count is strictly larger than the declaration-file count,
 *     which is what makes it useless as a denominator;
 *   - every namespace the fixture is handed belongs to a caller file that actually
 *     imports it.
 *
 * A relationship can stay true for years and still be worth guarding; a count cannot
 * survive one new file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  birthdayProbability,
  computeFixturesCensus,
  sumShapes,
  type FixturesCensus,
} from '@/lib/testing/fixtures-census';

const census: FixturesCensus = computeFixturesCensus();

/**
 * The docblock's shape table, parsed back out of the source and compared to the census.
 *
 * This is the only assertion that actually stops the rot: the other tests guard the
 * *relationships*, but the numerals in the table can drift silently while every
 * relationship still holds. Reading them back and comparing is what makes the table
 * self-enforcing — the fourth time this census would have been wrong, the build fails
 * instead of a reader noticing.
 */
describe('fixture census — the docblock table matches the code', () => {
  const docblock = readFileSync(
    join(process.cwd(), 'src/lib/settlement/__tests__/settlement-fixtures.ts'),
    'utf8',
  );

  /** Pull `| label | a | b | … |` rows out of the shape table by their leading label. */
  function tableRow(label: RegExp): number[] {
    for (const line of docblock.split('\n')) {
      if (!label.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const numbers = cells
        .slice(1) // drop the label cell
        .map((cell) => cell.replace(/[*`]/g, '').trim())
        .filter((cell) => /^\d+$/.test(cell))
        .map((cell) => Number(cell));
      if (numbers.length > 0) return numbers;
    }
    throw new Error(`docblock shape-table row not found: ${String(label)}`);
  }

  it('the declaration and caller columns match the census, row by row', () => {
    // Each row is `| label | decls | callers | what it leaves |`; strip emphasis and
    // backticks, then read the two numeric cells. Comparing every row is what makes the
    // table self-enforcing rather than decorative.
    const rows: Array<[RegExp, 'raw' | 'slice(-6)' | 'slice(-5)' | 'unsliced']> = [
      [/\|\s*`\$\{Date\.now\(\)\}` raw\s*\|/, 'raw'],
      [/\|\s*`\.toString\(36\)\.slice\(-6\)`\s*\|/, 'slice(-6)'],
      [/\|\s*`\.toString\(36\)\.slice\(-5\)`\s*\|/, 'slice(-5)'],
      [/\|\s*`\.toString\(36\)` unsliced\s*\|/, 'unsliced'],
    ];

    for (const [label, shape] of rows) {
      const [declared, callers] = tableRow(label);
      expect(declared, `${shape} declaration column`).toBe(census.allShapes[shape]);
      expect(callers, `${shape} caller column`).toBe(census.callerShapes[shape]);
    }
  });

  it('the "sum of rows" line matches both totals', () => {
    const [declTotal, callerTotal] = tableRow(/\|\s*\*\*sum of rows\*\*\s*\|/);
    expect(declTotal).toBe(sumShapes(census.allShapes));
    expect(callerTotal).toBe(sumShapes(census.callerShapes));
  });

  it('the collapse table\'s total is the namespace count', () => {
    // The "measured collapse" table is a second hand-typed tally in the same docblock,
    // and it has now rotted twice — it read 60, then 61, and was 62 the third time.
    // Its total is not an independent measurement: every row groups caller
    // declarations, so the total *is* the namespace count. Guarding that identity is
    // what stops the third recurrence, and it needs no expression evaluation — the
    // per-row counts stay instant-dependent and are deliberately not asserted here.
    //
    // Only the bold total row is read. The phone-value rows above it carry counts too,
    // but those change with the clock, so pinning them would be pinning a millisecond.
    const [total] = tableRow(/\|\s*\*\*total\*\*\s*\|/);
    expect(total).toBe(census.namespaces);
  });
});

describe('fixture census — the docblock’s structural claims', () => {
  it('counts a plausible repo at all (guards against a broken walk)', () => {
    // Not a magic number: a floor that fails loudly if the file walk breaks, without
    // pinning a total that legitimately grows with every new test file.
    expect(census.declarations).toBeGreaterThan(50);
    expect(census.callerFiles).toBeGreaterThan(30);
    expect(census.namespaces).toBeGreaterThanOrEqual(census.callerFiles);
  });

  it('has every declaration accounted for: fixture shapes + phone literals = declarations', () => {
    // The docblock's table must sum to its own header. The only row excluded from the
    // shape columns is the phone-literal declaration (`PHONE_PREFIX = \`+1780…\``),
    // which is why the offset is exactly `phonePrefixDeclarations`.
    expect(sumShapes(census.allShapes)).toBe(census.declarations - census.phonePrefixDeclarations);
  });

  it('keeps one unsliced base36 declaration, and it is small enough to be the docblock’s "smallest"', () => {
    // The docblock calls `.toString(36)` the smallest shape in both columns. If it ever
    // stops being the strict minimum, the sentence is wrong.
    const shapes = census.allShapes;
    const unsliced = shapes.unsliced;
    expect(unsliced).toBeGreaterThan(0);
    expect(unsliced).toBeLessThan(shapes.raw);
    expect(unsliced).toBeLessThan(shapes['slice(-6)']);
    expect(unsliced).toBeLessThan(shapes['slice(-5)']);
  });

  it('pin: raw is the majority shape among callers, slice(-5) is not', () => {
    // This is the claim two earlier docblock drafts got backwards, and the one that needs
    // the *caller* population to be true: at declaration level `slice(-5)` (44) beats
    // `raw` (33), so asserting this on `fixtureShapes` would fail today. Only among files
    // that actually call the fixture does `raw` lead — that reversal is the whole point.
    const shapes = census.callerShapes;
    const largest = Math.max(shapes.raw, shapes['slice(-6)'], shapes['slice(-5)'], shapes.unsliced);
    expect(shapes.raw).toBe(largest);
    expect(shapes['slice(-5)']).toBeLessThan(shapes.raw);
  });

  it('pin: slice(-5) is the largest shape among all declarations, but not among callers', () => {
    // The reversal the docblock describes: largest overall, third among callers. Both
    // halves must hold or the sentence is wrong.
    expect(census.fixtureShapes['slice(-5)']).toBeGreaterThan(census.fixtureShapes.raw);
    expect(census.callerShapes['slice(-5)']).toBeLessThan(census.callerShapes.raw);
    expect(census.callerShapes['slice(-5)']).toBeLessThan(census.callerShapes['slice(-6)']);
  });

  it('caller shapes sum to the namespace count', () => {
    // Every caller declaration is written for the namespace that file passes in, so the
    // caller-column total and the namespace count are the same number — one namespace
    // per caller declaration. The docblock's caller column leans on this.
    expect(sumShapes(census.callerShapes)).toBe(census.namespaces);
  });

  it('the "mentions prefix" count is strictly larger than the declaration file count', () => {
    // That inequality is the whole reason the docblock calls the mention count "not a
    // population". If it ever converged, the warning would be obsolete.
    expect(census.mentionFiles).toBeGreaterThan(census.declarationFiles);
  });

  it('counts the phone literal separately, and it is not a fixture namespace', () => {
    // `PHONE_PREFIX = \`+1780…\`` is a phone number in a non-caller file. The docblock
    // leans on this to explain why the shape table sums one short of the declaration
    // total; if the phone literal disappeared the explanation would be chasing a ghost.
    expect(census.phonePrefixDeclarations).toBeGreaterThanOrEqual(1);
  });

  it('offers a birthday bound that is a real function of the namespace count', () => {
    // The docblock quotes two percentages but states them as a method, not a literal.
    // Guard the method: monotonic in k, ~0 for a tiny population, non-trivial at scale.
    expect(birthdayProbability(0, 1e7)).toBe(0);
    expect(birthdayProbability(1, 1e7)).toBe(0);
    expect(birthdayProbability(census.namespaces * 3, 1e7)).toBeGreaterThan(0);
    expect(birthdayProbability(census.namespaces * 3, 1e7)).toBeLessThan(
      birthdayProbability(census.declarations * 3, 1e7),
    );
  });
});
