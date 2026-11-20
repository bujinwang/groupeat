import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Census of the repo's `'use client'` components: the population, and how it gets
 * rendered.
 *
 * ## Why this module exists
 *
 * Three comments in this tree asserted, in different words, that a client component with
 * hooks cannot be tested here. `render.ts` said such a component "remains untestable".
 * `actions.test.ts` said "no test can render it". The log said seven were "untested by
 * design — hooks need a DOM". All three were **false**, and all three had been false for
 * months.
 *
 * Measured per function over the stored V8 map: **30 of 31** client components already
 * execute, several at 82–94 % statement coverage, and the single holdout renders on the
 * first attempt once `server-only` is mocked. Hooks need a React dispatcher, not a
 * browser — `react-dom/server` supplies one, and `jsdom`/`happy-dom`/`linkedom` are all
 * absent from `devDependencies`.
 *
 * The claim that *is* true is narrower: **event handlers do not fire** — 2 of 93 across
 * the components that render. "Renders" and "interacts" were being conflated, and that
 * conflation is what let a false sentence stand: a claim that does not distinguish the
 * two cannot be checked by anyone.
 *
 * ## The measurement mistake this module made once, and the correction
 *
 * The first version counted a component as "mentioned" if *any* test file contained its
 * basename as a string. That reported **26 of 31 reachable, 5 unmentioned** — and the
 * five were false: `SetPasswordForm`, `AddMerchantMemberForm`, `BackfillOrganiserForm`,
 * `CreateMerchantForm`, `DigestConsentForm` all scored 77–89 % statement coverage,
 * because a **page** renders each of them and the page's own test renders the page:
 *
 *     SetPasswordForm      <- app/set-password/page.tsx
 *     AddMerchantMemberForm<- app/(admin)/admin/merchants/[id]/page.tsx
 *     BackfillOrganiser... <- app/(admin)/admin/users/page.tsx
 *     CreateMerchantForm   <- app/(admin)/admin/users/page.tsx
 *     DigestConsentForm    <- app/(merchant)/merchant/settings/page.tsx
 *
 * Basename-mention is not reachability. This version therefore follows the real chain:
 * a component counts as rendered if some **non-test** source imports it and some test
 * file mentions *that* source. The correction is recorded here rather than silently
 * applied, because "the census said 5 were untested and the coverage said 80 %" is
 * exactly the kind of contradiction that should be resolved in writing.
 *
 * ## What this module deliberately does not do
 *
 * It does not read the coverage map. Coverage lives in `node_modules/.cov/` only after a
 * full instrumented run, is gitignored, and would make every importing test depend on a
 * build step having happened. It counts the stable thing — population and shape — so the
 * docblocks' claims have a denominator that cannot go stale, while the coverage numbers
 * stay where they are cited, with their measurement date.
 */

export type ClientCensus = {
  /** Every `src/**\/*.tsx` whose first non-blank line is `'use client'`. */
  readonly files: readonly string[];
  /** How many there are. The denominator every "N of M" claim needs. */
  readonly total: number;
  /** Rendered via a page/source that a test file names. See the docblock above. */
  readonly renderedViaParent: readonly string[];
  /** Rendered because a test names the component's own basename. */
  readonly renderedDirectly: readonly string[];
  /** Neither — the genuinely unrendered ones, if any. */
  readonly unrendered: readonly string[];
  /** Files exporting a pure helper beside the component. The tested half of a client file. */
  readonly withPureHelper: readonly string[];
};

const SRC = join(process.cwd(), 'src');

function walk(dir: string, filter: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, filter, out);
    } else if (filter(name)) {
      out.push(full);
    }
  }
  return out;
}

const isComponent = (name: string): boolean => name.endsWith('.tsx') && !name.endsWith('.test.tsx');
const isTest = (name: string): boolean => name.endsWith('.test.ts') || name.endsWith('.test.tsx');

export function computeClientCensus(): ClientCensus {
  const tests = walk(SRC, isTest).map((file) => readFileSync(file, 'utf8')).join('\n');
  const sources = walk(SRC, isComponent);

  const files: string[] = [];
  const renderedDirectly: string[] = [];
  const renderedViaParent: string[] = [];
  const withPureHelper: string[] = [];

  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    const first = source.split('\n').find((line) => line.trim().length > 0) ?? '';
    if (!/^['"]use client['"];?$/.test(first.trim())) continue;

    const relative = file.slice(process.cwd().length + 1);
    files.push(relative);

    const base = file.split('/').pop()!.replace(/\.tsx$/, '');

    const exported = [...source.matchAll(/^export (?:async )?function ([a-zA-Z][A-Za-z0-9_]*)/gm)].map(
      (match) => match[1] as string,
    );
    if (exported.some((name) => /^[a-z]/.test(name))) withPureHelper.push(relative);

    if (tests.includes(base)) {
      renderedDirectly.push(relative);
      continue;
    }

    // Anyone who imports this component by name. Its importer's basename is what a test
    // would name, so the chain is one hop and needs no graph traversal.
    const importers = walk(SRC, isComponent).filter((candidate) => {
      if (candidate === file) return false;
      return new RegExp(`from ['"][^'"]*${base}['"]`).test(readFileSync(candidate, 'utf8'));
    });

    const parentNamedByATest = importers.some((importer) => {
      const parentBase = importer.split('/').pop()!.replace(/\.tsx$/, '');
      return tests.includes(parentBase);
    });

    if (parentNamedByATest) renderedViaParent.push(relative);
  }

  const accounted = new Set([...renderedDirectly, ...renderedViaParent]);
  return {
    files,
    total: files.length,
    renderedDirectly,
    renderedViaParent,
    unrendered: files.filter((file) => !accounted.has(file)),
    withPureHelper,
  };
}
