/**
 * Pins the git-provenance half of the residue gate: a green line must name the tree it ran.
 *
 * ## Why this is a mechanism test
 *
 * `AGENTS.md` used to say "Nothing checks it" — `vitest run` reads the working tree, not
 * `HEAD`, so a green gate and a commit hash could be quoted together without ever having
 * described the same code. A test that grepped `check-residue.mjs` for `rev-parse HEAD`
 * would pass even if the comparison ignored the result, which is the defect in a
 * test-shaped docblock. So every case below writes a baseline and asks a **real second
 * process** whether it will certify it. Two cases create real files in the working tree and
 * observe the refusal; one observes the preflight refusing before it counts anything.
 *
 * ## Why the lock path is redirected, again
 *
 * These `--compare` calls need a run lock to exist. Using the real one would either consume
 * the outer `npm run verify`'s lock or be refused by it. Each test therefore writes a
 * hand-built lock at a temp `GROUPEAT_RESIDUE_LOCK_PATH`, naming the baseline it is about
 * to compare. That is the same fixture shape `residue-lock.test.ts` uses and asserts.
 *
 * ## Why the stamp comes from `--provenance`
 *
 * `--provenance` reports the gate's own reading of `HEAD` and `git status --porcelain`.
 * Re-deriving the hash here would leave a test that passes when the implementation's
 * hashing breaks — both sides would be wrong together. The mismatch cases are what prove
 * the gate actually *compares* the stamp: they inject a wrong value into a genuine one.
 *
 * ## The two probe files own their teardown
 *
 * The tests that dirty the working tree create one untracked file at the repo root and
 * delete it in `finally` and again in `afterEach`. An untracked probe with no teardown is
 * how a previous slice contaminated a certification run: it left `repro-*` users behind
 * and turned a green gate red. Nothing is written to the database here — these are files,
 * and they are removed by path.
 *
 * ## Why `git` is faked on PATH rather than the worktree disturbed
 *
 * `readTree()` returns `ok: false` when `execFileSync('git', …)` throws. The obvious way to
 * reach that is to run from a copy of the repository with `.git` removed — but that copy
 * would need `node_modules` too, and it would put a second Prisma client against
 * `groupeat_dev`. A fake `git` earlier on the **child's** PATH is both cheaper and more
 * precise: only the spawned process sees it, the real worktree is never touched, and the
 * marker it prints to stderr proves the refusal came from the intended failure rather than
 * from an unrelated git error. The executable lives in the per-test temp directory and is
 * removed by `afterEach` along with the lock and baseline.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** `src/lib/scripts/__tests__/` → `src/lib/scripts` → `src/lib` → `src` → repo. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CHECK_RESIDUE = join(REPO_ROOT, 'scripts', 'check-residue.mjs');

/** Exit code `check-residue.mjs` reserves for a baseline it cannot trust. */
const UNTRUSTWORTHY_EXIT = 2;

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Provenance {
  readonly ok: boolean;
  readonly head?: string;
  readonly statusHash?: string;
  readonly treeClean?: boolean;
  readonly status?: string;
  readonly error?: string;
}

type Baseline = Record<string, unknown>;

let workspace: string;
let lockPath: string;
let baselinePath: string;
let probePath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'groupeat-residue-provenance-'));
  lockPath = join(workspace, '.residue.lock');
  baselinePath = join(workspace, 'baseline.json');
  probePath = join(REPO_ROOT, `provenance-probe-${process.pid}.txt`);
});

afterEach(() => {
  // Belt and braces: a failed assertion must not leave the working tree dirty, because the
  // outer `npm run verify` compares its own tree state after this file has finished.
  if (existsSync(probePath)) rmSync(probePath);
  rmSync(workspace, { recursive: true, force: true });
});

function runNode(
  args: readonly string[],
  envOverride: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GROUPEAT_RESIDUE_LOCK_PATH: lockPath,
        // Applied last: the broken-git cases deliberately replace PATH for this child only.
        ...envOverride,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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

/** The implementation's own reading of the tree, never a re-implementation of it. */
async function provenance(): Promise<Provenance> {
  const result = await runNode([CHECK_RESIDUE, '--provenance']);
  expect(result.code).toBe(0);
  const tree = JSON.parse(result.stdout) as Provenance;
  expect(tree.ok, `--provenance failed: ${tree.error ?? result.stderr}`).toBe(true);
  return tree;
}

/** Real counters, so the comparison has no residue of its own to trip over. */
async function counts(): Promise<Record<string, number>> {
  const result = await runNode([CHECK_RESIDUE]);
  expect(result.code, `dump failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, number>;
}

/** A lock naming the baseline, in the shape `acquireLock()` writes. */
function writeLock(): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        pid: process.pid,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
        baselinePath,
        argv: ['--require-clean'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * Writes a baseline claiming a clean database, with the gate's genuine provenance stamp.
 * `mutate` is how the refusal cases inject one wrong value into an otherwise real file.
 */
async function prepare(mutate: (baseline: Baseline) => void = () => undefined): Promise<Provenance> {
  const tree = await provenance();
  const stamp = {
    head: tree.head,
    statusHash: tree.statusHash,
    treeClean: tree.treeClean,
  };
  const baseline: Baseline = {
    ...(await counts()),
    __baselineClean: true,
    __git: stamp,
  };
  mutate(baseline);
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  writeLock();
  return tree;
}

/**
 * A `git` that cannot answer, visible only to one spawned child.
 *
 * `readTree()` calls `execFileSync('git', …)` twice. A fake executable that exits 127 makes
 * the first call throw, so `readTree()` takes its `ok: false` branch. The marker on stderr
 * is visible in the gate's own error text (`execFileSync` puts stderr into `error.message`),
 * which lets a test prove the refusal came from this fixture. `process.execPath` is an
 * absolute path to node, so overriding PATH cannot stop the child from starting; Prisma
 * resolves its engine from `node_modules`, not from PATH.
 */
function brokenGitEnv(): Record<string, string> {
  const bin = join(workspace, 'bin');
  mkdirSync(bin, { recursive: true });
  const fakeGit = join(bin, 'git');
  writeFileSync(
    fakeGit,
    '#!/bin/sh\necho FAKE_GIT_UNAVAILABLE >&2\nexit 127\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  // `mode` is filtered through the process umask; chmod makes the executable bit certain.
  chmodSync(fakeGit, 0o755);
  return { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
}

async function compare(envOverride: Record<string, string> = {}): Promise<RunResult> {
  return runNode([CHECK_RESIDUE, '--compare', baselinePath], envOverride);
}

describe('a certificate has to name the tree it measured', () => {
  it('accepts a genuine stamp and prints the short HEAD with the green line', async () => {
    const tree = await prepare();
    expect(existsSync(lockPath)).toBe(true);

    const result = await compare();

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('VERIFIED from a clean baseline');
    if (tree.treeClean === true) {
      expect(result.stdout).toContain(`at ${String(tree.head).slice(0, 7)}`);
      expect(result.stdout).not.toContain('NOT attributable');
    } else {
      // A hand-built baseline on an uncommitted tree is allowed to complete, but the gate
      // must withhold the hash and say why. Asserted rather than assumed, because this is
      // the branch a bare `npx vitest run` on a dirty tree takes.
      expect(result.stdout).toContain('NOT attributable');
      expect(result.stdout).not.toContain(`at ${String(tree.head).slice(0, 7)}`);
    }
    // A green compare releases the lock on the way out.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a baseline stamped at a different commit', async () => {
    await prepare((baseline) => {
      baseline.__git = { ...(baseline.__git as object), head: '0'.repeat(40) };
    });

    const result = await compare();

    expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
    expect(result.stderr).toContain('HEAD MOVED DURING THE RUN');
    expect(result.stdout).not.toContain('VERIFIED');
    // Refusals release too, or the next chain inherits a dead lock from this one.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a baseline with no provenance at all', async () => {
    await prepare((baseline) => {
      delete baseline.__git;
    });

    const result = await compare();

    expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
    expect(result.stderr).toContain('BASELINE HAS NO GIT PROVENANCE');
    expect(result.stdout).not.toContain('VERIFIED');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses when treeClean disagrees with the tree it is standing in', async () => {
    await prepare((baseline) => {
      const stamp = baseline.__git as { treeClean: boolean };
      baseline.__git = { ...stamp, treeClean: !stamp.treeClean };
    });

    const result = await compare();

    expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
    expect(result.stderr).toContain('TREE CLEANLINESS CHANGED DURING THE RUN');
    expect(result.stdout).not.toContain('VERIFIED');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('leaves the older non-certifying UNVERIFIED path alone', async () => {
    // Only `__baselineClean: true` claims a certificate. A baseline without it is the
    // pre-existing "counts did not move" diagnostic and must not gain a new hard refusal.
    const result = await runNode([CHECK_RESIDUE]);
    expect(result.code).toBe(0);
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...(JSON.parse(result.stdout) as object), __baselineClean: false }, null, 2)}\n`,
      'utf8',
    );
    writeLock();

    const comparison = await compare();

    expect(comparison.code).toBe(0);
    expect(comparison.stdout).toContain('UNVERIFIED BASELINE');
    expect(comparison.stdout).not.toContain('VERIFIED from a clean baseline');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('the tree is read, not just quoted', () => {
  it('detects an untracked file that appears between the preflight and the comparison', async () => {
    await prepare();
    try {
      writeFileSync(probePath, 'untracked file created mid-run\n', 'utf8');
      const result = await compare();

      expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
      expect(result.stderr).toContain('WORKING TREE CHANGED DURING THE RUN');
      // The refusal names the path, so the reader can see what changed.
      expect(result.stderr).toContain(`provenance-probe-${process.pid}.txt`);
      expect(result.stdout).not.toContain('VERIFIED');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (existsSync(probePath)) rmSync(probePath);
    }
  });

  it('refuses to certify a dirty tree at the preflight, before counting anything', async () => {
    try {
      writeFileSync(probePath, 'uncommitted work present at preflight\n', 'utf8');

      const result = await runNode([
        CHECK_RESIDUE,
        '--require-clean',
        '--baseline',
        baselinePath,
      ]);

      expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
      expect(result.stderr).toContain('UNCOMMITTED WORK');
      expect(result.stderr).toContain(`provenance-probe-${process.pid}.txt`);
      // No counts were written: the refusal happens before `readCounts()`, exactly as the
      // lock refusal does. Its stdout is the redirected baseline, and it must stay empty.
      expect(result.stdout).toBe('');
      // The lock was taken and then released, so this refusal does not wedge the next run.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (existsSync(probePath)) rmSync(probePath);
    }
  });

  it('--provenance is a diagnostic: it runs under a lock and does not consume it', async () => {
    writeLock();

    const result = await runNode([CHECK_RESIDUE, '--provenance']);

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Provenance).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('when git itself cannot be read', () => {
  it('--provenance reports ok:false with the real error, and does not consume a lock', async () => {
    writeLock();

    const result = await runNode([CHECK_RESIDUE, '--provenance'], brokenGitEnv());

    // A diagnostic reports what it found; it does not turn an unreadable git into a failure.
    expect(result.code).toBe(0);
    const tree = JSON.parse(result.stdout) as Provenance;
    expect(tree.ok).toBe(false);
    expect(tree.error).toContain('FAKE_GIT_UNAVAILABLE');
    expect(tree.error).toContain('git rev-parse HEAD');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('refuses to certify a run at the preflight, before reading a single count', async () => {
    const result = await runNode(
      [CHECK_RESIDUE, '--require-clean', '--baseline', baselinePath],
      brokenGitEnv(),
    );

    expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
    expect(result.stderr).toContain('CANNOT READ GIT PROVENANCE');
    expect(result.stderr).toContain('refusing to certify this run');
    expect(result.stderr).toContain('FAKE_GIT_UNAVAILABLE');
    // No counts were produced, so the shell redirect would have left an empty baseline.
    expect(result.stdout).toBe('');
    // The preflight took the lock before reading git and released it on the way out.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses the certificate at the comparison even with a genuine stamp', async () => {
    // `prepare()` uses the real git, so the baseline is not the thing that is wrong. The
    // refusal has to come from this process being unable to re-read the tree.
    await prepare();

    const result = await compare(brokenGitEnv());

    expect(result.code).toBe(UNTRUSTWORTHY_EXIT);
    expect(result.stderr).toContain('CANNOT READ GIT PROVENANCE');
    expect(result.stderr).toContain('refusing the certificate');
    expect(result.stderr).toContain('FAKE_GIT_UNAVAILABLE');
    expect(result.stdout).not.toContain('VERIFIED');
    // `finish(2)` rather than `process.exit`: a refusal must not wedge the next chain.
    expect(existsSync(lockPath)).toBe(false);
  });
});
