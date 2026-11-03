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
 * ## What "mutating" means, precisely
 *
 * An export named `POST`, `PUT`, `PATCH` or `DELETE`. `GET` and `HEAD` are not in the
 * list, and the scope read they perform is deliberately still `requireMerchant()` —
 * reading is what impersonation is *for*. A test that demanded the write gate on `GET`
 * would push somebody to weaken the read path to make it pass.
 *
 * ## Why it fails loudly on an empty scan
 *
 * A glob that silently matches nothing passes every assertion in it. If `API_ROOT` were
 * ever moved, this file would go green and stop protecting anything — so the file count
 * is asserted first, against a number small enough to be stable and large enough that a
 * broken walk cannot reach it. The count is a floor, not an equality: adding routes must
 * not fail this test, only losing the walk must.
 */

const API_ROOT = join(process.cwd(), 'src/app/api/merchant');

const MUTATING_EXPORTS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** The gate under test. Named once so the diagnostic and the assertion cannot drift. */
const WRITE_GATE = 'requireMerchantWrite()';

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

const files = routeFiles(API_ROOT);
const allHandlers = files.flatMap(handlers);
const mutating = allHandlers.filter((handler) =>
  (MUTATING_EXPORTS as readonly string[]).includes(handler.method),
);

describe('FR-904 · the scan itself', () => {
  it('found the merchant route tree', () => {
    // A floor, not an equality: adding a route must not fail this file. If this number
    // stops being reached, the walk is broken and every assertion below is vacuous.
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(mutating.length).toBeGreaterThanOrEqual(11);
  });

  it('found both kinds of handler, so the split works', () => {
    // If `handlers` returned only one kind, the filter below would be meaningless in one
    // direction or the other — and a splitter bug is a silent pass, not a visible error.
    expect(allHandlers.some((handler) => handler.method === 'GET')).toBe(true);
    expect(mutating.length).toBeLessThan(allHandlers.length);
  });
});

describe('FR-904 · every mutating merchant handler refuses a borrowed session', () => {
  for (const handler of mutating) {
    it(`${handler.method} ${handler.file}`, () => {
      expect(
        handler.body.includes(WRITE_GATE),
        `${handler.file} exports ${handler.method} but never calls ${WRITE_GATE}. ` +
          'An impersonating admin could change this merchant\'s data. Use ' +
          '`requireMerchantWrite()` instead of `requireMerchant()`.',
      ).toBe(true);
    });
  }

  it('no mutating handler still calls the read gate', () => {
    // `requireMerchantWrite` calls `requireMerchant` internally, so a handler that calls
    // both is not wrong — but a handler that calls only the read gate is exactly the
    // hole, and it is invisible in review because the call looks identical.
    const offenders = mutating.filter(
      (handler) =>
        handler.body.includes('requireMerchant()') && !handler.body.includes(WRITE_GATE),
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
