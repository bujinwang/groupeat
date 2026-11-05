/**
 * Refuse to run the suite on an interpreter whose tzdata cannot answer Alberta dates.
 *
 * ## The failure this exists to stop
 *
 * `npm run verify` runs whatever `node` is on `PATH`. On this machine `which -a node`
 * puts a bundled **22.22.2 with tzdata 2025c** first, so a bare `npm run verify` uses
 * it — while `.nvmrc` pins **24.21.0** and `engines` floors at `>=24.0.0`. That
 * bundled binary violates `engines` and runs anyway.
 *
 * The consequence is not a crash but a *wrong answer*. Alberta adopted permanent DST
 * on 2026-11-01 and is UTC−6 year-round from that date; a tzdata release that predates
 * the rule reads Edmonton as UTC−7 in winter. Five tests in four files assert winter
 * timestamps, so a stale interpreter turns them red while the code and the expectations
 * are both correct. Measured on the same commit, same minute:
 *
 *   v22.22.2 / tzdata 2025c -> 5 failed, 35 passed
 *   v24.21.0 / tzdata 2026c -> 40 passed
 *
 * Two separate people read that failure as a defect in the code under test. The prose
 * in `AGENTS.md` documented the trap and did not prevent it, because a rule that is only
 * prose is a rule that gets skipped. This is the enforcement.
 *
 * ## The offset is authoritative; the pin is advisory
 *
 * A version-based check would be easy and would be wrong in both directions. `v24.15.0`
 * is a modern v24 build with **tzdata 2026a**, which predates the rule: it reports
 * UTC−7 and fails the same five tests. Measured, not assumed — a `major >= 24` test
 * passes it, and the offset assertion below rejects it.
 *
 * The mirror-image mistake is refusing an interpreter that is *right*. `v24.22.1` ships
 * **tzdata 2026e**, reports the correct UTC−6, and differs from `.nvmrc` by a patch
 * version. An exact pin would block it, which trades one false answer for another: the
 * suite would have run correctly and the gate would have said no. That is the same
 * error as trusting a version string in the first place, wearing the opposite coat.
 *
 * So the two checks are not equal, and the script treats them differently:
 *
 *   - **Fatal.** The offset, by either probe. This is the fact the suite depends on.
 *   - **Fatal.** Below the `engines.node` floor. That floor expresses a real
 *     compatibility claim (Prisma 6, Next 15) which the offset probe says nothing
 *     about, so it is enforced on its own terms.
 *   - **Advisory.** A version that differs from `.nvmrc` while the offset is correct.
 *     Printed on stdout in the success path as *drift*, not failure, so a green run
 *     still says which interpreter produced it and invites an update to the pin rather
 *     than blocking.
 *
 * A rule that fails a correct run is a rule people learn to bypass, and a bypassed gate
 * is worth less than no gate.
 *
 * ## Why both probes
 *
 *   - `Intl.DateTimeFormat` with an **explicit** `timeZone` is what the application
 *     and most of the failing tests call. It is independent of the ambient `TZ`, so it
 *     is the honest one to gate on.
 *   - `getTimezoneOffset()` reads the **ambient** zone, and is the form `AGENTS.md`
 *     quotes. It is kept because a reader will look for it, but it must be evaluated
 *     under `TZ=America/Edmonton` explicitly: under `TZ=UTC` a perfectly good
 *     interpreter returns `0`, and pinning the ambient zone is what makes the number
 *     comparable between runs and machines.
 *
 * Both are asserted. They agreed on every interpreter measured here, and if they ever
 * disagree that is itself worth failing on.
 *
 * ## Why `test` is not gated
 *
 * `npm test` stays a bare `vitest run` on purpose. A fast, preflight-free run is
 * genuinely useful — for a single file, for a watch loop, for a machine with only one
 * interpreter installed — and the asymmetry is a deliberate choice rather than an
 * oversight. `verify` is the gate; `test` is the tool.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The zone the suite's winter expectations are written against. */
const ZONE = 'America/Edmonton';

/**
 * A winter instant after Alberta's 2026-11-01 change, and the offset it must resolve to.
 *
 * `getTimezoneOffset()` is minutes *behind* UTC, so UTC−6 is `360`. The ground truth is
 * the system tzdata, which is what a correct interpreter should agree with:
 *
 *   America/Edmonton  Sun Nov  1 08:00:00 2026 UT = Sun Nov  1 02:00:00 2026 CST
 *   isdst=0 gmtoff=-21600
 */
const PROBE_INSTANT = '2026-11-02T12:00:00Z';
const REQUIRED_OFFSET_MINUTES = 360;

/** Reads a file relative to the repository root. */
function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/**
 * The version `.nvmrc` pins, without the leading `v`.
 *
 * Read rather than hardcoded so this check cannot become a third copy of the pin and
 * drift from it — the defect class it exists to catch.
 */
function pinnedVersion() {
  const raw = read('.nvmrc').trim();
  return raw.startsWith('v') ? raw.slice(1) : raw;
}

/**
 * The `engines.node` floor from `package.json`, or `null` when absent.
 *
 * Only the simple `>=X.Y.Z` form is understood; anything else is reported as unparsed
 * rather than guessed at, because silently mis-reading the floor is how a check starts
 * passing things it should refuse.
 */
function engineFloor() {
  const pkg = JSON.parse(read('package.json'));
  const declared = pkg?.engines?.node;
  if (typeof declared !== 'string') return { declared: null, floor: null };
  const match = /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(declared.trim());
  return { declared, floor: match ? match[1] : null };
}

/** Compares two `X.Y.Z` strings. Returns a negative, zero or positive number. */
function compareVersions(left, right) {
  const parse = (value) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** The offset this interpreter reports for `PROBE_INSTANT` in `ZONE`, in minutes behind UTC. */
function reportedOffsetMinutes() {
  // `getTimezoneOffset()` reads the ambient zone; Intl reads the named one. Both are
  // measured, and the ambient one is forced so the number is comparable everywhere.
  const ambient = new Date(PROBE_INSTANT).getTimezoneOffset();

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date(PROBE_INSTANT));
  const wallHour = Number.parseInt(formatted, 10);

  // Rebuild the offset from the wall-clock hour the named zone renders: 12:00Z showing
  // as 06:00 means UTC−6. This is exactly the comparison the failing tests make.
  const namedZoneOffset = (12 - wallHour) * 60;
  return { ambient, namedZoneOffset, wallHour };
}

const pinned = pinnedVersion();
const { declared, floor } = engineFloor();
const current = process.versions.node;
const tzdata = process.versions.tz;
const { ambient, namedZoneOffset, wallHour } = reportedOffsetMinutes();

const problems = [];
const advisories = [];

// ---- The floor. Fatal on its own terms: it expresses a compatibility claim (Prisma 6,
// Next 15) that the offset probe cannot see. ----
if (floor !== null && compareVersions(current, floor) < 0) {
  problems.push({
    what: 'version is below the engines floor',
    detail: `running ${current}, engines.node requires ${declared}`,
  });
} else if (floor === null && declared !== null) {
  // Not a failure: the floor is real but unparseable, so it is surfaced rather than
  // silently unenforced.
  advisories.push(`could not parse engines.node "${declared}" as ">=X.Y.Z"; the floor was not enforced by this check.`);
}

// ---- Behaviour: the fact the suite depends on. Fatal, by either probe. ----
if (ambient !== REQUIRED_OFFSET_MINUTES) {
  problems.push({
    what: 'wrong offset for a winter Alberta instant',
    detail: `getTimezoneOffset() under TZ=${ZONE} returned ${ambient}, required ${REQUIRED_OFFSET_MINUTES}`,
  });
}
if (namedZoneOffset !== REQUIRED_OFFSET_MINUTES) {
  problems.push({
    what: 'wrong offset for a winter Alberta instant',
    detail: `Intl with timeZone:'${ZONE}' rendered ${PROBE_INSTANT} as ${wallHour}:00, implying UTC${namedZoneOffset === 0 ? '±0' : `−${namedZoneOffset / 60}`}, required UTC−6`,
  });
}

// The pin note only means anything once the offset is right. Emitting "offset is
// correct, this is drift" next to a failed offset assertion would be the script
// contradicting itself in the one message a stuck reader reads most closely.
const offsetIsCorrect = problems.length === 0;
if (compareVersions(current, pinned) !== 0 && offsetIsCorrect) {
  advisories.push(
    `running ${current}, .nvmrc pins ${pinned} — offset is correct, so this is drift rather than a blocked gate. Update .nvmrc if ${current} is the new baseline.`,
  );
}

if (problems.length === 0) {
  console.log(
    `interpreter ok: node ${current} (tzdata ${tzdata}), ${ZONE} at ${PROBE_INSTANT} is UTC−6 as required.`,
  );
  // Advisories go to stdout on the success path, not stderr: a green run should still
  // say which interpreter produced it and which pin it drifted from.
  for (const advisory of advisories) {
    console.log(`note: ${advisory}`);
  }
  process.exit(0);
}

console.error('');
console.error('INTERPRETER — the test suite cannot run on this `node`.');
console.error('');
for (const problem of problems) {
  console.error(`  ✗ ${problem.what}`);
  console.error(`    ${problem.detail}`);
}
if (advisories.length > 0) {
  console.error('');
  for (const advisory of advisories) {
    console.error(`  note: ${advisory}`);
  }
}
console.error('');
console.error('## Why this matters');
console.error('');
console.error('  Alberta adopted permanent DST on 2026-11-01 and is UTC−6 year-round from');
console.error('  that date. Five tests assert winter timestamps against that rule. An');
console.error('  interpreter whose tzdata predates it reports UTC−7, so those tests fail');
console.error('  while the code under test and the expectations are both correct.');
console.error('');
console.error('  Ground truth from the system tzdata:');
console.error('    America/Edmonton  Sun Nov  1 08:00:00 2026 UT = 02:00:00 CST isdst=0 gmtoff=-21600');
console.error('');
console.error('## How to fix it');
console.error('');
console.error('  Point the gate at an interpreter whose tzdata is 2026b or later — the');
console.error('  release that introduced Alberta\'s permanent UTC−6. The pinned build works:');
console.error('');
console.error(`    ~/.nvm/versions/node/v${pinned}/bin/node node_modules/vitest/vitest.mjs run`);
console.error('');
console.error('  or put it first on PATH for the gate:');
console.error('');
console.error(`    PATH="$HOME/.nvm/versions/node/v${pinned}/bin:$PATH" npm run verify`);
console.error('');
console.error('  or switch the shell over:');
console.error('');
console.error('    nvm use');
console.error('');
console.error('  Modern is not enough: v24.15.0 satisfies the major version and still ships');
console.error('  tzdata 2026a, which fails this same check. Compare tzdata, not majors.');
console.error('  If a newer build reports the correct offset, it passes — the pin is advice,');
console.error('  the offset is the gate. Only a stale offset or a version below the engines');
console.error('  floor stops the run.');
console.error('');
process.exit(1);
