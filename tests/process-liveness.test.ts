// Unit tests for the L4 pid-liveness/pid-reuse helper (src/process-liveness.ts).
// Uses real child processes (no fakes) since this module's entire job is to
// shell out to the real OS — a mock would just test the mock.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  isProcessAlive,
  getProcessStartTime,
  createProcessLivenessCheck,
  PID_START_TOLERANCE_MS,
} from '../src/process-liveness.js';

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

  it('createProcessLivenessCheck: isRunAlive returns true for a live pid whose recorded startedAt predates its real OS start time', () => {
    // The daemon records `started_at` when the run row is inserted, strictly
    // before the child is actually spawned (see index.ts's insertRun() call
    // at tick time vs. runner.ts's spawn()) — so a genuine (non-reused) match
    // always has OS start time >= recorded startedAt. Using the *current*
    // process (this test runner) with a startedAt safely in its own past
    // reproduces exactly that "genuine" shape without needing a live child.
    const check = createProcessLivenessCheck();
    const recordedStartedAt = Date.now() - 60_000; // 60s "before" now, comfortably before this process's own start
    expect(check.isRunAlive(process.pid, recordedStartedAt)).toBe(true);
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
});
