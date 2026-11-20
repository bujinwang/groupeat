import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

import { errorResponse, invalidBody } from '../http';

/**
 * Every production `.ts`/`.tsx` file under `dir`, excluding tests.
 *
 * A walk rather than a hand-written list: a list stops covering the directory someone
 * adds next, and the guard below would then pass while the thing it guards is live.
 */
function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      files.push(...productionSources(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * `errorResponse` — the one place an exception becomes an HTTP response.
 *
 * ## The hole this closes, measured
 *
 * V8 coverage over the full suite: `src/lib/http.ts` executed **23 of 35
 * statements**, 8 of 10 branches, 1 of 2 functions. Two regions were dark:
 *
 *   - lines 33–42, the entire `ZodError` → 422 branch (`for` loop, `path.join`,
 *     the `|| 'form'` fallback, the response). Branch arm `32:33` — the `return`
 *     inside it — had **0 hits**.
 *   - lines 57–58, `invalidBody`. Function `invalidBody@56` had **0 calls**.
 *
 * Plus one arm that is single-sided: `46:43`, the `'unknown'` half of
 * `error instanceof Error ? error.name : 'unknown'`. Nothing in the suite has ever
 * thrown a non-`Error`, so the day a library throws a bare string, the log line has
 * never been observed doing the right thing.
 *
 * ## What the measurement turned up, which is worth more than the number
 *
 * The docblock of `http.ts` presents a three-row contract table:
 *
 *     | `AppError`  | its own status, its safe public message, its `fieldErrors` |
 *     | `ZodError`  | 422 with per-field messages                                 |
 *     | anything else | 500 with a generic message                               |
 *
 * Row 2 is **not reachable from this tree**, and that is a measurement rather than
 * an impression: `grep -rn '\.parse(' src` (excluding tests, excluding this file)
 * returns **zero** zod calls — every one of the sixteen validation sites in the
 * routes uses `safeParse` and branches on `!parsed.success` with its own inline
 * `NextResponse`. Nothing in `src/` can throw a `ZodError` at `errorResponse`.
 *
 * That is why it sat at 0 % while 33 call sites "used" the function: the branch is
 * not untested, it is **unexercised because it is unreachable**. A per-file coverage
 * number would have called it neglect; the branch map calls it dead.
 *
 * Rather than delete it — a production change with no mandate, and the branch is
 * correct for the day a route does throw — this file does three things: it executes
 * the branch so its behaviour is pinned, it records the behaviour that the
 * `join/input.ts` comment gets **wrong**, and it adds a guard that fails if the
 * branch's unreachability stops being true (at which point it needs route-level
 * tests, not these).
 *
 * ## The false claim this found
 *
 * `src/lib/join/input.ts:118` says:
 *
 *     // First message wins, matching `errorResponse`'s behaviour: a field with two
 *     // problems should show the one that comes first, not the last one written.
 *
 * Measured, with one field carrying both a `min` and an `email` failure:
 *
 *     errorResponse (last wins) : {"email":"Invalid email"}
 *     join/input   (first wins) : {"email":"String must contain at least 10 character(s)"}
 *
 * It is the opposite. `errorResponse` writes `fieldErrors[key] = issue.message`
 * unconditionally, so the *last* issue for a key overwrites the earlier ones — and
 * `join/input` uses `??=`. The comment claims parity with a behaviour that is the
 * reverse of the one it describes. Test 8 below pins both sides so the sentence
 * cannot drift back.
 *
 * There is a second divergence in the same family, also measured: the branch keys on
 * `issue.path.join('.')` while the six route-local loops key on `issue.path[0]`. For
 * a nested issue the route loops report `a`, this branch reports `a.b`; for a
 * root-level `ZodError` issue (`path: []`) the route loops drop the message entirely
 * (`{}`) while this branch files it under `'form'`.
 */

vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const logError = vi.mocked(logger.error);

type Body = {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};

async function bodyOf(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

/** A real `ZodError`, from a real schema — not a hand-built stub. */
function zodErrorFor(schema: z.ZodTypeAny, input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error('this fixture was supposed to fail validation');
  return parsed.error;
}

describe('errorResponse — an AppError keeps its own status and its safe message', () => {
  it('maps a 422 to VALIDATION and passes the field errors through untouched', async () => {
    const response = errorResponse(
      AppError.validation({ dealPriceCents: 'Use a whole number of cents.' }),
      'api/test',
    );

    expect(response.status).toBe(422);
    const body = await bodyOf(response);
    expect(body.error).toBe('VALIDATION');
    expect(body.fieldErrors).toEqual({ dealPriceCents: 'Use a whole number of cents.' });
  });

  it('reports fieldErrors as {} — never undefined — when the AppError carries none', async () => {
    // The `?? {}` on line 26 is the whole reason a client can call
    // `Object.keys(body.fieldErrors)` without a guard. Removing it sends `undefined`,
    // which serialises to a missing key: a 422 with no field errors at all reads to a
    // client exactly like a validation failure it cannot act on.
    const response = errorResponse(new AppError(422, 'Check the values you entered.'), 'api/test');

    expect(response.status).toBe(422);
    const body = await bodyOf(response);
    expect(body.fieldErrors).toEqual({});
    expect('fieldErrors' in body).toBe(true);
  });

  it('maps every non-422 AppError to REQUEST_FAILED, at the status the AppError chose', async () => {
    // The vocabulary is deliberately two-valued: `VALIDATION` means "change what you
    // typed", `REQUEST_FAILED` means "the request was fine and it still did not work".
    // A 409 leaking out as VALIDATION would invite the merchant to retype a body that
    // was never the problem.
    const cases = [
      { error: AppError.unauthorized(), status: 401 },
      { error: AppError.forbidden(), status: 403 },
      { error: AppError.notFound(), status: 404 },
      { error: AppError.conflict(), status: 409 },
      { error: AppError.badRequest(), status: 400 },
    ];

    for (const { error, status } of cases) {
      const response = errorResponse(error, 'api/test');
      expect(response.status, `status for ${error.status}`).toBe(status);
      expect((await bodyOf(response)).error, `error code for ${status}`).toBe('REQUEST_FAILED');
    }
  });

  it('returns the AppError publicMessage verbatim, not a generic one', async () => {
    // `publicMessage` is the field whose whole purpose is being safe to show. Falling
    // back to "Something went wrong" here would make every refusal in the product
    // indistinguishable from a crash.
    const response = errorResponse(
      AppError.conflict('This drop has already been published.'),
      'api/test',
    );
    expect((await bodyOf(response)).message).toBe('This drop has already been published.');
  });
});

describe('errorResponse — a ZodError becomes a 422 with per-field messages', () => {
  /**
   * Nothing in `src/` throws a `ZodError` today (see this file's docblock). These
   * tests exist so that the branch is *defined* rather than merely present, and the
   * guard at the bottom of this file is what keeps "nothing throws one" a measured
   * fact instead of a belief.
   */

  it('turns one issue into a 422 naming that field', async () => {
    const error = zodErrorFor(z.object({ email: z.string().email() }), { email: 'nope' });

    const response = errorResponse(error, 'api/test');

    expect(response.status).toBe(422);
    const body = await bodyOf(response);
    expect(body.error).toBe('VALIDATION');
    expect(body.message).toBe('Check the values you entered.');
    expect(body.fieldErrors).toEqual({ email: 'Invalid email' });
  });

  it('keys a nested issue by its dotted path, not by its first segment', async () => {
    // `path.join('.')`. The route-local loops in `src/app/api` use `path[0]`, so the
    // same issue is filed as `a` there and `a.b` here. That divergence is real and
    // currently harmless (no request body is nested), but pinning it means nobody
    // "fixes" one side by copying the other without noticing the difference.
    const error = zodErrorFor(z.object({ a: z.object({ b: z.string() }) }), { a: { b: 5 } });

    const body = await bodyOf(errorResponse(error, 'api/test'));
    expect(Object.keys(body.fieldErrors ?? {})).toEqual(['a.b']);
  });

  it("files a root-level issue under 'form'", async () => {
    // A root `.refine()` produces `path: []`, so `[].join('.')` is `''`, which is
    // falsy, which is what `|| 'form'` exists for. Verified as a real zod behaviour
    // before writing this: `z.object({a: z.number()}).refine(...)` yields
    // `[ [], 'must be positive' ]`.
    //
    // This is the sharpest divergence in the family: the six route-local loops do
    // `issue.path[0]` behind a `typeof field === 'string'` check, so a root-level
    // issue is **silently dropped** (`{}`). Here it survives under `'form'`.
    const schema = z
      .object({ a: z.number() })
      .refine((value) => value.a > 0, { message: 'must be positive' });
    const error = zodErrorFor(schema, { a: -1 });

    const body = await bodyOf(errorResponse(error, 'api/test'));
    expect(body.fieldErrors).toEqual({ form: 'must be positive' });
  });

  it('keeps the LAST message when one field fails twice — and join/input keeps the first', async () => {
    // Measure of the sentence in `src/lib/join/input.ts:118`, which claims
    // "First message wins, matching `errorResponse`'s behaviour". They do not match.
    // `errorResponse` does `fieldErrors[key] = issue.message` (unconditional, so last
    // wins); `join/input` does `fieldErrors[key] ??= issue.message` (first wins).
    const schema = z.object({ email: z.string().min(10).email() });
    const error = zodErrorFor(schema, { email: 'a@b' });

    // The fixture is only meaningful if the field really does fail twice.
    expect(error.issues.filter((issue) => issue.path.join('.') === 'email')).toHaveLength(2);

    const body = await bodyOf(errorResponse(error, 'api/test'));
    expect(body.fieldErrors).toEqual({ email: 'Invalid email' });

    // The same issues through `join/input`'s rule, to state the divergence instead of
    // describing it: first-wins would have said "at least 10 character(s)".
    const firstWins: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join('.') || 'form';
      firstWins[key] ??= issue.message;
    }
    expect(firstWins.email).toBe('String must contain at least 10 character(s)');
    expect(body.fieldErrors?.email).not.toBe(firstWins.email);
  });
});

describe('errorResponse — anything else is a 500 that leaks nothing', () => {
  it('logs the route and the error name, and returns a generic message', async () => {
    logError.mockClear();

    const response = errorResponse(new TypeError('cannot read properties of undefined'), 'api/test');

    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body.error).toBe('INTERNAL');
    expect(body.message).toBe('Something went wrong. Try again.');
    expect(logError).toHaveBeenCalledWith('api.unhandled_error', {
      route: 'api/test',
      reason: 'TypeError',
    });
  });

  it('never puts the thrown message in the response body', async () => {
    // The 500 path exists so a Prisma or Stripe message never reaches a diner. The
    // message is thrown away on the floor — this asserts the floor is still there.
    const secret = 'No such destination: acct_test_leaky_message';

    const response = errorResponse(new Error(secret), 'api/test');

    const raw = JSON.stringify(await bodyOf(response));
    expect(raw).not.toContain('acct_test_leaky_message');
    expect(raw).not.toContain('No such destination');
  });

  it("logs reason 'unknown' when what was thrown is not an Error", async () => {
    // The other half of `error instanceof Error ? error.name : 'unknown'`, which had
    // never executed: every throw in the suite is an `Error`. A rejected promise from a
    // library that throws a bare string would land here, and `error.name` on a string
    // is `undefined` — the log line would read `reason: undefined`, which is a worse
    // signal than no field at all.
    logError.mockClear();

    const response = errorResponse('a bare string', 'api/test');

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith('api.unhandled_error', {
      route: 'api/test',
      reason: 'unknown',
    });
  });

  it('treats null and undefined the same way as any other non-Error', async () => {
    // `throw undefined` is legal, and `instanceof` on it is false rather than fatal.
    for (const thrown of [null, undefined, 0, {}, []]) {
      logError.mockClear();
      const response = errorResponse(thrown, 'api/test');
      expect(response.status).toBe(500);
      expect(logError).toHaveBeenCalledWith('api.unhandled_error', {
        route: 'api/test',
        reason: 'unknown',
      });
    }
  });
});

describe('invalidBody — the 400 for a body that is not shaped as expected', () => {
  it('is AppError.badRequest with a default message, indistinguishable from it', async () => {
    // It had never been called: zero importers, zero executions. Pinning it as an exact
    // alias is the honest assertion — if it ever grows a custom status or message, this
    // fails and someone has to decide whether a second 400 vocabulary is wanted.
    const viaHelper = invalidBody();
    const viaStatic = AppError.badRequest();

    expect(viaHelper).toBeInstanceOf(AppError);
    expect(viaHelper.status).toBe(viaStatic.status);
    expect(viaHelper.publicMessage).toBe(viaStatic.publicMessage);

    const response = errorResponse(viaHelper, 'api/test');
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(body.error).toBe('REQUEST_FAILED');
    expect(body.message).toBe('That request could not be processed.');
  });

  it('honours a caller-supplied message', async () => {
    expect(invalidBody('Send a JSON object.').publicMessage).toBe('Send a JSON object.');
  });
});

describe('the ZodError branch is unreachable from this tree — guarded, not assumed', () => {
  /**
   * The guard this file exists for.
   *
   * The tests above prove the branch *works*. They cannot prove it is *needed*, and
   * that distinction is the whole finding: 33 call sites "use" `errorResponse` and
   * not one of them can produce a `ZodError`. If a route ever adds a throwing
   * `.parse(`, the branch becomes live — and these unit tests would still pass while
   * the route that reaches it stays untested. This assertion fails at that moment, so
   * the discovery is made by the build rather than by the next coverage census.
   */
  it('no production source hands a ZodError to errorResponse', () => {
    const root = process.cwd();
    const files = productionSources(join(root, 'src'));

    const offenders: string[] = [];
    for (const file of files) {
      // `src/lib/http.ts` is where the branch lives, so it necessarily mentions the
      // shape of the check. Every other file must not throw a zod parse.
      if (file.endsWith(join('lib', 'http.ts'))) continue;
      // A throwing parse is `.parse(`; `safeParse(` ends in `safeParse(` and is caught
      // by the lookbehind. `JSON`/`Number`/`Date`/`Float`/`Int` are the other owners of
      // a `.parse` method in this tree and none of them throw a `ZodError`.
      if (/(?<!safe)(?<!JSON)(?<!Number)(?<!Date)(?<!Float)(?<!Int)\.parse\s*\(/.test(
        readFileSync(file, 'utf8'),
      )) {
        offenders.push(file.slice(root.length + 1));
      }
    }

    // The floor is not a target: it fails loudly if the walk breaks, without pinning a
    // count that legitimately grows with every file added.
    expect(files.length, 'production .ts/.tsx files walked').toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
