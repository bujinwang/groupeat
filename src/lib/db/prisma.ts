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

/**
 * Prisma's `maxWait` default is 2 000 ms (`maxWait ?= 2000`, `library.d.ts:2654`) and
 * that is the cap on **acquiring a transaction slot**, before any statement runs.
 *
 * Under Vitest the concurrency tests deliberately start sixteen transactions at once
 * (`join/service.test.ts` — "never oversells under sixteen simultaneous joins"). On an
 * idle machine the pool turns over fast enough. Under CPU contention it does not, and
 * the failure is not a slow query — it is
 * `Transaction API error: Unable to start a transaction in the given time.`, which no
 * `testTimeout` can rescue because it is thrown from inside Prisma, not from the test.
 * Reproduced at will: 14 busy-loops on 14 cores fail that test; alone it passes.
 *
 * So the wait is widened **in tests only**. `NODE_ENV` is `test` under Vitest and
 * `development` or `production` otherwise (measured, not assumed), so production
 * transaction semantics are untouched — deliberately: a real request that cannot get a
 * slot in 2 s is information an operator should keep.
 *
 * `timeout` (the cap on the transaction's own lifetime) is left at its default. Raising
 * it would let a genuinely wedged transaction hold a row lock for longer, and the
 * sixteen-way test does not need it — it needs to *start*, not to run slowly.
 */
const transactionOptions =
  process.env.NODE_ENV === 'test' ? { maxWait: 15_000, timeout: 20_000 } : undefined;

export const prisma: PrismaClient =
  globalForPrisma.groupeatPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    ...(transactionOptions === undefined ? {} : { transactionOptions }),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.groupeatPrisma = prisma;
}
