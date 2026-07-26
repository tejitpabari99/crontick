// Daemon entry point: starts the scheduler, runner, store, and HTTP API.
// Re-execs with --experimental-sqlite on Node < 24 when the flag is absent.
// See docs/internals/daemon.md
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureDirs,
  pidFilePath,
  portFilePath,
  logsDir,
  runsDbPath,
  jobsDir,
} from '../paths.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { Runner } from './runner.js';
import { createApiServer } from './api.js';
import type { ApiContext } from './api.js';
import { createLogger, isVerboseEnv, type LogEvent } from '../logger.js';
import { loadConfig } from '../config.js';
import { createProcessLivenessCheck } from '../process-liveness.js';

/** Cap on missed fires recorded per job at startup (see enumerateFiresBetween()). */
const MISSED_FIRE_CAP_PER_JOB = 500;

// ── SQLite shim ───────────────────────────────────────────────────────────────
// node:sqlite is experimental on Node <24; re-exec with the flag so the child
// process has access to DatabaseSync. This shim carries no logic of its own.

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const needsSqliteShim = nodeMajor < 24 && !process.execArgv.includes('--experimental-sqlite');

if (needsSqliteShim) {
  const child = spawn(process.execPath, ['--experimental-sqlite', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: process.env,
    detached: false,
  });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
} else {
  // ── Logger ──────────────────────────────────────────────────────────────────

  let logFile: string | null = null;

  function isEpipeError(err: unknown): boolean {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE';
  }

  function writeStderr(line: string): void {
    try {
      process.stderr.write(line);
    } catch (err) {
      if (!isEpipeError(err)) throw err;
    }
  }

  // Swallow EPIPE on stderr — happens when the daemon is detached and the
  // parent shell that spawned it has already closed its pipe.
  process.stderr.on('error', (err) => {
    if (!isEpipeError(err)) throw err;
  });

  function writeLogEvent(event: LogEvent): void {
    const line = JSON.stringify(event);
    writeStderr(line + '\n');
    if (logFile) {
      try { appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
    }
  }

  const logger = createLogger({ verbose: isVerboseEnv(), component: 'daemon', sink: writeLogEvent });

  // ── Single-instance guard ───────────────────────────────────────────────────
  // Invariant: only one daemon per data directory. Enforced via PID file + kill(pid,0) liveness probe.

  function checkSingleInstance(): void {
    const pidPath = pidFilePath();
    if (!existsSync(pidPath)) return;
    try {
      const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          logger.error('Daemon already running', { pid: existingPid });
          process.exit(1);
        } catch {
          logger.warn('Removing stale PID file', { pid: existingPid });
        }
      }
    } catch { /* ignore */ }
  }

  function cleanup(): void {
    for (const p of [pidFilePath(), portFilePath()]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }

  process.on('uncaughtException', (err) => {
    if (isEpipeError(err)) return;
    logger.error('Fatal daemon error', { error: String(err) });
    cleanup();
    process.exit(1);
  });

  // ── Main ────────────────────────────────────────────────────────────────────

  async function main(): Promise<void> {
    ensureDirs();
    const today = new Date().toISOString().slice(0, 10);
    logFile = join(logsDir(), `daemon-${today}.log`);
    logger.info('Starting crontick daemon', { pid: process.pid, node: process.version, verbose: logger.isDebugEnabled(), logFile });

    checkSingleInstance();
    writeFileSync(pidFilePath(), String(process.pid), 'utf-8');

    const startedAt = new Date();
    const retentionCap = loadConfig().retention.maxRunsPerJob;
    const store = new Store(runsDbPath(), jobsDir(), logger, retentionCap);
    store.open();
    // Backfill pass for databases that predate the retention cap (or predate an
    // upgrade that lowered it). Best-effort: a backfill failure (disk full,
    // corrupted rows, etc.) must be logged loudly but must never prevent the
    // daemon from starting and serving already-scheduled jobs.
    let pruned = 0;
    try {
      pruned = store.pruneAllJobsRunHistory();
    } catch (err) {
      logger.error('Run retention backfill failed on startup; continuing without it', { error: String(err) });
    }
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} run(s) exceeding the retention cap of ${retentionCap} during startup`);
    }
    store.loadJobsFromDisk();
    const jobs = store.listJobs();
    logger.info(`Loaded ${jobs.length} job(s) from disk`);

    const scheduler = new Scheduler(logger);

    // ── L2: missed-fire report on startup ─────────────────────────────────────
    // Report-only: never catch up or re-run a backlog (a 30s health check down
    // for a month would otherwise replay ~86,400 times). For each enabled job
    // with a prior watermark, enumerate fires missed between the watermark and
    // "now" (bounded by MISSED_FIRE_CAP_PER_JOB) and record them as terminal
    // 'missed' runs; jobs with no watermark yet (never observed live) are
    // skipped. The watermark is always advanced to "now" afterward so the next
    // restart computes forward from here, not from a stale point in the past.
    let jobsWithMissedFires = 0;
    let missedRunsRecorded = 0;
    let jobsCapped = 0;
    const nowMs = startedAt.getTime();
    for (const job of jobs) {
      if (!job.enabled) continue;
      const state = store.getScheduleState(job.id);
      if (!state) {
        store.recordTick(job.id, nowMs);
        continue;
      }
      try {
        const result = scheduler.enumerateFiresBetween(job.schedule, state.lastTickAt, nowMs, {
          cap: MISSED_FIRE_CAP_PER_JOB,
        });
        if (result.capped) {
          jobsCapped++;
          jobsWithMissedFires++;
          missedRunsRecorded++;
          const earliest = new Date(result.fires[0]).toISOString();
          const latest = new Date(result.fires[result.fires.length - 1]).toISOString();
          store.recordMissedRun(
            job.id,
            result.fires[result.fires.length - 1],
            `MISSED: ${result.fires.length}+ fires missed between ${earliest} and ${latest} (capped at ${MISSED_FIRE_CAP_PER_JOB}, only a summary recorded)`,
          );
        } else if (result.fires.length > 0) {
          jobsWithMissedFires++;
          for (const plannedAt of result.fires) {
            store.recordMissedRun(job.id, plannedAt);
          }
          missedRunsRecorded += result.fires.length;
        }
      } catch (err) {
        logger.error('Missed-fire computation failed for job; skipping', { jobId: job.id, error: String(err) });
      }
      store.recordTick(job.id, nowMs);
    }
    const missedFireSummary = {
      jobsWithMissedFires,
      missedRunsRecorded,
      jobsCapped,
      capPerJob: MISSED_FIRE_CAP_PER_JOB,
    };
    if (missedRunsRecorded > 0) {
      logger.warn('Recorded missed fires from downtime; these are report-only and were not re-run', missedFireSummary);
    }

    const runner = new Runner(undefined, logger);

    // Reconcile runs left as running/queued from a prior crash (L3/L4): check
    // real pid liveness (+ recorded startedAt, to reject a reused pid) instead
    // of unconditionally canceling everything, so a genuinely-still-alive
    // child (L8: children now survive the daemon's death on both platforms)
    // is adopted rather than treated as a second concurrent execution.
    const livenessCheck = createProcessLivenessCheck();
    const reconciliation = store.reconcileOrphanRuns(livenessCheck);
    if (reconciliation.canceled > 0) {
      logger.warn(`Reconciled ${reconciliation.canceled} orphaned run(s) from previous daemon session`);
    }
    for (const { jobId, runId, pid } of reconciliation.adopted) {
      runner.adoptRun(jobId, runId, pid, store);
    }
    if (reconciliation.adopted.length > 0) {
      logger.info(`Adopted ${reconciliation.adopted.length} run(s) still alive from a previous daemon session`, {
        adopted: reconciliation.adopted.map((a) => ({ jobId: a.jobId, runId: a.runId, pid: a.pid })),
      });
    }

    for (const job of jobs) {
      if (job.enabled) scheduler.schedule(job);
    }

    // Wire scheduler ticks to the runner. Re-read the job from store to pick up
    // any updates applied since it was initially scheduled.
    scheduler.on('tick', ({ jobId, plannedAt }) => {
      try {
        const job = store.getJob(jobId);
        if (!job || !job.enabled) return;
        const run = store.insertRun(jobId, plannedAt.getTime());
        store.recordTick(jobId, plannedAt.getTime());
        runner.run(job, run.id, store).catch((err: unknown) => {
          logger.error('Runner error', { jobId, error: String(err) });
        });
      } catch (err) {
        // A synchronous throw out of an EventEmitter listener is not caught by
        // runner.run()'s own .catch() — it propagates straight to the global
        // uncaughtException handler and kills the daemon, taking down every
        // other scheduled job with it, not just this one. Catching here keeps
        // one job's failure (e.g. a store error) from ending the process.
        logger.error('Failed to record/dispatch scheduled run', { jobId, error: String(err) });
      }
    });

    async function reload(): Promise<void> {
      logger.info('Reloading jobs from disk');
      // Read+validate everything that can throw (config) BEFORE mutating the
      // live schedule. loadConfig() throws a CrontickError on a malformed or
      // out-of-bounds config.json (e.g. retention.maxRunsPerJob out of range).
      // If unscheduleAll() ran first, that throw would leave the daemon with
      // an empty scheduler until the next successful reload or a restart —
      // every job silently stops firing. Computing reloadedCap first means a
      // failed reload leaves the previous schedule fully intact.
      const reloadedCap = loadConfig().retention.maxRunsPerJob;
      scheduler.unscheduleAll();
      store.loadJobsFromDisk();
      // Re-read config here too so a changed retention.maxRunsPerJob takes
      // effect on `crontick daemon reload` without requiring a full daemon
      // restart (only the cap is config-driven at reload time; other config,
      // e.g. engines, is already re-read per prompt-action run).
      store.setRunRetentionCap(reloadedCap);
      const reloaded = store.listJobs();
      for (const job of reloaded) {
        if (job.enabled) scheduler.schedule(job);
      }
      logger.info(`Reloaded ${reloaded.length} job(s)`);
    }

    const ctx: ApiContext = { store, scheduler, runner, startedAt, port: 0, reload, logger, missedFireSummary, shutdown: () => Promise.resolve() };
    const server = createApiServer(ctx);

    // Bind to 127.0.0.1:0 — OS assigns an ephemeral port written to daemon.port
    // for client discovery. Loopback-only binding is a security invariant.
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        ctx.port = port;
        writeFileSync(portFilePath(), String(port), 'utf-8');
        logger.info(`API listening on 127.0.0.1:${port}`);
        resolve();
      });
      server.on('error', reject);
    });

    // Graceful shutdown (L1): stop accepting new connections, unschedule all
    // timers, drain briefly, then close SQLite and remove discovery files.
    // L8: in-flight runs are deliberately left alone here, not killed — they
    // were spawned with detached:true/unref() so they keep running
    // independently of this process on both Windows and POSIX (see spawn() in
    // runner.ts). Their `runs` rows stay 'running'; the next daemon start's
    // reconcileOrphanRuns() pass (L3/L4) will adopt them if still alive or
    // cancel them if not. This makes a graceful stop behave identically to an
    // abrupt daemon death (crash/kill -9) from the child's point of view —
    // one liveness-checked reconciliation path handles both, on both
    // platforms, instead of two different behaviors to reason about.
    let shuttingDown = false;
    async function shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down`);
      server.close();
      scheduler.unscheduleAll();
      await new Promise<void>((r) => setTimeout(r, 100)); // brief drain window
      store.close();
      cleanup();
      logger.info('Daemon stopped');
      process.exit(0);
    }
    // ctx.shutdown starts as a stub (createApiServer(ctx) above needs ctx to
    // exist before `shutdown` — which closes over `server` — can be defined);
    // wire the real implementation now, same pattern as ctx.port = port above.
    ctx.shutdown = shutdown;

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    logger.info('Daemon ready');
  }

  main().catch((err: unknown) => {
    logger.error('Fatal daemon error', { error: String(err) });
    cleanup();
    process.exit(1);
  });
}
