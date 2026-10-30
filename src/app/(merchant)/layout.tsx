import type { ReactNode } from 'react';

import { AppNav } from '@/components/AppNav';
import { requireRoleOrRedirect } from '@/lib/auth/authorize';

/**
 * Merchant shell.
 *
 * The role gate is here as well as in `middleware.ts` on purpose
 * (ARCHITECTURE-sprint1 §7.3): middleware is a redirect convenience, and a
 * matcher change must not become an authorisation hole.
 */
export default async function MerchantLayout({ children }: { children: ReactNode }) {
  await requireRoleOrRedirect(['MERCHANT']);

  return (
    <>
      <AppNav role="MERCHANT" />
      <main>{children}</main>
    </>
  );
}
