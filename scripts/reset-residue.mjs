/**
 * Removes the rows a test suite leaves behind, so the residue gate can start from the
 * clean baseline it needs in order to mean anything.
 *
 * Usage:
 *
 *   npm run residue:wipe              # dry run: print what would be deleted
 *   npm run residue:wipe -- --apply   # delete it
 *
 * ## Why this exists rather than `prisma migrate reset`
 *
 * `npm run db:reset` is the obvious answer and the wrong instrument for a gate. It drops
 * and rebuilds the schema, destroys every `User` and `Merchant` in the database, and
 * needs a re-seed before anything runs again — a minute of work to remove twenty-seven
 * orphaned diners. It is also destructive in a way a preflight should never be
 * implicitly: a developer with a half-built merchant in the dev database would lose it
 * to a command whose name says "residue".
 *
 * So this deletes *only* the counted tables from `scripts/check-residue.mjs`, and only
 * `--apply` actually deletes. The dry run is the default because the first thing anyone
 * will do is run it to see what it thinks is residue.
 *
 * ## The order is the foreign-key order, and it is not optional
 *
 * Prisma does not cascade through `deleteMany` for a plain (Restrict) FK, and the schema
 * has two relations that would raise if the order were reversed:
 *
 *   - `DropParticipant.customer` has **no `onDelete`**, so it defaults to `Restrict`.
 *     Deleting a `Customer` that a participant still references raises
 *     `DropParticipant_customerId_fkey`. Participants therefore go before customers.
 *   - `DropParticipant.shareLink` is `SetNull` on one side and `ShareLink.drop` is
 *     `Cascade`, so links must go before participants, and participants before drops
 *     are handled by the cascade — but deleting drops explicitly is clearer than
 *     relying on it, and it is what removes the orders and participants underneath.
 *
 * The sequence below is children-first, deepest first. It is the same order the
 * individual teardowns in the suite use, which is the point: this script is that
 * knowledge in one place rather than in fifteen `afterAll` blocks.
 *
 * ## What it deliberately does not touch
 *
 * `auditLogs`. It is append-only by design (`AGENTS.md`, FR-902) and is the one table
 * `check-residue.mjs` treats as expected growth. Deleting audit history to make a count
 * tidy would be exactly the kind of test-shaped compromise this slice has been removing.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

/**
 * Deletion order, children before parents.
 *
 * Each entry names the Prisma model and why it sits where it does, because the reason is
 * the only thing that stops someone reordering them alphabetically later.
 */
const order = [
  // Reaches Drop by Cascade but Customer by a plain FK, so it must precede both. There
  // is no cascade in either direction that would save a reversed order.
  ['order', 'references DropParticipant (plain FK) and Drop (Cascade)'],
  ['dropParticipant', 'references Customer with no onDelete → Restrict'],
  ['shareLink', 'plain FKs to Merchant and OrganiserProfile, so before both'],
  ['ledgerEntry', 'no FK at all, so nothing cascades to it'],
  ['drop', 'cascades participants and orders; still after them for clarity'],
  ['digestDelivery', 'cascades from Merchant and User; delete before them'],
  ['aiDraft', 'merchantId is SetNull — blanking it makes the row unreachable'],
  ['menuItem', 'cascades from Merchant'],
  ['merchantUser', 'cascades from Merchant and User'],
  ['organiserProfile', 'cascades from User'],
  ['passwordInvite', 'cascades from User'],
  ['customer', 'after dropParticipant, or DropParticipant_customerId_fkey raises'],
  ['consentRecord', 'no FK — deliberately outlives the join it records'],
  ['merchant', 'after everything that references it'],
  ['user', 'last: AuditLog.actorUserId is SetNull, so this blanks rather than raises'],
];

/**
 * An `AuditLog` is never deleted here, but its `actorUserId` becomes null when the actor
 * goes. That is `onDelete: SetNull` doing its job, and it is worth stating so nobody
 * later "fixes" it by adding a cascade.
 */

const plan = [];
for (const [model, why] of order) {
  const count = await prisma[model].count();
  plan.push({ model, count, why });
}

const total = plan.reduce((sum, row) => sum + row.count, 0);

if (total === 0) {
  process.stdout.write(
    'residue: nothing to delete — every counted table is already empty.\n' +
      'The gate can be certified from this baseline: npm run verify\n',
  );
  await prisma.$disconnect();
  process.exit(0);
}

process.stdout.write(
  `${apply ? 'DELETING' : 'WOULD DELETE'} test residue, children first:\n\n`,
);
for (const row of plan) {
  const marker = row.count > 0 ? '●' : '·';
  process.stdout.write(
    `  ${marker} ${row.model.padEnd(18)} ${String(row.count).padStart(5)}   ${row.why}\n`,
  );
}
process.stdout.write(`\n  total ${total}\n\n`);

if (!apply) {
  process.stdout.write(
    'Dry run. Nothing was deleted. To apply:\n\n' +
      '  npm run residue:wipe -- --apply\n\n' +
    'This does not drop the schema and does not delete `auditLogs` — it is not\n' +
    '`migrate reset`, and it does not need a re-seed.\n',
  );
  await prisma.$disconnect();
  process.exit(0);
}

// Every step attempted, and the script fails if any did. The same rule the suite's
// teardowns follow: a throw halfway through must not leave the rest undeleted and
// unreported, because the next step is a `verify` that would then read a dirty baseline
// and — before this slice — have called it clean.
const failures = [];
for (const [model] of order) {
  try {
    const { count } = await prisma[model].deleteMany();
    process.stdout.write(`  deleted ${String(count).padStart(5)} from ${model}\n`);
  } catch (error) {
    failures.push({ model, error });
    process.stdout.write(`  FAILED  ${model}: ${error.message}\n`);
  }
}

await prisma.$disconnect();

if (failures.length > 0) {
  process.stderr.write(
    `\nresidue:wipe failed on ${failures.length} table(s). The database is now partially\n` +
      'wiped — re-run to retry, and expect `npm run verify` to refuse its baseline until\n' +
      'this succeeds.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '\nDone. Baseline is clean; the gate can now certify a run:\n\n  npm run verify\n',
);
