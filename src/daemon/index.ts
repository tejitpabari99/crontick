/**
 * crontick daemon entry point.
 * T-NEW-4: Re-exec with --experimental-sqlite on Node < 24 if flag is absent.
 */
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

// ── SQLite shim ───────────────────────────────────────────────────────────────

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

  function log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data ? { data } : {}) });
    process.stderr.write(line + '\n');
    if (logFile) {
      try { appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
    }
  }

  // ── Single-instance guard ───────────────────────────────────────────────────

  function checkSingleInstance(): void {
    const pidPath = pidFilePath();
    if (!existsSync(pidPath)) return;
    try {
      const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          log('error', 'Daemon already running', { pid: existingPid });
          process.exit(1);
        } catch {
          log('warn', 'Removing stale PID file', { pid: existingPid });
        }
      }
    } catch { /* ignore */ }
  }

  function cleanup(): void {
    for (const p of [pidFilePath(), portFilePath()]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }

  // ── Main ────────────────────────────────────────────────────────────────────

  async function main(): Promise<void> {
    ensureDirs();
    const today = new Date().toISOString().slice(0, 10);
    logFile = join(logsDir(), `daemon-${today}.log`);
    log('info', 'Starting crontick daemon', { pid: process.pid, node: process.version });

    checkSingleInstance();
    writeFileSync(pidFilePath(), String(process.pid), 'utf-8');

    const store = new Store(runsDbPath(), jobsDir());
    store.open();
    const reconciled = store.reconcileOrphanRuns();
    if (reconciled > 0) {
      log('warn', `Reconciled ${reconciled} orphaned run(s) from previous daemon session`);
    }
    store.loadJobsFromDisk();
    const jobs = store.listJobs();
    log('info', `Loaded ${jobs.length} job(s) from disk`);

    const scheduler = new Scheduler();
    const runner = new Runner();

    for (const job of jobs) {
      if (job.enabled) scheduler.schedule(job, store);
    }

    scheduler.on('tick', ({ jobId, plannedAt }) => {
      const job = store.getJob(jobId);
      if (!job || !job.enabled) return;
      const run = store.insertRun(jobId, plannedAt.getTime());
      runner.run(job, run.id, store).catch((err: unknown) => {
        log('error', 'Runner error', { jobId, error: String(err) });
      });
    });

    async function reload(): Promise<void> {
      log('info', 'Reloading jobs from disk');
      scheduler.unscheduleAll();
      store.loadJobsFromDisk();
      const reloaded = store.listJobs();
      for (const job of reloaded) {
        if (job.enabled) scheduler.schedule(job, store);
      }
      log('info', `Reloaded ${reloaded.length} job(s)`);
    }

    const startedAt = new Date();
    const ctx = { store, scheduler, runner, startedAt, port: 0, reload };
    const server = createApiServer(ctx);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        ctx.port = port;
        writeFileSync(portFilePath(), String(port), 'utf-8');
        log('info', `API listening on 127.0.0.1:${port}`);
        resolve();
      });
      server.on('error', reject);
    });

    let shuttingDown = false;
    async function shutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', `Received ${signal}, shutting down`);
      server.close();
      scheduler.unscheduleAll();
      await new Promise<void>((r) => setTimeout(r, 100));
      store.close();
      cleanup();
      log('info', 'Daemon stopped');
      process.exit(0);
    }

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    log('info', 'Daemon ready');
  }

  main().catch((err: unknown) => {
    process.stderr.write(`Fatal daemon error: ${String(err)}\n`);
    cleanup();
    process.exit(1);
  });
}
