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
import { createLogger, isVerboseEnv, type LogEvent } from '../logger.js';
import { loadConfig } from '../config.js';

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

    const retentionCap = loadConfig().retention.maxRunsPerJob;
    const store = new Store(runsDbPath(), jobsDir(), logger, retentionCap);
    store.open();
    // Cancel runs left as running/queued from a prior crash (orphan reconciliation).
    const reconciled = store.reconcileOrphanRuns();
    if (reconciled > 0) {
      logger.warn(`Reconciled ${reconciled} orphaned run(s) from previous daemon session`);
    }
    // Backfill pass for databases that predate the retention cap (or predate an
    // upgrade that lowered it). reconcileOrphanRuns() runs first so any stale
    // running/queued rows it just canceled are immediately eligible eviction
    // candidates, rather than requiring a second restart to truncate them.
    // Best-effort: a backfill failure (disk full, corrupted rows, etc.) must
    // be logged loudly but must never prevent the daemon from starting and
    // serving already-scheduled jobs.
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
    const runner = new Runner(undefined, logger);

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

    const startedAt = new Date();
    const ctx = { store, scheduler, runner, startedAt, port: 0, reload, logger };
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

    // Graceful shutdown: stop accepting connections, unschedule all timers,
    // drain briefly, then close SQLite and remove discovery files.
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
