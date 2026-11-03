import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createElement } from 'react';

import { renderToHtml, textOf } from '@/lib/testing/render';

/**
 * `/change-password` — the one screen a temporary-password user can reach (S1-019).
 *
 * ## The page is thin; the action is the surface
 *
 * `page.tsx` is `'use client'` and holds no state of its own — its docblock says so ("the page
 * needs no state from the server"), and the render below confirms it: two password inputs, a
 * helper sentence, one submit button, no error paragraph. There is nothing else a render can
 * reach, because every interesting state after that comes from a POST.
 *
 * `changePasswordAction` had no test anywhere in this repo before this file. It is the only
 * caller of `lib/auth/credentials.changePassword`, and the two things it decides are worth
 * pinning:
 *
 *   1. **Where a failure is reported.** The page renders `state.error` inside a `Field` when
 *      `state.field` names that field, and in a standalone alert otherwise. So the action's
 *      choice of `field` decides *which* of three places the sentence appears, and a wrong
 *      choice puts "That is not your current password" under "New password".
 *   2. **That the session cookie is re-signed only on success.** A temporary-password user's
 *      session carries `mv = true`, which is what the middleware gate reads. Re-signing before
 *      the password is actually changed would open the gate while the temporary password still
 *      worked.
 */

vi.mock('server-only', () => ({}));

const redirectError = vi.hoisted(() => {
  class RedirectError extends Error {
    constructor(public readonly destination: string) {
      super(`NEXT_REDIRECT:${destination}`);
      this.name = 'RedirectError';
    }
  }
  return RedirectError;
});

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redirect: (destination: string) => {
    throw new redirectError(destination);
  },
}));

const changePassword = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/credentials', () => ({ changePassword }));

const applySessionCookie = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ applySessionCookie, getSession }));

const { changePasswordAction } = await import('@/app/change-password/actions');
const ChangePasswordPage = (await import('@/app/change-password/page')).default;

const SESSION = { userId: 'user-1', role: 'MERCHANT', mustChangePassword: true };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

async function submit(
  fields: Record<string, string>,
): Promise<{ error: string | null; field: string | null } | { redirectedTo: string }> {
  try {
    const state = await changePasswordAction({ error: null, field: null }, form(fields));
    return { error: state.error, field: state.field };
  } catch (error) {
    if (error instanceof redirectError) {
      return { redirectedTo: error.destination };
    }
    throw error;
  }
}

/**
 * Render the page **without calling it**.
 *
 * `renderToHtml(ChangePasswordPage())` — invoking the function in the argument list — throws
 * `Cannot read properties of null (reading 'useActionState')`, because the body runs eagerly
 * and `useActionState` needs a Suspense boundary above it. Handing over `createElement(Page)`
 * defers the call until React renders it, inside the boundary `renderToHtml` supplies. Probed
 * both ways; the eager form fails before a byte is written.
 *
 * Every other suite in this repo calls page functions directly, which is correct for an async
 * server component — the point there is to await its queries. This page is a client component
 * with a hook at the top, and that is the difference.
 */
async function renderPage(): Promise<string> {
  return renderToHtml(createElement(ChangePasswordPage));
}

  it('associates the policy helper with the input it describes', async () => {
    // Found by probe R on `/login`: deleting the whole `aria-describedby` wiring from a `Field`
    // changed no assertion, because no assertion existed. `Field` now wires its own helper and
    // error ids into the control, so this is the test that can see it — the helper paragraph
    // and the input are two separate elements, and only `aria-describedby` connects them.
    const html = await renderPage();

    const input = /<input\b[^>]*id="newPassword"[^>]*>/.exec(html);
    expect(input).not.toBeNull();
    expect(input![0]).toContain('aria-describedby="newPassword-helper"');
    // And the id it names is really in the document — a dangling reference is worse than none.
    expect(html).toContain('id="newPassword-helper"');
  });

  it('associates a field error with the input it belongs to', async () => {
    // The state a POST produces, rendered directly: `Field` is handed the error and must connect
    // it. Before this it rendered the sentence and left it unassociated, so a screen-reader
    // user heard "invalid entry" with no reason — on 51 of 52 call sites in this repo.
    const { Field } = await import('@/components/ui/Field');
    const html = await renderToHtml(
      createElement(Field, {
        id: 'currentPassword',
        label: 'Current password',
        error: 'That is not your current password.',
        children: createElement('input', {
          id: 'currentPassword',
          name: 'currentPassword',
          type: 'password',
        }),
      }),
    );

    expect(html).toContain('That is not your current password.');
    expect(html).toContain('id="currentPassword-error"');
    expect(html).toMatch(/<input\b[^>]*aria-describedby="currentPassword-error"/);
  });

  it('keeps a caller’s own aria-describedby and appends to it', async () => {
    // `/login` points its inputs at a standalone alert. Replacing that would silently drop the
    // alert from the accessibility tree, so `Field` extends rather than overwrites.
    const { Field } = await import('@/components/ui/Field');
    const html = await renderToHtml(
      createElement(Field, {
        id: 'email',
        label: 'Email',
        helper: 'Use your work address.',
        children: createElement('input', {
          id: 'email',
          name: 'email',
          'aria-describedby': 'some-alert',
        }),
      }),
    );

    expect(html).toMatch(/<input\b[^>]*aria-describedby="some-alert email-helper"/);
  });

  it('points at no id when there is neither a helper nor an error', async () => {
    // The false arm. A `Field` with nothing to describe must not emit
    // `aria-describedby=""` or name an id that was never rendered.
    const { Field } = await import('@/components/ui/Field');
    const html = await renderToHtml(
      createElement(Field, {
        id: 'plain',
        label: 'Plain',
        children: createElement('input', { id: 'plain', name: 'plain' }),
      }),
    );

    expect(html).not.toContain('aria-describedby');
  });

  it('renders a non-element child unchanged rather than throwing', async () => {
    // `isValidElement` is the guard. A text child is legal React and a `cloneElement` on it
    // would throw; this asserts the branch rather than trusting it.
    const { Field } = await import('@/components/ui/Field');
    const html = await renderToHtml(
      createElement(Field, { id: 'odd', label: 'Odd', helper: 'Just text.', children: 'not an element' }),
    );

    expect(textOf(html)).toContain('not an element');
    expect(html).toContain('id="odd-helper"');
  });

beforeEach(() => {
  changePassword.mockReset();
  applySessionCookie.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue(SESSION);
  applySessionCookie.mockResolvedValue(undefined);
});

describe('/change-password — the form as it first paints', () => {
  it('renders both password fields and the policy in words', async () => {
    const html = await renderPage();
    const text = textOf(html);

    expect(text).toContain('Choose a new password');
    expect(html).toContain('id="currentPassword"');
    expect(html).toContain('id="newPassword"');
    // The helper is the only place a user learns the rule before being rejected by it.
    expect(text).toContain('At least 12 characters, with at least one letter and one number.');
    expect(html).toContain('minLength="12"');
  });

  it('marks the two fields with the autocomplete values that keep them apart', async () => {
    // `current-password` and `new-password` tell a password manager to offer the saved
    // credential for one and generate a fresh one for the other. Both being
    // `current-password` makes a manager overwrite the saved password with the temporary one.
    const html = await renderPage();

    expect(html.toLowerCase()).toContain('autocomplete="current-password"');
    expect(html.toLowerCase()).toContain('autocomplete="new-password"');
  });

  it('paints no error before anything has been submitted', async () => {
    const html = await renderPage();

    expect(html).not.toContain('role="alert"');
    expect(textOf(html)).not.toContain('⚠');
  });

  it('explains the forced case without claiming the change is voluntary', async () => {
    // S1-019: the same screen serves both, and the copy has to work for a user who has no
    // choice. A sentence like "You can change your password here" would be a lie to them.
    const text = textOf(await renderPage());

    expect(text).toContain('you need to replace it before you can use the rest of GroupEat');
  });
});

describe('/change-password — the action', () => {
  it('sends a signed-out visitor to /login without calling changePassword', async () => {
    // The middleware gate should make this unreachable, which is exactly why it is asserted:
    // an action is a public endpoint, and a POST forged against it does not pass through the
    // page's gate.
    getSession.mockResolvedValue(null);

    const result = await submit({ currentPassword: 'a', newPassword: 'b' });

    expect(result).toEqual({ redirectedTo: '/login' });
    expect(changePassword).not.toHaveBeenCalled();
    expect(applySessionCookie).not.toHaveBeenCalled();
  });

  it('passes the session user, not the form, as the identity', async () => {
    // A `userId` field in the form would let one user change another's password. The action
    // must read the identity from the cookie and ignore anything the body says about it.
    changePassword.mockResolvedValue({
      ok: true,
      session: { ...SESSION, mustChangePassword: false },
      redirectTo: '/merchant/drops',
    });

    await submit({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
      userId: 'somebody-else',
    });

    expect(changePassword).toHaveBeenCalledWith('user-1', 'old-password-1', 'new-password-2');
  });

  it('re-signs the session and redirects on success', async () => {
    changePassword.mockResolvedValue({
      ok: true,
      session: { ...SESSION, mustChangePassword: false },
      redirectTo: '/merchant/drops',
    });

    const result = await submit({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    });

    expect(result).toEqual({ redirectedTo: '/merchant/drops' });
    // The re-signed session is what clears `mv`, which is what opens the middleware gate.
    expect(applySessionCookie).toHaveBeenCalledWith({ ...SESSION, mustChangePassword: false });
  });

  it('reports a wrong current password against that field, and writes no cookie', async () => {
    changePassword.mockResolvedValue({
      ok: false,
      status: 422,
      field: 'currentPassword',
      message: 'That is not your current password.',
    });

    const result = await submit({
      currentPassword: 'wrong',
      newPassword: 'new-password-2',
    });

    // The `field` is what puts the sentence under the right input: `'currentPassword'` renders
    // inside the current-password `Field`, and any other value renders it in the standalone
    // alert. Getting this backwards shows the message against the wrong box.
    expect(result).toEqual({
      error: 'That is not your current password.',
      field: 'currentPassword',
    });
    expect(applySessionCookie).not.toHaveBeenCalled();
  });

  it('reports a policy failure against the new password', async () => {
    changePassword.mockResolvedValue({
      ok: false,
      status: 422,
      field: 'newPassword',
      message: 'Password must be at least 12 characters.',
    });

    const result = await submit({ currentPassword: 'old-password-1', newPassword: 'short' });

    expect(result).toEqual({
      error: 'Password must be at least 12 characters.',
      field: 'newPassword',
    });
  });

  it('reports a missing user as a general failure, with no field', async () => {
    // `changePassword` returns `status: 401` and **no `field`** when the row is gone. The
    // action forwards `result.field ?? null`, so the page falls back to its standalone alert —
    // the right place for "Please sign in again.", which belongs to neither input.
    changePassword.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'Please sign in again.',
    });

    const result = await submit({ currentPassword: 'a', newPassword: 'b' });

    expect(result).toEqual({ error: 'Please sign in again.', field: null });
    expect(applySessionCookie).not.toHaveBeenCalled();
  });

  it('does not trim or transform the passwords', async () => {
    // A password is not an email. Trimming would silently change what the user typed, and the
    // stored hash would then disagree with the password they believe they set.
    changePassword.mockResolvedValue({
      ok: false,
      status: 422,
      field: 'currentPassword',
      message: 'That is not your current password.',
    });

    await submit({ currentPassword: '  spaced  ', newPassword: ' also-spaced ' });

    expect(changePassword).toHaveBeenCalledWith('user-1', '  spaced  ', ' also-spaced ');
  });

  it('substitutes an empty string for a missing field rather than the word "null"', async () => {
    // `String(formData.get('x') ?? '')` — a hand-rolled POST with no fields must not reach
    // `changePassword` with the string `'null'`, which would pass a length check.
    changePassword.mockResolvedValue({
      ok: false,
      status: 422,
      field: 'currentPassword',
      message: 'That is not your current password.',
    });

    await submit({});

    expect(changePassword).toHaveBeenCalledWith('user-1', '', '');
  });
});
