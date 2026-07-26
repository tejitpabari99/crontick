// Loopback-only HTTP API for the daemon. All routes enforce localhost access.
// See docs/internals/daemon.md for the full route table.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { URL } from 'node:url';
import type { Store } from './store.js';
import type { RunStatus } from './store.js';
import type { Scheduler } from './scheduler.js';
import type { Runner } from './runner.js';
import { JobSchema } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
import { VERSION } from '../version.js';
import { applyConfigDefaults } from '../job-input.js';
import {
  buildDashboardData,
  buildDashboardStats,
  dashboardStatusFromDaemon,
  resolveDashboardAsset,
} from '../dashboard.js';
import { nullLogger, type Logger } from '../logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Invariant: only loopback addresses may connect. Non-loopback → 403.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Poll interval for SSE log streaming. Stream closes when run reaches a terminal status. */
const SSE_POLL_MS = 200;

// ── Context shared with handlers ──────────────────────────────────────────────

export interface ApiContext {
  store: Store;
  scheduler: Scheduler;
  runner: Runner;
  startedAt: Date;
  port: number;
  reload: () => Promise<void>;
  logger?: Logger;
  /** L1: graceful in-process shutdown, wired by index.ts after the HTTP server exists. */
  shutdown?: (signal: string) => Promise<void>;
  /** L2: summary of fires missed while the daemon was down, computed once at startup. */
  missedFireSummary?: {
    jobsWithMissedFires: number;
    missedRunsRecorded: number;
    jobsCapped: number;
    capPerJob: number;
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

/** Create the daemon HTTP server. Enforces loopback-only access on every request. */
export function createApiServer(ctx: ApiContext): http.Server {
  const server = http.createServer((req, res) => {
    // Enforce localhost-only
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(remote)) {
      return sendError(res, 403, 'FORBIDDEN', 'Only localhost connections are allowed');
    }
    void handleRequest(req, res, ctx);
  });
  return server;
}

// ── Router ────────────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const baseUrl = `http://127.0.0.1`;
  const url = new URL(rawUrl, baseUrl);
  const path = url.pathname;
  const startedAt = Date.now();
  const logger = (ctx.logger ?? nullLogger).child('api');
  logger.debug('HTTP request received', { method, path });
  res.on('finish', () => {
    logger.debug('HTTP response sent', { method, path, status: res.statusCode, durationMs: Date.now() - startedAt });
  });

  try {
    // ── Health ───────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, buildDashboardData({ ...ctx, pid: process.pid }, { runsLimit: 1 }).health);
    }

    // ── Jobs ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/jobs') {
      return sendJson(res, 200, ctx.store.listJobs());
    }

    if (method === 'POST' && path === '/api/jobs') {
      const body = await readBody(req);
      const parsed = JobSchema.safeParse(body);
      if (!parsed.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
      }
      const job = applyConfigDefaults(parsed.data);
      ctx.store.upsertJob(job);
      const stored = ctx.store.getJob(job.id) ?? job;
      ctx.scheduler.schedule(stored);
      // L2: seed the missed-fire watermark so a restart computes forward from
      // "job just created/updated", not from some earlier (or absent) state.
      ctx.store.recordTick(stored.id);
      return sendJson(res, 201, stored);
    }

    // /api/jobs/:id/*
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
    if (jobMatch) {
      const id = decodeURIComponent(jobMatch[1]);
      const sub = jobMatch[2] ?? '';

      if (method === 'GET' && sub === '') {
        const job = ctx.store.getJob(id);
        if (!job) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        return sendJson(res, 200, job);
      }

      if (method === 'PUT' && sub === '') {
        const existing = ctx.store.getJob(id);
        if (!existing) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        const body = await readBody(req);
        const parsed = JobSchema.safeParse({ ...existing, ...body, id });
        if (!parsed.success) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
        }
        const job = applyConfigDefaults(parsed.data);
        ctx.store.upsertJob(job);
        const stored = ctx.store.getJob(id) ?? job;
        ctx.scheduler.schedule(stored);
        // L2: same watermark seed as job creation — an update can re-enable a
        // job or change its schedule, both of which should compute missed
        // fires forward from now, not from a stale pre-update state.
        ctx.store.recordTick(stored.id);
        return sendJson(res, 200, stored);
      }

      if (method === 'DELETE' && sub === '') {
        const deleted = ctx.store.deleteJob(id);
        if (!deleted) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        ctx.scheduler.unschedule(id);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && sub === '/enable') {
        const job = ctx.store.getJob(id);
        if (!job) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        const updated = { ...job, enabled: true };
        ctx.store.upsertJob(updated);
        ctx.scheduler.schedule(updated);
        // L2: re-enabling starts a fresh watermark, same reasoning as create/update.
        ctx.store.recordTick(id);
        return sendJson(res, 200, updated);
      }

      if (method === 'POST' && sub === '/disable') {
        const job = ctx.store.getJob(id);
        if (!job) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        const updated = { ...job, enabled: false };
        ctx.store.upsertJob(updated);
        ctx.scheduler.unschedule(id);
        return sendJson(res, 200, updated);
      }

      if (method === 'POST' && sub === '/run') {
        const job = ctx.store.getJob(id);
        if (!job) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
        const run = ctx.store.insertRun(id);
        // Fire-and-forget: return 202 immediately while the run executes async
        ctx.runner.run(job, run.id, ctx.store).catch(() => {});
        return sendJson(res, 202, { runId: run.id });
      }
    }

    // ── Runs ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/runs') {
      const jobId = url.searchParams.get('jobId') ?? undefined;
      const limit = url.searchParams.has('limit')
        ? parseInt(url.searchParams.get('limit')!, 10)
        : undefined;
      const since = url.searchParams.has('since')
        ? parseInt(url.searchParams.get('since')!, 10)
        : undefined;
      const status = (url.searchParams.get('status') ?? undefined) as RunStatus | undefined;
      return sendJson(res, 200, ctx.store.listRuns({ jobId, limit, since, status }));
    }

    // /api/runs/:id/*
    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const sub = runMatch[2] ?? '';

      if (method === 'GET' && sub === '') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        return sendJson(res, 200, run);
      }

      if (method === 'POST' && sub === '/cancel') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        const canceled = ctx.runner.cancelRun(id);
        return sendJson(res, 200, { ok: true, canceled });
      }

      if (method === 'GET' && sub === '/logs') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        const logs = ctx.store.getLogs(id);
        return sendJson(res, 200, logs.map((l) => ({
          runId: l.runId,
          stream: l.stream,
          ts: l.ts,
          data: l.chunk.toString('utf-8'),
        })));
      }

      if (method === 'GET' && sub === '/logs/stream') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        return streamLogs(req, res, id, ctx);
      }
    }

    // ── Schedules ─────────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/api/schedules/validate') {
      const body = await readBody(req);
      const { ScheduleSchema } = await import('../schemas/job.js');
      const parsed = ScheduleSchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, 200, { ok: false, error: JSON.stringify(parsed.error.format()) });
      }
      const result = ctx.scheduler.validateSchedule(parsed.data);
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && path === '/api/schedules/preview') {
      const body = await readBody(req);
      const { ScheduleSchema } = await import('../schemas/job.js');
      const scheduleResult = ScheduleSchema.safeParse(body?.schedule ?? body);
      if (!scheduleResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid schedule');
      }
      const n = typeof body?.n === 'number' ? body.n : 5;
      const tz = body?.tz as string | undefined;
      const next = ctx.scheduler.previewNext(scheduleResult.data, { n, tz });
      return sendJson(res, 200, { next });
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/stats/summary') {
      const jobs = ctx.store.listJobs();
      const runs = ctx.store.listRuns({ limit: 1000 });
      return sendJson(res, 200, buildDashboardStats(jobs, runs));
    }

    const statsJobMatch = path.match(/^\/api\/stats\/jobs\/([^/]+)$/);
    if (method === 'GET' && statsJobMatch) {
      const id = decodeURIComponent(statsJobMatch[1]);
      const job = ctx.store.getJob(id);
      if (!job) return sendError(res, 404, 'NOT_FOUND', `Job ${id} not found`);
      const runs = ctx.store.listRuns({ jobId: id, limit: 100 });
      return sendJson(res, 200, {
        jobId: id,
        totalRuns: runs.length,
        succeeded: runs.filter((r) => r.status === 'success').length,
        failed: runs.filter((r) => r.status === 'failed').length,
        lastStatus: runs[0]?.status ?? null,
        lastRunAt: runs[0]?.startedAt ?? null,
      });
    }

    // ── Daemon ────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/daemon/status') {
      return sendJson(res, 200, {
        pid: process.pid,
        version: VERSION,
        uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
        jobs: ctx.store.listJobs().length,
        // L2: report-only missed-fire summary computed once at startup.
        missedFires: ctx.missedFireSummary ?? {
          jobsWithMissedFires: 0,
          missedRunsRecorded: 0,
          jobsCapped: 0,
          capPerJob: 0,
        },
      });
    }

    if (method === 'POST' && path === '/api/daemon/reload') {
      await ctx.reload();
      return sendJson(res, 200, { ok: true });
    }

    // L1: graceful in-process stop. Respond first (200, before the socket is
    // torn down), then trigger the real shutdown once the response has been
    // flushed — see the `res.on('finish', ...)` below. Client-side callers
    // should treat "request succeeded" as "shutdown has started", not
    // "daemon has exited"; use the PID/port files disappearing (or a
    // connection-refused health probe) to confirm the process is gone.
    if (method === 'POST' && path === '/api/daemon/stop') {
      if (!ctx.shutdown) {
        return sendError(res, 501, 'NOT_IMPLEMENTED', 'Graceful shutdown is not wired for this context');
      }
      const doShutdown = ctx.shutdown;
      sendJson(res, 200, { ok: true, stopping: true, pid: process.pid });
      res.on('finish', () => {
        void doShutdown('HTTP /api/daemon/stop');
      });
      return;
    }

    // ── Export / Import ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/export') {
      return sendJson(res, 200, { jobs: ctx.store.listJobs() });
    }

    if (method === 'POST' && path === '/api/import') {
      const body = await readBody(req);
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const raw of jobs) {
        const parsed = JobSchema.safeParse(raw);
        if (parsed.success) {
          const job = applyConfigDefaults(parsed.data);
          ctx.store.upsertJob(job);
          ctx.scheduler.schedule(job);
          results.push({ id: job.id, ok: true });
        } else {
          results.push({ id: String(raw?.id ?? '?'), ok: false, error: 'validation failed' });
        }
      }
      return sendJson(res, 200, { imported: results.filter((r) => r.ok).length, results });
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/dashboard/status') {
      return sendJson(
        res,
        200,
        dashboardStatusFromDaemon(
          { ...ctx, pid: process.pid },
          `http://127.0.0.1:${ctx.port}`,
          {
            pid: process.pid,
            uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
            jobs: ctx.store.listJobs().length,
          },
        ),
      );
    }

    if (method === 'GET' && path === '/api/dashboard') {
      const runsLimit = optionalPositiveInt(url.searchParams.get('runsLimit'), 'runsLimit');
      const jobId = url.searchParams.get('jobId') ?? undefined;
      return sendJson(res, 200, buildDashboardData({ ...ctx, pid: process.pid }, { runsLimit, jobId }));
    }

    if (method === 'GET' && (path === '/' || path === '/dashboard' || path.startsWith('/dashboard/'))) {
      return serveDashboard(res, path);
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return sendError(res, 404, 'NOT_FOUND', `${method} ${path} not found`);
  } catch (err) {
    if (err instanceof CrontickError) {
      return sendError(res, 400, err.code, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return sendError(res, 500, 'INTERNAL_ERROR', msg);
  }
}

// ── SSE log streaming ─────────────────────────────────────────────────────────
// Sends existing log entries immediately, then polls for new entries every
// SSE_POLL_MS until the run reaches a terminal status or the client disconnects.

function streamLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  ctx: ApiContext,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let lastTs = 0;

  // Send existing logs first
  const existing = ctx.store.getLogs(runId);
  for (const log of existing) {
    sseEvent(res, { stream: log.stream, ts: log.ts, data: log.chunk.toString('utf-8') });
    if (log.ts > lastTs) lastTs = log.ts;
  }

  // Poll for new logs until run is terminal
  const poll = setInterval(() => {
    const run = ctx.store.getRun(runId);
    const newLogs = ctx.store.tailLogs(runId, lastTs);
    for (const log of newLogs) {
      sseEvent(res, { stream: log.stream, ts: log.ts, data: log.chunk.toString('utf-8') });
      if (log.ts > lastTs) lastTs = log.ts;
    }

    const terminal = new Set(['success', 'failed', 'canceled', 'timeout', 'missed']);
    if (!run || terminal.has(run.status)) {
      sseEvent(res, { done: true, status: run?.status });
      clearInterval(poll);
      res.end();
    }
  }, SSE_POLL_MS);

  req.on('close', () => {
    clearInterval(poll);
  });
}

function serveDashboard(
  res: http.ServerResponse,
  reqPath: string,
): void {
  const asset = resolveDashboardAsset(reqPath);

  res.writeHead(200, {
    'Content-Type': asset.contentType,
    'Content-Length': asset.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(asset.filePath).pipe(res);
}

function sseEvent(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function optionalPositiveInt(raw: string | null, field: string): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `Invalid ${field} ${raw}. Provide a positive integer, then retry: crontick dashboard data --runs-limit <n>`,
      { field, value: raw, action: 'crontick dashboard data --runs-limit <n>' },
    );
  }
  return parsed;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  sendJson(res, status, { error: { code, message, details } });
}
