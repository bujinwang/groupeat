/**
 * One run at a time per database — the cross-process lock behind the residue gate.
 *
 * ## The accident this exists to stop
 *
 * A dry run of `residue:wipe` reported two `user` rows at the start of a session. They
 * were not residue. Querying them showed `authmeyeml7-*` fixture accounts created four
 * seconds earlier — six of them by the time the query ran — and `ps` showed
 * `npm run verify` running at that moment at 1:51 elapsed. The operator was reading the
 * database through someone else's live test run and had no way to know.
 *
 * Nothing was broken in the gate's logic. It counted what was there. What was broken is
 * that it could not say *whose* rows those were, and neither could the reader, because
 * two processes were mutating one database with no exclusion between them. That is the
 * same family as every other defect this slice fixed: **a gate that cannot say what it
 * measured.** A count taken during another run is a count of an unknown mixture, and
 * both runs' results become unattributable — including the innocent one.
 *
 * ## Two shared mutable artifacts, not one
 *
 *   - the `groupeat_dev` database;
 *   - the baseline file, at a **fixed** path (`node_modules/.residue-before.json`).
 *
 * `fileParallelism: false` in `vitest.config.ts` serialises test files *within one
 * process*. It says nothing about two `npm run verify` invocations, let alone two people.
 * The second artifact is worse than the first in one respect: the preflight writes the
 * baseline with a shell redirect (`> node_modules/.residue-before.json`), so two
 * concurrent runs overwrite each other's baseline and then each compare against a file
 * the other one wrote. The counts can be individually correct and the comparison
 * meaningless.
 *
 * ## Why a file and not a handle
 *
 * The preflight (`--require-clean`) and the comparison (`--compare`) are **separate
 * processes** with `vitest run` between them, so an in-process lock cannot span the run
 * that needs protecting. The lock therefore outlives the process that took it, which
 * means it also has to be recoverable: a lock that can wedge the gate is worse than no
 * lock at all.
 *
 * The protocol, in full:
 *
 *   1. `--require-clean` creates `node_modules/.residue.lock` with `fs.openSync(...,'wx')`
 *      — an atomic exclusive create that fails if the file exists. It writes
 *      `{ pid, ownerPid, startedAt, baselinePath, argv }`, closes the descriptor, and leaves
 *      the file for `--compare` to find. The lock is released on every path where the
 *      preflight itself refuses, because in those cases no run is going to happen.
 *   2. `--compare` requires the lock to exist and its `baselinePath` to equal the path it
 *      was given, then deletes it **on success and on the residue-found path**, so a
 *      failing run does not wedge the next one.
 *   3. Anything else that finds the lock treats a **dead owner as stale and steals it**,
 *      printing one line. The pid is checked with `process.kill(pid, 0)`, which throws
 *      `ESRCH` for a process that is gone. There is no age heuristic: a long run is
 *      normal, and "the lock is old" is not evidence of anything.
 *
 * ## Why the lock names two processes, and which one decides liveness
 *
 * The obvious payload is the preflight's own pid, and it does not work. Measured: the
 * preflight writes the lock and exits in well under a second — the `&&` chain moves
 * straight on to `vitest run` — so the recorded pid is **dead four lines into a two-minute
 * run**. `isProcessAlive` then says so, a second run's preflight steals the lock without
 * hesitating, and the lock prevents exactly nothing. A dead-pid-steal rule is only safe if
 * the pid it checks lives as long as the thing being protected.
 *
 * The process whose lifetime *is* the protected window is the preflight's **parent**. Under
 * `npm run verify` that parent is `sh -c '… && vitest run && …'`, which exists from before
 * the first preflight until after the final `--compare`. So the payload records both:
 *
 *   - `pid`      — the preflight itself, for diagnosis ("who wrote this and when").
 *   - `ownerPid` — the parent, and the pid liveness is actually decided on.
 *
 * When `ownerPid` is absent — a lock written by hand, or by an older version of this script
 * — liveness falls back to `pid`, which is the only thing there is. That fallback is what
 * the stale-lock test exercises, and it is the honest behaviour: a lock naming one process
 * is a lock about that one process.
 *
 * The cost of choosing the parent is that a **hand-written** three-command run, started from
 * an interactive shell, names that shell. Its lock reads as live for as long as the shell
 * does, so abandoning the manual flow midway leaves a lock that must be removed by hand
 * rather than stolen. That is the right trade — the interactive case has a human present to
 * read the message, and the message names the exact file — and the alternative, keying
 * liveness on a pid that dies in a second, protects nobody.
 *
 * Step 2 does not check the pid, and cannot: `--compare` is a sibling of the preflight, not
 * its child, and the preflight has already exited by the time the comparison runs. That is
 * exactly why the baseline path is in the payload. It is the only thing the two processes
 * can check against each other.
 *
 * ## What is deliberately not locked
 *
 * `npm run residue` — the plain dump. It is a read-only diagnostic and it is the command
 * you reach for *while diagnosing* a concurrent run, so it has to stay usable during one.
 * Its output is still a count from an unknown mixture; that is why it prints counts and
 * exits 0 whatever they are, and why `AGENTS.md` says the dump is not a check.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exit code for "another run holds the lock". Distinct from 1 (residue found) and 2 (bad
 * arguments or a baseline that cannot be trusted), because a caller — and a test — has to
 * tell refusal-by-concurrency apart from refusal-because-the-suite-leaked. Those are
 * different problems with different fixes, and one of them is nobody's fault.
 */
export const LOCK_REFUSED_EXIT = 3;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the lock lives when nothing overrides it.
 *
 * Inside `node_modules/` on purpose. `.gitignore` ignores `node_modules/`, so a lock can
 * never be committed by accident — which matters more than it sounds: a lock file swept into
 * a commit is a lock that exists in every checkout, naming a pid that belongs to somebody
 * else's machine, and it would make the first run on a fresh clone believe a run was live.
 * A teammate lost an hour this same session to a commit that swept up another person's
 * in-progress edit; a committable lock is that mistake with a longer fuse.
 */
export const DEFAULT_LOCK_PATH = join(ROOT, 'node_modules', '.residue.lock');

/**
 * The lock path in force.
 *
 * `GROUPEAT_RESIDUE_LOCK_PATH` exists for exactly one purpose: the suite's own tests of
 * this module, which must take and steal locks while a real `npm run verify` is holding the
 * real one. A test that touched the default path would either refuse itself or, worse,
 * delete the lock the outer run is relying on and turn its `--compare` into a confusing
 * failure. Nothing else should set it, and the default is what the guard below protects.
 */
export const LOCK_PATH = process.env.GROUPEAT_RESIDUE_LOCK_PATH
  ? resolve(process.env.GROUPEAT_RESIDUE_LOCK_PATH)
  : DEFAULT_LOCK_PATH;

/**
 * Refuse to load if the default lock path is not under `node_modules/`.
 *
 * A development-time invariant, so it throws at import rather than warning: a default lock
 * path at a committable location is a defect in this module, not a runtime condition, and it
 * has to fail loudly enough that nobody ships it. Only the default is checked — the override
 * is a test hook and points at a temp directory by design.
 */
{
  const inside = relative(join(ROOT, 'node_modules'), DEFAULT_LOCK_PATH);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      `The residue lock must live inside node_modules/ so it can never be committed, but ` +
        `DEFAULT_LOCK_PATH is ${DEFAULT_LOCK_PATH}.`,
    );
  }
}

/**
 * Whether a process id is alive.
 *
 * `process.kill(pid, 0)` sends no signal; it only reports whether the pid exists. It
 * throws `ESRCH` when it does not. `EPERM` means the process exists and belongs to
 * another user, which is *alive* — treating it as dead would let us overwrite a lock held
 * by a live run, i.e. disable the lock in exactly the multi-user case it is for.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * The lock as it is on disk, or `null` when there is none.
 *
 * A lock that exists but cannot be parsed comes back as `{ malformed: true, raw }` rather
 * than `null`. The difference matters: `null` means "nobody holds it, take it", while a
 * malformed file means "something wrote this and we do not know what" — which is treated
 * as stale, but has to be *reported*, because the next thing a reader wants to know is
 * why the gate believed a lock with no pid in it.
 *
 * Both pids are carried through rather than collapsed here. `ownerPid` is the one liveness
 * is decided on (see the header); `pid` is kept so a message can name the process that wrote
 * the file, which is the number a reader will match against `ps`.
 */
export function readLock() {
  let raw;
  try {
    raw = readFileSync(LOCK_PATH, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { malformed: true, raw };
    }
    return {
      malformed: false,
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      ownerPid: typeof parsed.ownerPid === 'number' ? parsed.ownerPid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      baselinePath: typeof parsed.baselinePath === 'string' ? parsed.baselinePath : null,
      argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
    };
  } catch {
    // A truncated file is what a kill -9 during the write leaves behind, so this is a
    // real state and not a corrupt-disk hypothetical. Steal it, but say so.
    return { malformed: true, raw };
  }
}

/** Wraps whatever `readLock()` found into one shape, with a liveness answer. */
export function describeHolder(existing) {
  if (existing === null || existing === undefined) {
    return {
      present: false,
      alive: false,
      pid: null,
      ownerPid: null,
      startedAt: null,
      baselinePath: null,
      argv: [],
      detail: 'no lock file',
    };
  }

  if (existing.malformed) {
    return {
      present: true,
      alive: false,
      pid: null,
      ownerPid: null,
      startedAt: null,
      baselinePath: null,
      argv: [],
      detail: `the lock file is not readable as JSON (${JSON.stringify(existing.raw.slice(0, 120))})`,
    };
  }

  // The owner is the process whose lifetime spans the protected window; `pid` is only the
  // preflight and dies within a second of writing this file. Falling back to `pid` keeps a
  // hand-written or older lock meaningful instead of pretending it names no process.
  const effectivePid = existing.ownerPid ?? existing.pid;
  const alive = isProcessAlive(effectivePid);

  return {
    present: true,
    alive,
    pid: existing.pid,
    ownerPid: existing.ownerPid,
    startedAt: existing.startedAt,
    baselinePath: existing.baselinePath,
    argv: existing.argv,
    detail:
      effectivePid === null
        ? 'the lock file names no process id'
        : alive
          ? `pid ${effectivePid} is still running`
          : `pid ${effectivePid} is not running`,
    effectivePid,
  };
}

/**
 * The lock, if a live process holds it. `null` when nobody does.
 *
 * This is the check `residue:wipe` makes. It does not steal and it does not create: a
 * wipe that finds a stale lock only needs to get it out of the way, and a wipe that finds
 * a live one must stop.
 */
export function liveHolder() {
  const holder = describeHolder(readLock());
  return holder.present && holder.alive ? holder : null;
}

/**
 * One human-readable block describing a holder, for a refusal message.
 *
 * Both pids are printed when they differ, because they answer different questions: `owner`
 * is the process that has to stop for the gate to run, and `preflight` is the one a reader
 * can find in the shell history. Printing only the preflight would name a process that has
 * already gone, which is a refusal message that sends people looking for a ghost.
 */
export function formatHolder(holder) {
  const ownerPid = holder.ownerPid ?? holder.pid;
  const lines = [
    `  running     pid ${ownerPid === null ? '(not recorded)' : ownerPid}` +
      (holder.alive ? '' : '  — but that process is not alive'),
  ];
  if (holder.ownerPid !== null && holder.pid !== null && holder.ownerPid !== holder.pid) {
    lines.push(`  preflight   pid ${holder.pid} (exits before the suite starts)`);
  }
  lines.push(`  started     ${holder.startedAt === null ? '(not recorded)' : holder.startedAt}`);
  lines.push(
    `  baseline    ${holder.baselinePath === null ? '(not recorded)' : holder.baselinePath}`,
  );
  if (holder.argv.length > 0) {
    lines.push(`  command     node scripts/… ${holder.argv.join(' ')}`);
  }
  return lines.join('\n');
}

/** The lock file's directory. `node_modules/` exists in any installed checkout, but the
 * lock must not be the thing that fails when it does not — a fresh clone that runs the
 * gate before `npm install` should get a Prisma error, not an `ENOENT` about a lock. */
function ensureDirectory() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
}

/**
 * Take the lock, stealing it if its holder is gone.
 *
 * Returns `{ ok: true, stolen: <holder|null> }` or `{ ok: false, holder }`. The caller
 * prints the refusal, because the two callers have different things to say afterwards.
 *
 * `baselinePath` is what the eventual `--compare` will check itself against, so it has to
 * be the path the baseline is actually being written to. When it is `null` the pairing
 * cannot be verified later, and `--compare` says so instead of pretending.
 */
export function acquireLock({ baselinePath = null, argv = [], ownerPid = process.ppid } = {}) {
  ensureDirectory();

  const payload = {
    pid: process.pid,
    ownerPid,
    startedAt: new Date().toISOString(),
    baselinePath,
    argv: argv.map(String),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  // Two attempts, not a loop. The only way to lose the first is another process unlinking a
  // stale lock between our unlink and our create; losing twice means a live process is
  // genuinely cycling the lock, which is a refusal, not a spin.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      try {
        writeSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      return { ok: true, stolen: null };
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
    }

    const holder = describeHolder(readLock());

    // Our *own* lock file is not a conflict — it means this process already wrote one, which
    // only happens if the preflight is invoked twice in one process. The check is
    // deliberately narrow: it compares our pid against the writer's, and no other process
    // relationship. An earlier draft also treated "the owner is our parent" as ours, on the
    // theory that an `&&` chain is one thing. It is not safe: two `npm run verify`
    // invocations backgrounded from the same interactive shell share that shell as their
    // parent, so the second would have stolen the first's live lock and disarmed the guard
    // in precisely the two-run scenario it exists for.
    const ourOwnLock = holder.pid === process.pid;

    if (holder.alive && !ourOwnLock) {
      return { ok: false, holder };
    }

    // Dead owner, unreadable file, or a lock this chain wrote. All three are ours to clear.
    // The dead-owner case is the common one: `vitest run` failed or was killed, so the `&&`
    // chain stopped before `--compare` could release the lock.
    process.stderr.write(
      `residue lock: stealing the lock ${
        holder.present
          ? `owned by pid ${holder.ownerPid ?? holder.pid ?? '(unreadable)'}`
          : 'that vanished mid-check'
      } — ${holder.detail}.\n`,
    );
    try {
      unlinkSync(LOCK_PATH);
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    }
  }

  return { ok: false, holder: describeHolder(readLock()) };
}

/**
 * Release the lock. Always safe to call, including when it is already gone.
 *
 * Returns whether a lock file was actually removed, so a caller can report "released"
 * accurately rather than assuming.
 */
export function releaseLock() {
  try {
    unlinkSync(LOCK_PATH);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove a lock whose holder is gone, without taking it.
 *
 * `residue:wipe` calls this: it must not leave a dead lock behind for the next gate run to
 * trip over, but it must not claim the lock while it is only printing a dry run.
 */
export function clearIfStale() {
  const holder = describeHolder(readLock());
  if (!holder.present || holder.alive) return { cleared: false, holder };
  releaseLock();
  return { cleared: true, holder };
}
