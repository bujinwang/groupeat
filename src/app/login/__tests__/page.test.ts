import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithSearchParams, textOf } from '@/lib/testing/render';

/**
 * `/login` — the form's initial paint, and the server action behind it.
 *
 * ## Why this suite is mostly about the action
 *
 * `page.tsx` is `'use client'`: under a server render it executes once with
 * `useActionState` at its initial value, so a render can prove the two inputs, the
 * autocomplete hints, the hidden `next` field and the absence of an error paragraph — and
 * nothing else. The submit button's `pending` branch, the error paragraph and the
 * `aria-describedby` wiring are all states a POST would produce, and a render cannot reach
 * them. That gap is stated here rather than papered over.
 *
 * The action, though, is ordinary server code and it had **no test anywhere in this
 * repo** before this file. `loginAction` is the only place `safeNext` is called, and
 * `safeNext` is an open-redirect guard: a login form that will forward to any URL a query
 * string names is a phishing kit with the real brand on it. A guard with no test is a
 * guard nobody has seen work.
 *
 * ## What is real and what is mocked
 *
 * `authenticate` and `applySessionCookie` are mocked, because a successful login needs a
 * bcrypt-verified password and a cookie jar. Everything the *action itself* decides is
 * real: the empty-field short circuit, which value reaches `redirect()`, and whether the
 * cookie is written at all. The four lines that matter are
 *
 *     const requested = safeNext(String(formData.get('next') ?? ''));
 *     redirect(requested ?? result.redirectTo);
 *
 * and the whole first describe block is about those two lines.
 */

vi.mock('server-only', () => ({}));

/**
 * `redirect()` throws a control-flow error, and that error is the return value of the
 * action. Capturing it is the only way to assert *where* the action decided to send
 * somebody — the real `next/navigation` redirect throws a `NEXT_REDIRECT` digest that the
 * framework unwraps, and asserting on a digest string would be asserting on an internal
 * format.
 */
const redirectError = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(public readonly destination: string) {
      super(`NEXT_REDIRECT:${destination}`);
      this.name = 'RedirectError';
    }
  }
  return RedirectError;
});

/**
 * `redirect()` is replaced; **everything else in `next/navigation` is kept**.
 *
 * The first version of this mock exported `redirect` and nothing else, so the page's
 * `useSearchParams()` had no implementation, threw, and the `<Suspense>` boundary rendered
 * *"Switched to client rendering because the server rendering errored: No 'useSearchParams'
 * export is defined on the 'next/navigation' mock"* — where the form should have been. The
 * assertion then failed on a page that had never rendered, which reads like a broken page.
 * `importOriginal` is the difference between stubbing one function and deleting a module.
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: (destination: string) => {
    throw new redirectError(destination);
  },
}));

const requestHeaders = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.headers.get(name) ?? null }),
}));

const authenticate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/credentials', () => ({ authenticate }));

const applySessionCookie = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ applySessionCookie }));

const { loginAction } = await import('@/app/login/actions');
const LoginPage = (await import('@/app/login/page')).default;

const SESSION = { userId: 'user-1', role: 'MERCHANT', mv: false };

/** A form submission, as `useActionState` would build it. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

/** Run the action and report where it redirected, or what state it returned. */
async function submit(
  fields: Record<string, string>,
): Promise<{ redirectedTo: string } | { error: string | null }> {
  try {
    const state = await loginAction({ error: null }, form(fields));
    return { error: state.error };
  } catch (error) {
    if (error instanceof redirectError) {
      return { redirectedTo: error.destination };
    }
    throw error;
  }
}

beforeEach(() => {
  requestHeaders.headers.clear();
  authenticate.mockReset();
  applySessionCookie.mockReset();
  authenticate.mockResolvedValue({
    ok: true,
    session: SESSION,
    redirectTo: '/merchant/drops',
  });
  applySessionCookie.mockResolvedValue(undefined);
});

describe('/login — the form as it first paints', () => {
  it('renders both fields with the autocomplete hints a password manager needs', async () => {
    const { html } = await renderWithSearchParams(LoginPage());

    expect(html).toContain('Sign in to your account.');
    expect(html).toContain('id="email"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('type="password"');
    // `autoComplete` is camel-cased in the element and lower-cased in the markup.
    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
  });

  it('paints no error and no alert role before anything has been submitted', async () => {
    // The negative that makes the error paragraph a real branch rather than decoration.
    const { html } = await renderWithSearchParams(LoginPage());

    expect(html).not.toContain('id="login-error"');
    expect(html).not.toContain('role="alert"');
    expect(textOf(html)).not.toContain('Email or password is incorrect');
  });

  it('carries `next` as a hidden field even when the query string has none', async () => {
    // `searchParams.get('next') ?? ''` — the field is always present, so the action's
    // `String(formData.get('next') ?? '')` is reading an empty string rather than null.
    // Asserting the empty value rather than the absence is the point: an absent field and a
    // present-but-empty one both fall back to `redirectTo`, and only one of them is what this
    // form actually sends.
    const { html } = await renderWithSearchParams(LoginPage());
    const hidden = /<input\b[^>]*type="hidden"[^>]*>/.exec(html);

    expect(hidden).not.toBeNull();
    expect(hidden![0]).toContain('name="next"');
    expect(hidden![0]).toContain('value=""');
  });

  it('forwards a `?next=` from the query string into the hidden field', async () => {
    // **Probe N survived without this test.** It replaced
    // `value={searchParams.get('next') ?? ''}` with a hardcoded `value=""` and the suite stayed
    // green, because the only `next` fixture rendered had no query string — the constant and
    // the read produced the same markup. A test whose fixture value equals the hardcoded
    // fallback cannot see the lookup; this one carries a value the fallback cannot produce.
    const { html } = await renderWithSearchParams(LoginPage(), '?next=/merchant/drops/abc-123');
    const hidden = /<input\b[^>]*type="hidden"[^>]*>/.exec(html);

    expect(hidden).not.toBeNull();
    expect(hidden![0]).toContain('value="/merchant/drops/abc-123"');
  });

  it('does not re-encode a `next` that already carries a query string of its own', async () => {
    // `searchParams.get()` decodes, and React re-escapes on the way into an attribute — so a
    // nested query string has to survive as one value rather than being split or double-encoded
    // (which would break `safeNext`'s same-origin check on a legitimate path).
    //
    // The nested `&` must be percent-encoded in the *outer* query string or `URLSearchParams`
    // splits it into a separate parameter and `next` loses its tail — the first version of this
    // test wrote a bare `&` and got `value="/admin/drops/abc?tab=orders"`. That is correct
    // parsing, not a page bug, and it is why a real caller has to encode too.
    const { html } = await renderWithSearchParams(
      LoginPage(),
      '?next=%2Fadmin%2Fdrops%2Fabc%3Ftab%3Dorders%26sort%3Dasc',
    );
    const hidden = /<input\b[^>]*type="hidden"[^>]*>/.exec(html);

    expect(hidden).not.toBeNull();
    // `&` is escaped to `&amp;` in markup, which is what the browser decodes back to `&`.
    expect(hidden![0]).toContain('value="/admin/drops/abc?tab=orders&amp;sort=asc"');
  });

  it('does not say which half of the credentials was wrong', async () => {
    // PRD-sprint1 §6.1. The page has one message and the string is in the action; the claim
    // here is that the *page* contains no second, more specific sentence.
    const { html } = await renderWithSearchParams(LoginPage());
    const text = textOf(html);

    expect(text).not.toMatch(/no such user|unknown email|wrong email|email not found/i);
    expect(text).not.toMatch(/incorrect password|wrong password/i);
  });
});

describe('/login — the action refuses before it authenticates', () => {
  it('returns the generic error for an empty email or password without calling authenticate', async () => {
    // A wasted bcrypt round per empty submit is a cheap denial of service, and the message is
    // deliberately the same one a wrong password produces.
    const blankEmail = await submit({ email: '   ', password: 'correct-horse-battery' });
    const blankPassword = await submit({ email: 'owner@example.test', password: '' });

    expect(blankEmail).toEqual({ error: 'Email or password is incorrect.' });
    expect(blankPassword).toEqual({ error: 'Email or password is incorrect.' });
    expect(authenticate).not.toHaveBeenCalled();
    expect(applySessionCookie).not.toHaveBeenCalled();
  });

  it('passes the trimmed email through untouched otherwise', async () => {
    // `email.trim().length === 0` decides emptiness but the *untrimmed* string is what reaches
    // `authenticate`, which normalises it. Asserting the exact argument keeps a later
    // `.trim()` from silently changing which row is looked up.
    authenticate.mockResolvedValue({ ok: false, status: 401, message: 'Email or password is incorrect.' });

    await submit({ email: '  owner@example.test  ', password: 'x' });

    expect(authenticate).toHaveBeenCalledWith('  owner@example.test  ', 'x', 'local');
  });

  it('reports the failure and writes no cookie', async () => {
    authenticate.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'Email or password is incorrect.',
    });

    const result = await submit({ email: 'owner@example.test', password: 'wrong' });

    expect(result).toEqual({ error: 'Email or password is incorrect.' });
    expect(applySessionCookie).not.toHaveBeenCalled();
  });

  it('passes the rate-limit message through verbatim', async () => {
    // The action does not rewrite the message — `credentials.ts` owns the copy, and a second
    // place that formats it is a second place to get "try again in a few minutes" wrong.
    authenticate.mockResolvedValue({
      ok: false,
      status: 429,
      message: 'Too many attempts. Try again in a few minutes.',
      retryAfterSeconds: 600,
    });

    const result = await submit({ email: 'owner@example.test', password: 'x' });

    expect(result).toEqual({ error: 'Too many attempts. Try again in a few minutes.' });
  });
});

describe('/login — `safeNext`, the open-redirect guard', () => {
  /**
   * Every one of these is a string a query string can carry. The action's only job is to
   * decide whether it is a path on this site; anything else falls back to the role's home.
   *
   * The list is written out rather than generated because each entry is a different *reason*
   * the guard rejects it, and the reason is the comment.
   */
  const OFF_SITE = [
    ['an absolute URL', 'https://evil.example/login'],
    ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/steal'],
    ['a backslash-relative URL', '/\\evil.example'],
    ['a scheme with no slashes', 'javascript:alert(1)'],
    ['a bare path with no leading slash', 'merchant/drops'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a whitespace-prefixed absolute URL', ' https://evil.example'],
  ] as const;

  for (const [reason, next] of OFF_SITE) {
    it(`refuses ${reason}, falling back to the role’s home`, async () => {
      const result = await submit({ email: 'owner@example.test', password: 'x', next });

      expect(result).toEqual({ redirectedTo: '/merchant/drops' });
      // The cookie is still written: the login succeeded, and the guard is about where the
      // browser goes next, not about whether the session is valid.
      expect(applySessionCookie).toHaveBeenCalledTimes(1);
    });
  }

  it('honours a same-origin path', async () => {
    const result = await submit({
      email: 'owner@example.test',
      password: 'x',
      next: '/admin/drops/abc-123?tab=orders',
    });

    expect(result).toEqual({ redirectedTo: '/admin/drops/abc-123?tab=orders' });
  });

  it('honours a single slash even though it is a valid path on its own', async () => {
    // `/` passes `startsWith('/')` and does not start with `//`, so it is forwarded. Asserted
    // so a future tightening to "must be longer than one character" is a decision rather than
    // an accident.
    const result = await submit({ email: 'owner@example.test', password: 'x', next: '/' });

    expect(result).toEqual({ redirectedTo: '/' });
  });

  it('falls back when `next` is the empty string, which is what the form always sends', async () => {
    // The page's hidden field is `value=""` when the query string has no `next`. This is the
    // common case, and it must take the role's home rather than redirect to `''`.
    const result = await submit({ email: 'owner@example.test', password: 'x', next: '' });

    expect(result).toEqual({ redirectedTo: '/merchant/drops' });
  });

  it('sends a temporary-password user to /change-password when no `next` was asked for', async () => {
    // `authenticate` chooses `redirectTo`, and the forced-change gate lives there. The action
    // must not override it with a role home.
    authenticate.mockResolvedValue({
      ok: true,
      session: { ...SESSION, mustChangePassword: true },
      redirectTo: '/change-password',
    });

    const result = await submit({ email: 'owner@example.test', password: 'x' });

    expect(result).toEqual({ redirectedTo: '/change-password' });
  });

  it('lets `next` beat the forced-change gate, which is the documented precedence', async () => {
    // A deliberate consequence worth pinning: `safeNext(...) ?? result.redirectTo` puts the
    // query string first. So a temporary-password user who arrives with `?next=/merchant/drops`
    // is forwarded there — and then bounced by middleware, which is where the gate actually
    // lives. Asserting it here means the behaviour is recorded rather than discovered.
    authenticate.mockResolvedValue({
      ok: true,
      session: { ...SESSION, mustChangePassword: true },
      redirectTo: '/change-password',
    });

    const result = await submit({
      email: 'owner@example.test',
      password: 'x',
      next: '/merchant/drops',
    });

    expect(result).toEqual({ redirectedTo: '/merchant/drops' });
  });
});

describe('/login — the rate-limit key', () => {
  it('uses the first hop of x-forwarded-for', async () => {
    requestHeaders.headers.set('x-forwarded-for', '203.0.113.9, 10.0.0.1, 10.0.0.2');

    await submit({ email: 'owner@example.test', password: 'x' });

    expect(authenticate).toHaveBeenCalledWith('owner@example.test', 'x', '203.0.113.9');
  });

  it('trims the hop, so a proxy that writes ", " does not split the bucket', async () => {
    requestHeaders.headers.set('x-forwarded-for', '  203.0.113.9  , 10.0.0.1');

    await submit({ email: 'owner@example.test', password: 'x' });

    expect(authenticate).toHaveBeenCalledWith('owner@example.test', 'x', '203.0.113.9');
  });

  it('falls back to x-real-ip, then to the literal "local"', async () => {
    requestHeaders.headers.set('x-real-ip', '198.51.100.4');
    await submit({ email: 'owner@example.test', password: 'x' });
    expect(authenticate).toHaveBeenLastCalledWith('owner@example.test', 'x', '198.51.100.4');

    requestHeaders.headers.clear();
    await submit({ email: 'owner@example.test', password: 'x' });
    expect(authenticate).toHaveBeenLastCalledWith('owner@example.test', 'x', 'local');
  });

  it('skips an empty first hop rather than using it as the key', async () => {
    // `', 10.0.0.1'` splits to `['', ' 10.0.0.1']`. The first element is empty, so the guard
    // falls through — and then to `x-real-ip`, **not** to the second hop. That is the right
    // answer: the second hop of a forwarded chain is a proxy, and keying a rate limit on
    // "the proxy" gives every caller behind it one shared bucket. The first draft of this test
    // asserted `10.0.0.1` and failed, which is how the distinction got written down.
    requestHeaders.headers.set('x-forwarded-for', ' , 10.0.0.1');

    await submit({ email: 'owner@example.test', password: 'x' });

    expect(authenticate).toHaveBeenCalledWith('owner@example.test', 'x', 'local');
  });

  it('prefers an empty x-forwarded-for over a present x-real-ip … for the empty answer', async () => {
    // The fall-through order is `x-forwarded-for` → first hop (if non-empty) → `x-real-ip` →
    // `'local'`, so a present-but-unusable forwarded header still lets `x-real-ip` decide.
    requestHeaders.headers.set('x-forwarded-for', ' ');
    requestHeaders.headers.set('x-real-ip', '198.51.100.7');

    await submit({ email: 'owner@example.test', password: 'x' });

    expect(authenticate).toHaveBeenCalledWith('owner@example.test', 'x', '198.51.100.7');
  });

  it('is computed per request, not captured at module load', async () => {
    // A `clientKey` hoisted out of the action would be `'local'` for every caller forever,
    // which turns a per-client limit into a single global one.
    requestHeaders.headers.set('x-forwarded-for', '203.0.113.9');
    await submit({ email: 'owner@example.test', password: 'x' });

    requestHeaders.headers.set('x-forwarded-for', '203.0.113.10');
    await submit({ email: 'owner@example.test', password: 'x' });

    expect(authenticate).toHaveBeenNthCalledWith(1, 'owner@example.test', 'x', '203.0.113.9');
    expect(authenticate).toHaveBeenNthCalledWith(2, 'owner@example.test', 'x', '203.0.113.10');
  });
});
