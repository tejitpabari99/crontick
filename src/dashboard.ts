/**
 * Dashboard data assembly and static asset resolution. The daemon API calls
 * `buildDashboardData` to produce a snapshot; `resolveDashboardAsset` serves
 * the SPA assets with path-traversal protection.
 */
import { existsSync, statSync } from 'node:fs';
import { extname, join as pathJoin, normalize, resolve as pathResolve, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrontickError } from './errors.js';
import { redactValue } from './logger.js';
import { VERSION } from './version.js';
import { dataDir } from './paths.js';
import type { Job, Schedule } from './schemas/job.js';
import type { Store, Run } from './daemon/store.js';
import type { Scheduler } from './daemon/scheduler.js';

export interface DashboardOptions {
  runsLimit?: number;
  jobId?: string;
  /** Restrict the runs list to any of these job ids. */
  jobIds?: string[];
  /** Restrict the runs list to any of these statuses. */
  statuses?: Run['status'][];
  /** Free-text search over run id, status, error, session id, job id/alias and run logs. */
  q?: string;
}

export interface DashboardHealth {
  ok: true;
  product: 'crontick';
  version: string;
  uptimeSec: number;
  pid: number;
  port: number;
  /** Data directory of this daemon (lets a second daemon name the holder of the preferred port). */
  dataDir: string;
  node: string;
  platform: string;
  jobs: {
    total: number;
    enabled: number;
  };
  runs: {
    last24h: number;
    failures24h: number;
  };
}

export interface DashboardStats {
  totalJobs: number;
  enabledJobs: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  /** Average execution time in milliseconds (kept for backwards compatibility; prefer `avgDurationSec`). */
  avgDurationMs: number | null;
  /** Average execution time in seconds (2 decimals), over runs that finished executing; null when none. */
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}

export interface DashboardJob {
  /** Immutable GUID identity (see docs/concepts/jobs.md#identity). */
  id: string;
  /** Human-friendly, optional, user-editable identifier; unique among currently-defined jobs. Null when unset. */
  alias: string | null;
  description: string | null;
  /** The job's working directory (`action.cwd`); null when unset (the engine then starts in the daemon's directory). */
  cwd: string | null;
  enabled: boolean;
  scheduleLabel: string;
  actionKind: Job['action']['kind'];
  lastStatus: Run['status'] | null;
  lastRunAt: number | null;
  nextRunAt: string | null;
  job: Job;
}

export interface DashboardRun {
  id: string;
  jobId: string;
  /** The referenced job's alias at snapshot time, for display convenience; null if the job has no alias (or no longer exists). */
  jobAlias: string | null;
  status: Run['status'];
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  /** Prompt-engine session id captured for this run (or explicitly provided); null for non-prompt runs. */
  sessionId: string | null;
}

export interface DashboardData {
  generatedAt: number;
  health: DashboardHealth;
  stats: DashboardStats;
  jobs: DashboardJob[];
  runs: DashboardRun[];
}

export interface DashboardStatus {
  ok: true;
  running: boolean;
  url: string;
  port?: number;
  pid?: number;
  daemon: unknown;
}

export interface DashboardContext {
  store: Store;
  scheduler: Scheduler;
  startedAt: Date;
  port: number;
  pid?: number;
  node?: string;
  platform?: string;
}

export interface DashboardAsset {
  filePath: string;
  contentType: string;
  size: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function buildDashboardData(ctx: DashboardContext, options: DashboardOptions = {}): DashboardData {
  const runsLimit = normalizeLimit(options.runsLimit, 100);
  const jobs = ctx.store.listJobs();
  const recentRuns = ctx.store.listRuns({ jobId: options.jobId, jobIds: options.jobIds, statuses: options.statuses, q: options.q, limit: runsLimit });
  const allRuns = ctx.store.listRuns({ limit: 1000 });
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const runs24h = ctx.store.listRuns({ since: since24h });
  // Snapshot of jobId -> alias for run display convenience (DashboardRun.jobAlias).
  const aliasByJobId = new Map(jobs.map((job) => [job.id, job.alias ?? null] as const));

  return redactValue({
    generatedAt: Date.now(),
    health: buildDashboardHealth(ctx, jobs, runs24h),
    stats: buildDashboardStats(jobs, allRuns),
    jobs: jobs.map((job) => buildDashboardJob(ctx, job)),
    runs: recentRuns.map((run) => toDashboardRun(run, aliasByJobId)),
  }) as DashboardData;
}

export function buildDashboardHealth(ctx: DashboardContext, jobs: Job[], runs24h: Run[]): DashboardHealth {
  return {
    ok: true,
    product: 'crontick',
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    pid: ctx.pid ?? process.pid,
    port: ctx.port,
    dataDir: dataDir(),
    jobs: {
      total: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
    },
    runs: {
      last24h: runs24h.length,
      failures24h: runs24h.filter((run) => run.status === 'failed').length,
    },
    node: ctx.node ?? process.versions.node,
    platform: ctx.platform ?? process.platform,
  };
}

// Minor 5: statuses whose durationMs reflects real elapsed execution time.
// 'missed', 'queued', and 'running' rows never ran to completion (duration
// 0/undefined), and 'canceled' rows are likewise recorded with duration 0 —
// including any of them in the average drags it toward zero as they
// accumulate (up to 500 missed rows per job), rather than reflecting how
// long jobs actually take to run.
const EXECUTED_RUN_STATUSES: ReadonlySet<Run['status']> = new Set(['success', 'failed', 'timeout']);

/** Average `durationMs` over runs that actually executed (success/failed/timeout); null when there are none. */
export function averageDurationMs(runs: Run[]): number | null {
  const executedRuns = runs.filter((run) => EXECUTED_RUN_STATUSES.has(run.status));
  return executedRuns.length > 0
    ? Math.round(executedRuns.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / executedRuns.length)
    : null;
}

/** Milliseconds to seconds, rounded to 2 decimals; null passes through. */
export function msToSec(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 10) / 100;
}

export function buildDashboardStats(jobs: Job[], runs: Run[]): DashboardStats {
  const failed = runs.filter((run) => run.status === 'failed').length;
  const succeeded = runs.filter((run) => run.status === 'success').length;
  const avgDurationMs = averageDurationMs(runs);
  return {
    totalJobs: jobs.length,
    enabledJobs: jobs.filter((job) => job.enabled).length,
    totalRuns: runs.length,
    succeeded,
    failed,
    canceled: runs.filter((run) => run.status === 'canceled').length,
    skipped: runs.filter((run) => run.status === 'skipped').length,
    totalCostUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    totalTurns: runs.reduce((sum, run) => sum + (run.turns ?? 0), 0),
    avgDurationMs,
    avgDurationSec: msToSec(avgDurationMs),
  };
}

export function dashboardStatusFromDaemon(ctx: DashboardContext, baseUrl: string, daemon: unknown): DashboardStatus {
  return {
    ok: true,
    running: true,
    url: dashboardUrl(baseUrl),
    port: ctx.port,
    pid: ctx.pid ?? process.pid,
    daemon,
  };
}

function dashboardUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/dashboard`;
}

/**
 * Resolves a request path to a dashboard static file. Security guards:
 * 1. Rejects path segments containing '..' after URL-decoding (traversal attempt).
 * 2. After normalize+resolve, rejects any path that escapes the dashboard directory.
 * 3. Falls back to index.html for SPA client-side routing (non-existent sub-paths).
 */
export function resolveDashboardAsset(reqPath: string): DashboardAsset {
  const dashDir = dashboardDir();
  const indexFile = pathJoin(dashDir, 'index.html');
  let filePath: string;

  if (reqPath === '/' || reqPath === '/dashboard' || reqPath === '/dashboard/') {
    filePath = indexFile;
  } else {
    const sub = reqPath.startsWith('/dashboard/') ? reqPath.slice('/dashboard'.length) : reqPath;
    const decodedSub = safeDecodePath(sub).replace(/\\/g, '/');
    if (decodedSub.split('/').includes('..')) {
      throw new CrontickError(
        'BAD_DASHBOARD_ASSET',
        `Dashboard asset path is outside the dashboard directory. Request a path under /dashboard.`,
        { requestedPath: reqPath },
      );
    }
    const normalizedSub = normalize(sub).replace(/^[/\\]+/, '');
    filePath = pathResolve(dashDir, normalizedSub);
  }

  if (filePath !== indexFile && !filePath.startsWith(`${dashDir}${pathSep}`)) {
    throw new CrontickError(
      'BAD_DASHBOARD_ASSET',
      `Dashboard asset path is outside the dashboard directory. Request a path under /dashboard.`,
      { requestedPath: reqPath },
    );
  }

  if (!existsSync(filePath)) filePath = indexFile;
  if (!existsSync(filePath)) {
    throw new CrontickError(
      'DASHBOARD_ASSET_NOT_FOUND',
      `Dashboard assets were not found at ${dashDir}. Run: npm run build`,
      { dashboardDir: dashDir, action: 'npm run build' },
    );
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new CrontickError(
      'BAD_DASHBOARD_ASSET',
      `Dashboard asset path is not a file. Request a file under /dashboard.`,
      { requestedPath: reqPath },
    );
  }

  return {
    filePath,
    size: stat.size,
    contentType: MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
  };
}

export function dashboardDaemonDownError(operation: string): CrontickError {
  return new CrontickError(
    'DAEMON_NOT_RUNNING',
    `Dashboard daemon is not running while attempting ${operation}. Start it with: crontick daemon start`,
    { action: 'crontick daemon start', operation },
  );
}

function buildDashboardJob(ctx: DashboardContext, job: Job): DashboardJob {
  const lastRun = ctx.store.listRuns({ jobId: job.id, limit: 1 })[0];
  return {
    id: job.id,
    alias: job.alias ?? null,
    description: job.description ?? null,
    cwd: job.action.cwd ?? null,
    enabled: job.enabled,
    scheduleLabel: scheduleLabel(job.schedule),
    actionKind: job.action.kind,
    lastStatus: lastRun?.status ?? null,
    lastRunAt: lastRun?.startedAt ?? null,
    nextRunAt: job.enabled ? (ctx.scheduler.previewNext(job.schedule, { n: 1 })[0] ?? null) : null,
    job,
  };
}

function toDashboardRun(run: Run, aliasByJobId: ReadonlyMap<string, string | null>): DashboardRun {
  return {
    id: run.id,
    jobId: run.jobId,
    jobAlias: aliasByJobId.get(run.jobId) ?? null,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    durationMs: run.durationMs ?? null,
    exitCode: run.exitCode ?? null,
    error: run.error ?? null,
    sessionId: run.sessionId ?? null,
  };
}

function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === 'cron') return schedule.cron;
  if (schedule.kind === 'interval') return `every ${schedule.everySec}s`;
  return `once at ${schedule.runAt}`;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `Invalid dashboard runsLimit ${String(limit)}. Provide a positive integer for runsLimit, then retry the request.`,
      { runsLimit: limit, action: 'Provide a positive integer for runsLimit' },
    );
  }
  return limit;
}

function dashboardDir(): string {
  const moduleDir = pathResolve(fileURLToPath(import.meta.url), '..');
  return pathResolve(moduleDir, 'dashboard');
}

function safeDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
