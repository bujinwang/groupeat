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
  },
});
