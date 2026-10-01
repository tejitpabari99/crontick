// Loopback-only HTTP API for the daemon. All routes enforce localhost access.
// See docs/implementation/daemon.md for the full route table.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { URL } from 'node:url';
import type { Store } from './store.js';
import type { Run, RunStatus } from './store.js';
import { LOG_SOURCES, type LogSource } from '../log-source.js';
import type { Scheduler } from './scheduler.js';
import type { Runner } from './runner.js';
import { JobSchema } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
import { VERSION } from '../version.js';
import { applyConfigDefaults, generateAlias } from '../job-input.js';
import {
  averageDurationMs,
  msToSec,
  buildDashboardData,
  buildDashboardStats,
  dashboardStatusFromDaemon,
  resolveDashboardAsset,
} from '../dashboard.js';
import { buildRunOutput } from '../run-output.js';
import { nullLogger, redactValue, type Logger } from '../logger.js';
import { readEnvFileForAction } from './env-file.js';
import { SSE_POLL_MS } from '../constants/daemon.js';
import { resolveJobLogPath } from './job-log-file.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Invariant: only loopback addresses may connect. Non-loopback → 403.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Coerce an untrusted `source` query value to a valid LogSource, defaulting to 'all'. */
function normalizeLogSource(value: string | null): LogSource {
  return value !== null && (LOG_SOURCES as readonly string[]).includes(value) ? (value as LogSource) : 'all';
}

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
      return sendJson(res, 200, redactValue(ctx.store.listJobs()));
    }

    if (method === 'POST' && path === '/api/jobs') {
      const body = await readBody(req);
      const parsed = JobSchema.safeParse(body);
      if (!parsed.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
      }
      let job = applyConfigDefaults(parsed.data);
      const force = forceParam(url);
      // Auto-generate a unique alias when the caller didn't supply one (see
      // generateAlias in job-input.ts): word + random 1-1000, retried on
      // collision against every currently-live job's id AND alias.
      const autoAlias = job.alias === undefined;
      const alias = job.alias ?? generateAlias((candidate) => ctx.store.getJob(candidate) !== undefined);
      job = { ...job, alias };
      // A job identifier collides if either the (fresh, so this normally only
      // matters for import/restore scenarios) GUID `id` or the `alias`
      // already belongs to an existing job -- resolved the same way any
      // other job lookup accepts "id or alias" (see Store.getJob).
      const collision = ctx.store.getJob(job.id) ?? ctx.store.getJob(alias);
      if (collision) {
        if (!force) return sendDuplicateCreateError(res, alias);
        // force: replace the existing job in place, keeping ITS GUID id so
        // run history (which references the GUID) stays associated with the
        // job the caller is intentionally overwriting.
        job = { ...job, id: collision.id };
      }
      if (!validateJobSchedule(res, ctx.scheduler, job.schedule)) return;
      readEnvFileForAction(job.action);
      // A concurrent create can claim the same auto-generated alias between the
      // collision check above and this insert; the alias UNIQUE index then
      // rejects the write. Regenerate and retry (max 3). Explicit aliases never
      // retry: they surface as JOB_ALREADY_EXISTS.
      for (let attempt = 0; ; attempt++) {
        try {
          ctx.store.upsertJob(job);
          break;
        } catch (err) {
          if (autoAlias && attempt < MAX_ALIAS_RACE_RETRIES && isUniqueConstraintError(err)) {
            job = { ...job, alias: generateAlias((candidate) => ctx.store.getJob(candidate) !== undefined) };
            continue;
          }
          if (isUniqueConstraintError(err)) return sendDuplicateCreateError(res, job.alias ?? job.id);
          throw err;
        }
      }
      const stored = ctx.store.getJob(job.id) ?? job;
      ctx.scheduler.schedule(stored);
      // L2: seed the missed-fire watermark so a restart computes forward from
      // "job just created/updated", not from some earlier (or absent) state.
      ctx.store.recordTick(stored.id);
      return sendJson(res, 201, redactValue(stored));
    }

    // Atomic bulk delete: removes every job (and its runs/logs/schedule-state)
    // in a single store transaction. Guarded by ?force=1 like the client's
    // deleteJob({ all, force }) contract; force validation is enforced in core
    // too, this is the transport-side backstop.
    if (method === 'DELETE' && path === '/api/jobs') {
      if (!forceParam(url)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Deleting all jobs requires force:true');
      }
      // Snapshot the live jobs first so every schedule can be torn down and any
      // in-flight run canceled — deleting a job removes its definition entirely
      // (same reasoning as single-job DELETE), so nothing should keep firing or
      // stay running against a job that no longer exists.
      const jobs = ctx.store.listJobs();
      const deleted = ctx.store.deleteAllJobs();
      for (const job of jobs) {
        ctx.scheduler.unschedule(job.id);
        ctx.runner.cancelJob(job.id);
      }
      return sendJson(res, 200, { ok: true, deleted });
    }

    // /api/jobs/:id/*
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
    if (jobMatch) {
      const requestedId = decodeURIComponent(jobMatch[1]);
      const sub = jobMatch[2] ?? '';
      // Every job lookup below accepts EITHER the GUID `id` or the `alias`
      // (see Store.getJob) and resolves once, up front, to the canonical
      // job/id so every downstream store/scheduler/runner call operates on
      // the immutable GUID rather than whatever identifier the caller used.
      const job = ctx.store.getJob(requestedId);

      if (method === 'GET' && sub === '') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        return sendJson(res, 200, redactValue(job));
      }

      if (method === 'PUT' && sub === '') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const body = await readBody(req);
        const parsed = JobSchema.safeParse({ ...job, ...body, id: job.id });
        if (!parsed.success) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
        }
        const updatedJob = applyConfigDefaults(parsed.data);
        // Renaming the alias must not collide with any OTHER live job's id/alias.
        if (updatedJob.alias && updatedJob.alias !== job.alias) {
          const collision = ctx.store.getJob(updatedJob.alias);
          if (collision && collision.id !== job.id) {
            return sendDuplicateCreateError(res, updatedJob.alias);
          }
        }
        if (!validateJobSchedule(res, ctx.scheduler, updatedJob.schedule)) return;
        readEnvFileForAction(updatedJob.action);
        ctx.store.upsertJob(updatedJob);
        const stored = ctx.store.getJob(job.id) ?? updatedJob;
        ctx.scheduler.schedule(stored);
        // L2: same watermark seed as job creation — an update can re-enable a
        // job or change its schedule, both of which should compute missed
        // fires forward from now, not from a stale pre-update state.
        ctx.store.recordTick(stored.id);
        return sendJson(res, 200, redactValue(stored));
      }

      if (method === 'DELETE' && sub === '') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const deleted = ctx.store.deleteJob(job.id);
        if (!deleted) return sendJobNotFoundError(res, requestedId);
        ctx.scheduler.unschedule(job.id);
        // Major 4: unlike a daemon stop (where a detached child surviving is
        // deliberate, L8), deleting a job removes the definition entirely, so
        // there is nothing left for an in-flight run to belong to. Cancel any
        // active run for this job rather than leaving its process running
        // against a job that no longer exists. Visible via `canceledRun` in
        // the response instead of silently orphaning it.
        const canceledRun = ctx.runner.cancelJob(job.id);
        return sendJson(res, 200, { ok: true, canceledRun });
      }

      if (method === 'POST' && sub === '/enable') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const updated = { ...job, enabled: true };
        ctx.store.upsertJob(updated);
        ctx.scheduler.schedule(updated);
        // L2: re-enabling starts a fresh watermark, same reasoning as create/update.
        ctx.store.recordTick(job.id);
        return sendJson(res, 200, redactValue(updated));
      }

      if (method === 'POST' && sub === '/disable') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const updated = { ...job, enabled: false };
        ctx.store.upsertJob(updated);
        ctx.scheduler.unschedule(job.id);
        return sendJson(res, 200, redactValue(updated));
      }

      // `/run-now` is an alias of `/run` (used by the dashboard). Runs the job once
      // immediately WITHOUT touching `enabled` or the schedule: a disabled job stays
      // disabled, an enabled job keeps its normal schedule. Overlap policy still applies.
      if (method === 'POST' && (sub === '/run' || sub === '/run-now')) {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const run = ctx.store.insertRun(job.id);
        // Fire-and-forget: return 202 immediately while the run executes async.
        // Any rejection here is an invariant violation: Runner.run() should
        // always totalize the run row itself before resolving.
        ctx.runner.run(job, run.id, ctx.store).catch((err: unknown) => {
          logger.error('Runner.run rejected after POST /api/jobs/:id/run returned 202', {
            jobId: job.id,
            runId: run.id,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        });
        return sendJson(res, 202, { runId: run.id });
      }
    }

    // ── Runs ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/runs') {
      const { jobIds, statuses, q } = runFilterParams(url, ctx);
      // Validate with the shared positive-int helper so NaN/negative/Infinity
      // yield a clean 400 (VALIDATION_ERROR) instead of reaching SQLite and
      // surfacing as an opaque 500.
      const limit = optionalPositiveInt(url.searchParams.get('limit'), 'limit');
      const since = optionalPositiveInt(url.searchParams.get('since'), 'since');
      return sendJson(res, 200, redactValue(ctx.store.listRuns({ jobIds, limit, since, statuses, q })));
    }


    // /api/runs/:id/*
    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const sub = runMatch[2] ?? '';

      if (method === 'GET' && sub === '') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        // Per-job (not per-run) mirror file; null when file logging is disabled.
        return sendJson(res, 200, redactValue({ ...run, logFile: resolveJobLogPath(run.jobId) }));
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
        const source = normalizeLogSource(url.searchParams.get('source'));
        const logs = ctx.store.getLogs(id, source);
        return sendJson(res, 200, redactValue(logs.map((l) => ({
          runId: l.runId,
          stream: l.stream,
          ts: l.ts,
          data: l.chunk.toString('utf-8'),
        }))));
      }

      // Cleaned, human-readable view of the run's engine output (final answer, error,
      // readable transcript) -- see src/run-output.ts. The raw log stays at /logs.
      if (method === 'GET' && sub === '/output') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        const logs = ctx.store.getLogs(id, 'engine').map((l) => ({ stream: l.stream, data: l.chunk.toString('utf-8') }));
        return sendJson(res, 200, redactValue(buildRunOutput(run, logs)));
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
      const next = ctx.scheduler.previewNext(scheduleResult.data, { n });
      return sendJson(res, 200, { next });
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/stats/summary') {
      const jobs = ctx.store.listJobs();
      const runs = ctx.store.listRunsForExistingJobs({ limit: 1000 });
      return sendJson(res, 200, buildDashboardStats(jobs, runs));
    }

    const statsJobMatch = path.match(/^\/api\/stats\/jobs\/([^/]+)$/);
    if (method === 'GET' && statsJobMatch) {
      const requestedId = decodeURIComponent(statsJobMatch[1]);
      const job = ctx.store.getJob(requestedId);
      if (!job) return sendJobNotFoundError(res, requestedId);
      const runs = ctx.store.listRuns({ jobId: job.id, limit: 100 });
      return sendJson(res, 200, {
        jobId: job.id,
        totalRuns: runs.length,
        succeeded: runs.filter((r) => r.status === 'success').length,
        failed: runs.filter((r) => r.status === 'failed').length,
        canceled: runs.filter((r) => r.status === 'canceled').length,
        skipped: runs.filter((r) => r.status === 'skipped').length,
        totalCostUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
        totalTurns: runs.reduce((sum, run) => sum + (run.turns ?? 0), 0),
        lastStatus: runs[0]?.status ?? null,
        lastRunAt: runs[0]?.startedAt ?? null,
        avgDurationSec: msToSec(averageDurationMs(runs)),
      });
    }

    // ── Daemon ────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/daemon/status') {
      return sendJson(res, 200, {
        pid: process.pid,
        version: VERSION,
        port: ctx.port,
        baseUrl: `http://127.0.0.1:${ctx.port}`,
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
      // Major 4: detached children (L8) are deliberately left running past the
      // daemon's own exit, so report which runs are still in progress at the
      // moment of shutdown — visible to the caller (see stopDaemon() in
      // lifecycle.ts and `crontick daemon stop`'s output) instead of silently
      // abandoning them with no trace.
      const activeRuns = ctx.store.listRuns({ status: 'running' }).map((r) => ({ id: r.id, jobId: r.jobId }));
      sendJson(res, 200, { ok: true, stopping: true, pid: process.pid, activeRuns });
      res.on('finish', () => {
        void doShutdown('HTTP /api/daemon/stop');
      });
      return;
    }

    // ── Export / Import ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/export') {
      // L7: run history is opt-in via ?includeRuns=1 to keep the common
      // (jobs-only) export small; bounded by whatever retention has left.
      const includeRuns = url.searchParams.get('includeRuns') === '1';
      const payload: { jobs: ReturnType<Store['listJobs']>; runs?: Run[] } = { jobs: ctx.store.listJobs() };
      if (includeRuns) payload.runs = ctx.store.listRuns({});
      return sendJson(res, 200, redactValue(payload));
    }

    if (method === 'POST' && path === '/api/import') {
      const body = await readBody(req);
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const raw of jobs) {
        const parsed = JobSchema.safeParse(raw);
        if (parsed.success) {
          let job = applyConfigDefaults(parsed.data);
          // Import is a restore/merge operation, not a strict create: if this
          // row's id-or-alias already matches a currently-live job (e.g.
          // re-importing the same backup), overwrite that job in place --
          // keeping ITS GUID id -- rather than colliding on the
          // alias-uniqueness constraint (see store.ts) with a brand-new GUID.
          // This mirrors POST /api/jobs's --force semantics and keeps
          // re-import idempotent.
          const existing = (job.alias ? ctx.store.getJob(job.alias) : undefined) ?? ctx.store.getJob(job.id);
          if (existing) job = { ...job, id: existing.id };
          try {
            job = ctx.store.prepareImportedJob(job);
            // Best-effort: the alias-uniqueness DB index (see store.ts) can
            // still reject an import row whose alias collides with a
            // DIFFERENT already-live job; skip that one row rather than
            // failing the whole import.
            ctx.store.upsertJob(job);
            ctx.scheduler.schedule(job);
            results.push({ id: job.id, ok: true });
          } catch (err) {
            results.push({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          results.push({ id: String(raw?.id ?? '?'), ok: false, error: 'validation failed' });
        }
      }
      // L7: optional `runs` array (as produced by GET /api/export?includeRuns=1)
      // is restored archivally -- no execution, no scheduler interaction.
      // Passed through unvalidated (`unknown[]`, not cast to `Run[]`) --
      // Store.importRuns() validates each row itself (see RunImportSchema)
      // and skips malformed rows individually, the same way the jobs loop
      // above does, instead of trusting the wire payload's shape.
      const runs = Array.isArray(body?.runs) ? body.runs : undefined;
      const runsResult = runs ? ctx.store.importRuns(runs) : undefined;
      return sendJson(res, 200, {
        imported: results.filter((r) => r.ok).length,
        results,
        ...(runsResult ? { runsImported: runsResult.imported, runsSkipped: runsResult.skipped } : {}),
      });
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
      const { jobIds, statuses, q } = runFilterParams(url, ctx);
      return sendJson(res, 200, buildDashboardData({ ...ctx, pid: process.pid }, { runsLimit, jobIds, statuses, q }));
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

/**
 * Shared run-list filters: `jobId` (id or alias; comma-separated for several), `status`
 * (comma-separated for several) and `q` (free-text search incl. run logs).
 */
function runFilterParams(url: URL, ctx: ApiContext): { jobIds?: string[]; statuses?: RunStatus[]; q?: string } {
  const split = (name: string): string[] => url.searchParams.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  const jobIds = split('jobId').map((requested) => ctx.store.getJob(requested)?.id ?? requested);
  const statuses = split('status') as RunStatus[];
  const q = url.searchParams.get('q')?.trim() || undefined;
  return {
    jobIds: jobIds.length > 0 ? jobIds : undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    q,
  };
}

const MAX_ALIAS_RACE_RETRIES = 3;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function forceParam(url: URL): boolean {
  const raw = (url.searchParams.get('force') ?? '').toLowerCase();
  return raw === '1' || raw === 'true';
}

function sendJobNotFoundError(res: http.ServerResponse, idOrAlias: string): void {
  sendError(res, 404, 'JOB_NOT_FOUND', `Job ${idOrAlias} not found (id or alias)`);
}

function sendDuplicateCreateError(res: http.ServerResponse, jobId: string): void {
  sendError(
    res,
    409,
    'JOB_ALREADY_EXISTS',
    `Job "${jobId}" already exists. Use "crontick update ${jobId}" to change it, or re-run create with --force (CLI) or force: true (library/MCP) to intentionally replace it.`,
  );
}

function validateJobSchedule(
  res: http.ServerResponse,
  scheduler: Scheduler,
  schedule: Parameters<Scheduler['validateSchedule']>[0],
): boolean {
  const result = scheduler.validateSchedule(schedule);
  if (!result.ok) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid schedule', result.error);
    return false;
  }
  return true;
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
    sseEvent(res, redactValue({ stream: log.stream, ts: log.ts, data: log.chunk.toString('utf-8') }));
    if (log.ts > lastTs) lastTs = log.ts;
  }

  // Poll for new logs until run is terminal
  const poll = setInterval(() => {
    const run = ctx.store.getRun(runId);
    const newLogs = ctx.store.tailLogs(runId, lastTs);
    for (const log of newLogs) {
      sseEvent(res, redactValue({ stream: log.stream, ts: log.ts, data: log.chunk.toString('utf-8') }));
      if (log.ts > lastTs) lastTs = log.ts;
    }

    const terminal = new Set(['success', 'failed', 'canceled', 'skipped', 'timeout', 'missed']);
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
      `Invalid ${field} ${raw}. Provide a positive integer for ${field}, then retry the request.`,
      { field, value: raw, action: `Provide a positive integer for ${field}` },
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
