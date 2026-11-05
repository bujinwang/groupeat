import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * FR-904 — every mutating merchant route must refuse a borrowed session.
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 * > — PRD-v1.md:551
 *
 * ## Why this test is a source scan rather than a request
 *
 * The rule lives in `refuseIfImpersonating`, and calling one route with an impersonating
 * session proves that one route is wired. The failure mode is the route somebody adds
 * next month, and no runtime test can cover a handler that does not exist yet.
 *
 * So this walks the tree instead. It is the same argument as
 * `audit-append-only.test.ts`: a convention that is only written down in a docblock is
 * a convention that gets missed on the twelfth route; one that is grepped for is not.
 * Here the grep is cheap because the convention has exactly one correct spelling —
 * `requireMerchantWrite()` — and the gate it wraps is the only thing that both reads the
 * scope and refuses the write.
 *
 * ## Why `/api/organiser` is walked too, from gap 18
 *
 * The original version of this file scanned `src/app/api/merchant` only, and said so:
 * *"a mutating merchant operation added as a server action or under a new route group
 * would not be caught until its roots are extended."* Gap 18 added the first mutating
 * organiser handler (`POST /api/organiser/drops/:id/share`), which is exactly the
 * moment that sentence described — so the root is extended now, with its own expected
 * gate, rather than after something has already slipped through.
 *
 * Organiser impersonation does not exist yet. That is the reason to assert the gate, not
 * a reason to skip it: the guard is reachable through a signed claim, so it can break,
 * and if impersonation is ever widened the write path is already shut.
 *
 * ## What "mutating" means, precisely
 *
 * An export named `POST`, `PUT`, `PATCH` or `DELETE`. `GET` and `HEAD` are not in the
 * list, and the scope read they perform is deliberately still `requireMerchant()` —
 * reading is what impersonation is *for*. A test that demanded the write gate on `GET`
 * would push somebody to weaken the read path to make it pass.
 *
 * ## Why it fails loudly on an empty scan
 *
 * A glob that silently matches nothing passes every assertion in it. If a root were
 * ever moved, this file would go green and stop protecting anything — so the file count
 * is asserted first, against a number small enough to be stable and large enough that a
 * broken walk cannot reach it. The count is a floor, not an equality: adding routes must
 * not fail this test, only losing the walk must.
 */

/** Each surface and the one gate its mutating handlers must call. */
const ROOTS: readonly { readonly root: string; readonly gate: string }[] = [
  // The gate is a prefix, not the exact `()` spelling: the redemption route calls
  // `requireMerchantWrite({ allowStaff: true })` and is still on the write gate.
  { root: 'src/app/api/merchant', gate: 'requireMerchantWrite(' },
  { root: 'src/app/api/organiser', gate: 'requireOrganiserWrite(' },
];

const MUTATING_EXPORTS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Test directories hold `POST` calls of their own through mocked modules, and an
      // `__tests__` folder is not a route. Skipping is not an escape hatch: a test file
      // is never imported by Next's router.
      if (entry === '__tests__') {
        continue;
      }
      found.push(...routeFiles(full));
      continue;
    }
    if (entry === 'route.ts') {
      found.push(full);
    }
  }

  return found;
}

type Handler = {
  readonly file: string;
  readonly method: string;
  readonly body: string;
};

/**
 * Splits a route file into its exported handlers.
 *
 * A handler runs from its `export` line to the next line that is exactly `}` in column
 * zero, which is how every handler in this codebase is formatted. Crude on purpose: it
 * cannot be fooled by a call in the imports at the top, which is the mistake a naive
 * `.includes()` over the whole file would make — and one `GET` with the write gate would
 * then hide a `POST` without it.
 */
function handlers(file: string): Handler[] {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const out: Handler[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /^export async function (GET|POST|PUT|PATCH|DELETE)\(/.exec(line);
    if (!match) {
      continue;
    }

    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j] === '}') {
        end = j;
        break;
      }
    }

    out.push({
      file: relative(process.cwd(), file),
      method: match[1] ?? '',
      body: lines.slice(i, end + 1).join('\n'),
    });
  }

  return out;
}

const files = ROOTS.flatMap(({ root }) => routeFiles(join(process.cwd(), root)));
const allHandlers = files.flatMap(handlers);
/** `files` is absolute; `handlers` reports relative paths. Compare in one unit. */
const relativeFiles = files.map((file) => relative(process.cwd(), file));

/** Every mutating handler, paired with the gate its own surface requires. */
const mutating = allHandlers
  .filter((handler) => (MUTATING_EXPORTS as readonly string[]).includes(handler.method))
  .map((handler) => {
    const owner = ROOTS.find(({ root }) => handler.file.startsWith(root));
    // A handler outside every declared root cannot be gated by a rule nobody wrote for it,
    // so it is a failure of this file rather than a pass.
    expect(owner, `${handler.file} is not under any declared ROOTS entry`).toBeDefined();
    return { ...handler, gate: owner?.gate ?? '' };
  });

describe('FR-904 · the scan itself', () => {
  it('found the route trees', () => {
    // A floor, not an equality: adding a route must not fail this file. If this number
    // stops being reached, the walk is broken and every assertion below is vacuous.
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(mutating.length).toBeGreaterThanOrEqual(12);
  });

  it('found both roots, so extending one did not silently replace the other', () => {
    // A `ROOTS` entry pointing at a path that does not exist contributes nothing and
    // raises nothing — the same silent-empty-walk failure this file already guards
    // against one level up.
    for (const { root } of ROOTS) {
      expect(
        relativeFiles.some((file) => file.startsWith(root)),
        `no route.ts found under ${root}`,
      ).toBe(true);
    }
  });

  it('found both kinds of handler, so the split works', () => {
    // If `handlers` returned only one kind, the filter below would be meaningless in one
    // direction or the other — and a splitter bug is a silent pass, not a visible error.
    expect(allHandlers.some((handler) => handler.method === 'GET')).toBe(true);
    expect(mutating.length).toBeLessThan(allHandlers.length);
  });
});

describe('FR-904 · every mutating handler refuses a borrowed session', () => {
  for (const handler of mutating) {
    it(`${handler.method} ${handler.file}`, () => {
      expect(
        handler.body.includes(handler.gate),
        `${handler.file} exports ${handler.method} but never calls ${handler.gate}. ` +
          'An impersonating admin could change data on this surface. Use the write gate ' +
          'for the surface you are on, not the read one.',
      ).toBe(true);
    });
  }

  it('no mutating handler still calls a read gate only', () => {
    // `requireMerchantWrite` calls `requireMerchant` internally, so a handler that calls
    // both is not wrong — but a handler that calls only the read gate is exactly the
    // hole, and it is invisible in review because the call looks identical.
    const offenders = mutating.filter(
      (handler) =>
        (handler.body.includes('requireMerchant()') ||
          handler.body.includes('requireOrganiser()')) &&
        !handler.body.includes(handler.gate),
    );

    expect(offenders.map((handler) => `${handler.method} ${handler.file}`)).toEqual([]);
  });
});

describe('FR-904 · the exit route is reachable from a borrowed session', () => {
  it('lives under /api/auth, not /api/admin', () => {
    // The structural half of the guarantee. An impersonation session's role is
    // `MERCHANT` and `middleware.ts` gates `/api/admin` on being an `ADMIN`, so an exit
    // route there would be unreachable — an admin who could not leave. The exit is
    // authorised by the signed claim instead, which works from any role.
    const exit = join(process.cwd(), 'src/app/api/auth/impersonation/end/route.ts');
    const source = readFileSync(exit, 'utf8');

    expect(source).toMatch(/export async function POST\(/);
    // And it must clear the cookie when the admin row is gone, or the browser keeps a
    // session nobody can end.
    expect(source).toContain('clearSessionCookie');
  });
});
