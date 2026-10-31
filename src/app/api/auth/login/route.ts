import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { authenticate } from '@/lib/auth/credentials';
import { setSessionCookie } from '@/lib/auth/session';

/**
 * `POST /api/auth/login` — the HTTP surface for the same operation the login form
 * uses (PRD-sprint1 §6.1).
 *
 * Responses:
 *   200 `{ redirectTo }` + `Set-Cookie`   — signed in
 *   401 `{ error: 'INVALID_CREDENTIALS' }` — one message for both failure modes
 *   429 `{ error: 'RATE_LIMITED' }` + `Retry-After`
 *   400 `{ error: 'INVALID_REQUEST' }`     — body was not `{ email, password }`
 */

const bodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

/**
 * ⚠️ `x-forwarded-for` is only trustworthy behind a proxy that sets it and strips
 * a client-supplied value. See `lib/auth/rate-limit.ts`.
 */
function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get('x-real-ip') ?? 'local';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Email and password are required.' },
      { status: 400 },
    );
  }

  const result = await authenticate(parsed.data.email, parsed.data.password, clientKey(request));

  if (!result.ok) {
    const response = NextResponse.json(
      {
        error: result.status === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS',
        message: result.message,
      },
      { status: result.status },
    );
    if (result.retryAfterSeconds !== undefined) {
      response.headers.set('Retry-After', String(result.retryAfterSeconds));
    }
    return response;
  }

  const response = NextResponse.json({ redirectTo: result.redirectTo }, { status: 200 });
  await setSessionCookie(response, result.session);
  return response;
}
