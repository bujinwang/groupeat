import type { Metadata } from 'next';

import { Card } from '@/components/ui/Card';
import { findValidPasswordInvite } from '@/lib/auth/password-invite';

import { SetPasswordForm } from './SetPasswordForm';

/**
 * `/set-password?token=…` — FR-101's acceptance page.
 *
 * > `FR-101 | Ops creates a Merchant and invites an Owner by email | Owner receives a
 * > set-password link valid 72h` — PRD-v1.md:442
 *
 * ## It is public on purpose, and that is not the same as unauthenticated authorisation
 *
 * The visitor has no session yet; the token **is** the credential. The page asks the
 * store whether that token is currently usable, and renders a form only when it is. The
 * action consumes it, so a page render is a hint and the accept is the lock.
 *
 * ## One sentence for every bad token
 *
 * Unknown, consumed and expired all render the same message. The distinction would let
 * a stranger test whether a guessed token ever existed, and the legitimate holder's next
 * step is identical in all three cases.
 *
 * ## No referrer, no cache
 *
 * The token is in the URL. A page that let the browser send it in a `Referer` header, or
 * a shared proxy that cached the HTML, would move a bearer credential somewhere it was
 * never meant to go. `next.config.ts` supplies both headers for this path; this page is
 * also dynamic, so there is no static copy to serve.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set your password — GroupEat',
  robots: { index: false, follow: false },
};

function tokenFrom(raw: string | string[] | undefined): string {
  return typeof raw === 'string' ? raw : '';
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const token = tokenFrom(query.token);
  const invite = token.length > 0 ? await findValidPasswordInvite(token) : null;

  if (!invite) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <Card>
          <h1 className="text-lg font-semibold">This link can&apos;t be used</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            The invitation has expired or has already been used. Ask your GroupEat contact
            to send a new one — there is nothing else you need to do.
          </p>
          <a
            href="/login"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-muted"
          >
            Go to sign in
          </a>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <Card>
        <h1 className="text-lg font-semibold">Choose your password</h1>
        <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-soft">
          This is the owner account for your restaurant on GroupEat. The link works once.
        </p>
        <SetPasswordForm token={token} />
      </Card>
    </main>
  );
}
