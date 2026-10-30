/**
 * Next.js instrumentation hook — runs once when a server instance boots.
 *
 * This is where S1-007 becomes real: importing `lib/config` validates the
 * environment, so a missing `JWT_SECRET` stops the process at start with a
 * readable message instead of surfacing as a confusing 500 on the first login.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') {
    // Middleware runs on the Edge runtime, which has its own env handling.
    return;
  }
  await import('./lib/config');
}
