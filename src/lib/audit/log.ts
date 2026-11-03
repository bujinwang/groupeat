import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/logging/logger';

/**
 * FR-902 and FR-904's "audit log entry" — the one writer.
 *
 * > `FR-902 | Force-fail a drop and refund all | Double confirmation, audit log entry`
 * > `FR-904 | Impersonate a merchant owner (read-only) | Session flagged in audit log`
 *
 * ## Why this file has one exported function and no mutator
 *
 * An audit trail that can be edited is a log, not an audit trail. The guarantee here
 * is structural: `writeAuditEntry` is the only way in, there is no `updateAuditEntry`,
 * and `__tests__/audit-append-only.test.ts` greps the source tree to prove no
 * `prisma.auditLog.update` or `.delete` call exists anywhere.
 *
 * Postgres could enforce the same thing with a revoked grant on the table, and should
 * once this deploys under a dedicated application role. Until then the module boundary
 * is the guarantee, and the test is what keeps the boundary from being crossed by
 * somebody in a hurry.
 *
 * ## Why this is not a `server-only` module
 *
 * Every caller is a server action or a route handler, so the marker would be true.
 * It is deliberately absent anyway, for the reason `lib/db/prisma.ts` and
 * `payments/onboarding-service.ts` give: `server-only` throws on import outside a
 * React Server Component graph, which would make every DB-backed test that reaches
 * this module impossible to run under Vitest. `forceFailDrop` imports it statically
 * — the audit row has to be written before any money moves, so it cannot be behind a
 * dynamic import — and that would have put the `force-fail` suite out of reach.
 *
 * The boundary is held where it already is: nothing in a client component may reach
 * `lib/db/prisma`, and the route that calls this goes through `requireAdmin`.
 *
 * ## Why it takes the actor's email as an argument
 *
 * The alternative is a `User` lookup inside this function, which would make it
 * unusable from a transaction that already holds the row — and would read the email
 * *now* rather than at the moment the action happened, which is the wrong one. The
 * caller has the session and passes both.
 */

export type AuditAction =
  | 'drop.force_fail'
  | 'participant.refund'
  | 'session.impersonate';

export type AuditTargetType = 'drop' | 'participant' | 'user';

export type AuditEntryInput = {
  /** Null when the actor's `User` row has since been deleted; the email remains. */
  readonly actorUserId: string | null;
  /** The actor's email as it stood at the time of the action. */
  readonly actorEmail: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  /**
   * The facts that mattered, as they stood. Free-form by type because the useful
   * fields differ per action, and a rigid shape here would either be a union this
   * module has to keep in step with every caller, or a set of nullable columns
   * pretending structure.
   *
   * What belongs in it: numbers and identifiers that would be unrecoverable later.
   * What does not: anything that is only meaningful as a live reference, because this
   * row outlives the rows it describes.
   */
  readonly detail: Prisma.InputJsonValue;
  readonly ipAddress?: string | null;
};

/**
 * Writes one row. Returns its id.
 *
 * ## Why this does not swallow errors
 *
 * A caller that force-fails a drop must not proceed to refund every participant if
 * the audit row could not be written — an irreversible action with no record of who
 * authorised it is precisely what FR-902 exists to prevent. So this throws, and the
 * callers write it **inside** the same transaction as the state change where they can,
 * or before it where they cannot.
 */
export async function writeAuditEntry(input: AuditEntryInput): Promise<string> {
  const row = await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      detail: input.detail,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
    },
    select: { id: true },
  });

  // A log line as well as a row: the row is the record, this is what shows up in the
  // stream an operator is already watching. Neither replaces the other.
  logger.info('audit.written', {
    auditId: row.id,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    actorUserId: input.actorUserId ?? 'deleted',
  });

  return row.id;
}
