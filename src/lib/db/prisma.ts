import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma client.
 *
 * Next.js hot-reloads modules in development, which would otherwise create a new
 * connection pool on every edit and exhaust PostgreSQL. The client is cached on
 * `globalThis` outside production.
 *
 * Note: `server-only` is deliberately **not** imported here. It throws when
 * imported outside a React Server Component graph, which would make the
 * database-backed tests (`items-scope.test.ts` in T04) impossible to run under
 * Vitest. The server boundary is enforced where it can be: `lib/auth` imports
 * `server-only`, and no client component may import this module (checked by hand
 * and by the ESLint restricted-import rule).
 */
const globalForPrisma = globalThis as unknown as { groupeatPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.groupeatPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.groupeatPrisma = prisma;
}
