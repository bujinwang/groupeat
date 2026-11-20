/**
 * Counts the rows the test suite is most likely to leak, so a run can be checked for
 * residue rather than trusted to have cleaned up.
 *
 * Usage:
 *
 *   node scripts/check-residue.mjs                      # the counts alone, for diagnosis
 *   node scripts/check-residue.mjs --provenance          # HEAD + tree state, for diagnosis
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
 *
 * ## A green line is about a tree, not a hash
 *
 * `AGENTS.md` used to say, accurately, that `npm run verify` reads the working tree rather
 * than `HEAD`, that "Nothing checks it", and that the paragraph itself was "the only thing
 * standing between a green gate and a wrong hash". Committing first was a rule a person had
 * to remember. That rule is now the check below: `--require-clean` refuses to certify a
 * dirty tree, stamps `HEAD` and a fingerprint of `git status --porcelain` into the baseline,
 * and `--compare` refuses the certificate if either moved. The success line names the short
 * SHA it was measured at, so a green line and a hash now travel together.
 *
 * It does not make `vitest run` read `HEAD` — nothing can — and it does not watch the tree
 * continuously. It makes a false certificate *loud and non-zero* instead of quiet and green.
 * A hand-written baseline can still forge both markers; this gate has always been an
 * accident-detector, not an adversary-detector, and anyone able to write `node_modules/`
 * could already forge `__baselineClean`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * What the tests actually ran: the commit and the working tree at one instant.
 *
 * `vitest run` reads **files on disk**, not `HEAD`. Every certification in this repository
 * before this check existed was therefore a statement about a tree that happened to be on
 * somebody's disk at the time, with nothing in the gate recording which tree that was. The
 * cost was measured twice in one session: a teammate's uncommitted comment rewrite landed
 * during a live `npm run verify` and the run came back green with `POST: dirty=5`, and an
 * hour went into chasing a count that belonged to a worktree mid-edit. Both numbers were
 * real. Neither belonged to the commit they were reported against.
 *
 * So the preflight stamps this and the comparison re-reads it. Three things can make a green
 * line a false certificate, and all three are checked:
 *
 *   - `head`        — somebody committed (or checked out) between the two processes;
 *   - `statusHash`  — somebody edited, staged, or dropped an untracked file between them;
 *   - `treeClean`   — the run *started* dirty, so it was never about the commit at all.
 *
 * The hash is of `git status --porcelain`'s raw output, not of file contents. On a clean tree
 * — the only tree a preflight will now certify — any edit changes that output, which is all
 * the check needs. It is a **two-point check, not a watcher**: an edit made and reverted
 * between the preflight and the comparison is invisible. At both endpoints the tree is clean
 * and `HEAD` is unchanged, so the certificate describes the tree at both ends even though it
 * cannot describe every instant between them. A file-content hash of the whole worktree on
 * every run would buy more certainty than this gate needs and more time than it has.
 *
 * Returns `ok: false` rather than throwing when git is unavailable: a checkout without
 * `.git` (a tarball, a CI export) is a real way this script gets run, and the response is to
 * refuse certification with a sentence a human can act on, not a stack trace.
 */
function readTree() {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    const status = git(['status', '--porcelain']);
    return {
      ok: true,
      head,
      status,
      statusHash: createHash('sha256').update(status).digest('hex'),
      treeClean: status.trim().length === 0,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The stamp written into a baseline. Deliberably no raw `status`: it can be huge. */
function treeStamp(tree) {
  return { head: tree.head, statusHash: tree.statusHash, treeClean: tree.treeClean };
}

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
      // it. All seven teardowns select ledger rows by `dropId` — six use
      // `{ in: dropIds }`, one uses a scalar `dropId` — and neither shape can match
      // NULL. And `@@unique([orderId, type])` sits on a nullable column, so Postgres
      // does not even stop two `orderId: null` rows of the same type. A row written
      // without a `dropId` would outlive every teardown in this repository with no
      // counter able to see it. Count it UNSCOPED: the blind spot is exactly the rows
      // those scoped deletes miss. `reset-residue.mjs` already deletes it by name.
      ledgerEntry: await prisma.ledgerEntry.count(),
      // FR-606's idempotency record. A redeem test that supplies a `scanId` writes
      // one, and it cascades from `DropParticipant` — so a teardown that deletes
      // participants removes it. Counted anyway, for the reason this file keeps
      // repeating: a table no counter can see is a table whose leak is invisible,
      // and the cascade is exactly the kind of thing that changes silently.
      redemptionScans: await prisma.redemptionScan.count(),
      auditLogs: await prisma.auditLog.count(),
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * `--provenance`: the git half of the baseline, with no database and no lock.
 *
 * This exists so the gate's own tests can build a baseline carrying a **genuine** stamp
 * produced by this implementation, instead of re-implementing the hashing in a test fixture
 * (which would keep passing if the hashing here broke). Like the plain dump it is a
 * diagnostic, not a check: it exits 0 and reports whatever it found, including `ok: false`.
 */
if (process.argv.includes('--provenance')) {
  process.stdout.write(`${JSON.stringify(readTree(), null, 2)}\n`);
  process.exit(0);
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
// The lock, taken before a single row is counted — and the tree, read before the
// counts so a refused run never leaves numbers that look attributable.
// ---------------------------------------------------------------------------

/**
 * Set by a successful preflight and written into its baseline. Module scope because the
 * stamp is built in the `--compare`-less branch below, in the same process but after the
 * counts. Reading git *once*, at the moment the run is admitted, is the whole point: a
 * second read here would let a change during the preflight be stamped as if it had been
 * there all along.
 */
let treeAtStart = null;

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

  treeAtStart = readTree();

  if (!treeAtStart.ok) {
    releaseLock();
    process.stderr.write(
      'CANNOT READ GIT PROVENANCE — refusing to certify this run.\n\n' +
        `  ${treeAtStart.error}\n\n` +
        'The gate cannot say which commit and which working tree `vitest run` is about to\n' +
        'read, so a green line would be a certificate with no subject. This happens on a\n' +
        'checkout without `.git` (a tarball or a CI export) or when `git` is not on PATH.\n' +
        'Run the gate from a real git worktree. `npm test` remains available for a run that\n' +
        'is not a certificate.\n',
    );
    process.exit(2);
  }

  if (!treeAtStart.treeClean) {
    releaseLock();
    const paths = treeAtStart.status
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const shown = paths.slice(0, 20).map((line) => `  ${line}\n`).join('');
    const rest = paths.length > 20 ? `  ... and ${paths.length - 20} more\n` : '';
    process.stderr.write(
      'UNCOMMITTED WORK — refusing to certify this run.\n\n' +
        `  HEAD  ${treeAtStart.head}\n` +
        `  git status --porcelain reported ${paths.length} path(s):\n${shown}${rest}\n` +
        '`vitest run` reads the working tree, not `HEAD`. A green line from a dirty tree is\n' +
        'a claim about files that exist only on this disk; quoting it against the commit\n' +
        'above is a false certificate. This is measured, not hypothetical: a comment\n' +
        'rewrite landed during a live `npm run verify` in this repository and the run came\n' +
        'back green with POST: dirty=5, and another session lost an hour to a count that\n' +
        'belonged to a worktree mid-edit.\n\n' +
        'Commit (or stash) the work, then re-run the gate:\n\n' +
        '  git add <paths> && git commit -m "..."\n' +
        '  npm run verify\n\n' +
        'For a check on uncommitted work that is deliberately NOT a certificate, use\n' +
        '`npm test`. The run lock has already been released, so this refusal does not\n' +
        'wedge the next run.\n',
    );
    process.exit(2);
  }
}

const counts = await readCounts();

/**
 * Rows that legitimately outlive a run, reported but never fatal.
 *
 * `AuditLog` has no cascade from its target — `actorUserId` is `SetNull` and `targetId`
 * is a plain string — because an audit trail that vanished with its subject would not be
 * a record of anything. So a suite that exercises FR-902/903 necessarily leaves rows no
 * teardown should delete. Measured at +73 per full run. This sentence was written at
 * `e8a64c4` (2026-11-03) as "+71"; the delta became +73 at `5df2ae6` (2026-11-05), the
 * slice that took the suite from 2555 to 2580 tests, and has stayed +73 through every
 * gate recorded since `62090db`. Corrected 2026-11-05 rather than left as a
 * plausible-looking number. The printed `expected growth:` line is the live value; this is
 * a dated observation, not a threshold — a new audit-log-writing test will change it again.
 *
 * The suite size is deliberately not named here. The `e9fe581` correction pinned "2618
 * tests", and the very next slice added two mechanism tests, which would have made a
 * freshly corrected number stale for a reason that has nothing to do with audit logs.
 * Read the count from the runner's `Tests` line; do not freeze it in a comment.
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
    // Same rule for provenance: an absent `__git` is a baseline written before this check
    // existed, or one written by hand. Neither can produce a certificate. The stamp is
    // deliberately three scalar values and not the raw status text, so a baseline remains
    // small enough to read when somebody is diagnosing a refusal.
    ...(treeAtStart === null ? {} : { __git: treeStamp(treeAtStart) }),
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

/**
 * The certificate's second precondition: the code the suite ran is the code being named.
 *
 * Only a baseline that claims `__baselineClean` reaches here. That marker is the
 * certificate, so it is the one that has to carry provenance; a hand-written baseline
 * without it keeps the older, deliberately non-certifying `UNVERIFIED` behaviour and never
 * gets a green line with a hash attached.
 *
 * Every refusal goes through `finish(2)`, not `process.exit`: the preflight took the run
 * lock, and a refusal that left it behind would wedge the *next* run for a reason that has
 * nothing to do with residue. Exit 2 is "the baseline cannot be trusted", which is what
 * each of these is — `1` would say the suite leaked rows, and it did not.
 */
let provenance = null;
if (baselineClean) {
  const treeAtEnd = readTree();
  const refuse = (message) => {
    process.stderr.write(message);
    finish(2);
  };

  if (!treeAtEnd.ok) {
    refuse(
      'CANNOT READ GIT PROVENANCE — refusing the certificate.\n\n' +
        `  ${treeAtEnd.error}\n\n` +
        'The preflight recorded a commit and a working tree; this pass cannot re-read them,\n' +
        'so it cannot say whether the two halves of the run saw the same code. Re-run the\n' +
        'whole chain from a real git worktree: npm run verify\n',
    );
  }

  const stamp = before.__git;
  const validStamp =
    stamp !== null &&
    typeof stamp === 'object' &&
    !Array.isArray(stamp) &&
    typeof stamp.head === 'string' &&
    typeof stamp.statusHash === 'string' &&
    typeof stamp.treeClean === 'boolean';

  if (!validStamp) {
    refuse(
      'BASELINE HAS NO GIT PROVENANCE — refusing the certificate.\n\n' +
        `  ${path}\n\n` +
        'This baseline claims a clean database but does not record the commit and working\n' +
        'tree it was measured at. It was written by an older `--require-clean`, or by hand.\n' +
        'A green line from it would be a certificate with no subject, which is exactly the\n' +
        'defect this check exists to stop. Re-run the whole chain: npm run verify\n',
    );
  }

  const short = (value) => value.slice(0, 7);
  const statusBlock = treeAtEnd.status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 20)
    .map((line) => `  ${line}\n`)
    .join('');

  if (stamp.head !== treeAtEnd.head) {
    refuse(
      'HEAD MOVED DURING THE RUN — refusing the certificate.\n\n' +
        `  preflight  ${short(stamp.head)}\n` +
        `  now        ${short(treeAtEnd.head)}\n\n` +
        'Somebody committed, checked out, or reset between the preflight and this\n' +
        'comparison. `vitest run` read the tree that existed while it ran, so neither hash\n' +
        'describes the whole run. Re-run the chain on one commit: npm run verify\n',
    );
  }

  if (stamp.statusHash !== treeAtEnd.statusHash) {
    refuse(
      'WORKING TREE CHANGED DURING THE RUN — refusing the certificate.\n\n' +
        (statusBlock === '' ? '  (the tree is clean now; it was not at the preflight)\n' : statusBlock) +
        '\n' +
        '`vitest run` reads files on disk, not `HEAD`. An edit, a staged change, or an\n' +
        'untracked file appeared (or disappeared) between the preflight and this pass, so\n' +
        'the suite did not see one tree. This is the measured incident: a comment rewrite\n' +
        'landed during a live `npm run verify` here and the run came back green with\n' +
        'POST: dirty=5. Commit first, then re-run: npm run verify\n',
    );
  }

  if (stamp.treeClean !== treeAtEnd.treeClean) {
    refuse(
      'TREE CLEANLINESS CHANGED DURING THE RUN — refusing the certificate.\n\n' +
        `  preflight  ${stamp.treeClean ? 'clean' : 'dirty'}\n` +
        `  now        ${treeAtEnd.treeClean ? 'clean' : 'dirty'}\n\n` +
        'The two processes disagree about whether the working tree was committed state.\n' +
        'Re-run the chain from a clean tree: npm run verify\n',
    );
  }

  provenance = { head: treeAtEnd.head, treeClean: treeAtEnd.treeClean };
}

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
    // The hash travels WITH the green line. Separate lines get copied separately, and a
    // green line quoted next to a hash from a different run is the exact failure this
    // check was written for. A dirty tree at both ends (only possible from a hand-written
    // baseline — the preflight refuses such a tree) gets the old unattributed wording and
    // an explicit warning rather than a hash it has no claim to.
    const attribution = provenance.treeClean ? ` at ${provenance.head.slice(0, 7)}` : '';
    process.stdout.write(
      `no residue — VERIFIED from a clean baseline${attribution}: all ${mustBeClean.length} counted ` +
        `tables started at 0 and ended at 0${growthNote}\n`,
    );
    if (!provenance.treeClean) {
      process.stdout.write(
        '  WARNING: the working tree was dirty at both ends of this run. This result is\n' +
          `  NOT attributable to ${provenance.head.slice(0, 7)} or any commit.\n`,
      );
    }
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
