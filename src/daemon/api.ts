import http from 'node:http';
import { createReadStream, existsSync as fsExistsSync, statSync } from 'node:fs';
import {
  extname,
  resolve as pathResolve,
  join as pathJoin,
  normalize,
  sep as pathSep,
} from 'node:path';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import type { Runner } from './runner.js';
import { JobSchema } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
import { VERSION } from '../version.js';
import { createAutostart, NotImplementedInV1Error } from '../autostart/index.js';
import type { AutostartBackend } from '../autostart/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SSE_POLL_MS = 200;
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Context shared with handlers ──────────────────────────────────────────────

export interface ApiContext {
  store: Store;
  scheduler: Scheduler;
  runner: Runner;
  startedAt: Date;
  port: number;
  reload: () => Promise<void>;
}

// ── Server factory ────────────────────────────────────────────────────────────

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

  try {
    // ── Health ───────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/health') {
      const jobs = ctx.store.listJobs();
      const since24h = Date.now() - 24 * 60 * 60 * 1000;
      const runs24h = ctx.store.listRuns({ since: since24h });
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
        pid: process.pid,
        port: ctx.port,
        jobs: {
          total: jobs.length,
          enabled: jobs.filter((j) => j.enabled).length,
        },
        runs: {
          last24h: runs24h.length,
          failures24h: runs24h.filter((r) => r.status === 'failed').length,
        },
        node: process.versions.node,
        platform: process.platform,
      });
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
      ctx.store.upsertJob(parsed.data);
      ctx.scheduler.schedule(parsed.data, ctx.store);
      return sendJson(res, 201, parsed.data);
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
        ctx.store.upsertJob(parsed.data);
        ctx.scheduler.schedule(parsed.data, ctx.store);
        return sendJson(res, 200, parsed.data);
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
        ctx.scheduler.schedule(updated, ctx.store);
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
        // fire async, don't await
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
      return sendJson(res, 200, ctx.store.listRuns({ jobId, limit, since }));
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
      const failed = runs.filter((r) => r.status === 'failed').length;
      const succeeded = runs.filter((r) => r.status === 'success').length;
      return sendJson(res, 200, {
        totalJobs: jobs.length,
        enabledJobs: jobs.filter((j) => j.enabled).length,
        totalRuns: runs.length,
        succeeded,
        failed,
        avgDurationMs:
          runs.length > 0
            ? Math.round(runs.reduce((s, r) => s + (r.durationMs ?? 0), 0) / runs.length)
            : null,
      });
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
      });
    }

    if (method === 'POST' && path === '/api/daemon/reload') {
      await ctx.reload();
      return sendJson(res, 200, { ok: true });
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
          ctx.store.upsertJob(parsed.data);
          ctx.scheduler.schedule(parsed.data, ctx.store);
          results.push({ id: parsed.data.id, ok: true });
        } else {
          results.push({ id: String(raw?.id ?? '?'), ok: false, error: 'validation failed' });
        }
      }
      return sendJson(res, 200, { imported: results.filter((r) => r.ok).length, results });
    }

    // ── Autostart ─────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/api/autostart/status') {
      const backend = (url.searchParams.get('backend') ?? undefined) as AutostartBackend | undefined;
      const autostart = createAutostart({ backend });
      const result = await autostart.status();
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && path === '/api/autostart/install') {
      const body = await readBody(req);
      const backend = (body?.['backend'] as string | undefined) as AutostartBackend | undefined;
      const autostart = createAutostart({ backend });
      const result = await autostart.install();
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && path === '/api/autostart/remove') {
      const body = await readBody(req);
      const backend = (body?.['backend'] as string | undefined) as AutostartBackend | undefined;
      const autostart = createAutostart({ backend });
      const result = await autostart.remove();
      return sendJson(res, 200, result);
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────
    if (method === 'GET' && (path === '/' || path === '/dashboard' || path.startsWith('/dashboard/'))) {
      return serveDashboard(res, path);
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return sendError(res, 404, 'NOT_FOUND', `${method} ${path} not found`);
  } catch (err) {
    if (err instanceof NotImplementedInV1Error) {
      return sendError(res, 501, 'NOT_IMPLEMENTED_V1', err.message);
    }
    if (err instanceof CrontickError) {
      return sendError(res, 400, err.code, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return sendError(res, 500, 'INTERNAL_ERROR', msg);
  }
}

// ── SSE log streaming ─────────────────────────────────────────────────────────

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

    const terminal = new Set(['success', 'failed', 'canceled', 'timeout']);
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

function dashboardDir(): string {
  const moduleDir = pathResolve(fileURLToPath(import.meta.url), '..');
  return pathResolve(moduleDir, '../dashboard');
}

function serveDashboard(
  res: http.ServerResponse,
  reqPath: string,
): void {
  const dashDir = dashboardDir();
  const indexFile = pathJoin(dashDir, 'index.html');

  let filePath: string;
  if (reqPath === '/' || reqPath === '/dashboard' || reqPath === '/dashboard/') {
    filePath = indexFile;
  } else {
    const sub = reqPath.startsWith('/dashboard/') ? reqPath.slice('/dashboard'.length) : reqPath;
    const normalizedSub = normalize(sub).replace(/^[/\\]+/, '');
    filePath = pathResolve(dashDir, normalizedSub);
  }

  if (filePath !== indexFile && !filePath.startsWith(`${dashDir}${pathSep}`)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (!fsExistsSync(filePath)) {
    filePath = indexFile;
  }

  if (!fsExistsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

function sseEvent(res: http.ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
