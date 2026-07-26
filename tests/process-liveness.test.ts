// Unit tests for the L4 pid-liveness/pid-reuse helper (src/process-liveness.ts).
// Uses real child processes (no fakes) since this module's entire job is to
// shell out to the real OS — a mock would just test the mock.
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  isProcessAlive,
  getProcessStartTime,
  createProcessLivenessCheck,
  PID_START_TOLERANCE_MS,
} from '../src/process-liveness.js';

// MAJOR 4 regression test below needs to count real spawnSync invocations
// without breaking every other test in this file that relies on the real OS
// call going through — node:child_process's spawnSync isn't a redefinable
// property (vi.spyOn throws), so it's wrapped via vi.mock + a hoisted spy
// that still delegates to the real implementation.
const { spawnSyncSpy } = vi.hoisted(() => ({ spawnSyncSpy: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      spawnSyncSpy(...args);
      return actual.spawnSync(...args);
    },
  };
});

const node = process.execPath;

/** Spawn a short-lived child and resolve once it has actually exited. */
function spawnAndWaitForExit(ms: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(node, ['-e', `setTimeout(() => process.exit(0), ${ms})`]);
    const pid = child.pid!;
    child.on('exit', () => resolve(pid));
  });
}

describe('process-liveness', () => {
  it('isProcessAlive: true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive: false for invalid pids (0, negative, non-integer)', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it('isProcessAlive: false once a real child process has exited', async () => {
    const pid = await spawnAndWaitForExit(50);
    expect(isProcessAlive(pid)).toBe(false);
  }, 10_000);

  it('getProcessStartTime: returns a plausible past epoch-ms for the current process', () => {
    const startTime = getProcessStartTime(process.pid);
    expect(startTime).toBeDefined();
    // Must be in the past (this process is already running) and not absurdly
    // old (sanity bound: within the last 24h of CI/dev-machine uptime).
    expect(startTime!).toBeLessThanOrEqual(Date.now() + 1000);
    expect(startTime!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('getProcessStartTime: undefined for an invalid pid', () => {
    expect(getProcessStartTime(0)).toBeUndefined();
    expect(getProcessStartTime(-1)).toBeUndefined();
  });

  it('createProcessLivenessCheck: isRunAlive returns false for a dead pid regardless of startedAt', async () => {
    const pid = await spawnAndWaitForExit(50);
    const check = createProcessLivenessCheck();
    expect(check.isRunAlive(pid, Date.now())).toBe(false);
  }, 10_000);

  it('createProcessLivenessCheck: isRunAlive returns true for a live pid whose recorded startedAt closely matches its real OS start time (genuine match)', async () => {
    // Mirrors the real flow: startedAt is recorded immediately before spawn()
    // (index.ts's insertRun() happens right before runner.ts's spawn()), so a
    // genuine match's real OS start time differs from startedAt only by
    // scheduling/reporting latency — comfortably inside PID_START_TOLERANCE_MS.
    // (Replaces a prior version of this test that used a 60s-old startedAt,
    // which is not what a genuine spawn latency looks like and only passed by
    // coincidence under the old, buggy asymmetric tolerance check.)
    const startedAt = Date.now();
    const child = spawn(node, ['-e', 'setTimeout(() => {}, 5000)']);
    const check = createProcessLivenessCheck();
    try {
      expect(check.isRunAlive(child.pid!, startedAt)).toBe(true);
    } finally {
      child.kill();
    }
  }, 10_000);

  it('createProcessLivenessCheck: isRunAlive returns false for a live pid whose real start time is much LATER than the recorded startedAt (reused-pid shape)', () => {
    // Reproduces the exact reported bug shape: a process that reused a pid
    // necessarily started AFTER the original run's recorded startedAt, so the
    // old asymmetric check (`startTime >= startedAt - tolerance`) always said
    // true for this case — the pid-reuse guard guarded nothing. The current
    // test process started well within the last hour, so using it here with a
    // 1-hour-old startedAt reproduces "isRunAlive(pid, Date.now() - 3600_000)"
    // from the bug report directly.
    const check = createProcessLivenessCheck();
    const recordedStartedAt = Date.now() - 3_600_000;
    const result = check.isRunAlive(process.pid, recordedStartedAt);
    if (result !== undefined) {
      expect(result).toBe(false);
    }
  });

  it('createProcessLivenessCheck: isRunAlive returns false when startedAt is impossibly after the pid\'s real OS start time (pid-reuse signal)', () => {
    // A recorded startedAt far in the future relative to when this process
    // actually started can never describe this process — the OS-reported
    // start time will be far earlier than `startedAt - tolerance`, which is
    // exactly the reused-pid signal isRunAlive() is meant to catch.
    const check = createProcessLivenessCheck();
    const impossibleStartedAt = Date.now() + 10 * 60_000 + PID_START_TOLERANCE_MS + 1_000;
    const result = check.isRunAlive(process.pid, impossibleStartedAt);
    // Only assert false when the platform could actually resolve a start
    // time (result undefined means the OS tool was unavailable — still a
    // valid, documented outcome, just not what this test targets).
    if (result !== undefined) {
      expect(result).toBe(false);
    }
  });

  it('createProcessLivenessCheck: never throws for a bogus pid', () => {
    const check = createProcessLivenessCheck();
    expect(() => check.isRunAlive(999_999_999, Date.now())).not.toThrow();
    expect(check.isRunAlive(999_999_999, Date.now())).toBe(false);
  });

  it('createProcessLivenessCheck: queries the OS once total across repeated calls, not once per call (MAJOR 4 regression)', () => {
    // Before the fix, every isRunAlive() call did its own spawnSync
    // (~400ms on Windows via powershell.exe); a startup reconciliation with
    // dozens of orphaned runs meant dozens of sequential spawns. One check
    // object must now do a single bulk process-listing spawnSync, cached for
    // its lifetime, no matter how many times isRunAlive() is called on it —
    // mirroring reconcileOrphanRuns() calling isRunAlive() once per orphaned
    // run from the same check instance.
    const callsBefore = spawnSyncSpy.mock.calls.length;
    const check = createProcessLivenessCheck();
    check.isRunAlive(process.pid, Date.now());
    check.isRunAlive(process.pid, Date.now());
    check.isRunAlive(process.pid, Date.now());
    expect(spawnSyncSpy.mock.calls.length - callsBefore).toBe(1);
  });
});
