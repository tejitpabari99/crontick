// Loopback-only HTTP API for the daemon. All routes enforce localhost access.
// See docs/implementation/daemon.md for the full route table.
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { validateAfterGraph, type Store } from './store.js';
import type { RunStatus } from './store.js';
import type { Scheduler } from './scheduler.js';
import type { Runner } from './runner.js';
import { JobSchema, JOB_ALIAS_PATTERN, type Job } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
import { VERSION } from '../version.js';
import { applyConfigDefaults, generateAlias, type JobCreateInput, type JobPatchInput } from '../job-input.js';
import { prepareCreate, prepareUpdate } from '../job-prepare.js';
import { getEngineAdapter } from '../engines/registry.js';
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
import { redactWebhookDeep, restoreRedactedWebhook } from '../utils/webhook-redact.js';
import { readEnvFileForAction } from './env-file.js';
import { resolveJobLogPath } from './job-log-file.js';
import { TriggerDispatcher, type TriggerSkipReason } from './trigger.js';
import { createRelayChannel } from '../utils/relay-url.js';
import { toRelayStatusView, redactTriggerMeta } from '../utils/webhook-redact.js';
import { buildWebhookContext, buildWebhookPayload } from '../utils/webhook-payload.js';
import { checkMutatingRequest, isGuardedRequest } from './request-guard.js';
import { describeDaemonPort } from './bind-port.js';
import { dataDir } from '../paths.js';
import { CONFIG_EDIT_NOTICE, IN_FLIGHT_CHOICES } from '../constants/config.js';
import {
  getConfigRevision,
  loadConfig,
  loadDaemonConfigOrEmpty,
  redactConfigForRead,
  redactStoredConfigForRead,
  configFilePath,
  readStoredConfigFile,
  type ConfigOp,
} from '../config.js';
import { stripExportIds, stripWebhookSecrets } from '../share.js';
import type { CrontickConfig } from '../schemas/config.js';
import { applyConfigWithPolicy, applyJobUpdateWithPolicy, type InFlightChoice, type LostPendingConfigApply } from './config-apply.js';

/** Redaction for every API payload: logger redaction plus webhook relay/secret display form. */
function redactPublic(value: unknown): unknown {
  return redactWebhookDeep(redactValue(value));
}

/** Single-job payload that keeps the full webhook relay/secret (only `GET /api/jobs/:id` and create). */
function redactKeepingWebhook(job: Job): unknown {
  return { ...(redactValue(job) as Record<string, unknown>), schedule: job.schedule };
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Invariant: only loopback addresses may connect. Non-loopback → 403.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Run ids are generated identifiers; anything else cannot name a run. */

// ── Context shared with handlers ──────────────────────────────────────────────

export interface ApiContext {
  store: Store;
  scheduler: Scheduler;
  runner: Runner;
  startedAt: Date;
  port: number;
  reload: () => Promise<void>;
  /** Re-diff relay subscriptions against the stored jobs (idempotent). */
  syncRelays?: () => void;
  /** In-memory relay connection status (raw URLs; redacted before leaving the API). */
  relayStatus?: () => Array<Parameters<typeof toRelayStatusView>[0]>;
  /** Injectable fetch for `POST /api/relay/new` (tests); defaults to global fetch. */
  relayFetch?: typeof fetch;
  logger?: Logger;
  /** L1: graceful in-process shutdown, wired by index.ts after the HTTP server exists. */
  shutdown?: (signal: string) => Promise<void>;
  /** A wait-then-apply config save lost with the previous daemon session (null when none). */
  lostPendingConfigApply?: LostPendingConfigApply | null;
  /** L2: summary of fires missed while the daemon was down, computed once at startup. */
  missedFireSummary?: {
    jobsWithMissedFires: number;
    missedRunsRecorded: number;
    jobsCapped: number;
    capPerJob: number;
    catchUpRuns: number;
  };
}

/** True when `?name=1` (or `true`) is present. */
function flagParam(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v === '1' || v === 'true';
}

/** Dashboard editor form metadata, read from config so the form never hardcodes defaults. */
function buildEditorMeta(): unknown {
  const config = loadConfig();
  const engines = Object.entries(config.engines).map(([name, engine]) => {
    const adapter = getEngineAdapter(engine.type);
    return { name, type: engine.type, supportsTrust: Boolean(adapter.isFolderTrusted && adapter.trustFolder) };
  });
  return {
    engines,
    defaultEngine: config.defaultEngine,
    defaults: {
      overlap: config.defaults.overlap,
      ...(config.defaults.timeoutSec !== undefined ? { timeoutSec: config.defaults.timeoutSec } : {}),
      retry: config.defaults.retry,
    },
    aliasPattern: JOB_ALIAS_PATTERN.source,
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
    // Central guard: every mutating /api route, including unknown ones, before any handler runs.
    if (isGuardedRequest(method, path)) {
      const rejection = checkMutatingRequest(req);
      if (rejection) {
        req.resume();
        return sendError(res, rejection.status, 'REQUEST_REJECTED', rejection.message);
      }
    }

    // ── Health ───────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, buildDashboardData({ ...ctx, pid: process.pid }, { runsLimit: 1 }).health);
    }

    if (method === 'GET' && path === '/api/relays') {
      return sendJson(res, 200, (ctx.relayStatus?.() ?? []).map(toRelayStatusView));
    }

    // Dashboard "Create channel": the smee.io/new redirect is followed server-side (browser CORS blocks it).
    // Mutating, so the central request guard above already applies.
    if (method === 'POST' && path === '/api/relay/new') {
      return sendJson(res, 200, { url: await createRelayChannel(ctx.relayFetch) });
    }

    // ── Jobs ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/jobs') {
      return sendJson(res, 200, redactPublic(ctx.store.listJobs()));
    }

    // Form metadata for the dashboard editor; registered before /api/jobs/:id so it is not read as a job ref.
    if (method === 'GET' && path === '/api/jobs/editor-meta') {
      return sendJson(res, 200, buildEditorMeta());
    }

    if (method === 'POST' && path === '/api/jobs') {
      const body = await readBody(req);
      const prepare = flagParam(url, 'prepare');
      let jobData: Job;
      if (prepare) {
        // Prepare mode: body is a JobCreateInput; same normalize + trust pipeline as the client.
        const action = (body as { action?: { cwd?: unknown } }).action;
        if (typeof action?.cwd !== 'string' || action.cwd.length === 0) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'action.cwd is required', { cwd: 'action.cwd is required' });
        }
        jobData = prepareCreate(body as unknown as JobCreateInput, {
          env: process.env,
          trustFolder: flagParam(url, 'trustFolder'),
          resolveJob: (idOrAlias) => ctx.store.getJob(idOrAlias),
        });
      } else {
        const parsed = JobSchema.safeParse(body);
        if (!parsed.success) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
        }
        jobData = parsed.data;
      }
      let job = applyConfigDefaults(jobData);
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
      if (!checkAfterGraph(res, ctx.store, job)) return;
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
      ctx.syncRelays?.();
      // L2: seed the missed-fire watermark so a restart computes forward from
      // "job just created/updated", not from some earlier (or absent) state.
      ctx.store.recordTick(stored.id);
      return sendJson(res, 201, redactKeepingWebhook(stored));
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
      ctx.syncRelays?.();
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
        return sendJson(res, 200, redactKeepingWebhook(job));
      }

      if (method === 'PUT' && sub === '') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const body = await readBody(req);
        // A list payload round-tripped through an editor carries the display form; keep the stored values.
        if (body && typeof body === 'object' && (body as { schedule?: unknown }).schedule !== undefined) {
          (body as { schedule: unknown }).schedule = restoreRedactedWebhook((body as { schedule: unknown }).schedule, job.schedule);
        }
        let updatedJob: Job;
        if (flagParam(url, 'prepare')) {
          // Prepare mode: body is a JobPatchInput; field-wise merge + cwd-session rule + trust on key change.
          updatedJob = applyConfigDefaults(prepareUpdate(job, body as unknown as JobPatchInput, {
            env: process.env,
            trustFolder: flagParam(url, 'trustFolder'),
            resolveJob: (idOrAlias) => ctx.store.getJob(idOrAlias),
          }));
        } else {
          const merged: Record<string, unknown> = { ...job, ...body, id: job.id };
          // `description: null` removes the stored description (null-clears, see JobPatchInputSchema).
          if ((body as { description?: unknown }).description === null) delete merged['description'];
          const parsed = JobSchema.safeParse(merged);
          if (!parsed.success) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid job', parsed.error.format());
          }
          updatedJob = applyConfigDefaults(parsed.data);
        }
        // Renaming the alias must not collide with any OTHER live job's id/alias.
        if (updatedJob.alias && updatedJob.alias !== job.alias) {
          const collision = ctx.store.getJob(updatedJob.alias);
          if (collision && collision.id !== job.id) {
            return sendDuplicateCreateError(res, updatedJob.alias);
          }
        }
        if (!validateJobSchedule(res, ctx.scheduler, updatedJob.schedule)) return;
        if (!checkAfterGraph(res, ctx.store, updatedJob)) return;
        readEnvFileForAction(updatedJob.action);
        // Everything above validated the update; only now may in-flight runs be stopped / waited for.
        const inFlightParam = url.searchParams.get('inFlight');
        if (inFlightParam !== null && !(IN_FLIGHT_CHOICES as readonly string[]).includes(inFlightParam)) {
          return sendError(res, 400, 'VALIDATION_ERROR', `inFlight must be one of: ${IN_FLIGHT_CHOICES.join(', ')}`);
        }
        try {
          const { result } = await applyJobUpdateWithPolicy(
            { runner: ctx.runner, scheduler: ctx.scheduler },
            {
              jobId: job.id,
              ...(inFlightParam !== null ? { inFlight: inFlightParam as InFlightChoice } : {}),
              apply: () => {
                ctx.store.upsertJob(updatedJob);
                if (updatedJob.enabled && !job.enabled) ctx.store.resetConsecutiveFailures(job.id);
                const stored = ctx.store.getJob(job.id) ?? updatedJob;
                ctx.scheduler.schedule(stored);
                ctx.syncRelays?.();
                // L2: same watermark seed as job creation — an update can re-enable a
                // job or change its schedule, both of which should compute missed
                // fires forward from now, not from a stale pre-update state.
                ctx.store.recordTick(stored.id);
                return stored;
              },
            },
          );
          return sendJson(res, 200, redactPublic(result));
        } catch (err) {
          if (err instanceof CrontickError && err.code === 'RUNS_IN_FLIGHT') {
            return sendError(res, 409, err.code, err.message, err.details);
          }
          throw err;
        }
      }

      if (method === 'DELETE' && sub === '') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        // Jobs triggered `after` this one: refuse unless force (then disable them; their ref stays, inert).
        const dependents = ctx.store.listDependents(job.id).filter((d) => d.id !== job.id);
        if (dependents.length > 0) {
          if (!forceParam(url)) {
            const names = dependents.map((d) => d.alias ?? d.id);
            return sendError(
              res,
              409,
              'JOB_HAS_DEPENDENTS',
              `Job ${job.alias ?? job.id} has dependent job(s) triggered after it: ${names.join(', ')}. Re-run with --force to delete it and disable them.`,
              { dependents: names },
            );
          }
          for (const dep of dependents) {
            if (!dep.enabled) continue;
            ctx.store.upsertJob({ ...dep, enabled: false });
            ctx.scheduler.unschedule(dep.id);
          }
        }
        // Stop everything that could still touch the job first: the schedule,
        // then any in-flight run (unlike a daemon stop, where a detached child
        // surviving is deliberate, L8, deleting a job removes the definition
        // entirely, so nothing is left for a run to belong to). Visible via
        // `canceledRun` instead of silently orphaning it. Only then delete the
        // job together with its runs/logs/schedule state.
        ctx.scheduler.unschedule(job.id);
        const canceledRun = ctx.runner.cancelJob(job.id);
        const deleted = ctx.store.deleteJobAndRuns(job.id);
        if (!deleted) return sendJobNotFoundError(res, requestedId);
        ctx.syncRelays?.();
        return sendJson(res, 200, { ok: true, canceledRun, deletedRuns: deleted.deletedRuns });
      }

      if (method === 'POST' && sub === '/enable') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const updated = { ...job, enabled: true };
        if (!checkAfterGraph(res, ctx.store, updated)) return;
        ctx.store.upsertJob(updated);
        ctx.store.resetConsecutiveFailures(job.id);
        ctx.scheduler.schedule(updated);
        ctx.syncRelays?.();
        // L2: re-enabling starts a fresh watermark, same reasoning as create/update.
        ctx.store.recordTick(job.id);
        return sendJson(res, 200, redactPublic(updated));
      }

      if (method === 'POST' && sub === '/disable') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        const updated = { ...job, enabled: false };
        ctx.store.upsertJob(updated);
        ctx.scheduler.unschedule(job.id);
        ctx.syncRelays?.();
        return sendJson(res, 200, redactPublic(updated));
      }

      // Local webhook fire: same TriggerDispatcher path as relay events, minus the relay-only
      // HMAC/dedupe/burst guards (the local caller is the owner). Covered by the central request guard.
      if (method === 'POST' && sub === '/trigger') {
        if (!job) return sendJobNotFoundError(res, requestedId);
        if (job.schedule.kind !== 'webhook') {
          return sendError(res, 400, 'NOT_WEBHOOK_JOB', `Job ${requestedId} is not a webhook job; use run-now to run it once`);
        }
        if (!job.enabled) return sendError(res, 409, 'JOB_DISABLED', `Job ${requestedId} is disabled`);
        const body = await readBody(req, { strict: true });
        const context = buildWebhookContext({
          payload: buildWebhookPayload({ body: body['payload'], receivedAt: new Date().toISOString() }),
          source: 'local',
        });
        const dispatcher = new TriggerDispatcher({
          store: ctx.store, runner: ctx.runner, logger: logger,
          isPaused: (id) => ctx.scheduler.isPaused() || ctx.scheduler.isJobPaused(id),
        });
        const result = dispatcher.dispatch(job.id, {
          kind: 'webhook', env: context.env, promptSuffix: context.promptSuffix, meta: { ...context.meta },
        });
        if ('runId' in result) return sendJson(res, 202, { runId: result.runId });
        const refusal: Record<TriggerSkipReason, [number, string]> = {
          'not-found': [404, 'JOB_NOT_FOUND'],
          'disabled': [409, 'JOB_DISABLED'],
          'kind-mismatch': [400, 'NOT_WEBHOOK_JOB'],
          'broken': [409, 'JOB_BROKEN'],
          'paused': [409, 'JOB_PAUSED'],
        };
        const [status, code] = refusal[result.skipped];
        return sendError(res, status, code, `Job ${requestedId} was not triggered (${result.skipped})`);
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
      return sendJson(res, 200, redactPublic(ctx.store.listRuns({ jobIds, limit, since, statuses, q })));
    }


    // Delete runs by id list (?runId=a,b) XOR by job (?jobId=<id|alias|raw id>);
    // ?dryRun=1 reports the same result without deleting. Active runs are
    // skipped and reported, never canceled.
    if (method === 'DELETE' && path === '/api/runs') {
      const runIds = (url.searchParams.get('runId') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const jobId = (url.searchParams.get('jobId') ?? '').trim();
      if ((runIds.length > 0) === (jobId !== '')) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Provide exactly one of runId (comma-separated list) or jobId');
      }
      const dryRun = ['1', 'true'].includes((url.searchParams.get('dryRun') ?? '').toLowerCase());
      return sendJson(res, 200, ctx.store.deleteRuns(jobId ? { jobId, dryRun } : { runIds, dryRun }));
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
        const logFile = resolveJobLogPath(run.jobId);
        const trigger = ctx.store.getRunTrigger(run.id);
        return sendJson(res, 200, redactPublic({
          ...run,
          ...(trigger ? { trigger: redactTriggerMeta(trigger) } : {}),
          logFile,
          ...(logFile !== null ? { logFileExists: existsSync(logFile) } : {}),
          ...(run.transcriptPath ? { transcriptExists: existsSync(run.transcriptPath) } : {}),
        }));
      }

      if (method === 'POST' && sub === '/cancel') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        const canceled = ctx.runner.cancelRun(id);
        return sendJson(res, 200, { ok: true, canceled });
      }

      // Cleaned, human-readable view of the run's engine output (final answer, error, stderr) -- see src/run-output.ts. crontick does not store the engine's
      // raw logs; `logFile` is the per-job file of crontick-side events.
      if (method === 'GET' && sub === '/output') {
        const run = ctx.store.getRun(id);
        if (!run) return sendError(res, 404, 'NOT_FOUND', `Run ${id} not found`);
        return sendJson(res, 200, redactPublic({ ...buildRunOutput(run, ctx.store.getRunOutput(run.id)), logFile: resolveJobLogPath(run.jobId) }));
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
      if (result.ok && parsed.data.kind === 'after') {
        // Probe job: with ?jobId= it stands in for that job (cycle check); otherwise a fresh id.
        const subject = url.searchParams.get('jobId') ? ctx.store.getJob(url.searchParams.get('jobId')!) : undefined;
        const probe = { ...(subject ?? ({ id: randomUUID() } as Job)), schedule: parsed.data } as Job;
        const graph = validateAfterGraph(probe, ctx.store.listJobs());
        if (graph) return sendJson(res, 200, { ok: false, error: `${graph.code}: ${graph.message}` });
      }
      return sendJson(res, 200, result);
    }

    if (method === 'POST' && path === '/api/schedules/preview') {
      const body = await readBody(req);
      const { ScheduleSchema } = await import('../schemas/job.js');
      const scheduleResult = ScheduleSchema.safeParse(body?.schedule ?? body);
      if (!scheduleResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid schedule');
      }
      if (scheduleResult.data.kind === 'after') {
        return sendJson(res, 200, { next: [], fires: [], trigger: scheduleResult.data });
      }
      const n = typeof body?.n === 'number' ? body.n : 5;
      const next = ctx.scheduler.previewNext(scheduleResult.data, { n });
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
      const requestedId = decodeURIComponent(statsJobMatch[1]);
      const job = ctx.store.getJob(requestedId);
      if (!job) return sendJobNotFoundError(res, requestedId);
      const runs = ctx.store.listRuns({ jobId: job.id });
      return sendJson(res, 200, {
        jobId: job.id,
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
        dashboardUrl: `http://127.0.0.1:${ctx.port}/dashboard`,
        portNote: describeDaemonPort(ctx.port, currentConfigOrEmpty()),
        uptimeSec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
        jobs: ctx.store.listJobs().length,
        paused: ctx.scheduler.isPaused(),
        lostPendingConfigApply: ctx.lostPendingConfigApply ?? null,
        // L2: report-only missed-fire summary computed once at startup.
        missedFires: ctx.missedFireSummary ?? {
          jobsWithMissedFires: 0,
          missedRunsRecorded: 0,
          jobsCapped: 0,
          capPerJob: 0,
          catchUpRuns: 0,
        },
      });
    }

    if (method === 'POST' && path === '/api/daemon/pause') {
      ctx.scheduler.pause();
      return sendJson(res, 200, { ok: true, paused: true });
    }

    if (method === 'POST' && path === '/api/daemon/resume') {
      ctx.scheduler.resume();
      return sendJson(res, 200, { ok: true, paused: false });
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
      // Share format, schema 1: jobs only (no run history), ids omitted so every
      // import mints new ones. `?jobs=a,b` limits the export to those ids or
      // aliases, resolved here; any unknown one fails the whole export.
      const requested = url.searchParams.getAll('jobs').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
      let selected = ctx.store.listJobs();
      if (requested.length > 0) {
        const missing = requested.filter((idOrAlias) => !ctx.store.getJob(idOrAlias));
        if (missing.length > 0) {
          return sendError(res, 404, 'JOB_NOT_FOUND', `Job(s) not found (id or alias): ${missing.join(', ')}`, { missing });
        }
        const seen = new Set<string>();
        selected = [];
        for (const idOrAlias of requested) {
          const found = ctx.store.getJob(idOrAlias)!;
          if (!seen.has(found.id)) {
            seen.add(found.id);
            selected.push(found);
          }
        }
      }
      // Webhook relay (bearer URL) and secret are stripped unless the caller opts in with includeSecrets=1.
      const includeSecrets = flagParam(url, 'includeSecrets');
      const rows = stripExportIds(includeSecrets ? selected : stripWebhookSecrets(selected));
      // With includeSecrets the webhook schedule keeps its full values; everything else still goes through redaction.
      const jobs = includeSecrets
        ? rows.map((row) => ({ ...(redactValue(row) as object), schedule: row.schedule }))
        : rows;
      return sendJson(res, 200, includeSecrets
        ? { schema: 1, exportedAt: new Date().toISOString(), crontickVersion: VERSION, jobs }
        : redactPublic({ schema: 1, exportedAt: new Date().toISOString(), crontickVersion: VERSION, jobs }));
    }

    if (method === 'POST' && path === '/api/import') {
      // The client validated the whole file first; every row here is a job that
      // already went through normalization with a fresh GUID. Imports never
      // overwrite: an alias held by a live job (or by an earlier row of the same
      // file) gets the next free `-2`, `-3`, ... suffix and the row reports
      // `renamedFrom`.
      const body = await readBody(req);
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      const results: Array<{ id: string; alias?: string; ok: boolean; renamedFrom?: string; error?: string }> = [];
      const usedAliases = new Set<string>();
      // Schema-valid batch jobs, so an after-job sees upstreams that appear later in the same file.
      const batchJobs: Job[] = jobs.flatMap((raw: unknown) => {
        const p = JobSchema.safeParse(raw);
        return p.success ? [p.data] : [];
      });
      for (const raw of jobs) {
        const parsed = JobSchema.safeParse(raw);
        if (!parsed.success) {
          results.push({ id: String((raw as { id?: unknown })?.id ?? '?'), ok: false, error: 'validation failed' });
          continue;
        }
        let job = applyConfigDefaults(parsed.data);
        // Never reuse an id that is live (ids are fresh GUIDs, so this is defensive).
        if (ctx.store.getJob(job.id)) job = { ...job, id: randomUUID() };
        const taken = (candidate: string): boolean => usedAliases.has(candidate) || ctx.store.getJob(candidate) !== undefined;
        let renamedFrom: string | undefined;
        let alias = job.alias;
        if (alias === undefined) {
          alias = generateAlias(taken);
        } else if (taken(alias)) {
          renamedFrom = alias;
          let n = 2;
          while (taken(`${alias}-${n}`)) n++;
          alias = `${alias}-${n}`;
        }
        job = { ...job, alias };
        try {
          const schedule = ctx.scheduler.validateSchedule(job.schedule);
          if (!schedule.ok) throw new CrontickError('VALIDATION_ERROR', `Invalid schedule: ${schedule.error ?? 'unknown'}`);
          job = ctx.store.prepareImportedJob(job);
          // Graph check on the merged store + batch graph (batch jobs not yet applied count as upstreams).
          const graph = validateAfterGraph(job, [...ctx.store.listJobs(), ...batchJobs.filter((b) => b.id !== job.id)]);
          let importError: string | undefined;
          if (graph?.code === 'AFTER_CYCLE') throw new CrontickError(graph.code, `${graph.code}: ${graph.message}`);
          if (graph) {
            // Dangling upstream: import disabled with the error recorded; the rest of the batch proceeds.
            job = { ...job, enabled: false };
            importError = `${graph.code}: ${graph.message}`;
          }
          ctx.store.upsertJob(job);
          if (job.enabled) ctx.scheduler.schedule(job);
          ctx.store.recordTick(job.id);
          usedAliases.add(alias);
          results.push({ id: job.id, alias, ok: true, ...(renamedFrom ? { renamedFrom } : {}), ...(importError ? { error: importError, disabled: true } : {}) });
        } catch (err) {
          results.push({ id: job.id, alias, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      ctx.syncRelays?.();
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
      const { jobIds, statuses, q } = runFilterParams(url, ctx);
      return sendJson(res, 200, buildDashboardData({ ...ctx, pid: process.pid }, { runsLimit, jobIds, statuses, q }));
    }

    if (method === 'GET' && (path === '/' || path === '/dashboard' || path.startsWith('/dashboard/'))) {
      return serveDashboard(res, path);
    }

    // ── Config ────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        path: configFilePath(),
        revision: getConfigRevision(),
        config: redactConfigForRead(loadConfig()),
        stored: redactStoredConfigForRead(readStoredConfigFile()),
        readOnly: ['daemon'],
        notice: CONFIG_EDIT_NOTICE,
      });
    }

    if (method === 'PATCH' && path === '/api/config') {
      const body = await readBody(req);
      const request = parseConfigPatchBody(body);
      if ('error' in request) return sendError(res, 400, 'VALIDATION_ERROR', request.error);
      try {
        const result = await applyConfigWithPolicy(
          { runner: ctx.runner, scheduler: ctx.scheduler, reload: ctx.reload, dataDir: dataDir() },
          request,
        );
        return sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof CrontickError && (err.code === 'CONFIG_CONFLICT' || err.code === 'RUNS_IN_FLIGHT')) {
          return sendError(res, 409, err.code, err.message, err.details);
        }
        throw err;
      }
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
 * (comma-separated for several) and `q` (free-text search incl. run output).
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

/** Daemon-side graph guard (R4): dangling upstream or cycle -> 400 with AFTER_* code. */
function checkAfterGraph(res: http.ServerResponse, store: Store, job: Job): boolean {
  const err = validateAfterGraph(job, store.listJobs());
  if (!err) return true;
  sendError(res, 400, err.code, err.message);
  return false;
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

function parseConfigPatchBody(
  body: Record<string, unknown>,
): { ops: ConfigOp[]; ifRevision?: string; inFlight?: InFlightChoice } | { error: string } {
  const { ops, ifRevision, inFlight } = body;
  if (!Array.isArray(ops) || ops.length === 0) return { error: 'ops must be a non-empty array of { op: "set"|"unset", key, value? }' };
  const parsed: ConfigOp[] = [];
  for (const raw of ops) {
    const o = raw as { op?: unknown; key?: unknown; value?: unknown } | null;
    if (typeof o !== 'object' || o === null || typeof o.key !== 'string' || o.key === '') return { error: 'each op needs a non-empty string key' };
    if (o.op === 'set') {
      if (!('value' in o)) return { error: `set op for ${o.key} needs a value` };
      parsed.push({ op: 'set', key: o.key, value: o.value });
    } else if (o.op === 'unset') {
      parsed.push({ op: 'unset', key: o.key });
    } else {
      return { error: 'op must be "set" or "unset"' };
    }
  }
  if (ifRevision !== undefined && typeof ifRevision !== 'string') return { error: 'ifRevision must be a string' };
  if (inFlight !== undefined && !(IN_FLIGHT_CHOICES as readonly unknown[]).includes(inFlight)) {
    return { error: `inFlight must be one of: ${IN_FLIGHT_CHOICES.join(', ')}` };
  }
  return {
    ops: parsed,
    ...(ifRevision !== undefined ? { ifRevision } : {}),
    ...(inFlight !== undefined ? { inFlight: inFlight as InFlightChoice } : {}),
  };
}

async function readBody(req: http.IncomingMessage, opts: { strict?: boolean } = {}): Promise<Record<string, unknown>> {
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
        if (opts.strict) reject(new CrontickError('INVALID_PAYLOAD', 'Request body must be valid JSON'));
        else resolve({});
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

/** Config as it is now on disk (so a post-start edit shows as a mismatch); empty when unreadable. */
function currentConfigOrEmpty(): Pick<CrontickConfig, 'daemon'> {
  return loadDaemonConfigOrEmpty();
}
