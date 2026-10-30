import { z } from 'zod';

import {
  DEFAULT_FEES,
  DEFAULT_FLOOR_PCT,
  FLOOR_WARN_THRESHOLD,
  THIN_DISCOUNT_THRESHOLD,
} from './guardrail';

/**
 * Environment validation and the application's config surface.
 *
 * Two rules (ARCHITECTURE-sprint1 §2.6, S1-007):
 *   1. Missing or malformed environment fails fast, at boot, with a readable
 *      message that names the key and never echoes a secret.
 *   2. Business constants are **not** re-declared here. They live in
 *      `src/lib/guardrail/constants.ts` (the single home, §7.6) and are exposed
 *      through `APP_CONFIG` below so server code has one import for both.
 */

const envSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: 'is required — see .env.example' })
    .min(1, 'is required — see .env.example')
    .startsWith('postgres', 'must be a PostgreSQL connection string'),
  JWT_SECRET: z
    .string({ required_error: 'is required — see .env.example' })
    .min(32, 'must be at least 32 characters'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Used only by `prisma/seed.ts`; the seed refuses to run without it. */
  SEED_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

function formatIssues(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return issues.map((issue) => `  · ${issue.path.join('.')} ${issue.message}`).join('\n');
}

function loadEnv(source: NodeJS.ProcessEnv): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      [
        'GroupEat cannot start: the environment is incomplete.',
        formatIssues(parsed.error.issues),
        '',
        'Copy .env.example to .env and fill in every required value.',
      ].join('\n'),
    );
  }
  return parsed.data;
}

/** Validated environment. Importing this module validates it (fail fast). */
export const env: AppEnv = loadEnv(process.env);

/**
 * Touching this function is enough to force validation, which is what
 * `src/instrumentation.ts` does at server start.
 */
export function assertEnvReady(): AppEnv {
  return env;
}

/**
 * Business configuration for server code. Every value is a **reference** to the
 * guardrail constants, never a copy, so a change to the fee model or the thin
 * threshold has exactly one definition.
 */
export const APP_CONFIG = {
  fees: DEFAULT_FEES,
  thinDiscountThreshold: THIN_DISCOUNT_THRESHOLD,
  defaultFloorPct: DEFAULT_FLOOR_PCT,
  floorWarnThreshold: FLOOR_WARN_THRESHOLD,
  isProduction: env.NODE_ENV === 'production',
} as const;

export type AppConfig = typeof APP_CONFIG;
