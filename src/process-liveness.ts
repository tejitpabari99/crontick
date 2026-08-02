// Cross-platform, dependency-free process-liveness helpers used by the daemon's
// startup orphan reconciliation (see src/daemon/store.ts reconcileOrphanRuns()).
// Pure node: built-ins only, never throws, always resolves synchronously.
import { spawnSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import type { OrphanLivenessCheck } from './daemon/store.js';

/**
 * A pid match must have an OS-reported start time close to the run's
 * recorded startedAt in EITHER direction: crontick always writes startedAt
 * immediately before spawning (never after), so the real process should
 * start only slightly later, but scheduling/reporting jitter and clock skew
 * between crontick's clock and `ps`/Get-Process's clock can put the OS
 * timestamp a little earlier too. A pid whose real start time differs from
 * startedAt by more than this bound is a different process that happened to
 * reuse the pid — not the run we spawned — even though it's alive right now.
 */
export const PID_START_TOLERANCE_MS = 2_000;

/**
 * True if `pid` currently belongs to a live process. EPERM (process exists,
 * but we lack permission to signal it) is treated as alive — we cannot
 * safely conclude the process is gone. Any other error (ESRCH, invalid pid)
 * means "not alive".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort OS-reported process start time, in epoch ms. Returns undefined
 * when it cannot be determined (platform tool missing/unavailable, spawn
 * failure, unparseable output) — callers must treat that as inconclusive,
 * never as "process is gone" or "process is a match".
 */
export function getProcessStartTime(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    return osPlatform() === 'win32' ? windowsStartTime(pid) : posixStartTime(pid);
  } catch {
    return undefined;
  }
}

function windowsStartTime(pid: number): number | undefined {
  // PowerShell ships with every supported Windows version; Get-Process
  // exposes StartTime directly, avoiding wmic (deprecated/removed on newer
  // Windows) and avoiding any shell-quoting hazard (args array, shell:false).
  // The timeout is deliberately generous: powershell.exe cold-start can take
  // several seconds on a loaded machine/CI runner, and returning a definitive
  // start time (even a little late) is far better for reconciliation than
  // spuriously reporting "inconclusive" just because the shell was slow to
  // launch. This is a one-shot startup-path query, not a hot loop.
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    ],
    { encoding: 'utf-8', timeout: 20_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) return undefined;
  const out = (result.stdout ?? '').trim();
  if (!out) return undefined;
  const parsed = Date.parse(out);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function posixStartTime(pid: number): number | undefined {
  // `ps -o lstart=` reports the process start time in a locale-dependent but
  // Date.parse()-compatible format ("Thu Jul 26 08:00:00 2026"); force a
  // stable locale so parsing doesn't depend on the daemon's environment.
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf-8',
    timeout: 5_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error || result.status !== 0) return undefined;
  const out = (result.stdout ?? '').trim();
  if (!out) return undefined;
  const parsed = Date.parse(out);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * One bulk process listing (single spawnSync) instead of one spawnSync per
 * pid (L4 fix): the per-pid `windowsStartTime`/`posixStartTime` helpers above
 * cost ~400ms each on Windows, so a daemon restarting with dozens of
 * orphaned runs used to add tens of seconds to startup reconciliation. This
 * lists every process's pid + start time in one call; misses (e.g. a pid
 * that exited between the snapshot and the caller's isProcessAlive check)
 * fall back to the per-pid query in createProcessLivenessCheck().
 */
function bulkWindowsStartTimes(): Map<number, number> {
  const map = new Map<number, number>();
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-Process | ForEach-Object { try { \"$($_.Id)|$($_.StartTime.ToUniversalTime().ToString('o'))\" } catch {} }",
    ],
    { encoding: 'utf-8', timeout: 30_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) return map;
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const sep = line.indexOf('|');
    if (sep === -1) continue;
    const pid = Number(line.slice(0, sep));
    const ts = Date.parse(line.slice(sep + 1));
    if (Number.isInteger(pid) && !Number.isNaN(ts)) map.set(pid, ts);
  }
  return map;
}

function bulkPosixStartTimes(): Map<number, number> {
  const map = new Map<number, number>();
  const result = spawnSync('ps', ['-eo', 'pid,lstart'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error || result.status !== 0) return map;
  const lines = (result.stdout ?? '').split('\n').slice(1); // drop header row
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const pid = Number(tokens[0]);
    const ts = Date.parse(tokens.slice(1).join(' '));
    if (Number.isInteger(pid) && !Number.isNaN(ts)) map.set(pid, ts);
  }
  return map;
}

/** True if `startTime` (an OS-reported process start, epoch ms) is close
 * enough to `startedAt` (crontick's recorded run start, epoch ms) to be the
 * same process rather than an unrelated one that reused the pid. Shared by
 * createProcessLivenessCheck() (startup reconciliation) and runner.ts's
 * adoption poll (re-verified on every tick, not just once at reconciliation
 * — see isSameRunProcess below) so both use one definition of "same run".
 */
function withinStartTolerance(startTime: number, startedAt: number): boolean {
  return Math.abs(startTime - startedAt) <= PID_START_TOLERANCE_MS;
}

/**
 * True if `pid` is currently alive AND its OS-reported start time matches
 * `startedAt` within tolerance (not a reused pid). Undefined means
 * inconclusive (OS start time unavailable) — callers must not treat that as
 * either "same run" or "different run". Exported for runner.ts's adoption
 * poll, which must re-verify identity on every tick (a pid can be reused by
 * an unrelated process between one poll and the next, and blindly continuing
 * to treat it as the adopted run risks a later cancel-previous/skip sending
 * SIGTERM to that unrelated process).
 */
export function isSameRunProcess(pid: number, startedAt: number): boolean | undefined {
  if (!isProcessAlive(pid)) return false;
  const startTime = getProcessStartTime(pid);
  if (startTime === undefined) return undefined;
  return withinStartTolerance(startTime, startedAt);
}

/**
 * Builds the OrphanLivenessCheck the store expects: alive + not-obviously-a-
 * reused-pid (its OS start time is within tolerance of the run's recorded
 * startedAt in either direction — see withinStartTolerance). Returns
 * undefined (inconclusive) whenever the OS start time can't be determined at
 * all, favoring adoption over a false cancellation per
 * Store.reconcileOrphanRuns()'s documented contract.
 *
 * Signature is unchanged from before the L4 fix — only the internals now do
 * one bulk process-listing spawnSync (lazily, on the first isRunAlive call)
 * instead of one spawnSync per pid, cached for the lifetime of this check
 * (one daemon startup's reconciliation pass).
 */
export function createProcessLivenessCheck(): OrphanLivenessCheck {
  let bulkStartTimes: Map<number, number> | undefined;
  return {
    isRunAlive(pid: number, startedAt: number): boolean | undefined {
      if (!isProcessAlive(pid)) return false;
      if (bulkStartTimes === undefined) {
        bulkStartTimes = osPlatform() === 'win32' ? bulkWindowsStartTimes() : bulkPosixStartTimes();
      }
      const startTime = bulkStartTimes.get(pid) ?? getProcessStartTime(pid);
      if (startTime === undefined) return undefined;
      return withinStartTolerance(startTime, startedAt);
    },
  };
}
