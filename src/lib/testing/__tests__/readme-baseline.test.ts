import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The README's PRESENT-TENSE certified baseline is a claim about the current
 * merged tree, so it must move when master moves. This is a source scan, not a
 * DOM/visual test: it pins the literal paragraph, the same way Gate 33/34 scans
 * pin source tokens.
 *
 * ## Why there is no comment-stripping helper here
 *
 * The Gate 33/34 scans strip `//` and `/* *\/` because they inspect TS/TSX code
 * whose own docblock quotes the forbidden expressions — without stripping, the
 * explanation would trip the detector. Markdown has no comment syntax and this
 * paragraph has no such self-quoting problem: the marker below appears exactly
 * once in the whole repo. A stripper would be cargo-cult code here, so it is
 * deliberately omitted.
 *
 * ## What is injected
 *
 * Every entry point takes `readonly SourceFile[]` (the Gate 34 shape). The
 * production assertion feeds the real README; the synthetic assertions feed
 * hand-built files. The same parser is exercised by both, so the controls test
 * the detector, not a fixture that happens to look like the answer.
 */

/** Same injectable-file shape as the Gate 34 copy-rejection scan. */
export type SourceFile = { readonly path: string; readonly content: string };

type Baseline = {
  readonly label: string;
  readonly testFilesPassed: number;
  readonly testFilesSkipped: number;
  readonly testsPassed: number;
  readonly testsSkipped: number;
};

const README_PATH = 'README.md';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `src/lib/testing/__tests__` -> repo root. */
const REPO_ROOT = join(TEST_DIR, '../../../..');

/** The merged-master result this paragraph must state. */
const EXPECTED_BASELINE: Baseline = {
  label: 'combined Gates 32-34 baseline at merged HEAD `9c16157` on pinned Node 24.21.0',
  testFilesPassed: 232,
  testFilesSkipped: 1,
  testsPassed: 2998,
  testsSkipped: 8,
};

/**
 * Parses ONLY the present-tense bold baseline paragraph in README.md.
 *
 * Narrow on purpose: it requires the unique `**Current certified baseline
 * (...):**` marker AND the two exact field phrases `N test files passed / N
 * skipped` and `N tests passed / N skipped` inside that one paragraph. Dated
 * historical numbers elsewhere in the repo (e.g. docs/PROGRESS.md's 192 / 2604
 * at line 8326) have neither the marker nor the README path, so a stray number
 * cannot satisfy this parser.
 */
export function parseCertifiedBaseline(files: readonly SourceFile[]): Baseline | null {
  const readme = files.find((file) => file.path === README_PATH);
  if (!readme) return null;

  const marker = /\*\*Current certified baseline \(([^)]+)\):\*\*/;
  const match = marker.exec(readme.content);
  if (!match) return null;

  const label = match[1]!;
  const afterMarker = readme.content.slice(match.index + match[0].length);
  // The claim is one Markdown paragraph; it ends at the first blank line.
  const paragraph = afterMarker.split(/\n\s*\n/, 1)[0]!;

  const filesMatch = /(\d+)\s+test files passed\s*\/\s*(\d+)\s+skipped/.exec(paragraph);
  const testsMatch = /(\d+)\s+tests passed\s*\/\s*(\d+)\s+skipped/.exec(paragraph);
  if (!filesMatch || !testsMatch) return null;

  return {
    label,
    testFilesPassed: Number(filesMatch[1]),
    testFilesSkipped: Number(filesMatch[2]),
    testsPassed: Number(testsMatch[1]),
    testsSkipped: Number(testsMatch[2]),
  };
}

/** The real README, as the production assertion sees it. */
function realReadme(): SourceFile {
  return {
    path: README_PATH,
    content: readFileSync(join(REPO_ROOT, README_PATH), 'utf8'),
  };
}

describe('README present-tense certified baseline matches merged master', () => {
  it('reports the combined Gates 32-34 numbers at merged HEAD 9c16157', () => {
    expect(parseCertifiedBaseline([realReadme()])).toEqual(EXPECTED_BASELINE);
  });

  it('negative control: the old Gate 32 numbers (230 / 2986) are rejected', () => {
    const old: SourceFile = {
      path: README_PATH,
      content: [
        '**Current certified baseline (Gate 32):** 230 test files passed / 1 skipped,',
        '2986 tests passed / 8 skipped; all 8 skips are Stripe/live opt-in; 13 residue',
        'tables measured 0 → 0.',
        '',
        '## Environment',
      ].join('\n'),
    };
    const parsed = parseCertifiedBaseline([old]);

    // The parser reads the stale numbers faithfully — but they are not current.
    expect(parsed).toEqual({
      label: 'Gate 32',
      testFilesPassed: 230,
      testFilesSkipped: 1,
      testsPassed: 2986,
      testsSkipped: 8,
    });
    expect(parsed).not.toEqual(EXPECTED_BASELINE);
  });

  it('is narrow: dated history and untagged prose cannot satisfy the parser', () => {
    // A PROGRESS.md-style dated line with the field phrases but no marker/path.
    const history: SourceFile = {
      path: 'docs/PROGRESS.md',
      content:
        'Dated history — 192 test files passed / 0 skipped, 2604 tests passed / 0 skipped.',
    };
    expect(parseCertifiedBaseline([history])).toBeNull();

    // Same numbers in a README-shaped file, but without the bold present-tense marker.
    const untagged: SourceFile = {
      path: README_PATH,
      content: 'Once the numbers were 230 test files passed / 1 skipped, 2986 tests passed / 8 skipped.',
    };
    expect(parseCertifiedBaseline([untagged])).toBeNull();
  });
});
