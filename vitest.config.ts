import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration.
 *
 * `environment: 'node'` is deliberate (ARCHITECTURE-sprint1 §1.2, §7.7): the
 * sprint's test suite covers pure functions only, so no DOM is needed and the
 * suite stays fast enough to run on every save.
 */
export default defineConfig({
  /**
   * The automatic JSX runtime, which is what Next itself compiles with.
   *
   * Without this line a page file cannot be imported from a test at all: `tsconfig`
   * sets `jsx: "preserve"` for Next's own compiler, so esbuild falls back to the
   * **classic** transform, emits `React.createElement(...)`, and the page throws
   * `React is not defined` because a server component has no `React` import.
   *
   * This is still `environment: 'node'` and still no `.tsx` tests: the runner does not
   * need a DOM to execute a page function and serialise the element it returns —
   * `src/lib/testing/render.ts` explains what that does and does not prove. Keeping the
   * renderer honest is the whole point; keeping a browser out of the suite is the
   * constraint, and the two are not in conflict.
   */
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'default',
    /**
     * Loads `.env` and widens Prisma's 5-second connect timeout to 20 seconds.
     *
     * It has to be a setup file rather than a line in `src/lib/db/prisma.ts`: the timeout
     * is read from `DATABASE_URL` when the client is constructed, and setup files run
     * before the test file's module graph. `vitest.setup.ts` carries the measurement that
     * justified this — a real `Can't reach database server` reproduced at 5 028 ms against
     * a measured 5 000 ms default, on a host with 11.9 GB of swap in use.
     */
    setupFiles: ['./vitest.setup.ts'],
    /**
     * One test file at a time.
     *
     * The settlement suite is the reason. `runCutoffTick` scans **global** work
     * queues — every `PUBLISHED` drop past its cutoff, every `FAILED` drop holding
     * an authorisation — so a tick in one file would settle, lock or void the
     * fixtures of another file running in parallel. That is not a flaky test; it
     * is a test that corrupts its neighbours' data and then fails somewhere else.
     *
     * The alternative was to give the tick a merchant filter it does not need in
     * production, i.e. to bend the code under test to suit the harness. The suite
     * is a couple of seconds either way.
     */
    fileParallelism: false,
    /**
     * Per-test timeout, raised above Vitest's 5-second default.
     *
     * ## What was actually happening
     *
     * The gate failed twice on 2026-11-07 on **different** tests each run, both with
     * `Test timed out in 5000ms`. Diagnosed rather than assumed, because three of the
     * obvious explanations were wrong:
     *
     *   - **Not connection exhaustion.** A watcher sampling `pg_stat_activity` through a
     *     full gate saw a peak of **2** connections against `max_connections = 100`.
     *     Eighty of the 106 files that touch the real client never call `$disconnect`,
     *     which looked like the cause and was not: connections are opened lazily, so a
     *     file that finishes before issuing a query never opens one.
     *   - **Not the gate script.** A failing `&&` chain skips `--compare`, so a failed
     *     gate never checks residue — but it leaves no run lock either, so the next
     *     `--compare` refuses rather than certifying a stale baseline. The truncation is
     *     safe in the direction that matters.
     *   - **Not a slow test.** The one that failed (`/admin/commission > renders a month
     *     without changing a single row`) takes **31 ms** idle, and the whole file is
     *     609 ms. Across all 2634 tests exactly **one** exceeds 1000 ms.
     *
     * It is CPU contention, reproduced deterministically: with 14 busy-loops pinned to
     * the 14 cores, the same two suites failed on the same test at `5004ms`; run alone
     * five times on an idle machine they passed 5/5. The machine is a laptop that also
     * runs a browser, a window server and two Electron apps, and load averages of 6–9
     * were observed without any test running.
     *
     * A 5-second budget around 31 ms of work leaves a 160× margin, which is generous
     * until the scheduler stops co-operating; the first test in each file also pays the
     * module-graph and Prisma warm-up, and **that** is the part that inflates under load
     * (observed: a warm-up-dominated first assertion reporting 5007 ms).
     *
     * ## Why this value, and why not per-test
     *
     * 15 s is 3× the old ceiling and ~480× the slowest real assertion, so it cannot hide
     * a hang: a genuine deadlock or an unbounded query still fails, just later. Raising
     * only the affected tests was the alternative and is worse — the two failures landed
     * on unrelated files, so the next one would land somewhere else again, and adding
     * `timeout` to a test that takes 31 ms misdescribes it as slow.
     *
     * This does not make the suite fast; it stops a fast suite from reporting a failure
     * it did not find. The underlying cause — an over-subscribed host — is a property of
     * the machine, not of this repository, and is *not* fixed by this line.
     */
    testTimeout: 15_000,
  },
});
