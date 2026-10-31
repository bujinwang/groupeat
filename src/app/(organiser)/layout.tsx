import type { ReactNode } from 'react';

import { AppNav } from '@/components/AppNav';
import { requireRoleOrRedirect } from '@/lib/auth/authorize';

/** Organiser shell. Sprint 1 shows a placeholder (US-O1). */
export default async function OrganiserLayout({ children }: { children: ReactNode }) {
  await requireRoleOrRedirect(['ORGANISER']);

  return (
    <>
      <AppNav role="ORGANISER" />
      <main>{children}</main>
    </>
  );
}
