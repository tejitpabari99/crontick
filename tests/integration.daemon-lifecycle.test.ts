/**
 * Daemon lifecycle integration tests: graceful shutdown, reload-from-disk,
 * and fresh-data-directory creation. New file (not api.test.ts) because each
 * of these needs to spawn/kill/restart its own daemon instance mid-test,
 * incompatible with api.test.ts's single shared long-lived daemon serving
 * ~30 unrelated CRUD tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');
const node = process.execPath;

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch {
          // file may be mid-write; retry
        }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

// Windows does not clean up daemon.port on a kill(pid,'SIGTERM')-based stop
// (see the platform branch below), so a plain waitForPortFile() would read
// back the stale prior value the instant the file check runs. This variant
// polls until the file's value differs from the known-stale one, so it only
// resolves once the new process has actually written its own ephemeral port.
function waitForPortFileChange(
  dir: string,
  previousPort: number,
  maxMs = 30_000,
  getStderr?: () => string,
): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0 && port !== previousPort) return resolve(port);
        } catch {
          // file may be mid-write; retry
        }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon port change${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function readPidFile(dir: string): number | undefined {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return undefined;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  return !isNaN(pid) && pid > 0 ? pid : undefined;
}

async function waitForPidExit(pid: number, maxMs = 5_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function apiCall(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function spawnDaemon(dir: string, previousPort?: number): Promise<{ proc: ChildProcess; port: number }> {
  const stderrChunks: string[] = [];
  const proc = spawn(node, [DAEMON_SCRIPT], {
    env: { ...process.env, CRONTICK_HOME: dir },
    stdio: 'pipe',
  });
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
  const port =
    previousPort === undefined
      ? await waitForPortFile(dir, 30_000, () => stderrChunks.join(''))
      : await waitForPortFileChange(dir, previousPort, 30_000, () => stderrChunks.join(''));
  return { proc, port };
}

describe('Integration: daemon lifecycle', () => {
  // Track every daemon process spawned in this file so a failed assertion
  // can never leak a live daemon; force-killed unconditionally in afterEach.
  const liveProcs = new Set<ChildProcess>();
  const liveDirs = new Set<string>();

  afterEach(() => {
    for (const proc of liveProcs) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    liveProcs.clear();
    for (const dir of liveDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    liveDirs.clear();
  });

  // ── T-SHUTDOWN ────────────────────────────────────────────────────────────

  it('graceful shutdown: POSIX removes PID/port files; Windows tolerates a stale PID file on restart', async () => {
    const dir = makeTmpDir('crontick-shutdown-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const pid = readPidFile(dir);
    expect(pid).toBeDefined();

    process.kill(pid!, 'SIGTERM');
    await waitForPidExit(pid!, 5000);
    liveProcs.delete(proc); // already dead; nothing left to force-kill

    if (platform() !== 'win32') {
      // On POSIX, process.kill(pid, 'SIGTERM') is delivered to and handled by
      // the daemon's process.on('SIGTERM', ...) listener, which unlinks both
      // discovery files before exiting (src/daemon/index.ts shutdown()).
      expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(dir, 'daemon.port'))).toBe(false);
    } else {
      // On Windows, process.kill(pid, 'SIGTERM') unconditionally terminates
      // the process without invoking any registered signal handler (verified
      // empirically: a standalone script with a process.on('SIGTERM', ...)
      // handler never observed the signal when killed this way on this
      // platform). The daemon's cleanup() — which unlinks PID/port files —
      // therefore never runs, and the files may still exist here. The
      // pragmatic, still-true contract on Windows is: the process is
      // actually dead (already proven by waitForPidExit above), and a
      // subsequent daemon start tolerates and overwrites the stale PID file
      // (checkSingleInstance() in src/daemon/index.ts treats a dead PID as
      // stale, not a running-instance conflict).
      const restarted = await spawnDaemon(dir, port);
      liveProcs.add(restarted.proc);
      const health = await apiCall(restarted.port, 'GET', '/health');
      expect(health.status).toBe(200);
      expect((health.data as { ok: boolean }).ok).toBe(true);
    }
  }, 20_000);

  // ── T-RELOAD ──────────────────────────────────────────────────────────────

  it('daemon reload re-reads job files from disk and reschedules with the new runAt', async () => {
    const dir = makeTmpDir('crontick-reload-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const jobId = 'reload-target';
    // Deliberately far in the future — this isolates the assertion to "was
    // it (re)scheduled", not "did it fire": the original in-memory job could
    // not fire inside the poll window below on its own.
    const farRunAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'one-shot', runAt: farRunAt },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Bypass the API and edit the on-disk job JSON directly, mirroring the
    // documented "editing job JSON files externally" workflow. Read the
    // current file and mutate only schedule.runAt to avoid an accidental
    // schema mismatch causing loadJobsFromDisk() to silently skip it.
    //
    // The margin below must survive the writeFileSync + HTTP round trip to
    // /api/daemon/reload + reload()'s own work (loadConfig, unscheduleAll,
    // loadJobsFromDisk, re-scheduling) that all happen AFTER nearRunAt is
    // computed but BEFORE the one-shot timer is actually armed. A too-tight
    // margin (previously 1200ms) can elapse before scheduleOneShot() runs on
    // a loaded CI runner, which silently no-ops on a non-positive delay and
    // fails the test spuriously rather than exercising reload at all.
    const jobFile = join(dir, 'jobs', `${jobId}.json`);
    const onDisk = JSON.parse(readFileSync(jobFile, 'utf-8')) as { schedule: { runAt: string } };
    const nearRunAt = new Date(Date.now() + 5000).toISOString();
    onDisk.schedule.runAt = nearRunAt;
    writeFileSync(jobFile, JSON.stringify(onDisk, null, 2), 'utf-8');

    const reload = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(reload.status).toBe(200);
    expect((reload.data as { ok: boolean }).ok).toBe(true);

    // Crux assertion: a terminal run can only appear this quickly if reload()
    // picked up the on-disk edit and rescheduled with the near runAt — the
    // original 1-hour-out job would never fire inside this poll window.
    const terminal = new Set(['success', 'failed', 'canceled', 'timeout']);
    const deadline = Date.now() + 10_000;
    let runs: Array<{ status: string }> = [];
    for (;;) {
      const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
      runs = data as Array<{ status: string }>;
      if (runs.some((r) => terminal.has(r.status))) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runs.some((r) => r.status === 'success')).toBe(true);

    // The edited runAt was also loaded into the SQLite-backed job cache.
    const jobAfter = await apiCall(port, 'GET', `/api/jobs/${jobId}`);
    expect((jobAfter.data as { schedule: { runAt: string } }).schedule.runAt).toBe(nearRunAt);
  }, 25_000);

  // ── T-RELOAD-FAILURE ─────────────────────────────────────────────────────

  it('a reload that fails to load config leaves the existing schedule intact — no jobs are dropped', async () => {
    const dir = makeTmpDir('crontick-reload-fail-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    // A fast-firing interval job so we can prove it keeps running after a
    // reload attempt fails, without waiting on cron-minute granularity.
    const jobId = 'reload-fail-target';
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'interval', everySec: 1 },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Confirm the job is actually live before touching config.
    const deadlineBefore = Date.now() + 8000;
    let runsBefore: Array<{ status: string }> = [];
    for (;;) {
      const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
      runsBefore = data as Array<{ status: string }>;
      if (runsBefore.some((r) => r.status === 'success')) break;
      if (Date.now() >= deadlineBefore) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runsBefore.some((r) => r.status === 'success')).toBe(true);
    const countBefore = runsBefore.length;

    // Corrupt config.json with an out-of-bounds retention.maxRunsPerJob
    // (RetentionConfigSchema requires 1-100000) so the next reload's
    // loadConfig() throws a CrontickError.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ retention: { maxRunsPerJob: 0 } }),
      'utf-8',
    );

    const reload = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(reload.status).toBe(400);
    expect((reload.data as { error: { code: string } }).error.code).toBe('CONFIG_VALIDATION_ERROR');

    // Crux assertion: the job scheduled before the failed reload must still
    // be firing. If reload() unscheduled everything before validating config
    // (the pre-fix ordering), the scheduler would be left empty and this job
    // would never produce another run.
    const deadlineAfter = Date.now() + 8000;
    let runsAfter: Array<{ status: string }> = runsBefore;
    for (;;) {
      const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
      runsAfter = data as Array<{ status: string }>;
      if (runsAfter.length > countBefore) break;
      if (Date.now() >= deadlineAfter) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runsAfter.length).toBeGreaterThan(countBefore);

    // The daemon process itself is still healthy, not just this one job.
    const health = await apiCall(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect((health.data as { ok: boolean }).ok).toBe(true);
  }, 25_000);

  // ── T-RETENTION-RELOAD ───────────────────────────────────────────────────
  // specs/006-state-and-persistence.md R-006-23: a running daemon MUST apply
  // an updated retention cap without a restart.

  it('reload applies a newly-lowered retention.maxRunsPerJob without a daemon restart', async () => {
    const dir = makeTmpDir('crontick-retention-reload-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const jobId = 'retention-reload-target';
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'interval', everySec: 1 },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Let more runs accumulate than the cap we're about to apply — the
    // default built-in cap is 100, so 5 successful runs comfortably fit
    // under it and would never be evicted without the config change below.
    const NEW_CAP = 2;
    const deadlineAccrue = Date.now() + 10_000;
    let runs: Array<{ status: string }> = [];
    for (;;) {
      const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
      runs = data as Array<{ status: string }>;
      if (runs.filter((r) => r.status === 'success').length >= NEW_CAP + 3) break;
      if (Date.now() >= deadlineAccrue) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(runs.filter((r) => r.status === 'success').length).toBeGreaterThanOrEqual(NEW_CAP + 3);

    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ retention: { maxRunsPerJob: NEW_CAP } }),
      'utf-8',
    );
    const reload = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(reload.status).toBe(200);
    expect((reload.data as { ok: boolean }).ok).toBe(true);

    // The next insertRun (from the still-ticking interval) applies the new,
    // lower cap — no restart involved. Poll until the row count settles at
    // (not below) NEW_CAP.
    const deadlineEvict = Date.now() + 10_000;
    let afterCounts: Array<{ status: string }> = [];
    for (;;) {
      const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
      afterCounts = data as Array<{ status: string }>;
      if (afterCounts.length <= NEW_CAP) break;
      if (Date.now() >= deadlineEvict) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(afterCounts.length).toBe(NEW_CAP);
  }, 30_000);

  // ── T-FRESH-INSTALL ───────────────────────────────────────────────────────

  it('creates the full data directory tree on a clean machine (no pre-existing directories)', async () => {
    // Unlike every other daemon-spawning test in this suite, this one does
    // NOT pre-create jobs/logs (or even the immediate parent) before spawning
    // the daemon — the opposite of makeTmpDir()'s convention above.
    const root = mkdtempSync(join(tmpdir(), 'crontick-fresh-'));
    const home = join(root, 'nested', 'crontick-home');
    liveDirs.add(root);

    const { proc, port } = await spawnDaemon(home);
    liveProcs.add(proc);

    const health = await apiCall(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect((health.data as { ok: boolean }).ok).toBe(true);

    expect(existsSync(join(home, 'jobs'))).toBe(true);
    expect(existsSync(join(home, 'logs'))).toBe(true);
    expect(existsSync(join(home, 'runs.db'))).toBe(true);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(true);
    expect(existsSync(join(home, 'daemon.port'))).toBe(true);
  }, 15_000);
});
