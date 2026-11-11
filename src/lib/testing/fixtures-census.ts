/**
 * The census the `settlement-fixtures.ts` docblock used to hand-count.
 *
 * That docblock is a long argument about how hand-counted numbers rot — and its own
 * census rotted three times while making the argument. This module is the fix: the
 * numbers are *computed*, the docblock carries a machine-checked stanza, and
 * `fixtures-census.test.ts` fails the build when the two disagree. A comment that
 * cannot disagree with the code is a comment nobody reads twice.
 *
 * ## What is counted, and why each population is separate
 *
 * `grep` returns files that *mention* a prefix; that is not the population that can
 * collide. Three distinct populations, in increasing narrowness:
 *
 *   - **declarations** — `const <name> = \`…\`` where the name ends in `PREFIX`.
 *   - **caller files** — files that import `settlementFixtures` and invoke it.
 *   - **namespaces** — one per distinct identifier passed as the first argument, so a
 *     file that calls it twice with two different prefixes counts twice.
 *
 * A namespace that is never handed to the fixture never mints a phone, so only the
 * last population can collide. The docblock's table uses the last two.
 *
 * ## Comment stripping is load-bearing
 *
 * Block and line comments are removed before every scan. Without that, a docblock
 * *describing* `settlementFixtures(prefix)` counts as a call site — this file's own
 * sibling `scoped-counts.ts` matched on exactly that, and a census that counts its own
 * prose is the defect this whole exercise is about.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The shape of a prefix expression, keyed by what it does to the timestamp. */
export type PrefixShape = 'raw' | 'slice(-6)' | 'slice(-5)' | 'unsliced';

export type ShapeTally = Record<PrefixShape, number>;

export type FixturesCensus = {
  /** `const <name>PREFIX = \`…\`` declarations anywhere under `src/`. */
  declarations: number;
  /** Distinct files holding at least one such declaration. */
  declarationFiles: number;
  /** Every declaration broken down by the shape of its right-hand side. */
  allShapes: ShapeTally;
  /**
   * Declarations that are a **phone number**, not a fixture namespace
   * (`PHONE_PREFIX = \`+1780…\``). Counted in `declarations`, excluded from
   * `fixtureShapes`, because `+1780` is not a namespace anyone passes to the fixture.
   */
  phonePrefixDeclarations: number;
  /** `declarations - phonePrefixDeclarations`, and the table's own denominator. */
  fixtureShapes: ShapeTally;
  /**
   * Declarations **in caller files only** — the population that can actually mint a
   * phone. The docblock's "raw is the majority" claim is a statement about this table,
   * not about `fixtureShapes`: at declaration level `slice(-5)` is the largest shape,
   * and only at caller level does `raw` overtake it. Two different tables on purpose.
   */
  callerShapes: ShapeTally;
  /** Files that import `settlementFixtures` and invoke it. */
  callerFiles: number;
  /** Distinct identifier arguments across all call sites. */
  namespaces: number;
  /** Callsites of `settlementFixtures(<ident>)`, excluding the definition. */
  invocations: number;
  /** Files a loose "Date.now() and the word prefix" grep touches — not a population. */
  mentionFiles: number;
};

const SRC = 'src';

/**
 * Excluded from every count, for a reason that is the point of the census rather than a
 * convenience: **this module's own source** contains the literal strings `Date.now()`
 * and `prefix` (in the mention test below), so it matches the very grep it computes. A
 * census that counts itself is how these numbers drifted in the first place.
 */
const SELF = 'src/lib/testing/fixtures-census.ts';

/**
 * The fixture's own file is skipped for **calls** only: `function settlementFixtures(
 * prefix…)` matches the call regex and would report one phantom caller. It is *not*
 * skipped for the mention count, because the documented `grep` the docblock describes
 * counts this file's own docblock line as one of its "mentions prefix" hits — being
 * faithful to the command matters more than tidiness here.
 */
const DEFINITION = 'src/lib/settlement/__tests__/settlement-fixtures.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block and line comments so prose cannot masquerade as code. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function shapeOf(rhs: string): PrefixShape | 'phone' {
  // `+1780…` is a phone number literal, not a namespace.
  if (/^\s*\+/.test(rhs)) return 'phone';
  if (rhs.includes('slice(-6)')) return 'slice(-6)';
  if (rhs.includes('slice(-5)')) return 'slice(-5)';
  if (rhs.includes('toString(36)')) return 'unsliced';
  return 'raw';
}

const EMPTY: ShapeTally = { raw: 0, 'slice(-6)': 0, 'slice(-5)': 0, unsliced: 0 };

function tally(target: ShapeTally, shape: PrefixShape): void {
  target[shape] += 1;
}

/**
 * Compute the census. Pure with respect to the working tree: reads files, writes none.
 *
 * Pass `root` to point at a different checkout (the test uses the repo root).
 */
export function computeFixturesCensus(root = process.cwd()): FixturesCensus {
  const files = walk(join(root, SRC));
  const declarationRe = /(?:const|let|var)\s+([A-Za-z0-9_$]*PREFIX)\s*=\s*`([^`]*)`/g;
  const callRe = /settlementFixtures\(\s*([A-Za-z0-9_$]+)/g;

  const allShapes: ShapeTally = { ...EMPTY };
  const fixtureShapes: ShapeTally = { ...EMPTY };
  const callerShapes: ShapeTally = { ...EMPTY };
  let declarations = 0;
  let phonePrefixDeclarations = 0;
  const declarationFileSet = new Set<string>();
  const callerFileSet = new Set<string>();
  const namespaces = new Set<string>();
  let invocations = 0;
  let mentionFiles = 0;

  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/');
    if (rel === SELF) continue;

    const raw = readFileSync(file, 'utf8');

    // The loose "mentions prefix" grep, so the docblock can say why it is not a
    // population rather than merely assert it.
    if (raw.split('\n').some((line) => line.includes('Date.now()') && /prefix/i.test(line))) {
      mentionFiles += 1;
    }

    const code = codeOnly(raw);

    // Decide caller-hood before tallying shapes, so a file's declarations can be
    // attributed to the caller population in the same pass.
    const calls = [...code.matchAll(callRe)].map((match) => match[1] as string);
    const isCaller = rel !== DEFINITION && calls.length > 0;

    for (const match of code.matchAll(declarationRe)) {
      const rhs = match[2] ?? '';
      const shape = shapeOf(rhs);
      declarations += 1;
      declarationFileSet.add(rel);
      if (shape === 'phone') {
        phonePrefixDeclarations += 1;
      } else {
        tally(allShapes, shape);
        tally(fixtureShapes, shape);
        if (isCaller) tally(callerShapes, shape);
      }
    }

    // A caller is a file that invokes the fixture with an identifier argument. The
    // definition's own signature matches the call regex, so it is skipped here only.
    if (isCaller) {
      callerFileSet.add(rel);
      invocations += calls.length;
      for (const ident of calls) namespaces.add(`${rel}#${ident}`);
    }
  }

  return {
    declarations,
    declarationFiles: declarationFileSet.size,
    allShapes,
    phonePrefixDeclarations,
    fixtureShapes,
    callerShapes,
    callerFiles: callerFileSet.size,
    namespaces: namespaces.size,
    invocations,
    mentionFiles,
  };
}

/** The sum of one shape table — the number the docblock's header must agree with. */
export function sumShapes(tallyToSum: ShapeTally): number {
  return (
    tallyToSum.raw + tallyToSum['slice(-6)'] + tallyToSum['slice(-5)'] + tallyToSum.unsliced
  );
}

/**
 * Birthday-bound collision probability for `k` items drawn from `n` — the figure the
 * docblock quotes for the phone namespace, and the reason a 6-digit hash is not enough.
 */
export function birthdayProbability(k: number, n: number): number {
  return 1 - Math.exp(-(k * (k - 1)) / (2 * n));
}

/** Run directly (`npm run census:fixtures`) to print the current numbers. */
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('fixtures-census.ts');

if (invokedDirectly) {
  const census = computeFixturesCensus();
  const callerItems = census.namespaces * 3;
  process.stdout.write(
    [
      `declarations            ${census.declarations}`,
      `declarationFiles        ${census.declarationFiles}`,
      `phonePrefixDeclarations ${census.phonePrefixDeclarations}`,
      `allShapes               ${JSON.stringify(census.allShapes)} (sum ${sumShapes(census.allShapes)})`,
      `fixtureShapes           ${JSON.stringify(census.fixtureShapes)} (sum ${sumShapes(census.fixtureShapes)})`,
      `callerShapes            ${JSON.stringify(census.callerShapes)} (sum ${sumShapes(census.callerShapes)})`,
      `callerFiles             ${census.callerFiles}`,
      `namespaces              ${census.namespaces}`,
      `invocations             ${census.invocations}`,
      `mentionFiles            ${census.mentionFiles}`,
      `birthday @ ${census.namespaces}x3=${callerItems}  ${(birthdayProbability(callerItems, 1e7) * 100).toFixed(3)} %`,
      `birthday @ ${census.declarations}x3=${census.declarations * 3}  ${(birthdayProbability(census.declarations * 3, 1e7) * 100).toFixed(3)} %`,
      '',
    ].join('\n'),
  );
}
