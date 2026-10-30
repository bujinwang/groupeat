import type { ReactNode } from 'react';

import { AppNav } from '@/components/AppNav';
import { requireRoleOrRedirect } from '@/lib/auth/authorize';

/** Admin shell. Re-checks the role; see `(merchant)/layout.tsx`. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireRoleOrRedirect(['ADMIN']);

  return (
    <>
      <AppNav role="ADMIN" />
      <main>{children}</main>
    </>
  );
}
