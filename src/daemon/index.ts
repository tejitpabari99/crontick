// Daemon entry point: starts the scheduler, runner, store, and HTTP API.
// Re-execs with --experimental-sqlite on Node < 24 when the flag is absent.
// See docs/implementation/daemon.md
import { dispatchTimeRun } from './time-dispatch.js';
import { scanMissedFires, dispatchCatchUps } from './startup-catchup.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureClaudeHookHelper } from '../claude-completion-marker.js';
import {
  configPath,
  dataDir,
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
import { consumeLostPendingConfigApply } from './config-apply.js';
import { createApiServer } from './api.js';
import { bindPort, preferredDaemonPort } from './bind-port.js';
import { probeHealth } from './ensure.js';
import type { ApiContext } from './api.js';
import { RelayGuard } from './relay-guard.js';
import { RelayManager } from './relay.js';
import { TriggerDispatcher, registerAfterTrigger } from './trigger.js';
import { createLogger, isVerboseEnv, type LogEvent, type Logger } from '../logger.js';
import { ensureConfigFile, loadConfig } from '../config.js';
import { createProcessLivenessCheck } from '../process-liveness.js';
import { SUPERVISED_ENV } from '../constants/daemon.js';

/** Cap on missed fires recorded per job at startup (see enumerateFiresBetween()). */
const MISSED_FIRE_CAP_PER_JOB = 500;

/** Matches the daily daemon log filenames written below (`daemon-YYYY-MM-DD.log`). */
const DAEMON_LOG_FILE_PATTERN = /^daemon-\d{4}-\d{2}-\d{2}\.log$/;

/**
 * Minor 6: run history has always been bounded by retention.maxRunsPerJob,
 * but daemon logs had no cap or cleanup at all — an install left running for
 * months would accumulate a `daemon-YYYY-MM-DD.log` file per day forever.
 * Deletes the oldest daily log files beyond `maxLogFiles`, keeping the most
 * recent ones (filenames are ISO-dated, so a plain string sort is
 * chronological). Best-effort: a failure to list/delete is logged but must
 * never prevent the daemon from starting or reloading.
 */
function pruneOldDaemonLogs(dir: string, maxLogFiles: number, logger: Logger): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.error('Failed to list log directory for retention', { dir, error: String(err) });
    return 0;
  }
  const logFiles = entries.filter((name) => DAEMON_LOG_FILE_PATTERN.test(name)).sort();
  const excess = logFiles.length - maxLogFiles;
  if (excess <= 0) return 0;
  let removed = 0;
  for (const name of logFiles.slice(0, excess)) {
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch (err) {
      logger.error('Failed to remove old daemon log file during retention', { file: name, error: String(err) });
    }
  }
  return removed;
}

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
  // Forward termination signals so a supervisor's SIGTERM reaches the real
  // daemon (graceful shutdown, exit 0) instead of killing only this shim.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => { child.kill(sig); });
  }
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
          // Under a service manager (Restart=on-failure / KeepAlive SuccessfulExit:false)
          // a non-zero exit would crash-loop when the user demand-started first.
          if (process.env[SUPERVISED_ENV] === '1') {
            logger.info('Daemon already running; exiting 0 (supervised)', { pid: existingPid });
            process.exit(0);
          }
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
    try {
      ensureConfigFile();
    } catch (err) {
      logger.debug('Default config file could not be created', { error: String(err) });
    }
    // Best-effort: Claude SessionEnd hook helper (rewritten idempotently each start).
    ensureClaudeHookHelper(dataDir());
    const today = new Date().toISOString().slice(0, 10);
    logFile = join(logsDir(), `daemon-${today}.log`);
    logger.info('Starting crontick daemon', { pid: process.pid, node: process.version, verbose: logger.isDebugEnabled(), logFile });

    checkSingleInstance();
    writeFileSync(pidFilePath(), String(process.pid), 'utf-8');

    const startedAt = new Date();
    const startupConfig = loadConfig();
    const retentionCap = startupConfig.retention.maxRunsPerJob;
    // Minor 6: bounded log retention, configured alongside run retention.
    // Best-effort — must never block startup.
    try {
      const prunedLogs = pruneOldDaemonLogs(logsDir(), startupConfig.retention.maxLogFiles, logger);
      if (prunedLogs > 0) {
        logger.info(`Pruned ${prunedLogs} old daemon log file(s) exceeding the retention cap of ${startupConfig.retention.maxLogFiles}`);
      }
    } catch (err) {
      logger.error('Daemon log retention failed on startup; continuing without it', { error: String(err) });
    }
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
    const nowMs = startedAt.getTime();
    // SP10: opt-in `catchUp` jobs are collected as pending and dispatched below, once the
    // runner, orphan reconciliation and tick/after listeners exist. Reload never catches up.
    const { summary: missedFireSummary, pending: pendingCatchUps } = scanMissedFires({
      store, scheduler, logger, nowMs, cap: MISSED_FIRE_CAP_PER_JOB,
    });
    if (missedFireSummary.missedRunsRecorded > 0) {
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
    for (const f of reconciliation.finalized) {
      runner.recordRunOutcome(f.jobId, f.runId, { status: f.status, error: f.error }, store);
      const dependents = store.listDependents(f.jobId);
      if (dependents.length > 0) {
        logger.info('Run finalized at startup; its after-dependents are not triggered (no replay)', {
          jobId: f.jobId, runId: f.runId, status: f.status, dependents: dependents.map((d) => d.id),
        });
      }
    }
    for (const { jobId, runId, pid } of reconciliation.adopted) {
      runner.adoptRun(jobId, runId, pid, store);
    }
    if (reconciliation.adopted.length > 0) {
      logger.info(`Adopted ${reconciliation.adopted.length} run(s) still alive from a previous daemon session`, {
        adopted: reconciliation.adopted.map((a) => ({ jobId: a.jobId, runId: a.runId, pid: a.pid })),
      });
    }

    // After-trigger listener: registered only now, AFTER startup reconciliation, so runs
    // finalized at startup never fire dependents (D4); adopted runs exiting later do.
    const triggerDispatcher = new TriggerDispatcher({
      store, runner, logger,
      isPaused: (id) => scheduler.isPaused() || scheduler.isJobPaused(id),
    });
    registerAfterTrigger({ runner, store, dispatcher: triggerDispatcher, logger });
    // Webhook relays: one idempotent sync wired to startup, job mutations and reload.
    const relayGuard = new RelayGuard({
      logger,
      getSecret: (id) => {
        const sch = store.getJob(id)?.schedule;
        return sch?.kind === 'webhook' ? sch.secret : undefined;
      },
      recordRateLimited: (jobId, error, runId, at) => {
        if (runId === undefined) return store.recordSkippedRun(jobId, at, error).id;
        store.updateRun(runId, { error });
        return runId;
      },
    });
    const relays = new RelayManager({ dispatcher: triggerDispatcher, logger, guard: relayGuard.guard });
    const syncRelays = (): void => {
      try { relays.sync(store.listJobs()); } catch (err) { logger.error('Relay sync failed', { error: String(err) }); }
    };
    syncRelays();

    for (const job of jobs) {
      if (job.enabled) scheduler.schedule(job);
    }

    // Wire scheduler ticks to the runner. Re-read the job from store to pick up
    // any updates applied since it was initially scheduled.
    scheduler.on('tick', ({ jobId, plannedAt }) => {
      try {
        const result = dispatchTimeRun({ store, runner, logger }, jobId, plannedAt);
        if ('skipped' in result) {
          // Disabled out-of-band (e.g. auto-disabled after consecutive failures): drop the timer.
          scheduler.unschedule(jobId);
        }
      } catch (err) {
        // A synchronous throw out of an EventEmitter listener is not caught by
        // runner.run()'s own .catch() — it propagates straight to the global
        // uncaughtException handler and kills the daemon, taking down every
        // other scheduled job with it, not just this one. Catching here keeps
        // one job's failure (e.g. a store error) from ending the process.
        logger.error('Failed to record/dispatch scheduled run', { jobId, error: String(err) });
      }
    });

    // Fires that come due while paused are recorded 'skipped' (not run, not replayed on resume).
    scheduler.on('paused-tick', ({ jobId, plannedAt }) => {
      try {
        const job = store.getJob(jobId);
        if (!job || !job.enabled) return;
        store.recordSkippedRun(jobId, plannedAt.getTime());
        store.recordTick(jobId, plannedAt.getTime());
      } catch (err) {
        logger.error('Failed to record skipped run while paused', { jobId, error: String(err) });
      }
    });

    // SP10 catch-up: everything a run depends on (runner, reconciliation, tick + after
    // listeners, schedules) exists now, so dispatch the pending catch-up runs.
    dispatchCatchUps({ store, runner, logger }, pendingCatchUps, missedFireSummary, nowMs);
    if (missedFireSummary.catchUpRuns > 0) {
      logger.info(`Started ${missedFireSummary.catchUpRuns} catch-up run(s) for fires missed during downtime`);
    }

    async function reload(): Promise<void> {
      logger.info('Reloading jobs from disk');
      // Read+validate everything that can throw (config) BEFORE mutating the
      // live schedule. loadConfig() throws a CrontickError on a malformed or
      // out-of-bounds config.json (e.g. retention.maxRunsPerJob out of range).
      // If unscheduleAll() ran first, that throw would leave the daemon with
      // an empty scheduler until the next successful reload or a restart —
      // every job silently stops firing. Computing reloadedCap first means a
      // failed reload leaves the previous schedule fully intact.
      const reloadedConfig = loadConfig();
      const reloadedCap = reloadedConfig.retention.maxRunsPerJob;
      scheduler.unscheduleAll();
      store.loadJobsFromDisk();
      // Re-read config here too so a changed retention.maxRunsPerJob takes
      // effect on `crontick daemon reload` without requiring a full daemon
      // restart (only the cap is config-driven at reload time; other config,
      // e.g. engines, is already re-read per prompt-action run).
      store.setRunRetentionCap(reloadedCap);
      // Minor 6: a lowered retention.maxLogFiles also takes effect immediately
      // on reload, same as the run-retention cap, rather than requiring a
      // full daemon restart. Best-effort — never blocks reload.
      try {
        const prunedLogs = pruneOldDaemonLogs(logsDir(), reloadedConfig.retention.maxLogFiles, logger);
        if (prunedLogs > 0) {
          logger.info(`Pruned ${prunedLogs} old daemon log file(s) exceeding the retention cap of ${reloadedConfig.retention.maxLogFiles}`);
        }
      } catch (err) {
        logger.error('Daemon log retention failed on reload; continuing without it', { error: String(err) });
      }
      const reloaded = store.listJobs();
      for (const job of reloaded) {
        if (job.enabled) scheduler.schedule(job);
      }
      syncRelays();
      logger.info(`Reloaded ${reloaded.length} job(s)`);
    }

    // A wait-then-apply config save pending when the previous daemon died is lost; report it, never replay it.
    const lostPendingConfigApply = consumeLostPendingConfigApply(dataDir());
    if (lostPendingConfigApply) {
      logger.warn('A pending config save (wait for in-flight runs) was lost on restart; re-apply it if still wanted', lostPendingConfigApply);
    }

    const ctx: ApiContext = { store, scheduler, runner, startedAt, port: 0, reload, syncRelays, relayStatus: () => relays.status(), logger, missedFireSummary, lostPendingConfigApply, shutdown: () => Promise.resolve() };
    const server = createApiServer(ctx);

    // Bind loopback only (security invariant). Prefer the stable default port;
    // fall back to an OS-assigned port when it is taken. The real port is written
    // to daemon.port for client discovery.
    const listenOn = (port: number): Promise<number> => new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const bound = await bindPort(preferredDaemonPort(startupConfig), {
      configPath: configPath(),
      dataDir: dataDir(),
      listen: listenOn,
      probe: async (port) => {
        const healthy = await probeHealth(`http://127.0.0.1:${port}`, 1_000);
        return healthy.ok
          ? { kind: 'crontick', pid: healthy.info.pid, dataDir: healthy.info.dataDir }
          : { kind: 'foreign' };
      },
      notify: (message) => {
        writeStderr(`${message}\n`);
        logger.warn(message);
      },
    });
    ctx.port = bound.port;
    writeFileSync(portFilePath(), String(bound.port), 'utf-8');
    logger.info(`API listening on 127.0.0.1:${bound.port}`, bound.fellBack ? { fellBackFrom: bound.preferred } : undefined);

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
      relays.stop();
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
