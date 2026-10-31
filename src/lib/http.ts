import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { AppError, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logging/logger';

/**
 * The one place an exception becomes an HTTP response (ARCHITECTURE-sprint1 §7.3).
 *
 * | Source | Response |
 * |---|---|
 * | `AppError` | its own status, its safe public message, its `fieldErrors` |
 * | `ZodError` | 422 with per-field messages |
 * | anything else | 500 with a generic message — the real error is logged, never returned |
 *
 * A guardrail outcome is **not** an exception: `INCOMPLETE_COST_DATA` and
 * `INFEASIBLE` are 200s with a state. Only a genuine bug reaches the 500 branch.
 */

export function errorResponse(error: unknown, route: string): NextResponse {
  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: error.status === 422 ? 'VALIDATION' : 'REQUEST_FAILED',
        message: error.publicMessage,
        fieldErrors: error.fieldErrors ?? {},
      },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] = issue.message;
    }
    return NextResponse.json(
      { error: 'VALIDATION', message: 'Check the values you entered.', fieldErrors },
      { status: 422 },
    );
  }

  logger.error('api.unhandled_error', {
    route,
    reason: error instanceof Error ? error.name : 'unknown',
  });

  return NextResponse.json(
    { error: 'INTERNAL', message: 'Something went wrong. Try again.' },
    { status: 500 },
  );
}

/** `AppError` for a request body that is not shaped the way the route expects. */
export function invalidBody(message = 'That request could not be processed.'): AppError {
  return AppError.badRequest(message);
}
