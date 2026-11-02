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
