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
 * `--require-clean` also takes an exclusive lock (`scripts/residue-lock.mjs`) and holds it
 * until `--compare` releases it, so only one run at a time can touch the database and the
 * baseline file. `--baseline <path>` declares where the shell redirect is sending the
 * baseline; it defaults to the path `npm run verify` uses. See "## One run at a time".
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
 *
 * ## One run at a time, and why it is enforced rather than documented
 *
 * Two `npm run verify` invocations share two mutable artifacts: the `groupeat_dev`
 * database and the baseline file at a fixed path. Nothing serialised them. The cost was
 * measured at the start of a session — `residue:wipe` (dry run) reported two `user` rows
 * that turned out to be six `authmeyeml7-*` fixture accounts, four seconds old, created by
 * an `npm run verify` that was still running. The operator was reading the database
 * through someone else's live run. Every number in that output was real, and none of it
 * was about the state the reader thought it was about.
 *
 * So `--require-clean` takes an exclusive lock before it counts, and the count below is
 * therefore the first count in this repository guaranteed not to be a mixture. The lock is
 * defined and explained in `scripts/residue-lock.mjs`; what matters here is the ordering —
 * **the lock comes before the counts**, because a refusal computed from numbers read
 * during another run is the defect wearing a lock's clothing.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireLock,
  formatHolder,
  LOCK_PATH,
  LOCK_REFUSED_EXIT,
  readLock,
  releaseLock,
} from './residue-lock.mjs';

/**
 * Where `npm run verify` sends the baseline, and therefore what the lock records by
 * default.
 *
 * This mirrors the redirect in `package.json` rather than introducing a second fixed path:
 * `verify` writes `<repo>/node_modules/.residue-before.json`, and so does this. A
 * hand-written three-command run that redirects somewhere else passes `--baseline <path>`
 * so that the pairing `--compare` checks still holds.
 */
const DEFAULT_BASELINE_PATH = join(
  import.meta.dirname,
  '..',
  'node_modules',
  '.residue-before.json',
);

/**
 * The value after a `--flag`, or `null` when the flag is absent or carries no value.
 *
 * `--compare` needs the path that follows it and `--baseline` needs the path being
 * redirected to, so both are read the same way. A missing value returns `null` rather than
 * `undefined` so that "absent" and "present but valueless" cannot be confused at a call
 * site; both are refusals, and each caller says which.
 */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

const requireClean = process.argv.includes('--require-clean');
const compareAt = process.argv.indexOf('--compare');

/**
 * Reads every counter.
 *
 * A function rather than a top-level object for two reasons. The dump path calls it after
 * deciding not to lock, and the gate path calls it after taking the lock, so the ordering
 * is visible at the call sites instead of depending on where an object literal sits in the
 * file. And it holds the connection for exactly the length of the read, so a lock refusal
 * never opens a Prisma client against a database it is not going to touch.
 */
async function readCounts() {
  const prisma = new PrismaClient();
  try {
    return {
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
      // `ConsentRecord` was missing from this list until a residue audit asked whether the
      // gate could see every table the teardowns it polices actually delete. It could not.
      // Every one of the six join-path teardowns deletes `Customer` *and* `ConsentRecord`,
      // and the counter only measured the first — so half of the fix was certified by a
      // number that would not have moved had it been left undone. It happens to be 0, which
      // is the point: it was 0 and nobody could have told you whether that was cleanup or
      // luck. An uncounted table is not a clean table.
      consentRecord: await prisma.consentRecord.count(),
      drops: await prisma.drop.count(),
      shareLinks: await prisma.shareLink.count(),
      // Counted since `AiDraft.merchantId` became `onDelete: SetNull`: deleting a merchant
      // no longer fails on its drafts, it *blanks* them. So a teardown that deletes the
      // merchant before its drafts now leaves a row that `deleteMany({ merchantId })` can
      // no longer find, and the leak would be invisible in every other counter here. This
      // is the first counter that would move.
      aiDrafts: await prisma.aiDraft.count(),
      // FR-704's delivery record. A test that sends a digest writes one, and a teardown
      // that forgets it would leave a row that the next run's idempotency check reads — the
      // failure would be "the suite sent nothing", which looks like the feature, not a leak.
      digestDeliveries: await prisma.digestDelivery.count(),
      // `LedgerEntry` has no relation field at all: `orderId` and `dropId` are bare
      // nullable strings, so no FK cascades to it and no parent count can stand in for
      // it. All seven teardowns that delete ledger rows filter
      // `where: { dropId: { in: dropIds } }`, which cannot match NULL — and
      // `@@unique([orderId, type])` sits on a nullable column, so Postgres does not
      // even stop two `orderId: null` rows of the same type. A row written without a
      // `dropId` would outlive every teardown in this repository with no counter able
      // to see it. Count it UNSCOPED: the blind spot is exactly the rows those scoped
      // deletes miss. `reset-residue.mjs` already deletes it by name.
      ledgerEntry: await prisma.ledgerEntry.count(),
      auditLogs: await prisma.auditLog.count(),
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The dump: counts alone, no lock, exit 0 whatever they are.
 *
 * `npm run residue` is the command someone reaches for *while* diagnosing a concurrent
 * run, so locking it would remove the only instrument available in exactly the situation it
 * exists for. Its output is still a count from an unknown mixture — that is why the exit
 * code carries no judgement, and why `AGENTS.md` says the dump is not a check.
 */
if (compareAt === -1 && !requireClean) {
  const counts = await readCounts();
  process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The lock, taken before a single row is counted.
// ---------------------------------------------------------------------------

if (requireClean) {
  const baselinePath = flagValue(process.argv, '--baseline') ?? DEFAULT_BASELINE_PATH;
  const { ok, holder } = acquireLock({
    baselinePath,
    argv: process.argv.slice(2),
  });

  if (!ok) {
    const ownerPid = holder.ownerPid ?? holder.pid;
    process.stderr.write(
      'ANOTHER RUN HOLDS THE DATABASE — refusing to start.\n\n' +
        formatHolder(holder) +
        '\n\n' +
        'Two runs share the `groupeat_dev` database and one baseline file, so neither\n' +
        'can say what it measured. This is measured, not hypothetical: a dry run of\n' +
        '`residue:wipe` during a live `npm run verify` reported six fixture users four\n' +
        'seconds old as residue, because nothing in that output said whose rows they\n' +
        'were. Both runs produce unattributable numbers, including the innocent one.\n\n' +
        'Wait for it to finish, then re-run. To stop it deliberately:\n\n' +
        `  kill ${ownerPid === null ? '<pid>' : ownerPid}\n\n` +
        'A lock whose process is gone is stolen automatically, so a run that was killed\n' +
        'does not wedge this gate. A lock whose process is alive is somebody else working.\n',
    );
    process.exit(LOCK_REFUSED_EXIT);
  }
}

const counts = await readCounts();

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
  /**
   * Give the lock back before refusing.
   *
   * No run is going to follow this, so holding the lock would block the one command the
   * message below tells the reader to run. The dead-pid steal would recover it too, since
   * this process exits immediately — but that puts the recovery in the next process's hands
   * and makes the message momentarily false. Releasing first costs one line.
   */
  releaseLock();
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
      'The wipe deletes the residue-prone tables in foreign-key order — including\n' +
      'uncounted cascade children — and never deletes `auditLogs`. It is not\n' +
      '`migrate reset`: it does not drop the schema and\n' +
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

/**
 * Releases the lock and exits. Every `--compare` exit below goes through this, which is the
 * point: the residue path must release too, or the next run inherits a dead lock from the
 * failure before it.
 *
 * A failing gate that wedges the gate is worse than the leak it reported, because the next
 * person cannot tell the two apart — they see the lock refusal, not the finding.
 */
function finish(code) {
  releaseLock();
  process.exit(code);
}

const path = process.argv[compareAt + 1];
if (!path) {
  process.stderr.write('--compare needs a path to a previously written count file\n');
  // The preflight took the lock, so release it: the reader is about to fix the command and
  // re-run the chain, and a leftover lock would refuse them for the wrong reason.
  finish(2);
}

// ---------------------------------------------------------------------------
// The other half of the lock: this comparison must be the one the preflight opened.
// ---------------------------------------------------------------------------

/**
 * `--compare` cannot check the pid, and this is the design constraint that shapes the check.
 *
 * The preflight (`--require-clean`) and this pass are separate processes with `vitest run`
 * between them; the preflight has exited long before this runs, so its pid is dead by
 * construction and a pid check here would refuse every honest run. What the two processes
 * *can* agree on is the baseline path: the preflight wrote the path it expected this pass to
 * be given, and this pass knows the path it was given.
 *
 * A missing lock is therefore a real failure, not a formality. It means the baseline on disk
 * was not produced by a run that held the database, so there is no evidence about what
 * produced the before-counts — which is the whole point of the exercise. `npm run verify`
 * always goes through the preflight, so this branch means someone ran `--compare` by hand
 * against a stale file, or truncated the lock out from under a live run.
 */
const lock = readLock();
const sameFile = (left, right) => {
  if (left === null || right === null) return false;
  if (left === right) return true;
  // The preflight records the absolute path; `npm run verify` passes the same string it
  // redirected to (`node_modules/.residue-before.json`, relative to the repo root). Both
  // name one file, so compare resolved paths rather than the strings.
  return resolve(left) === resolve(right);
};

if (lock === null) {
  process.stderr.write(
    'NO RUN LOCK — this comparison has no baseline it can trust.\n\n' +
      `The preflight (\`--require-clean\`) takes an exclusive lock and leaves it for this\n` +
      `step to release. There is no lock at ${LOCK_PATH}\n\n` +
      'So either the preflight did not run, or it refused (in which case its message is\n' +
      'above and the baseline file is empty), or a live run is in progress and this pass\n' +
      'is reading its half-written state. Re-run the whole chain:\n\n' +
      '  npm run verify\n',
  );
  process.exit(2);
}

if (lock.malformed) {
  process.stderr.write(
    `UNREADABLE RUN LOCK at ${LOCK_PATH}\n\n` +
      'The lock file exists but is not valid JSON, so the baseline path it guards cannot\n' +
      'be checked. Delete it and re-run the chain:\n\n' +
      `  rm ${LOCK_PATH}\n` +
      '  npm run verify\n',
  );
  // Deliberately not deleted here: an unreadable lock is evidence of something odd, and
  // removing evidence before the reader sees it is how a defect becomes a mystery.
  process.exit(2);
}

if (!sameFile(lock.baselinePath, path)) {
  process.stderr.write(
    'BASELINE / LOCK MISMATCH — refusing to compare.\n\n' +
      `  lock says   ${lock.baselinePath === null ? '(nothing recorded)' : lock.baselinePath}\n` +
      `  given       ${resolve(path)}\n\n` +
      'The run that took the lock wrote its baseline somewhere else, so this comparison\n' +
      'would be reading a file the lock does not describe. That is the concurrent case the\n' +
      'lock exists to catch, seen from the other side: one run holding the database while a\n' +
      'second compares against a third file.\n\n' +
      'If you are running the three commands by hand and redirected to your own path, pass\n' +
      'the same path to the preflight so the pairing is recorded:\n\n' +
      `  node scripts/check-residue.mjs --require-clean --baseline ${path} > ${path}\n`,
  );
  // Deliberately NOT released. The whole meaning of a mismatch is that this pass does not
  // know whose lock that is, and the plausible owner is a *live* run that took the lock
  // while this chain was between its preflight and its comparison. Deleting it would hand
  // the concurrency defect to the one run that was behaving correctly. Refusing and leaving
  // the lock alone means the worst case is a stale lock, which is stealable, rather than a
  // live run that lost its guard mid-flight.
  process.exit(2);
}

/**
 * A missing or truncated baseline file is not an exotic case — it is what you get
 * whenever the preflight before it failed, because the `&&` chain redirects the
 * preflight's stdout into this very file and the preflight writes nothing on failure.
 * So a bare `JSON.parse` here would turn "the preflight refused, look at its message"
 * into `SyntaxError: Unexpected end of JSON input` pointing at this line. That is a
 * worse error than the one it hides: it names the parser rather than the cause.
 */
let before;
try {
  before = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  process.stderr.write(
    `Cannot read a baseline from ${path}.\n\n` +
      `That usually means the \`--require-clean\` preflight before this step failed and ` +
      `wrote nothing — check its message above, which names the dirty table and its ` +
      `count. It can also mean the path is wrong.\n\n` +
      `(${error instanceof Error ? error.message : String(error)})\n`,
  );
  // Release, because the preflight did take the lock and did not get to this step. Holding
  // it would block the `residue:wipe` the preflight's own message recommends.
  finish(2);
}

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
  finish(0);
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
// Released on the failing path as well as the passing one. A gate that wedges itself when
// it reports a leak is worse than the leak: the next person sees the lock refusal and not
// the finding, and the finding is the thing that was supposed to be actionable.
finish(1);
