/**
 * Counts the rows the test suite is most likely to leak, so a run can be checked for
 * residue rather than trusted to have cleaned up.
 *
 * Usage:
 *
 *   node scripts/check-residue.mjs                      # the counts alone, for diagnosis
 *   node scripts/check-residue.mjs --require-clean \
 *     > /tmp/before.json                                # preflight: refuse a dirty baseline
 *   node scripts/check-residue.mjs --compare /tmp/before.json
 *
 * `--compare` exits non-zero when any count moved, so it can gate a slice.
 * `--require-clean` exits non-zero when the baseline is already dirty, and stamps the
 * written JSON as clean so the comparison knows what it was comparing against.
 *
 * ## A comparison cannot detect a leak that has saturated
 *
 * This script compares counts before and after one run. That is only evidence of
 * cleanup if the *before* state was clean, and for several slices nothing checked.
 * Measured on a wiped database:
 *
 *   run 1   customers 0 → 46    RESIDUE
 *   run 2   customers 46 → 46   "no residue"
 *
 * The second line is not a suite that cleans up. It is 46 rows created every run and
 * deleted never, so the before-count equals the after-count and the delta is zero. The
 * number that made the gate look green was a symptom of the leak being total: once a
 * leak saturates, the gate reports a steady state and calls it cleanliness. Every
 * `no residue` this project banked before `--require-clean` existed was measured from a
 * database that already held the leak, and therefore proves only that the counts did
 * not move — not that anything was cleaned away.
 *
 * So the baseline is now a checked precondition rather than an assumption, and the
 * success line says which of the two things it actually proved.
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
  // Counted since `AiDraft.merchantId` became `onDelete: SetNull`: deleting a merchant no
  // longer fails on its drafts, it *blanks* them. So a teardown that deletes the merchant
  // before its drafts now leaves a row that `deleteMany({ merchantId })` can no longer
  // find, and the leak would be invisible in every other counter here. This is the first
  // counter that would move.
  aiDrafts: await prisma.aiDraft.count(),
  // FR-704's delivery record. A test that sends a digest writes one, and a teardown that
  // forgets it would leave a row that the next run's idempotency check reads — the
  // failure would be "the suite sent nothing", which looks like the feature, not a leak.
  digestDeliveries: await prisma.digestDelivery.count(),
  auditLogs: await prisma.auditLog.count(),
};

await prisma.$disconnect();

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
 *
 * It is also excluded from the clean-baseline requirement, for the same reason: this
 * table is never empty, and a precondition it can never satisfy is not a precondition.
 */
const expectedToGrow = new Set(['auditLogs']);
const countedTables = Object.keys(counts);
const mustBeClean = countedTables.filter((key) => !expectedToGrow.has(key));

const requireClean = process.argv.includes('--require-clean');
const compareAt = process.argv.indexOf('--compare');

if (compareAt === -1 && !requireClean) {
  process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Preflight: the baseline must be clean, or the comparison proves nothing.
// ---------------------------------------------------------------------------

/**
 * The tables that are not at zero, in the order they are declared.
 *
 * Zero is the right requirement and not an arbitrary one: after a full run every counted
 * table except `auditLogs` should be empty, because every fixture deletes what it made.
 * A non-zero count here is therefore either residue from a previous run or a checked-in
 * seed, and both make the numbers that follow meaningless.
 */
const dirty = mustBeClean.filter((key) => counts[key] !== 0);

if (requireClean && dirty.length > 0) {
  process.stderr.write(
    'RESIDUE IN THE BASELINE — refusing to certify this run.\n\n' +
      '  table                    rows\n' +
      dirty.map((key) => `  ${key.padEnd(22)} ${counts[key]}\n`).join('') +
      '\n' +
      'This gate compares counts before and after a run, which is only evidence of\n' +
      'cleanup when the before-state is clean. A leak that happens every run leaves\n' +
      'the count unchanged, so a dirty baseline reports `no residue` forever:\n' +
      '46 customer rows survived several slices exactly that way.\n\n' +
      'Wipe the test residue, then re-run:\n\n' +
      '  npm run residue:wipe              # dry run, shows what would go\n' +
      '  npm run residue:wipe -- --apply   # actually delete\n\n' +
      'The wipe touches only the counted tables, in foreign-key order, and never\n' +
      'deletes `auditLogs`. It is not `migrate reset`: it does not drop the schema and\n' +
      'does not need a re-seed.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// No --compare: write the baseline for a later comparison, stamped with its
// provenance so the comparison cannot overstate what it proved.
// ---------------------------------------------------------------------------

if (compareAt === -1) {
  const stamped = {
    ...counts,
    // Read back by the `--compare` pass below. A baseline that does not carry this
    // marker was written by an older invocation or by hand, and is treated as dirty —
    // the safe direction to fail in.
    __baselineClean: requireClean && dirty.length === 0,
  };
  process.stdout.write(`${JSON.stringify(stamped, null, 2)}\n`);
  process.exit(0);
}

const path = process.argv[compareAt + 1];
if (!path) {
  process.stderr.write('--compare needs a path to a previously written count file\n');
  process.exit(2);
}

const before = JSON.parse(readFileSync(path, 'utf8'));

/**
 * Whether the baseline this run is being compared against was proved clean.
 *
 * `undefined` for a file written before this marker existed, which is deliberate: an
 * unknown baseline is treated exactly like a dirty one, so the failure mode is an
 * `UNVERIFIED` line rather than a false certificate.
 */
const baselineClean = before.__baselineClean === true;

const moved = countedTables.filter((key) => counts[key] !== before[key]);
const residue = moved.filter((key) => !expectedToGrow.has(key));
const growth = moved.filter((key) => expectedToGrow.has(key));

for (const key of growth) {
  process.stdout.write(
    `expected growth: ${key} ${before[key]} → ${counts[key]} (+${counts[key] - before[key]})\n`,
  );
}

if (residue.length === 0) {
  const growthNote =
    growth.length > 0 ? `, ${growth.length} known-growth table(s) noted above` : '';

  if (baselineClean) {
    process.stdout.write(
      `no residue — VERIFIED from a clean baseline: all ${mustBeClean.length} counted ` +
        `tables started at 0 and ended at 0${growthNote}\n`,
    );
  } else {
    // Exit 0 is correct: the run did not leak *relative to where it started*. But the
    // line must not read as a certificate, because it is not one.
    const startedDirty = mustBeClean.filter((key) => before[key] !== 0);
    process.stdout.write(
      `no residue — UNVERIFIED BASELINE. ` +
        (startedDirty.length > 0
          ? `${startedDirty.map((key) => `${key} started at ${before[key]}`).join(', ')}. `
          : 'the baseline file carries no clean marker. ') +
        `This proves the counts did not move; it does not prove the suite cleans up, ` +
        `because a leak that already saturated also leaves them unchanged.\n` +
        `Re-run from a clean baseline to certify: npm run residue:wipe -- --apply, then verify.\n`,
    );
  }
  process.exit(0);
}

process.stderr.write(
  `RESIDUE — the suite left rows behind` +
    `${baselineClean ? ' (baseline was clean, so this is new leakage)' : ''}:\n\n`,
);
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
