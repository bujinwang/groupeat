import 'dotenv/config';

/**
 * Test-only: widen Prisma's connect timeout.
 *
 * ## What was actually failing
 *
 * The full suite intermittently failed a **single** test with
 *
 *     Invalid `db.customer.count()` invocation in src/lib/testing/scoped-counts.ts:185
 *     Can't reach database server at `localhost:5432`
 *
 * That reads like a dead database. It is not. Three measurements ruled out the
 * obvious explanations:
 *
 *   - **Not a server refusal.** PostgreSQL's own log (`/usr/local/var/log/postgresql@14.log`)
 *     holds nothing for the failing minute — no `FATAL`, no `too many connections`, no
 *     restart. `pg_postmaster_start_time()` showed 3 days of uptime across the failure.
 *     `max_connections` is 100 and `pg_stat_activity` peaked at 2.
 *   - **Not a leaked connection.** `grep "too many clients"` over the whole log: zero hits.
 *     `pg_hba.conf` is `trust`, so no auth handshake can stall.
 *   - **Not cross-file corruption by `$disconnect()`.** Twenty-seven files call it in a
 *     top-level `afterAll`, which looked like a shared-client hazard — but `pool: 'forks'`
 *     with `isolate: true` makes tinypool recycle the worker after *every* file, so the
 *     `globalThis` singleton never survives into the next file. Proved by measurement, not
 *     by reading the config: a marker planted in one test file was `undefined` in the next.
 *
 * ## The mechanism, reproduced
 *
 * "Can't reach database server" is Prisma's **connect-timeout** message, not a refusal.
 * Measured against a non-routable host: the default is **5 000 ms** (5 011 ms observed),
 * and it scales with `connect_timeout=1` → 1 006 ms, `=2` → 2 005 ms.
 *
 * Every test file pays a full connect because it runs in a fresh fork with a fresh client.
 * On an idle machine that costs **p50 = 10 ms**. This host is not idle: 11.9 GB of 13.3 GB
 * swap in use, 20.5 M swapouts, load average 15–55 while the suite runs. Under deliberate
 * CPU saturation alone the same connect slowed to p50 = 455 ms, p90 = 999 ms, max 2 496 ms —
 * approaching but not crossing the 5 s line. Adding memory pressure crossed it:
 *
 *     FAIL after 5028ms: Can't reach database server at `localhost:5432`
 *     n=108 fails=4 p50=2403ms p90=4148ms max=5111ms
 *
 * Four failures at 5 026–5 028 ms, against the measured 5 000 ms ceiling. Same host
 * oversubscription that produced the 5 s *test* timeouts and the 2 s `maxWait` failures:
 * one cause, three symptoms. This is the third.
 *
 * ## Why a connection-string parameter, and why test-only
 *
 * It has to apply before any module builds a `PrismaClient`, which is why it lives here
 * rather than in `src/lib/db/prisma.ts`: `setupFiles` run before the test file's module
 * graph, whereas reading `DATABASE_URL` at client-construction time would race the
 * `import 'dotenv/config'` that individual test files do.
 *
 * 20 s is 4× the default and ~4× the worst connect measured (5.1 s), so it cannot hide an
 * unreachable database — it just stops a *reachable* one from being reported as unreachable.
 * It sits above `testTimeout` (15 s) on purpose: if the database genuinely dies, the test
 * timeout still fires first and reports the failure honestly, rather than this line waiting
 * out a longer window.
 *
 * Production semantics are untouched. `.env` is not modified, no repository code changes,
 * and `src/lib/db/prisma.ts` keeps its `NODE_ENV`-gated behaviour, so a real request that
 * cannot connect in 5 s still says so in 5 s — which is information an operator wants.
 */
const CONNECT_TIMEOUT_SECONDS = 20;

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl !== undefined && !/[?&]connect_timeout=/.test(databaseUrl)) {
  const separator = databaseUrl.includes('?') ? '&' : '?';
  process.env.DATABASE_URL = `${databaseUrl}${separator}connect_timeout=${CONNECT_TIMEOUT_SECONDS}`;
}
