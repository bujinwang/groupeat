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
  },
});
