import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { verifyPassword } from '@/lib/auth/password';
import { issuePasswordInvite } from '@/lib/auth/password-invite';
import { prisma } from '@/lib/db/prisma';
import { renderToHtml, textOf } from '@/lib/testing/render';

import { setPasswordAction } from '../actions';

/**
 * FR-101's acceptance surface, against real Postgres.
 *
 * The loader test proves a token is issued and consumed; this proves the page shows the
 * form only for a live token and that the action updates the account and burns the link.
 * The page is a server component with one client form, so `renderToHtml` can execute it
 * without a browser; the form's submit is exercised by calling the action directly,
 * which is what a browser would post.
 */

const PREFIX = `setpw${Date.now().toString(36).slice(-5)}`;
const createdUserIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${tag}@example.test`,
      passwordHash: 'old-hash',
      role: 'MERCHANT',
      mustChangePassword: true,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function renderPage(token: string): Promise<{ html: string; text: string }> {
  const page = await import('@/app/set-password/page');
  const html = await renderToHtml(
    await page.default({ searchParams: Promise.resolve({ token }) }),
  );
  return { html, text: textOf(html) };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeAll(async () => {
  // Users are created per test; this hook documents that teardown owns them.
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe('/set-password', () => {
  it('renders the form for a live invitation, with the token in the form', async () => {
    const userId = await makeUser('live');
    const invite = await issuePasswordInvite(userId);

    const { html, text } = await renderPage(invite.token);

    expect(text).toContain('Choose your password');
    expect(text).toContain('Set password');
    expect(html).toContain(`name="token" value="${invite.token}"`);
  });

  it('renders one refusal for an unknown, used or expired token', async () => {
    const unknown = await renderPage('not-a-token');
    expect(unknown.text).toContain("This link can't be used");
    expect(unknown.text).not.toContain('Set password');

    const userId = await makeUser('used');
    const invite = await issuePasswordInvite(userId);
    await setPasswordAction(
      { error: null, fieldErrors: {}, done: false },
      form({
        token: invite.token,
        password: 'correct-horse-battery-9',
        confirmPassword: 'correct-horse-battery-9',
      }),
    );

    const used = await renderPage(invite.token);
    expect(used.text).toContain("This link can't be used");
  });

  it('sets the password, clears the temporary flag, and refuses a replay', async () => {
    const userId = await makeUser('accept');
    const invite = await issuePasswordInvite(userId);

    const state = await setPasswordAction(
      { error: null, fieldErrors: {}, done: false },
      form({
        token: invite.token,
        password: 'correct-horse-battery-9',
        confirmPassword: 'correct-horse-battery-9',
      }),
    );

    expect(state).toEqual({ error: null, fieldErrors: {}, done: true });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(user.mustChangePassword).toBe(false);
    expect(await verifyPassword('correct-horse-battery-9', user.passwordHash)).toBe(true);

    const replay = await setPasswordAction(
      { error: null, fieldErrors: {}, done: false },
      form({
        token: invite.token,
        password: 'another-password-9',
        confirmPassword: 'another-password-9',
      }),
    );
    expect(replay.done).toBe(false);
    expect(replay.error).toContain('no longer valid');
  });

  it('validates the password policy and the confirmation before touching the token', async () => {
    const userId = await makeUser('policy');
    const invite = await issuePasswordInvite(userId);

    const state = await setPasswordAction(
      { error: null, fieldErrors: {}, done: false },
      form({ token: invite.token, password: 'short', confirmPassword: 'short' }),
    );

    expect(state.done).toBe(false);
    expect(state.fieldErrors.password).toContain('12 characters');
    // The token is still live: a validation error must not consume it.
    expect(await prisma.passwordInvite.count({ where: { userId, usedAt: null } })).toBe(1);
  });
});
