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

/**
 * An optional string where `""` means "not set".
 *
 * `AI_API_KEY=` in a `.env` is how a half-configured machine looks, and it is
 * not an error worth refusing to boot over — it is the same state as not having
 * the key at all. Without this, `z.string().min(1).optional()` would reject the
 * empty string and the app would fail to start for a feature that is designed to
 * degrade.
 */
function optionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  );
}

const envSchema = z.object({  DATABASE_URL: z
    .string({ required_error: 'is required — see .env.example' })
    .min(1, 'is required — see .env.example')
    .startsWith('postgres', 'must be a PostgreSQL connection string'),
  JWT_SECRET: z
    .string({ required_error: 'is required — see .env.example' })
    .min(32, 'must be at least 32 characters'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Used only by `prisma/seed.ts`; the seed refuses to run without it. */
  SEED_PASSWORD: z.string().min(8, 'must be at least 8 characters').optional(),

  // ---------------------------------------------------------------------
  // The copy model (M3). All three are optional, and that is the point:
  // PRD-v1 §9.1.4 requires the deal builder to work with no model at all.
  // Absence is not a misconfiguration, it is a supported mode — the planner
  // writes the copy itself. An *empty* value (`AI_API_KEY=`) is treated as
  // absent, because that is what a half-filled .env looks like and failing
  // boot over it would be a worse outcome than running without the model.
  // ---------------------------------------------------------------------
  AI_API_KEY: optionalString(),
  AI_BASE_URL: optionalString(),
  AI_MODEL: optionalString(),

  // ---------------------------------------------------------------------
  // M5 — settlement jobs and redemption codes.
  //
  // Both optional, and both absences are supported modes rather than
  // misconfigurations:
  //
  //   - `CRON_SECRET` unset means the cutoff job is **refused** (503
  //     `NOT_CONFIGURED`) rather than left open. A job route with no auth is a
  //     public endpoint that moves money; refusing to run is the safe default,
  //     and it is what makes "the scheduler was never wired" visible in the
  //     first tick instead of silently not settling drops.
  //   - `REDEMPTION_SECRET` unset means the code key is derived from
  //     `JWT_SECRET` via HKDF (design §12 Q4), so there is no new required
  //     variable for a fresh checkout. Setting it is the production upgrade
  //     path: printed codes then survive a session-secret rotation.
  // ---------------------------------------------------------------------
  CRON_SECRET: optionalString(),
  REDEMPTION_SECRET: optionalString(),

  // ---------------------------------------------------------------------
  // Stripe (M2 onboarding, M4 join, M5 capture) — optional, with a defined
  // refusal for every absence.
  //
  // `stripe.ts` reads the key lazily so that a test or a seed script can import
  // a module without a full payment environment; adding it here makes the
  // configuration surface explicit and keeps `.env.example` honest.
  //
  // ADR-001: direct charges. The secret key is the platform's, and every
  // money-touching call is scoped with `forMerchant(accountId)`.
  // ---------------------------------------------------------------------
  STRIPE_SECRET_KEY: optionalString(),
  STRIPE_WEBHOOK_SECRET: optionalString(),
  /** Publishable key for the Payment Element. Safe to expose to the browser. */
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalString(),
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
