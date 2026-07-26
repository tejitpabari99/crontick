// Cross-platform, dependency-free process-liveness helpers used by the daemon's
// startup orphan reconciliation (see src/daemon/store.ts reconcileOrphanRuns()).
// Pure node: built-ins only, never throws, always resolves synchronously.
import { spawnSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import type { OrphanLivenessCheck } from './daemon/store.js';

/**
 * A real OS process start time can only ever be at or after the moment
 * crontick recorded a run as started (the child is always spawned after
 * insertRun()/updateRun() run). A small negative tolerance absorbs
 * second-level rounding from `ps -o lstart=` and cross-process clock skew
 * without weakening the pid-reuse check itself.
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
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    ],
    { encoding: 'utf-8', timeout: 5_000, windowsHide: true },
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
 * Builds the OrphanLivenessCheck the store expects: alive + not-obviously-a-
 * reused-pid (its OS start time isn't earlier than the run's recorded
 * startedAt). Returns undefined (inconclusive) whenever the OS start time
 * can't be determined at all, favoring adoption over a false cancellation
 * per Store.reconcileOrphanRuns()'s documented contract.
 */
export function createProcessLivenessCheck(): OrphanLivenessCheck {
  return {
    isRunAlive(pid: number, startedAt: number): boolean | undefined {
      if (!isProcessAlive(pid)) return false;
      const startTime = getProcessStartTime(pid);
      if (startTime === undefined) return undefined;
      return startTime >= startedAt - PID_START_TOLERANCE_MS;
    },
  };
}
