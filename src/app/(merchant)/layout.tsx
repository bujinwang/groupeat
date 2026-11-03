import type { ReactNode } from 'react';

import { AppNav } from '@/components/AppNav';
import { ImpersonationBanner } from '@/components/merchant/ImpersonationBanner';
import { requireRoleOrRedirect } from '@/lib/auth/authorize';
import { impersonationBanner } from '@/lib/auth/impersonation';

/**
 * Merchant shell.
 *
 * The role gate is here as well as in `middleware.ts` on purpose
 * (ARCHITECTURE-sprint1 §7.3): middleware is a redirect convenience, and a
 * matcher change must not become an authorisation hole.
 *
 * ## FR-904's banner lives here rather than in each page
 *
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 *
 * A layout renders for every route in the group, so one line covers all eleven merchant
 * pages and — more importantly — covers the twelfth somebody adds next month. A banner
 * placed per page would be the same class of mistake as a write gate placed per handler
 * without a test: correct on the day it is written, quietly absent from whatever comes
 * next.
 *
 * The rule is enforced in `authorize.ts` regardless. This is the *hint* — the reason the
 * 403 will not feel arbitrary — and a hint that appears on only some pages is worse than
 * none, because its absence reads as "this account is mine".
 */
export default async function MerchantLayout({ children }: { children: ReactNode }) {
  const session = await requireRoleOrRedirect(['MERCHANT']);
  const banner = await impersonationBanner(session);

  return (
    <>
      <AppNav role="MERCHANT" />
      {banner ? (
        <ImpersonationBanner
          viewingEmail={banner.viewingEmail}
          actorEmail={banner.actorEmail}
          expiresAt={banner.expiresAt.toISOString()}
          auditId={banner.auditId}
        />
      ) : null}
      <main>{children}</main>
    </>
  );
}
