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
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { stopDaemon } from '../src/daemon/lifecycle.js';

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
  // specs/006-state-and-persistence.md R-006-20: a running daemon MUST apply
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

  // ── T-LOG-RETENTION (Minor 6) ────────────────────────────────────────────
  // Unlike run history, daemon logs previously had no cap or cleanup at all —
  // an install left running for months accumulates a daemon-YYYY-MM-DD.log
  // per day forever. Retention is now configured via retention.maxLogFiles,
  // consistent with retention.maxRunsPerJob, and enforced at startup.

  it('startup prunes old daemon log files beyond retention.maxLogFiles, keeping the newest', async () => {
    const dir = makeTmpDir('crontick-log-retention-');
    liveDirs.add(dir);
    const logsPath = join(dir, 'logs');

    // Seed 10 fake daily logs dated well in the past, plus a low cap — the
    // daemon's own "today" log (written the moment it starts logging) sorts
    // after all of these lexicographically, so it must survive the prune.
    const seeded: string[] = [];
    for (let i = 30; i >= 1; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const name = `daemon-${d}.log`;
      writeFileSync(join(logsPath, name), 'old log content\n', 'utf-8');
      seeded.push(name);
    }
    expect(readdirSync(logsPath).length).toBe(seeded.length);

    const MAX_LOG_FILES = 3;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ retention: { maxLogFiles: MAX_LOG_FILES } }),
      'utf-8',
    );

    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);
    const health = await apiCall(port, 'GET', '/health');
    expect(health.status).toBe(200);

    // Prune runs synchronously during main(), before /health is reachable,
    // so no polling is needed here — the port file only appears after it.
    const remaining = readdirSync(logsPath).filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(n));
    expect(remaining.length).toBe(MAX_LOG_FILES);

    const today = new Date().toISOString().slice(0, 10);
    expect(remaining).toContain(`daemon-${today}.log`);
    // The oldest seeded files must be the ones removed, not the newest.
    expect(remaining).not.toContain(seeded[0]);
  }, 20_000);

  it('reload applies a newly-lowered retention.maxLogFiles without a daemon restart', async () => {
    const dir = makeTmpDir('crontick-log-retention-reload-');
    liveDirs.add(dir);
    const logsPath = join(dir, 'logs');
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    // Seed extra fake old logs after startup so the default cap (30) does not
    // already remove them — this isolates the assertion to reload-time
    // pruning specifically, not the startup pass covered by the test above.
    for (let i = 20; i >= 1; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      writeFileSync(join(logsPath, `daemon-${d}.log`), 'old log content\n', 'utf-8');
    }
    expect(
      readdirSync(logsPath).filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(n)).length,
    ).toBeGreaterThan(20);

    const NEW_CAP = 4;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ retention: { maxLogFiles: NEW_CAP } }),
      'utf-8',
    );
    const reload = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(reload.status).toBe(200);
    expect((reload.data as { ok: boolean }).ok).toBe(true);

    const remaining = readdirSync(logsPath).filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(n));
    expect(remaining.length).toBe(NEW_CAP);
  }, 20_000);

  // ── T-FRESH-INSTALL ───────────────────────────────────────────────────────

  // ── T-GRACEFUL-STOP (L1 + L8) ────────────────────────────────────────────
  // specs/004 previously documented POST /api/daemon/stop without it
  // existing; this proves the route now performs an in-process graceful
  // shutdown (works identically on Windows and POSIX, unlike signal-based
  // stopDaemon()) and that an in-flight child survives the daemon's own
  // exit (the deliberate L8 choice — see shutdown()'s doc comment in
  // src/daemon/index.ts).

  it('POST /api/daemon/stop responds before exit, cleans up discovery files, and leaves an in-flight child running (L1 + L8)', async () => {
    const dir = makeTmpDir('crontick-stop-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const pid = readPidFile(dir);
    expect(pid).toBeDefined();

    // A child that proves (a) it started, and (b) it is still alive well
    // after the daemon process has exited, without any fixed sleep in the
    // assertion path itself (both files are polled for).
    const startedFile = join(dir, 'child-started.txt');
    const doneFile = join(dir, 'child-done.txt');
    const script =
      `const fs = require('fs');` +
      `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');` +
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(doneFile)}, 'done'), 3000);`;

    const jobId = 'stop-survivor';
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'exec', command: node, args: ['-e', script] },
    });
    expect(created.status).toBe(201);

    const runRes = await apiCall(port, 'POST', `/api/jobs/${jobId}/run`);
    expect(runRes.status).toBe(202);

    // Wait for the child to actually be spawned (not just queued) before
    // stopping the daemon, so the stop genuinely races a live child.
    const startDeadline = Date.now() + 10_000;
    while (Date.now() < startDeadline && !existsSync(startedFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(startedFile)).toBe(true);
    expect(existsSync(doneFile)).toBe(false); // still mid-flight

    const before = Date.now();
    const stopRes = await apiCall(port, 'POST', '/api/daemon/stop');
    const elapsedMs = Date.now() - before;
    expect(stopRes.status).toBe(200);
    expect(stopRes.data).toMatchObject({ ok: true, stopping: true, pid });
    // The response must arrive promptly — well before the child's own
    // 3000ms completion delay — proving it isn't waiting on the child.
    expect(elapsedMs).toBeLessThan(2000);

    await waitForPidExit(pid!, 10_000);
    liveProcs.delete(proc); // already dead; nothing left to force-kill

    // Discovery files are cleaned up identically on both platforms because
    // this is an in-process shutdown, not a signal handler race.
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
    expect(existsSync(join(dir, 'daemon.port'))).toBe(false);

    // The child was spawned detached/unref'd (L8) and must keep running to
    // completion strictly after the daemon that spawned it has exited.
    const doneDeadline = Date.now() + 10_000;
    while (Date.now() < doneDeadline && !existsSync(doneFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(doneFile)).toBe(true);
  }, 30_000);

  // ── T-STOP-REPORTS-ACTIVE-RUNS (Major 4) ─────────────────────────────────
  // A prior version of POST /api/daemon/stop only ever returned
  // { ok, stopping, pid } — an in-flight run (deliberately left running past
  // the daemon's own exit, L8) vanished from view with nothing tracking it
  // afterwards. This proves the stop response now reports which runs were
  // still active at the moment of shutdown, so the caller can act instead of
  // the work silently disappearing.
  it('POST /api/daemon/stop reports runs still in progress instead of silently abandoning them (Major 4)', async () => {
    const dir = makeTmpDir('crontick-stop-report-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const startedFile = join(dir, 'active-started.txt');
    const script =
      `const fs = require('fs');` +
      `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');` +
      `setTimeout(() => {}, 5000);`;

    const jobId = 'stop-report-job';
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'exec', command: node, args: ['-e', script] },
    });
    expect(created.status).toBe(201);

    const runRes = await apiCall(port, 'POST', `/api/jobs/${jobId}/run`);
    expect(runRes.status).toBe(202);
    const runId = (runRes.data as { runId: string }).runId;

    const startDeadline = Date.now() + 10_000;
    while (Date.now() < startDeadline && !existsSync(startedFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(startedFile)).toBe(true);

    const stopRes = await apiCall(port, 'POST', '/api/daemon/stop');
    expect(stopRes.status).toBe(200);
    const activeRuns = (stopRes.data as { activeRuns?: Array<{ id: string; jobId: string }> }).activeRuns;
    expect(activeRuns).toEqual(expect.arrayContaining([{ id: runId, jobId }]));

    const pid = readPidFile(dir);
    if (pid !== undefined) await waitForPidExit(pid, 10_000);
    liveProcs.delete(proc);
  }, 30_000);

  // ── T-DELETE-CANCELS-RUN (Major 4) ───────────────────────────────────────
  // A prior version of DELETE /api/jobs/:id never touched the job's active
  // run: deleting the job left its process running with the job definition
  // gone. This proves the delete now cancels the in-flight run (and its real
  // child process) rather than orphaning it.
  it('DELETE /api/jobs/:id cancels the job\'s active run instead of orphaning its process (Major 4)', async () => {
    const dir = makeTmpDir('crontick-delete-cancel-');
    liveDirs.add(dir);
    const { proc, port } = await spawnDaemon(dir);
    liveProcs.add(proc);

    const startedFile = join(dir, 'delete-started.txt');
    const doneFile = join(dir, 'delete-done.txt');
    const script =
      `const fs = require('fs');` +
      `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');` +
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(doneFile)}, 'done'), 4000);`;

    const jobId = 'delete-cancel-job';
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'exec', command: node, args: ['-e', script] },
    });
    expect(created.status).toBe(201);

    const runRes = await apiCall(port, 'POST', `/api/jobs/${jobId}/run`);
    expect(runRes.status).toBe(202);
    const runId = (runRes.data as { runId: string }).runId;

    const startDeadline = Date.now() + 10_000;
    while (Date.now() < startDeadline && !existsSync(startedFile)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(startedFile)).toBe(true);
    expect(existsSync(doneFile)).toBe(false);

    const deleteRes = await apiCall(port, 'DELETE', `/api/jobs/${jobId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data).toMatchObject({ ok: true, canceledRun: true });

    // The run row must reflect the cancellation, and — crucially — the real
    // child process must not be left running to completion after its job
    // definition is gone.
    const runDeadline = Date.now() + 10_000;
    let finalStatus: string | undefined;
    while (Date.now() < runDeadline) {
      const runCheck = await apiCall(port, 'GET', `/api/runs/${runId}`);
      finalStatus = (runCheck.data as { status?: string }).status;
      if (finalStatus === 'canceled') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(finalStatus).toBe('canceled');

    await new Promise((r) => setTimeout(r, 4500));
    expect(existsSync(doneFile)).toBe(false);
  }, 30_000);

  // ── T-STALL-ESCALATE (Major 3) ───────────────────────────────────────────
  // A prior version of stopDaemon() treated a 200 from POST /api/daemon/stop
  // as good enough to call the shutdown "graceful", and returned
  // { stopped: false, mode: 'graceful' } with no further action if the
  // process didn't actually exit within the wait window — a stalled/wedged
  // daemon was left running forever with no automatic recovery. This stands
  // up a fake daemon (a real child process + a stub HTTP server that
  // accepts the stop request without ever terminating it) to prove
  // stopDaemon() now escalates (SIGTERM, then SIGKILL if needed) and reports
  // the escalation accurately.
  it('stopDaemon escalates to SIGTERM/SIGKILL when the graceful HTTP route accepts the stop but the process never exits (Major 3)', async () => {
    const dir = makeTmpDir('crontick-stall-');
    liveDirs.add(dir);

    const stalled = spawn(node, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    const fakePid = stalled.pid!;
    writeFileSync(join(dir, 'daemon.pid'), String(fakePid));

    // Stub server standing in for the real daemon's stop route: accepts the
    // request (200) but never actually terminates the pid, simulating a
    // daemon wedged mid-shutdown after having already accepted the request.
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/daemon/stop') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stopping: true, pid: fakePid, activeRuns: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const stubPort = (server.address() as { port: number }).port;
    writeFileSync(join(dir, 'daemon.port'), String(stubPort));

    try {
      const result = await stopDaemon({ env: { CRONTICK_HOME: dir }, timeoutMs: 500 });
      // Previously: { stopped: false, mode: 'graceful' } — no escalation.
      expect(result.stopped).toBe(true);
      expect(result.mode).toBe('hard-kill');
      expect(result.message.toLowerCase()).toMatch(/sigterm|sigkill/);

      // The pid must actually be gone, not just reported as stopped.
      expect(() => process.kill(fakePid, 0)).toThrow();
    } finally {
      server.close();
      try { stalled.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);


  // Report-only: missed fires while the daemon was down are recorded as
  // 'missed' runs and surfaced in /api/daemon/status, but never replayed.

  it('records missed fires across a crash/restart and surfaces them in status (L2)', async () => {
    const dir = makeTmpDir('crontick-missed-');
    liveDirs.add(dir);
    const first = await spawnDaemon(dir);
    liveProcs.add(first.proc);

    // Sub-second interval so several fires are missed within a short,
    // bounded downtime window rather than needing minute-granularity cron.
    const jobId = 'missed-fire-target';
    const created = await apiCall(first.port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'interval', everySec: 0.5 },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Let it tick at least once so job_schedule_state has a watermark to
    // compute missed fires from on the next start.
    const tickDeadline = Date.now() + 8000;
    for (;;) {
      const { data } = await apiCall(first.port, 'GET', `/api/runs?jobId=${jobId}`);
      if ((data as unknown[]).length > 0) break;
      if (Date.now() >= tickDeadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Simulate a crash (not a graceful stop) so no watermark bookkeeping
    // beyond the last recorded tick happens on the way down.
    first.proc.kill('SIGKILL');
    await waitForPidExit(first.proc.pid!, 5000);
    liveProcs.delete(first.proc);

    // Bounded, unavoidable real downtime: missed fires only exist if time
    // actually elapses past several 0.5s ticks while nothing is running.
    await new Promise((r) => setTimeout(r, 2500));

    const second = await spawnDaemon(dir, first.port);
    liveProcs.add(second.proc);

    const status = await apiCall(second.port, 'GET', '/api/daemon/status');
    expect(status.status).toBe(200);
    const missedFires = (status.data as { missedFires: Record<string, number> }).missedFires;
    expect(missedFires.jobsWithMissedFires).toBeGreaterThanOrEqual(1);
    expect(missedFires.missedRunsRecorded).toBeGreaterThanOrEqual(1);
    expect(typeof missedFires.capPerJob).toBe('number');

    const missedRuns = await apiCall(second.port, 'GET', `/api/runs?jobId=${jobId}&status=missed`);
    expect(missedRuns.status).toBe(200);
    const rows = missedRuns.data as Array<{ status: string; error?: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].status).toBe('missed');
  }, 30_000);

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
