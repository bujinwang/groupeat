/**
 * Counts the rows the test suite is most likely to leak, so a run can be checked for
 * residue rather than trusted to have cleaned up.
 *
 * Usage:
 *
 *   node scripts/check-residue.mjs > /tmp/before.json
 *   npx vitest run
 *   node scripts/check-residue.mjs --compare /tmp/before.json
 *
 * The `--compare` form exits non-zero when any count moved, so it can gate a slice.
 *
 * ## Why `users` and not the row type you were looking at
 *
 * The `/admin/users` slice verified its teardown by counting *profile-less organisers*
 * — the symptom that had been visible on the admin screen. That count was stable at 98
 * and the suite was still leaking 26 `User` rows per run, from five files that each
 * created a real actor for `AuditLog.actorUserId` and assumed
 * `settlementFixtures.cleanup()` would remove it. It does not: that fixture deletes the
 * drop, its participants and its customers, and a `User` is not its business.
 *
 * `users` is the table every fixture writes and no fixture owns, so it is the count
 * that moves. The specific counters below it are for narrowing a leak once `users` has
 * told you there is one.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

const counts = {
  users: await prisma.user.count(),
  organisers: await prisma.user.count({ where: { role: 'ORGANISER' } }),
  organiserProfiles: await prisma.organiserProfile.count(),
  // An ORGANISER account with no profile is the state `listProfilelessOrganisers`
  // exists to surface, and the one the admin screen lists as a broken account.
  profilelessOrganisers:
    (await prisma.user.count({ where: { role: 'ORGANISER' } })) -
    (await prisma.organiserProfile.count()),
  merchants: await prisma.merchant.count(),
  customers: await prisma.customer.count(),
  drops: await prisma.drop.count(),
  shareLinks: await prisma.shareLink.count(),
  auditLogs: await prisma.auditLog.count(),
};

await prisma.$disconnect();

const compareAt = process.argv.indexOf('--compare');
if (compareAt === -1) {
  process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  process.exit(0);
}

const path = process.argv[compareAt + 1];
if (!path) {
  process.stderr.write('--compare needs a path to a previously written count file\n');
  process.exit(2);
}

const before = JSON.parse(readFileSync(path, 'utf8'));

/**
 * Rows that legitimately outlive a run, reported but never fatal.
 *
 * `AuditLog` has no cascade from its target — `actorUserId` is `SetNull` and `targetId`
 * is a plain string — because an audit trail that vanished with its subject would not be
 * a record of anything. So a suite that exercises FR-902/903 necessarily leaves rows no
 * teardown should delete. Measured at +71 per full run.
 *
 * Excluded from the pass/fail decision rather than from the output, and for a specific
 * reason: a residue check that fails on every run is a residue check nobody reads. The
 * growth is still printed, so an *unexpected jump* — a runaway that writes hundreds — is
 * visible, and a reader who knows the baseline can see it move.
 */
const expectedToGrow = new Set(['auditLogs']);

const moved = Object.keys(counts).filter((key) => counts[key] !== before[key]);
const residue = moved.filter((key) => !expectedToGrow.has(key));
const growth = moved.filter((key) => expectedToGrow.has(key));

for (const key of growth) {
  process.stdout.write(
    `expected growth: ${key} ${before[key]} → ${counts[key]} (+${counts[key] - before[key]})\n`,
  );
}

if (residue.length === 0) {
  process.stdout.write(
    `no residue — ${Object.keys(counts).length - expectedToGrow.size} counts unchanged` +
      `${growth.length > 0 ? `, ${growth.length} known-growth table(s) noted above` : ''}\n`,
  );
  process.exit(0);
}

process.stderr.write('RESIDUE — the suite left rows behind:\n\n');
for (const key of residue) {
  const delta = counts[key] - before[key];
  process.stderr.write(`  ${key.padEnd(22)} ${before[key]} → ${counts[key]}  (${delta > 0 ? '+' : ''}${delta})\n`);
}
process.stderr.write(
  '\nFind the writing suite: it creates a row that no `cleanup()` names. See the\n' +
    '`### Teardown` section of AGENTS.md — including the `step()` collector, which is\n' +
    'what stops a failing run from leaking more than a passing one.\n',
);
process.exit(1);
