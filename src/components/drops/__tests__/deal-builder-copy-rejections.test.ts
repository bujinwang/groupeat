import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `DealBuilder`'s copy-rejection card — a source scan, not a DOM render.
 *
 * ## Why there is no DOM test here
 *
 * `DealBuilder` is a routed client component: it holds `useState`/`useMemo` and calls
 * `useRouter()`.
 *
 * **Correction — 2026-11-20.** An earlier version of this paragraph claimed that
 * `src/lib/testing/render.ts` "executes **server** components only". That was false,
 * and that file's own second 2026-11-12 correction disproves it: the Node harness
 * can render client components to static HTML through `react-dom/server` (hooks need
 * a React dispatcher, not a browser), and `renderWithRouter` supplies the context a
 * `useRouter()` call needs. What the harness cannot do is fire event handlers, so the
 * post-interaction results phase — reached only after the interview's final click —
 * cannot be reached without a router/interaction harness. This file therefore does
 * not claim a UI behaviour it has not observed: it pins that the results-phase
 * render block is **present in source**, and that it reads the merchant-facing field.
 *
 * ## Why the scan strips comments
 *
 * The file under test is also the file that carries the long docblocks describing
 * this very defect. A naive `source.includes('About the wording')` would go green
 * because a comment mentions the card, with the render deleted. The scan therefore
 * strips `//` and `/* *\/` comments (preserving string literals) before looking,
 * and the synthetic "bite" test below proves that stripping is load-bearing: with
 * it removed, a file whose tokens live only in comments is wrongly accepted and
 * that test fails.
 *
 * ## What is injected
 *
 * Every entry point takes `readonly SourceFile[]`. The production assertion feeds
 * the real file; the synthetic assertions feed hand-built files. The same scanner
 * is exercised by both, so the controls are about the detector, not about a
 * fixture that happens to look like the answer.
 */

export type SourceFile = { path: string; content: string };

/** Tokens that can only all be present in code if the card is really rendered. */
const CARD_TOKENS = ['result.copyRejected', 'rejection.message', 'About the wording'] as const;

/**
 * Removes line and block comments while leaving string literals intact.
 *
 * Kept local and deliberately small: a state machine over quotes and comment
 * openers is enough for TSX, and treating a `//` inside a URL string as code is
 * the reason the string branch exists. No parser dependency is needed for three
 * literal tokens.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const end = source.length;

  while (i < end) {
    const char = source[i]!;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      i += 2;
      while (i < end && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < end && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      i += 1;
      while (i < end) {
        const inner = source[i]!;
        out += inner;
        i += 1;
        if (inner === '\\') {
          if (i < end) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/** Paths whose comment-stripped content contains the full render signature. */
export function filesWithWordingCard(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => {
      const code = stripComments(file.content);
      return CARD_TOKENS.every((token) => code.includes(token));
    })
    .map((file) => file.path);
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '../../../..');
const DEAL_BUILDER_PATH = 'src/components/drops/DealBuilder.tsx';

describe('DealBuilder · the results phase renders the copy-rejection card', () => {
  it('reads result.copyRejected and renders each rejection.message under "About the wording"', () => {
    const dealBuilder: SourceFile = {
      path: DEAL_BUILDER_PATH,
      content: readFileSync(join(REPO_ROOT, DEAL_BUILDER_PATH), 'utf8'),
    };

    expect(filesWithWordingCard([dealBuilder])).toEqual([DEAL_BUILDER_PATH]);
  });

  it('positive control: tokens in code are detected', () => {
    const inCode: SourceFile = {
      path: 'in-code.tsx',
      content: [
        '<ul>{result.copyRejected.map((rejection, index) => (',
        '  <li key={`${rejection.archetype}-${rejection.field}-${index}`}>{rejection.message}</li>',
        '))}</ul>',
        '<h2>About the wording</h2>',
      ].join('\n'),
    };

    expect(filesWithWordingCard([inCode])).toEqual(['in-code.tsx']);
  });

  it('bite: tokens that appear only in comments are not mistaken for a render', () => {
    // Remove the `stripComments` call in `filesWithWordingCard` and this fails:
    // the raw source below contains all three tokens, so a naive scan would
    // accept a file with no render at all.
    const inCommentsOnly: SourceFile = {
      path: 'in-comments-only.tsx',
      content: [
        '// result.copyRejected rejection.message About the wording',
        '/*',
        ' * result.copyRejected',
        ' * rejection.message',
        ' * About the wording',
        ' */',
        'const nothingHere = 1;',
      ].join('\n'),
    };

    expect(filesWithWordingCard([inCommentsOnly])).toEqual([]);
  });
});
