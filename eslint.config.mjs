import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config.
 *
 * Two rules carry product weight (ARCHITECTURE-sprint1 §2.1, AC-12):
 *   - `no-console` is an error: all output goes through `src/lib/logging/logger.ts`,
 *     which redacts PII and emits one structured JSON line per event.
 *   - `no-restricted-imports` keeps `src/lib/guardrail/` dependency-free at lint
 *     time, so a bad import is caught by `npm run lint` as well as by
 *     `purity.test.ts` (AC-8).
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'var/**',
      'coverage/**',
      'next-env.d.ts',
      'prisma/migrations/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // §7.8 rule 2 — the copy oracle dies silently if production code imports it:
    // the test would then assert the code against itself. Only `__tests__/` may
    // read `__fixtures__/`.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/__fixtures__/**', '@/lib/copy/__fixtures__/*'],
              message:
                'The frozen-copy fixture is a test-only oracle (ARCHITECTURE §7.8). Production code must not read the PRD transcription — import the copy module instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // The guardrail folder may import nothing but its own files.
    // `__tests__/` is exempt: the harness needs `vitest` and `node:fs`, and the
    // production-code guarantee is what matters (purity.test.ts asserts it).
    files: ['src/lib/guardrail/**/*.ts'],
    ignores: ['src/lib/guardrail/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'next',
                'next/*',
                'react',
                'react-dom',
                'react/*',
                '@prisma/client',
                'prisma',
                '@prisma/*',
                'fs',
                'node:*',
                'zod',
                'jose',
                'bcryptjs',
                'server-only',
                '@/*',
              ],
              message:
                'src/lib/guardrail must stay dependency-free and self-contained. Pass values in instead of importing them.',
            },
          ],
        },
      ],
    },
  },
  {
    // Seed and scripts run in Node and legitimately print progress.
    files: ['prisma/seed.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
