/**
 * Tests for the cross-process run lock behind `scripts/check-residue.mjs`.
 *
 * ## Why these tests spawn processes instead of importing the module
 *
 * The lock's entire reason for existing is that the preflight and the comparison are
 * **separate processes**, with `vitest run` between them. A test that imported
 * `residue-lock.mjs` and called `acquireLock()` would prove the functions work and prove
 * nothing about the property that matters, which is that a *second OS process* is refused.
 * Two cooperating functions in one address space cannot demonstrate that — an in-process
 * mutex would pass such a test and protect nothing. So every case below runs the real
 * scripts with `child_process`, and the lock is observed on disk.
 *
 * ## Why the lock path is redirected
 *
 * These tests take and delete locks *while a real `npm run verify` is holding the real one*,
 * because that is when the suite runs. Touching `node_modules/.residue.lock` from here would
 * either refuse the outer run's own comparison or delete the lock the outer run is relying
 * on, turning an honest gate into an inscrutable failure. Every test therefore sets
 * `GROUPEAT_RESIDUE_LOCK_PATH` to a path inside a per-test temp directory.
 *
 * ## The liveness rule, and the pid these tests use
 *
 * The lock records the pid of its **owner** — the process whose lifetime spans the run, not
 * the preflight, which exits within a second. A stale lock is one whose owner is gone, and
 * "gone" is decided by `process.kill(pid, 0)`. These tests cannot manufacture a real dead
 * pid portably, so they use a pid that is guaranteed not to exist in any plausible session:
 * they spawn `node -e ''`, wait for it to exit, and reuse its pid. It is a real pid, it was
 * really alive, and it is really dead by the time the assertion runs — which is exactly the
 * state a killed `npm run verify` leaves behind.
 *
 * ## Why a hand-built baseline now carries a git stamp
 *
 * Since the provenance slice, `--compare` refuses a baseline that claims
 * `__baselineClean: true` without a `__git` stamp. These fixtures are hand-built on purpose
 * — they must not depend on the database being empty — but they still have to be honest
 * about the tree. `--provenance` supplies the gate's own reading rather than a copy of its
 * hashing logic. Two preflight tests also branch on `treeClean`: the gate now refuses a
 * dirty working tree with exit 2 *before* it reads the database, so on an uncommitted tree
 * the "dirty baseline" branch is a provenance refusal instead of a residue refusal. This
 * file stays independent of both the database's cleanliness and the tree's cleanliness;
 * `residue-provenance.test.ts` is where the provenance check itself is pinned.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The repository root, four levels up from this file:
 * `src/lib/scripts/__tests__/` → `src/lib/scripts` → `src/lib` → `src` → repo.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CHECK_RESIDUE = join(REPO_ROOT, 'scripts', 'check-residue.mjs');
const RESET_RESIDUE = join(REPO_ROOT, 'scripts', 'reset-residue.mjs');

/** Exit code `check-residue.mjs` and `reset-residue.mjs` use for "another run holds it". */
const LOCK_REFUSED_EXIT = 3;

/** The exit code a second preflight returns, mirrored so the assertion reads as intent. */
interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The three scalar values `--require-clean` stamps into a baseline. */
interface TreeStamp {
  readonly head: string;
  readonly statusHash: string;
  readonly treeClean: boolean;
}

/**
 * Runs a script and resolves with its exit code and both streams.
 *
 * `spawn` rather than `execFileSync` because the interesting cases include a script that
 * refuses, and a synchronous helper that throws on a non-zero exit would make the assertion
 * about the throw rather than about the exit code.
 */
function runNode(
  args: readonly string[],
  options: {
    readonly lockPath: string;
    readonly baselinePath?: string;
    readonly detached?: boolean;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GROUPEAT_RESIDUE_LOCK_PATH: options.lockPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached ?? false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A pid that is certainly not running.
 *
 * Spawns a trivial node process, waits for it to exit, and returns the pid it had. The
 * process really existed and really exited, so the pid is dead — no guessing at a range, no
 * assuming `99999` is free, and no risk of picking the pid of the test runner itself.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const { pid } = child;
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      resolve();
    });
  });
  if (pid === undefined) throw new Error('spawned child had no pid');
  return pid;
}

/**
 * Writes a lock file claiming a given owner pid, in the shape the real script writes.
 *
 * Written directly rather than through `acquireLock()` on purpose: the test needs to control
 * the recorded pid, and a lock whose owner is already dead cannot be produced by a live
 * process. The shape is asserted elsewhere (`a preflight writes a lock naming its owner`),
 * so this fixture stays honest.
 */
function writeLock(
  lockPath: string,
  ownerPid: number,
  overrides: Partial<{
    pid: number;
    startedAt: string;
    baselinePath: string | null;
    argv: readonly string[];
  }> = {},
): void {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        pid: overrides.pid ?? ownerPid,
        ownerPid,
        startedAt: overrides.startedAt ?? new Date().toISOString(),
        baselinePath: overrides.baselinePath ?? null,
        argv: overrides.argv ?? [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * The gate's own git reading, used to make a hand-built baseline carry a genuine stamp.
 *
 * It is a read-only diagnostic with no database and no lock, so it is safe to call while the
 * outer `npm run verify` holds the real one. `treeClean` is also how the two preflight tests
 * below decide which refusal they should expect on an uncommitted tree.
 */
async function provenance(): Promise<TreeStamp> {
  const result = await runNode([CHECK_RESIDUE, '--provenance'], { lockPath });
  expect(result.code, `--provenance failed: ${result.stderr}`).toBe(0);
  const tree = JSON.parse(result.stdout) as TreeStamp & { ok: boolean; error?: string };
  expect(tree.ok, `--provenance failed: ${tree.error ?? result.stdout}`).toBe(true);
  return { head: tree.head, statusHash: tree.statusHash, treeClean: tree.treeClean };
}

/**
 * Runs a preflight and writes its stdout to `baselinePath`, mirroring the shell redirect in
 * `package.json` (`… --require-clean > node_modules/.residue-before.json`).
 *
 * The redirect is not incidental to what is being tested. `check-residue.mjs` never writes
 * the baseline itself — the `&&` chain's `>` does — so a test that only captured stdout would
 * be testing a script with no baseline on disk, and `--compare` would then fail for a reason
 * unrelated to the lock. Reproducing the redirect keeps the test on the real code path.
 */
async function runPreflight(
  options: { readonly lockPath: string; readonly baselinePath: string; readonly argv?: readonly string[] },
): Promise<RunResult> {
  const result = await runNode(
    [CHECK_RESIDUE, '--require-clean', '--baseline', options.baselinePath, ...(options.argv ?? [])],
    { lockPath: options.lockPath },
  );
  // Written whatever the exit code, exactly as `>` would: on refusal the preflight prints
  // nothing to stdout, so this truncates the file to empty — the state the real chain leaves
  // and the state `--compare` has to survive.
  writeFileSync(options.baselinePath, result.stdout, 'utf8');
  return result;
}

let workspace: string;
let lockPath: string;
let baselinePath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'groupeat-residue-lock-'));
  lockPath = join(workspace, '.residue.lock');
  baselinePath = join(workspace, 'baseline.json');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the lock path can never be committed', () => {
  it('defaults into node_modules, which gitignored the directory', async () => {
    // Read the *default* rather than the constant in force, so the assertion is about where
    // the lock lands when nothing overrides it — the case that ships. Read as text because
    // importing a `.mjs` module from a `strict` TypeScript test would need a declaration file
    // for it, and adding one for a single constant is more machinery than the invariant is
    // worth. The invariant is a string, so read the string.
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'residue-lock.mjs'), 'utf8');
    const match = /DEFAULT_LOCK_PATH\s*=\s*join\(([^)]*)\)/.exec(source);
    expect(match, 'DEFAULT_LOCK_PATH should be built with join(…)').not.toBeNull();
    const arguments_ = (match?.[1] ?? '').split(',').map((part) => part.trim());
    // The last two arguments are the directory and the file name.
    expect(arguments_.at(-2)).toBe("'node_modules'");
    expect(arguments_.at(-1)).toBe("'.residue.lock'");

    // And the repository actually ignores that directory, rather than merely naming it:
    // a lock that is not ignored is a lock somebody commits.
    const defaultPath = join(REPO_ROOT, 'node_modules', '.residue.lock');
    const ignored = spawn('git', ['check-ignore', '--quiet', defaultPath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    const ignoredCode = await new Promise<number | null>((resolve, reject) => {
      ignored.on('error', reject);
      ignored.on('close', (code) => {
        resolve(code);
      });
    });
    expect(ignoredCode, `${defaultPath} must be gitignored so a lock cannot be committed`).toBe(0);
  });
});

describe('a preflight that finds a live lock', () => {
  it('refuses to start and names the holding pid', async () => {
    // `process.pid` here is the test runner, which is unambiguously alive. Using a real live
    // pid matters: a lock naming a dead process must be *stolen*, and a test that used a
    // dead pid would assert the opposite of the intended behaviour.
    writeLock(lockPath, process.pid, {
      baselinePath,
      argv: ['--require-clean'],
    });

    const result = await runNode([CHECK_RESIDUE, '--require-clean', '--baseline', baselinePath], {
      lockPath,
    });

    expect(result.code).toBe(LOCK_REFUSED_EXIT);
    expect(result.stderr).toContain('ANOTHER RUN HOLDS THE DATABASE');
    expect(result.stderr).toContain(`pid ${process.pid}`);
    expect(result.stderr).toContain('kill');
  });

  it('does not count anything before refusing', async () => {
    // The ordering is the point of the whole change: a refusal computed from counts read
    // during another run would be the original defect wearing a lock. A refused preflight
    // writes nothing to stdout, so the redirected baseline stays empty — the observable
    // consequence of "the lock comes before the counts".
    writeLock(lockPath, process.pid, { baselinePath });

    const result = await runNode([CHECK_RESIDUE, '--require-clean', '--baseline', baselinePath], {
      lockPath,
    });

    expect(result.code).toBe(LOCK_REFUSED_EXIT);
    expect(result.stdout).toBe('');
  });
});

describe('a lock whose owner is gone', () => {
  it('is stolen, with one printed line naming the dead pid', async () => {
    const stalePid = await deadPid();
    writeLock(lockPath, stalePid, { baselinePath });

    const result = await runNode([CHECK_RESIDUE, '--require-clean', '--baseline', baselinePath], {
      lockPath,
    });

    // The exit code is deliberately *not* asserted as a fixed value. It depends on the
    // database — 0 when clean, 1 when a neighbouring suite's fixtures are live — and that has
    // nothing to do with whether a stale lock is stolen. What matters, and what is asserted,
    // is that the steal happened and the lock was not left naming a dead process.
    expect(result.stderr).toContain('stealing');
    expect(result.stderr).toContain(String(stalePid));
    expect(result.stderr).not.toContain('ANOTHER RUN HOLDS THE DATABASE');

    const cleanTree = (await provenance()).treeClean;
    if (result.code === 0) {
      // Clean baseline: the lock was replaced with this run's payload, which is what the
      // eventual `--compare` will match its baseline path against.
      const replaced = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(replaced.ownerPid).not.toBe(stalePid);
      expect(replaced.baselinePath).toBe(baselinePath);
    } else if (!cleanTree) {
      // An uncommitted tree is refused before the counts are read, with exit 2. The stale
      // lock is still stolen and still released — that is the property under test here.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('UNCOMMITTED WORK');
      expect(existsSync(lockPath)).toBe(false);
    } else {
      // Dirty database: the preflight refused, and the refusal path releases the lock so that
      // the `residue:wipe` its own message recommends is not blocked. A stale lock replaced by
      // one that then correctly vanishes is still a successful steal.
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('RESIDUE IN THE BASELINE');
      expect(existsSync(lockPath)).toBe(false);
    }
  });

  it('is cleared by residue:wipe, which then proceeds', async () => {
    const stalePid = await deadPid();
    writeLock(lockPath, stalePid, { baselinePath });

    const result = await runNode([RESET_RESIDUE], { lockPath });

    // A dry run on a clean database exits 0 and prints the "nothing to delete" line. The
    // assertion that matters is that the refusal did *not* happen, plus the stale notice.
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('A TEST RUN HOLDS THE DATABASE');
    expect(result.stdout).toContain('stale run lock');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('residue:wipe while a run holds the database', () => {
  it('refuses, names the holder, and offers no override', async () => {
    writeLock(lockPath, process.pid, { baselinePath });

    const result = await runNode([RESET_RESIDUE], { lockPath });

    expect(result.code).toBe(LOCK_REFUSED_EXIT);
    expect(result.stderr).toContain('A TEST RUN HOLDS THE DATABASE');
    expect(result.stderr).toContain(`pid ${process.pid}`);
    // The refusal is deliberately bypass-free, and the message has to say so: a reader who
    // goes looking for `--force` in the help text will otherwise assume it exists and that
    // they failed to find it.
    expect(result.stderr).toContain('There is no override flag');
    // Nothing was deleted, so the lock is still the live run's to release.
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('the comparison side', () => {
  /**
   * A baseline file with a clean marker, built from a real count.
   *
   * The plain dump reads the real database and never refuses, so this produces genuine
   * counters without depending on the database being *empty*. That independence matters:
   * a comparison test that first required a successful `--require-clean` preflight would
   * only pass on a pristine database, so it would fail for a reason unrelated to the lock
   * and send the reader looking in the wrong place. The lock is what is under test here,
   * not the cleanliness of `groupeat_dev`.
   */
  async function synthesizeBaseline(): Promise<void> {
    const dump = await runNode([CHECK_RESIDUE], { lockPath });
    expect(dump.code, `dump failed: ${dump.stderr}`).toBe(0);
    const counts = JSON.parse(dump.stdout) as Record<string, number>;
    // `__git` is required by `--compare` for anything claiming a clean baseline. Using the
    // gate's own `--provenance` keeps this fixture honest without copying its algorithm.
    const stamp = await provenance();
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...counts, __baselineClean: true, __git: stamp }, null, 2)}\n`,
      'utf8',
    );
  }

  it('releases the lock on the success path', async () => {
    await synthesizeBaseline();
    writeLock(lockPath, process.pid, { baselinePath });
    expect(existsSync(lockPath)).toBe(true);

    const compare = await runNode([CHECK_RESIDUE, '--compare', baselinePath], { lockPath });

    expect(compare.code).toBe(0);
    expect(compare.stdout).toContain('VERIFIED from a clean baseline');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when it finds residue', async () => {
    await synthesizeBaseline();

    // Claim one more customer than the dump measured, which makes the *current* count look
    // like residue. That exercises the failing path without writing a row into the shared
    // database — the leak stays a property of these files, not of `groupeat_dev`, so this
    // test cannot leave residue behind for the gate to find.
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...baseline, customers: Number(baseline.customers) + 1 }, null, 2)}\n`,
      'utf8',
    );
    writeLock(lockPath, process.pid, { baselinePath });

    const compare = await runNode([CHECK_RESIDUE, '--compare', baselinePath], { lockPath });

    expect(compare.code).toBe(1);
    expect(compare.stderr).toContain('RESIDUE — the suite left rows behind');
    expect(compare.stderr).toContain('customers');
    // The property under test: a red gate must not wedge the next run.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a baseline the lock does not describe, and leaves the lock alone', async () => {
    const otherBaseline = join(workspace, 'somebody-elses.json');
    await synthesizeBaseline();
    writeLock(lockPath, process.pid, { baselinePath });

    writeFileSync(otherBaseline, readFileSync(baselinePath), 'utf8');
    const compare = await runNode([CHECK_RESIDUE, '--compare', otherBaseline], { lockPath });

    expect(compare.code).toBe(2);
    expect(compare.stderr).toContain('BASELINE / LOCK MISMATCH');
    // Leaving the lock is deliberate: a mismatch means this pass does not know whose lock it
    // found, and the plausible owner is a live run. Deleting it would disarm the innocent
    // one. The worst case is a stale lock, which the next run steals.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('refuses when there is no lock at all', async () => {
    // A baseline written without a preflight is a file with no provenance. Comparing against
    // it would produce a certificate about a run nobody guarded.
    await synthesizeBaseline();

    const compare = await runNode([CHECK_RESIDUE, '--compare', baselinePath], { lockPath });

    expect(compare.code).toBe(2);
    expect(compare.stderr).toContain('NO RUN LOCK');
  });

  it('pairs the real preflight with the real comparison end to end', async () => {
    // The only test that exercises both halves as the `&&` chain does, because the two
    // processes agreeing on a baseline path is the mechanism a hand-built lock file cannot
    // prove. It is written to be honest about the one thing it cannot control: whether the
    // database is empty at this instant, since the suite runs file after file against one
    // shared database and another file's fixtures may be live.
    //
    // So it branches on what the preflight actually did, and asserts the correct consequence
    // of each — rather than demanding a clean database and failing for a reason that has
    // nothing to do with the lock.
    const preflight = await runPreflight({ lockPath, baselinePath });

    if (preflight.code === 0) {
      // Clean baseline: the comparison must accept the pairing, come back green, and release.
      expect(existsSync(lockPath)).toBe(true);
      const compare = await runNode([CHECK_RESIDUE, '--compare', baselinePath], { lockPath });
      expect(compare.code, compare.stderr).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      return;
    }

    // The preflight refused, which is correct behaviour, and the important property is
    // that it released the lock on the way out. Otherwise the `residue:wipe` its own
    // message recommends would be blocked by a lock nobody is holding. Which refusal it
    // was depends on the tree: an uncommitted tree is rejected (exit 2) before the
    // database is even counted, while a dirty database on a clean tree gives exit 1.
    if ((await provenance()).treeClean) {
      expect(preflight.code).toBe(1);
      expect(preflight.stderr).toContain('RESIDUE IN THE BASELINE');
    } else {
      expect(preflight.code).toBe(2);
      expect(preflight.stderr).toContain('UNCOMMITTED WORK');
    }
    expect(existsSync(lockPath)).toBe(false);

    // And the state it leaves behind is the one `--compare` has a message for, because the
    // shell redirect truncated the baseline to empty. That has to be a diagnosis, not a
    // `SyntaxError` — the regression this guards was exactly that.
    const compare = await runNode([CHECK_RESIDUE, '--compare', baselinePath], { lockPath });
    expect(compare.code).toBe(2);
    expect(compare.stderr).toContain('NO RUN LOCK');
  });
});

describe('the limit of the mechanism, measured', () => {
  /**
   * The lock guards the gate's entry points, not the database.
   *
   * This test exists in the opposite spirit to the rest of the file: it pins a *hole* rather
   * than a protection. `vitest.config.ts` has no `globalSetup`, so the lock is taken by
   * `check-residue.mjs` and nothing else — a bare `vitest run` never asks for it and cannot be
   * made to. Recording that here, with a passing test, is what stops the next person reading
   * the lock's docblock and concluding that `groupeat_dev` has a single writer.
   *
   * It is asserted rather than described because the day someone adds a `globalSetup` that
   * takes the lock, this test fails — and that failure is the signal to update the docblock's
   * caveat rather than to delete the test.
   */
  it('a bare vitest run does NOT observe the lock — it is the gate that locks, not the runner', async () => {
    writeLock(lockPath, process.pid, { baselinePath });

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          'src/lib/analytics/__tests__/read-counts.test.ts',
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, GROUPEAT_RESIDUE_LOCK_PATH: lockPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    // The runner does not refuse, and does not mention the lock. If this ever starts failing
    // with a lock refusal, the mechanism was extended and the AGENTS.md caveat is stale.
    expect(result.stderr).not.toContain('ANOTHER RUN HOLDS');
    expect(result.stderr).not.toContain('A TEST RUN HOLDS');
    // And it ran: `1 passed` in the summary. The suite result is what proves it did not
    // politely decline for some other reason.
    expect(`${result.stdout}${result.stderr}`).toMatch(/\d+ passed/);
    // It also did not consume or release somebody else's lock.
    expect(existsSync(lockPath)).toBe(true);
  }, 120_000);
});

describe('the plain dump', () => {
  it('still runs while a lock is held, because it is the diagnostic for that case', async () => {
    writeLock(lockPath, process.pid, { baselinePath });

    const result = await runNode([CHECK_RESIDUE], { lockPath });

    // Exit 0 with counts, not a refusal: `npm run residue` is what someone reaches for
    // *during* a concurrent run, so locking it would remove the only available instrument.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"customers"');
    expect(result.stderr).not.toContain('ANOTHER RUN HOLDS');
    // It also must not have consumed the lock: a read-only diagnostic that released the
    // guard would make the next run think the database was free.
    expect(existsSync(lockPath)).toBe(true);
  });
});
