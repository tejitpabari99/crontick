import { existsSync, statSync } from 'node:fs';
import { extname, join as pathJoin, normalize, resolve as pathResolve, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrontickError } from './errors.js';
import { VERSION } from './version.js';
import type { Job, Schedule } from './schemas/job.js';
import type { Store, Run } from './daemon/store.js';
import type { Scheduler } from './daemon/scheduler.js';
import type { DaemonStopResult } from './daemon/lifecycle.js';

export interface DashboardOptions {
  runsLimit?: number;
  jobId?: string;
}

export interface DashboardHealth {
  ok: true;
  product: 'crontick';
  version: string;
  uptimeSec: number;
  pid: number;
  port: number;
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
  avgDurationMs: number | null;
}

export interface DashboardJob {
  id: string;
  description: string | null;
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
  status: Run['status'];
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
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

export interface DashboardStartResult extends DashboardStatus {
  startedDaemon: boolean;
}

export type DashboardStopResult = DaemonStopResult;

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
  const runs = ctx.store.listRuns({ jobId: options.jobId, limit: runsLimit });
  const allRuns = ctx.store.listRuns({ limit: 1000 });
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const runs24h = ctx.store.listRuns({ since: since24h });

  return {
    generatedAt: Date.now(),
    health: buildDashboardHealth(ctx, jobs, runs24h),
    stats: buildDashboardStats(jobs, allRuns),
    jobs: jobs.map((job) => buildDashboardJob(ctx, job)),
    runs: runs.map(toDashboardRun),
  };
}

export function buildDashboardHealth(ctx: DashboardContext, jobs: Job[], runs24h: Run[]): DashboardHealth {
  return {
    ok: true,
    product: 'crontick',
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    pid: ctx.pid ?? process.pid,
    port: ctx.port,
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

export function buildDashboardStats(jobs: Job[], runs: Run[]): DashboardStats {
  const failed = runs.filter((run) => run.status === 'failed').length;
  const succeeded = runs.filter((run) => run.status === 'success').length;
  return {
    totalJobs: jobs.length,
    enabledJobs: jobs.filter((job) => job.enabled).length,
    totalRuns: runs.length,
    succeeded,
    failed,
    avgDurationMs: runs.length > 0
      ? Math.round(runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / runs.length)
      : null,
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

export function dashboardUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/dashboard`;
}

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
        `Dashboard asset path is outside the dashboard directory. Request a path under /dashboard, then retry: crontick dashboard start`,
        { requestedPath: reqPath, action: 'crontick dashboard start' },
      );
    }
    const normalizedSub = normalize(sub).replace(/^[/\\]+/, '');
    filePath = pathResolve(dashDir, normalizedSub);
  }

  if (filePath !== indexFile && !filePath.startsWith(`${dashDir}${pathSep}`)) {
    throw new CrontickError(
      'BAD_DASHBOARD_ASSET',
      `Dashboard asset path is outside the dashboard directory. Request a path under /dashboard, then retry: crontick dashboard start`,
      { requestedPath: reqPath, action: 'crontick dashboard start' },
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
      `Dashboard asset path is not a file. Request a file under /dashboard, then retry: crontick dashboard start`,
      { requestedPath: reqPath, action: 'crontick dashboard start' },
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
    `Dashboard daemon is not running while attempting ${operation}. Start it with: crontick dashboard start`,
    { action: 'crontick dashboard start', operation },
  );
}

function buildDashboardJob(ctx: DashboardContext, job: Job): DashboardJob {
  const lastRun = ctx.store.listRuns({ jobId: job.id, limit: 1 })[0];
  return {
    id: job.id,
    description: job.description ?? null,
    enabled: job.enabled,
    scheduleLabel: scheduleLabel(job.schedule),
    actionKind: job.action.kind,
    lastStatus: lastRun?.status ?? null,
    lastRunAt: lastRun?.startedAt ?? null,
    nextRunAt: job.enabled ? (ctx.scheduler.previewNext(job.schedule, { n: 1 })[0] ?? null) : null,
    job,
  };
}

function toDashboardRun(run: Run): DashboardRun {
  return {
    id: run.id,
    jobId: run.jobId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    durationMs: run.durationMs ?? null,
    exitCode: run.exitCode ?? null,
    error: run.error ?? null,
  };
}

function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === 'cron') return schedule.cron + (schedule.tz ? ` (${schedule.tz})` : '');
  if (schedule.kind === 'interval') return `every ${schedule.everySec}s`;
  return `once at ${schedule.runAt}`;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `Invalid dashboard runsLimit ${String(limit)}. Provide a positive integer, then retry: crontick dashboard data --runs-limit <n>`,
      { runsLimit: limit, action: 'crontick dashboard data --runs-limit <n>' },
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
