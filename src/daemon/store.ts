// Dual-persistence layer: JSON files (source of truth for jobs) + SQLite WAL (runs, run outputs, job cache).
// Only the daemon opens this store (single-writer invariant).
// See docs/implementation/storage.md
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job, type PromptAction } from '../schemas/job.js';
import { CrontickError, ORPHAN_RUN_ERROR_MESSAGE } from '../errors.js';
import { jobJsonSchemaText } from '../schema-json.js';
import { nullLogger, type Logger } from '../logger.js';
import type { EngineOutput } from '../run-output.js';
import { readClaudeCompletionMarker, readClaudeHookTranscriptPath } from '../claude-completion-marker.js';
import { loadConfig } from '../config.js';
import { resolveJobRef } from '../utils/job-ref.js';
import { resolveJobLogPath } from './job-log-file.js';
import { getEngineAdapter } from '../engines/registry.js';
import { DEFAULT_RUN_RETENTION_CAP } from '../constants/retention.js';

// ── Types ─────────────────────────────────────────────────────────────────────

// 'missed' is a terminal status recorded by recordMissedRun() for a scheduled
// fire the daemon was down for. It is never a success or a failure — it is
// its own outcome — but it IS terminal for retention purposes (see
// pruneRunsForJob(), which excludes only 'running'/'queued').
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'timeout' | 'missed';

export interface Run {
  id: string;
  jobId: string;
  startedAt: number; // epoch ms
  endedAt?: number;
  status: RunStatus;
  exitCode?: number;
  error?: string;
  durationMs?: number;
  pid?: number; // OS pid of the spawned child, set once known (see updateRun); absent for 'queued'/'missed' runs.
  outputTruncated: boolean; // true once a run's captured output hit the byte cap (NOT NULL DEFAULT 0 column, always present).
  sessionId?: string; // prompt-engine session id captured from output (or explicitly provided) for this run; absent for non-prompt runs.
  command?: string; // redacted resolved command line (binary + args) actually spawned for this run; absent for 'queued'/'missed' runs.
  costUsd?: number;
  turns?: number;
  usageJson?: string; // redacted raw engine usage block
  transcriptPath?: string;
  engineStatus?: string;
}

export interface ListRunsOptions {
  jobId?: string;
  limit?: number;
  since?: number; // epoch ms
  status?: RunStatus;
  /** Restrict to any of these job ids (combined with `jobId` if both are given). */
  jobIds?: string[];
  /** Restrict to any of these statuses (combined with `status` if both are given). */
  statuses?: RunStatus[];
  /**
   * Case-insensitive substring search over run id, status, error, session id, the job
   * id/alias, and the stored run logs (all streams). Bound as a LIKE parameter (never
   * interpolated); `%`, `_` and `\` in the text are matched literally.
   */
  q?: string;
}

/** Per-job watermark: the last time this job's schedule was known to be observed by a running daemon. */
export interface ScheduleState {
  jobId: string;
  lastTickAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/**
 * Injected by the daemon so reconcileOrphanRuns() can tell a still-alive
 * process apart from a dead one whose pid has since been reused by an
 * unrelated process. Implementations live outside store.ts (a process-liveness
 * helper) — see reconcileOrphanRuns()'s doc comment for exactly what this
 * needs to provide.
 */
export interface OrphanLivenessCheck {
  isRunAlive(pid: number, startedAt: number): boolean | undefined;
}

export interface OrphanReconciliationResult {
  /** Number of runs canceled (dead, reused-pid, or no checker available to tell). */
  canceled: number;
  /** Runs left as 'running' because they were confirmed (or inconclusively assumed) still alive. */
  adopted: Array<{ runId: string; jobId: string; pid: number }>;
  /** Runs finalized here from a Claude completion marker (success/failed); callers must route these through the failure recorder (`Runner.recordRunOutcome()`). */
  finalized: Array<{ runId: string; jobId: string; status: 'success' | 'failed'; error?: string }>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Sentinel value written to a recordMissedRun() row's `error` column,
 * following the `CODE: message` convention already used for
 * ORPHAN_RUN_ERROR_MESSAGE (src/errors.ts) and other runs.error values.
 */
export const MISSED_RUN_ERROR_MESSAGE = 'MISSED: daemon was not running at the scheduled fire time';

/** `error` written to a skipped run recorded because the daemon was paused when the fire came due. */
export const PAUSED_SKIP_ERROR_MESSAGE = 'SKIPPED: daemon was paused at the scheduled fire time';

/** Result of Store.deleteRuns / `DELETE /api/runs` (also returned by dry runs). */
export interface DeleteRunsResult {
  deleted: string[];
  skipped: Array<{ id: string; status: RunStatus }>;
  notFound: string[];
  jobLogRemoved: boolean;
}

export class Store {
  private db!: DatabaseSync;
  private dbPath: string;
  private jobsPath: string;
  private logger: Logger;
  private runRetentionCap: number;
  /** After-jobs with a dangling or cyclic upstream, recomputed on every loadJobsFromDisk(); inert until repaired. */
  private brokenJobs = new Map<string, AfterGraphError>();

  constructor(
    dbPath?: string,
    jobsPath?: string,
    logger: Logger = nullLogger,
    runRetentionCap: number = DEFAULT_RUN_RETENTION_CAP,
  ) {
    this.dbPath = dbPath ?? runsDbPath();
    this.jobsPath = jobsPath ?? jobsDir();
    this.logger = logger.child('store');
    this.runRetentionCap = runRetentionCap;
  }

  /**
   * Update the retention cap applied to future pruneRunsForJob() calls (both
   * the per-insert path and any subsequent pruneAllJobsRunHistory() backfill).
   * Lets `crontick daemon reload` pick up a changed `retention.maxRunsPerJob`
   * config value without requiring a full daemon restart.
   */
  setRunRetentionCap(cap: number): void {
    this.runRetentionCap = cap;
  }

  /** Open the SQLite database, enable WAL + foreign keys, and create the schema. */
  open(): void {
    this.logger.debug('Opening store', { dbPath: this.dbPath, jobsPath: this.jobsPath });
    this.db = new DatabaseSync(this.dbPath);
    // WAL enables concurrent reads from HTTP handlers without blocking writes.
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.createSchema();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }

  /**
   * Creates every table/index a fresh database needs, in one idempotent pass.
   * `CREATE TABLE/INDEX IF NOT EXISTS` throughout, so calling this again on an
   * already-initialized database (e.g. a second open()) is a no-op. crontick has
   * a single fixed schema (no migrations): every column is declared directly
   * in its `CREATE TABLE`, and the alias-uniqueness index is created
   * alongside the tables.
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        alias TEXT,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error TEXT,
        duration_ms INTEGER,
        pid INTEGER,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        claude_result_completed INTEGER NOT NULL DEFAULT 0,
        command TEXT,
        cost_usd REAL,
        turns INTEGER,
        usage_json TEXT,
        transcript_path TEXT,
        engine_status TEXT,
        trigger_json TEXT
      );

      -- Parsed engine output (final answer, error, full stderr) for a run. The engine's raw stdout/stderr is never stored: the runner keeps
      -- its own transcript, and crontick-side events go to a log file.
      CREATE TABLE IF NOT EXISTS run_outputs (
        run_id TEXT PRIMARY KEY,
        format TEXT NOT NULL,
        result TEXT,
        engine_error TEXT,
        stderr TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_schedule_state (
        job_id TEXT PRIMARY KEY,
        last_tick_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Consecutive failed runs per job (auto-disable after maxConsecutiveFailures). Absent row = 0.
      CREATE TABLE IF NOT EXISTS job_failure_state (
        job_id TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL
      );

      -- idx_runs_job_id (a single-column index) is deliberately never created:
      -- idx_runs_job_id_started_at is a strict left-prefix superset of it, so
      -- every query it would have served is served at least as well by this
      -- one. Retention eviction needs an index-ordered (job_id, started_at)
      -- walk to avoid a scan-then-sort per pruneRunsForJob() call.
      CREATE INDEX IF NOT EXISTS idx_runs_job_id_started_at ON runs(job_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

      -- Alias uniqueness enforced at the DB layer as a defense-in-depth
      -- backstop against a race between two concurrent create/update requests
      -- (app-level checks in api.ts via generateAlias/getJob are the primary
      -- enforcement). Partial index so multiple NULL aliases stay allowed.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_alias ON jobs(alias) WHERE alias IS NOT NULL;
    `);
  }

  /** Write job to both SQLite cache and JSON file on disk (JSON is source of truth). */
  upsertJob(job: Job): void {
    const persisted = normalizeJobForPersistence(job);
    const json = JSON.stringify(persisted);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO jobs (id, alias, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, json=excluded.json, updated_at=excluded.updated_at',
      )
      .run(persisted.id, persisted.alias ?? null, json, now);
    const filePath = join(this.jobsPath, `${persisted.id}.json`);
    const schemaPath = join(this.jobsPath, `${persisted.id}.schema.json`);
    writeJobFileHardened(filePath, json);
    writeJobFileHardened(schemaPath, jobJsonSchemaText());
    this.logger.debug('Persisted job files', { jobId: persisted.id, alias: persisted.alias, filePath, schemaPath });
  }

  /**
   * Imported sessions lack trustworthy job-to-transcript provenance.
   *
   * This resets `sessionId` only for engines whose resume is transcript-backed
   * (today: Claude) -- routed through the adapter registry, per design
   * principle #1, rather than a literal `engine.type === 'claude'` branch.
   * `resumeTranscriptPath(...) !== undefined` is the same signal runner.ts's
   * own resume preflight uses to decide whether provenance-gating applies at
   * all (an adapter without transcript-backed resume, like RawAdapter,
   * returns undefined and its sessionId is left untouched).
   */
  prepareImportedJob(job: Job): Job {
    if (job.action.kind !== 'prompt' || !job.action.sessionId) return job;
    const config = loadConfig({ path: join(dirname(this.dbPath), 'config.json') });
    const engine = config.engines[job.action.engine ?? config.defaultEngine];
    const requiresResumeProvenance = engine !== undefined
      && getEngineAdapter(engine.type).resumeTranscriptPath(job.action.cwd ?? process.cwd(), job.action.sessionId) !== undefined;
    if (!requiresResumeProvenance || this.hasCompletedClaudeSession(job.id, job.action.sessionId)) return job;
    const action = { ...job.action };
    delete action.sessionId;
    return {
      ...job,
      action: {
        ...action,
        reuseSession: (job.overlap ?? 'skip') === 'skip',
      },
    };
  }

  /**
   * Persist a captured session ID back into the job definition.
   * Guards against races: only writes if the job still matches the expected action state.
   */
  tryCapturePromptSession(jobId: string, expectedAction: PromptAction, sessionId: string): boolean {
    const current = this.getJob(jobId);
    if (!current || current.action.kind !== 'prompt') return false;
    if (!isSamePromptCaptureTarget(current.action, expectedAction)) return false;
    if (!current.action.reuseSession || current.action.sessionId) return false;

    this.upsertJob({
      ...current,
      action: {
        ...current.action,
        sessionId,
        reuseSession: false,
      },
    });
    this.logger.debug('Captured prompt session id', { jobId });
    return true;
  }

  /**
   * Resolves a user-supplied job identifier to the stored job, accepting
   * EITHER the immutable GUID `id` or the human-friendly `alias`. `id` is
   * tried first (an exact primary-key match), falling back to an alias
   * lookup -- this is the single resolution point every job lookup in
   * api.ts funnels through, so "job id or alias" works uniformly everywhere
   * a job identifier is accepted.
   */
  getJob(idOrAlias: string): Job | undefined {
    const job = resolveJobRef(idOrAlias, {
      byId: (ref) => this.getJobRowById(ref),
      byAlias: (ref) => this.getJobRowByAlias(ref),
    });
    if (job) this.logger.debug('Read job from store', { ref: idOrAlias, jobId: job.id });
    return job;
  }

  private getJobRowById(id: string): Job | undefined {
    const row = this.db.prepare('SELECT json FROM jobs WHERE id = ?').get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Job) : undefined;
  }

  private getJobRowByAlias(alias: string): Job | undefined {
    const row = this.db.prepare('SELECT json FROM jobs WHERE alias = ?').get(alias) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Job) : undefined;
  }

  listJobs(): Job[] {
    const rows = this.db.prepare('SELECT json FROM jobs ORDER BY id').all() as Array<{
      json: string;
    }>;
    this.logger.debug('Listed jobs', { count: rows.length });
    return rows.map((r) => JSON.parse(r.json) as Job);
  }

  /** Enabled-or-not jobs whose `after` schedule points at `upstreamId` (full scan; N is small). */
  listDependents(upstreamId: string): Job[] {
    return this.listJobs().filter((j) => j.schedule.kind === 'after' && j.schedule.jobId === upstreamId);
  }

  /** After-jobs flagged broken (dangling/cyclic upstream) by the last loadJobsFromDisk(), keyed by job id. */
  getBrokenJobs(): ReadonlyMap<string, AfterGraphError> {
    return this.brokenJobs;
  }

  isJobBroken(id: string): boolean {
    return this.brokenJobs.has(id);
  }

  /** Persists what triggered a non-time run (SP05 stores `{kind, upstream}`; rendering is SP06). */
  setRunTrigger(runId: string, trigger: Record<string, unknown>): void {
    this.db.prepare('UPDATE runs SET trigger_json = ? WHERE id = ?').run(JSON.stringify(trigger), runId);
  }

  getRunTrigger(runId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT trigger_json FROM runs WHERE id = ?').get(runId) as
      | { trigger_json: string | null }
      | undefined;
    return row?.trigger_json ? (JSON.parse(row.trigger_json) as Record<string, unknown>) : undefined;
  }

  /** Accepts either the GUID `id` or the `alias` (see getJob) and deletes the resolved job together with its runs, run outputs and schedule state. */
  deleteJob(idOrAlias: string): boolean {
    return this.deleteJobAndRuns(idOrAlias) !== undefined;
  }

  /**
   * Deletes a job and everything that belongs to it in ONE transaction: its
   * run outputs, runs, schedule state, then the job row. Deleting a job removes
   * its history on every surface (nothing is archived). After the commit the
   * job JSON files and the per-job log file are unlinked best-effort (the
   * SQLite rows are the transactional source of truth; files are mirrors).
   * Claude's own transcripts are never touched. Returns undefined when the job
   * does not exist, else the number of runs removed.
   */
  deleteJobAndRuns(idOrAlias: string): { jobId: string; deletedRuns: number } | undefined {
    const job = this.getJob(idOrAlias);
    if (!job) return undefined;
    let deletedRuns = 0;
    let deleted = 0;
    this.db.exec('BEGIN;');
    try {
      this.db.prepare('DELETE FROM run_outputs WHERE run_id IN (SELECT id FROM runs WHERE job_id = ?)').run(job.id);
      deletedRuns = (this.db.prepare('DELETE FROM runs WHERE job_id = ?').run(job.id) as { changes: number }).changes;
      this.db.prepare('DELETE FROM job_schedule_state WHERE job_id = ?').run(job.id);
      this.db.prepare('DELETE FROM job_failure_state WHERE job_id = ?').run(job.id);
      deleted = (this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id) as { changes: number }).changes;
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    this.removeJobFiles(job.id);
    this.removeJobLogFile(job.id);
    this.logger.debug('Deleted job', { jobId: job.id, alias: job.alias, deleted: deleted > 0, deletedRuns });
    return deleted > 0 ? { jobId: job.id, deletedRuns } : undefined;
  }

  /** Best-effort removal of a job's per-job log file (see resolveJobLogPath). Returns true when a file was removed. */
  private removeJobLogFile(jobId: string): boolean {
    try {
      const logPath = resolveJobLogPath(jobId);
      if (logPath && existsSync(logPath)) {
        unlinkSync(logPath);
        return true;
      }
    } catch {
      // best-effort
    }
    return false;
  }

  /**
   * Deletes runs (and their outputs) selected by explicit run ids XOR a job
   * ref (id or alias; falls back to the raw id so runs of an already-deleted
   * job can still be cleaned up). Queued/running runs are skipped and
   * reported, never deleted. Output rows then run rows go in ONE transaction.
   * When an affected job no longer exists and no runs remain for it, its
   * per-job log file is removed; a live job's log is never touched. With
   * `dryRun` the same result is computed but nothing is changed.
   */
  deleteRuns(opts: { runIds: string[]; jobId?: undefined; dryRun?: boolean } | { jobId: string; runIds?: undefined; dryRun?: boolean }): DeleteRunsResult {
    const dryRun = opts.dryRun === true;
    const deleted: string[] = [];
    const skipped: Array<{ id: string; status: RunStatus }> = [];
    const notFound: string[] = [];
    const rows: Array<{ id: string; job_id: string; status: string }> = [];
    if (opts.jobId !== undefined) {
      const targetJobId = this.getJob(opts.jobId)?.id ?? opts.jobId;
      rows.push(...(this.db.prepare('SELECT id, job_id, status FROM runs WHERE job_id = ? ORDER BY started_at, id').all(targetJobId) as typeof rows));
    } else {
      for (const id of opts.runIds) {
        const row = this.db.prepare('SELECT id, job_id, status FROM runs WHERE id = ?').get(id) as (typeof rows)[number] | undefined;
        if (row) rows.push(row);
        else notFound.push(id);
      }
    }
    const touchedJobs = new Set<string>();
    for (const row of rows) {
      if (row.status === 'queued' || row.status === 'running') {
        skipped.push({ id: row.id, status: row.status });
      } else {
        deleted.push(row.id);
        touchedJobs.add(row.job_id);
      }
    }
    if (!dryRun && deleted.length > 0) {
      this.db.exec('BEGIN;');
      try {
        const del = (table: string, col: string) => this.db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`);
        for (const id of deleted) {
          del('run_outputs', 'run_id').run(id);
          del('runs', 'id').run(id);
        }
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
    let jobLogRemoved = false;
    const deletedSet = new Set(deleted);
    for (const jobId of touchedJobs) {
      if (this.getJobRowById(jobId)) continue; // live job: log untouched
      const remaining = (this.db.prepare('SELECT id FROM runs WHERE job_id = ?').all(jobId) as Array<{ id: string }>)
        .filter((r) => !deletedSet.has(r.id));
      if (remaining.length > 0) continue;
      if (dryRun) {
        const logPath = resolveJobLogPath(jobId);
        if (logPath && existsSync(logPath)) jobLogRemoved = true;
      } else if (this.removeJobLogFile(jobId)) {
        jobLogRemoved = true;
      }
    }
    this.logger.debug('Deleted runs', { deleted: deleted.length, skipped: skipped.length, notFound: notFound.length, dryRun });
    return { deleted, skipped, notFound, jobLogRemoved };
  }

  /**
   * Atomically delete every job and all data associated with jobs: run history,
   * run outputs, and per-job schedule state, in a single transaction. Returns the
   * number of job rows removed. Like single-job delete, runs and their outputs are
   * removed too. Job JSON files and per-job log files are unlinked best-effort
   * after the DB commit (the SQLite rows are the transactional source of truth;
   * files are a mirror).
   */
  deleteAllJobs(): number {
    const jobs = this.listJobs();
    this.db.exec('BEGIN;');
    let deleted: number;
    try {
      this.db.exec('DELETE FROM run_outputs;');
      this.db.exec('DELETE FROM runs;');
      this.db.exec('DELETE FROM job_schedule_state;');
      this.db.exec('DELETE FROM job_failure_state;');
      deleted = (this.db.prepare('DELETE FROM jobs').run() as { changes: number }).changes;
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    for (const job of jobs) {
      this.removeJobFiles(job.id);
      this.removeJobLogFile(job.id);
    }
    this.logger.info('Deleted all jobs', { deleted });
    return deleted;
  }

  /** Best-effort removal of a job's persisted JSON + schema files (the DB row is the transactional source of truth). */
  private removeJobFiles(jobId: string): void {
    const filePath = join(this.jobsPath, `${jobId}.json`);
    const schemaPath = join(this.jobsPath, `${jobId}.schema.json`);
    for (const path of [filePath, schemaPath]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
      }
    }
  }


  /**
   * Load jobs from the jobs directory (JSON files are source of truth on
   * daemon start). Each file is loaded as-is: job files already carry a GUID
   * `id` and optional `alias`. A file that fails to parse or validate is
   * skipped with a warning (best-effort robustness), never rewritten.
   */
  loadJobsFromDisk(): void {
    if (!existsSync(this.jobsPath)) {
      this.logger.debug('Jobs directory missing during load', { jobsPath: this.jobsPath });
      return;
    }
    const files = readdirSync(this.jobsPath).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'));
    let loaded = 0;
    for (const file of files) {
      const filePath = join(this.jobsPath, file);
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
        const parsed = JobSchema.safeParse(raw);
        if (parsed.success) {
          const json = JSON.stringify(parsed.data);
          this.db
            .prepare(
              'INSERT INTO jobs (id, alias, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, json=excluded.json, updated_at=excluded.updated_at',
            )
            .run(parsed.data.id, parsed.data.alias ?? null, json, Date.now());
          loaded++;
        } else {
          // warn (not debug): a job silently vanishing from the schedule after a
          // crash mid-write or a hand edit must be visible without --verbose.
          const first = parsed.error.issues[0];
          const reason = first ? `${first.path.join('.') || '<root>'}: ${first.message}` : parsed.error.message;
          this.logger.warn('Skipped job file failing schema validation', { filePath, reason });
        }
      } catch (err) {
        this.logger.warn('Skipped unreadable or malformed job file', { filePath, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    this.flagBrokenAfterJobs();
    this.logger.debug('Loaded jobs from disk', { jobsPath: this.jobsPath, files: files.length, loaded });
  }

  /** Post-pass of loadJobsFromDisk: marks after-jobs with a dangling/cyclic upstream as broken (still loaded, never fired). */
  private flagBrokenAfterJobs(): void {
    this.brokenJobs = new Map();
    const jobs = this.listJobs();
    for (const job of jobs) {
      const err = validateAfterGraph(job, jobs);
      if (!err) continue;
      this.brokenJobs.set(job.id, err);
      this.logger.warn('Job is broken and will not fire', { jobId: job.id, code: err.code, reason: err.message });
    }
  }


  // ── Run CRUD ────────────────────────────────────────────────────────────────

  insertRun(jobId: string, startedAt?: number): Run {
    const id = randomUUID();
    const now = startedAt ?? Date.now();
    this.db
      .prepare(
        'INSERT INTO runs (id, job_id, started_at, status) VALUES (?, ?, ?, ?)',
      )
      .run(id, jobId, now, 'queued');
    this.logger.debug('Inserted run', { runId: id, jobId, startedAt: now });
    // Retention is best-effort maintenance, not part of the run-recording
    // contract: a prune failure (disk full, corrupted rows, etc.) must never
    // stop a run from being recorded/executed. Log loudly and degrade to
    // "run recorded, prune deferred" — the next insertRun (or the startup
    // backfill) gets another chance to catch up.
    try {
      this.pruneRunsForJob(jobId);
    } catch (err) {
      this.logger.error('Run retention prune failed; run was still recorded', { jobId, error: String(err) });
    }
    return { id, jobId, startedAt: now, status: 'queued', outputTruncated: false };
  }

  /**
   * Records a scheduled fire the daemon was not running to execute (see
   * job_schedule_state / recordTick()). Inserted directly as a terminal
   * 'missed' run — startedAt and endedAt both equal plannedAt, since nothing
   * ever actually ran — so it needs no separate updateRun() call to reach a
   * terminal state, and is an ordinary retention-eviction candidate like any
   * other terminal run.
   */
  recordMissedRun(jobId: string, plannedAt: number, note?: string): Run {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO runs (id, job_id, started_at, ended_at, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, jobId, plannedAt, plannedAt, 'missed', note ?? MISSED_RUN_ERROR_MESSAGE);
    this.logger.debug('Recorded missed run', { runId: id, jobId, plannedAt });
    try {
      this.pruneRunsForJob(jobId);
    } catch (err) {
      this.logger.error('Run retention prune failed; missed run was still recorded', { jobId, error: String(err) });
    }
    return { id, jobId, startedAt: plannedAt, endedAt: plannedAt, status: 'missed', error: note ?? MISSED_RUN_ERROR_MESSAGE, outputTruncated: false };
  }

  /** Records a fire that came due while the daemon was paused as a terminal 'skipped' run (startedAt = endedAt = plannedAt). */
  recordSkippedRun(jobId: string, plannedAt: number, note: string = PAUSED_SKIP_ERROR_MESSAGE): Run {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO runs (id, job_id, started_at, ended_at, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, jobId, plannedAt, plannedAt, 'skipped', note);
    this.logger.debug('Recorded skipped run', { runId: id, jobId, plannedAt });
    try {
      this.pruneRunsForJob(jobId);
    } catch (err) {
      this.logger.error('Run retention prune failed; skipped run was still recorded', { jobId, error: String(err) });
    }
    return { id, jobId, startedAt: plannedAt, endedAt: plannedAt, status: 'skipped', error: note, outputTruncated: false };
  }

  updateRun(
    id: string,
    update: Partial<Pick<Run, 'status' | 'exitCode' | 'error' | 'endedAt' | 'durationMs' | 'pid' | 'outputTruncated' | 'sessionId' | 'command' | 'costUsd' | 'turns' | 'usageJson' | 'transcriptPath' | 'engineStatus'>>,
  ): void {
    const run = this.getRun(id);
    if (!run) {
      // The run's job may have been deleted while the run was still in flight
      // (deleting a job removes its runs); late updates are simply dropped.
      this.logger.debug('Ignoring update for a run that no longer exists', { runId: id });
      return;
    }

    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (update.status !== undefined) {
      fields.push('status = ?');
      values.push(update.status);
    }
    if (update.exitCode !== undefined) {
      fields.push('exit_code = ?');
      values.push(update.exitCode ?? null);
    }
    if (update.error !== undefined) {
      fields.push('error = ?');
      values.push(update.error ?? null);
    }
    if (update.endedAt !== undefined) {
      fields.push('ended_at = ?');
      values.push(update.endedAt ?? null);
    }
    if (update.durationMs !== undefined) {
      fields.push('duration_ms = ?');
      values.push(update.durationMs ?? null);
    }
    if (update.pid !== undefined) {
      fields.push('pid = ?');
      values.push(update.pid ?? null);
    }
    if (update.outputTruncated !== undefined) {
      fields.push('output_truncated = ?');
      values.push(update.outputTruncated ? 1 : 0);
    }
    if (update.sessionId !== undefined) {
      // A retry can assign a fresh Claude session to the same run row. Its
      // earlier result must never certify the new, possibly incomplete ID.
      fields.push('claude_result_completed = CASE WHEN session_id = ? THEN claude_result_completed ELSE 0 END');
      values.push(update.sessionId);
      fields.push('session_id = ?');
      values.push(update.sessionId ?? null);
    }
    if (update.command !== undefined) {
      fields.push('command = ?');
      values.push(update.command ?? null);
    }
    if (update.costUsd !== undefined) {
      fields.push('cost_usd = ?');
      values.push(update.costUsd);
    }
    if (update.turns !== undefined) {
      fields.push('turns = ?');
      values.push(update.turns);
    }
    if (update.usageJson !== undefined) {
      fields.push('usage_json = ?');
      values.push(update.usageJson);
    }
    if (update.transcriptPath !== undefined) {
      fields.push('transcript_path = ?');
      values.push(update.transcriptPath);
    }
    if (update.engineStatus !== undefined) {
      fields.push('engine_status = ?');
      values.push(update.engineStatus);
    }

    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.logger.debug('Updated run', { runId: id, fields });
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(id) as DbRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /** Records evidence that Claude produced a complete result for this session. */
  markCompletedClaudeSession(runId: string, sessionId: string): void {
    const result = this.db.prepare('UPDATE runs SET session_id = ?, claude_result_completed = 1 WHERE id = ?')
      .run(sessionId, runId) as { changes: number };
    if (result.changes === 0) throw new CrontickError('NOT_FOUND', `Run ${runId} not found`);
  }

  /**
   * Preflight eligibility requires a completed prior run for this job and ID.
   *
   * Keyed purely off `claude_result_completed` (set only after a real parsed
   * `result` line, see markCompletedClaudeSession()) -- NOT the run row's
   * terminal `status` column. A retry loop reuses the same run row across
   * attempts and only calls finalizeRun() (which writes the terminal status)
   * after the whole loop ends, so a mid-loop resume preflight would otherwise
   * see `status: 'running'` on a row whose transcript was already written and
   * wrongly conclude the session doesn't exist (see tests/unit/claude-adapter.test.ts
   * "resumes across a retry within the same run"). A row can only ever reach
   * claude_result_completed = 1 via markCompletedClaudeSession(), which itself
   * only fires after parseResult() found a complete `result` line -- proof the
   * transcript was written -- regardless of what status the row later settles
   * on (even 'canceled'/'timeout' if a later attempt in the same run aborts).
   * The transcript-existence preflight (resumeTranscriptPath + transcriptExists
   * in runner.ts) still applies on top of this and is the actual guard against
   * a pruned/missing transcript.
   */
  hasCompletedClaudeSession(jobId: string, sessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM runs
      WHERE job_id = ? AND session_id = ? AND claude_result_completed = 1 LIMIT 1`).get(jobId, sessionId) !== undefined;
  }


  private queryRuns(opts: ListRunsOptions = {}): Run[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.jobId) {
      conditions.push('runs.job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.jobIds && opts.jobIds.length > 0) {
      conditions.push(`runs.job_id IN (${opts.jobIds.map(() => '?').join(', ')})`);
      params.push(...opts.jobIds);
    }
    if (opts.since !== undefined) {
      conditions.push('runs.started_at >= ?');
      params.push(opts.since);
    }
    if (opts.status !== undefined) {
      conditions.push('runs.status = ?');
      params.push(opts.status);
    }
    if (opts.statuses && opts.statuses.length > 0) {
      conditions.push(`runs.status IN (${opts.statuses.map(() => '?').join(', ')})`);
      params.push(...opts.statuses);
    }
    const q = opts.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(`(
        runs.id LIKE ? ESCAPE '\\'
        OR runs.status LIKE ? ESCAPE '\\'
        OR runs.error LIKE ? ESCAPE '\\'
        OR runs.session_id LIKE ? ESCAPE '\\'
        OR runs.job_id LIKE ? ESCAPE '\\'
        OR runs.job_id IN (SELECT jobs.id FROM jobs WHERE jobs.alias LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM run_outputs WHERE run_outputs.run_id = runs.id AND run_outputs.result LIKE ? ESCAPE '\\')
      )`);
      params.push(like, like, like, like, like, like, like);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Defense-in-depth: bind LIMIT as a parameter (never string-interpolated)
    // and reject any non-finite / non-positive value so a bad limit can never
    // reach SQLite as malformed SQL. The HTTP layer validates first (see
    // api.ts optionalPositiveInt), this is the store-side backstop.
    let limitClause = '';
    if (opts.limit !== undefined) {
      const n = Number(opts.limit);
      if (!Number.isInteger(n) || n <= 0) {
        throw new CrontickError(
          'VALIDATION_ERROR',
          `Invalid limit ${opts.limit}. Provide a positive integer for limit, then retry.`,
        );
      }
      limitClause = 'LIMIT ?';
      params.push(n);
    }
    const rows = this.db.prepare(`SELECT runs.* FROM runs ${where} ORDER BY runs.started_at DESC ${limitClause}`)
      .all(...params) as unknown as DbRunRow[];
    this.logger.debug('Listed runs', {
      count: rows.length,
      jobId: opts.jobId,
      limit: opts.limit,
      since: opts.since,
      status: opts.status,
    });
    return rows.map(rowToRun);
  }

  listRuns(opts: ListRunsOptions = {}): Run[] {
    return this.queryRuns(opts);
  }

  // ── Run output CRUD ──────────────────────────────────────────────────────────

  /** Persist (replace) a run's parsed engine output. No-op when the run no longer exists (e.g. its job was deleted mid-run). */
  setRunOutput(runId: string, out: EngineOutput): void {
    this.db
      .prepare(
        `INSERT INTO run_outputs (run_id, format, result, engine_error, stderr)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ?)
         ON CONFLICT(run_id) DO UPDATE SET format=excluded.format, result=excluded.result, engine_error=excluded.engine_error,
           stderr=excluded.stderr`,
      )
      .run(runId, out.format, out.result, out.engineError, out.stderr, runId);
  }

  /** The parsed engine output stored for a run; undefined when the run never produced any (skipped, missed, still running). */
  getRunOutput(runId: string): EngineOutput | undefined {
    const row = this.db.prepare('SELECT * FROM run_outputs WHERE run_id = ?').get(runId) as unknown as DbOutputRow | undefined;
    if (!row) return undefined;
    return {
      format: row.format === 'claude-stream-json' ? 'claude-stream-json' : 'text',
      result: row.result,
      engineError: row.engine_error,
      stderr: row.stderr,
    };
  }

  // ── Schedule state (missed-fire watermark) ───────────────────────────────────

  /**
   * Advance job_schedule_state.last_tick_at — called every time the daemon
   * actually processes a tick for this job, and seeded at job creation/enable
   * time. This is the watermark a startup missed-fire pass reads back via
   * getScheduleState() to enumerate fires that happened while nothing was
   * listening; it is intentionally decoupled from any particular tick source.
   */
  recordTick(jobId: string, at: number = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO job_schedule_state (job_id, last_tick_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET last_tick_at=excluded.last_tick_at, updated_at=excluded.updated_at',
      )
      .run(jobId, at, Date.now());
  }

  // ── Consecutive-failure state (auto-disable) ─────────────────────────────────

  /** Current consecutive failed-run count for a job (0 when none recorded). */
  getConsecutiveFailures(jobId: string): number {
    const row = this.db.prepare('SELECT consecutive_failures AS n FROM job_failure_state WHERE job_id = ?').get(jobId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Increment the consecutive-failure count and return the new value. */
  incrementConsecutiveFailures(jobId: string): number {
    this.db
      .prepare('INSERT INTO job_failure_state (job_id, consecutive_failures) VALUES (?, 1) ON CONFLICT(job_id) DO UPDATE SET consecutive_failures = consecutive_failures + 1')
      .run(jobId);
    return this.getConsecutiveFailures(jobId);
  }

  /** Reset the consecutive-failure count (successful run, or the job was re-enabled). */
  resetConsecutiveFailures(jobId: string): void {
    this.db.prepare('DELETE FROM job_failure_state WHERE job_id = ?').run(jobId);
  }

  /** Returns undefined for a job never observed live (no missed-fire computation is possible without a watermark). */
  getScheduleState(jobId: string): ScheduleState | undefined {
    const row = this.db
      .prepare('SELECT * FROM job_schedule_state WHERE job_id = ?')
      .get(jobId) as DbScheduleStateRow | undefined;
    return row ? { jobId: row.job_id, lastTickAt: row.last_tick_at, updatedAt: row.updated_at } : undefined;
  }

  /**
   * On daemon startup, decide the fate of every run left 'running'/'queued' by
   * an unclean shutdown, instead of unconditionally canceling all of them.
   *
   * 'queued' runs (overlap: queue, never actually spawned) are always
   * canceled — there is no process to check liveness of.
   *
   * 'running' runs are canceled too unless `check` is supplied AND it reports
   * the recorded pid is still (plausibly) the same live process: `check` is
   * expected to come from a process-liveness helper providing at least
   * pid-liveness (e.g. `process.kill(pid, 0)`) and, ideally, enough identity
   * signal (this store passes the run's own `started_at` alongside the pid)
   * to reject a pid that has since been reused by an unrelated process — for
   * example by comparing the OS-reported start time of that pid against the
   * run's `started_at`. `isRunAlive` returning `undefined` (inconclusive,
   * e.g. the OS tool it needs is unavailable) is treated the same as `true`:
   * favor adopting over risking a false cancellation that would let a second,
   * overlapping execution of the same job start on the very next tick.
   */
  reconcileOrphanRuns(check?: OrphanLivenessCheck): OrphanReconciliationResult {
    const stuck = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('running', 'queued')")
      .all() as unknown as DbRunRow[];

    const adopted: OrphanReconciliationResult['adopted'] = [];
    const finalized: OrphanReconciliationResult['finalized'] = [];
    const toCancel: string[] = [];

    for (const row of stuck) {
      if (row.status === 'running' && check && row.pid != null) {
        const alive = check.isRunAlive(row.pid, row.started_at);
        if (alive !== false) {
          adopted.push({ runId: row.id, jobId: row.job_id, pid: row.pid });
          continue;
        }
      }
      if (row.status === 'running') {
        const marker = readClaudeCompletionMarker(dirname(this.dbPath), row.id, row.session_id ?? undefined);
        const hookTranscriptPath = readClaudeHookTranscriptPath(dirname(this.dbPath), row.id, row.session_id ?? undefined);
        if (marker) {
          this.updateRun(row.id, {
            status: marker.exitStatus === 0 ? 'success' : 'failed',
            exitCode: marker.exitStatus,
            ...(hookTranscriptPath ? { transcriptPath: hookTranscriptPath } : {}),
            ...(marker.exitStatus === 0 ? {} : { error: `CLAUDE_HOOK: SessionEnd reported exit status ${marker.exitStatus}` }),
            endedAt: Date.now(),
          });
          finalized.push({
            runId: row.id,
            jobId: row.job_id,
            status: marker.exitStatus === 0 ? 'success' : 'failed',
            ...(marker.exitStatus === 0 ? {} : { error: `CLAUDE_HOOK: SessionEnd reported exit status ${marker.exitStatus}` }),
          });
          continue;
        }
      }
      toCancel.push(row.id);
    }

    // Batched for the same reason pruneRunsForJob() batches its deletes: an
    // unbounded "WHERE id IN (?,?,...)" can exceed node:sqlite's bound
    // parameter limit on a daemon that crashed with a very large backlog.
    let canceled = 0;
    for (let i = 0; i < toCancel.length; i += Store.EVICTION_BATCH_SIZE) {
      const batch = toCancel.slice(i, i + Store.EVICTION_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const result = this.db
        .prepare(`UPDATE runs SET status = 'canceled', error = ?, ended_at = ? WHERE id IN (${placeholders})`)
        .run(ORPHAN_RUN_ERROR_MESSAGE, Date.now(), ...batch) as { changes: number };
      canceled += result.changes;
    }

    this.logger.debug('Reconciled orphan runs', { canceled, adopted: adopted.length });
    return { canceled, adopted, finalized };
  }

  // ── Run retention ─────────────────────────────────────────────────────────────

  /**
   * node:sqlite rejects a single statement bound with more than 32766
   * parameters (SQLITE_LIMIT_VARIABLE_NUMBER). A naive "DELETE ... WHERE id IN
   * (?,?,...)" with one placeholder per evicted row hits that ceiling on any
   * job whose backlog grew past ~32766 terminal runs since its cap was last
   * lowered (e.g. via `crontick daemon reload`) — exactly the databases the
   * startup backfill exists to fix, so the daemon would never start again.
   * 500 ids per batch keeps each DELETE far under the limit while also
   * bounding how long any single transaction holds the table, which matters
   * when the startup backfill has to walk tens of thousands of rows across
   * many jobs.
   */
  private static readonly EVICTION_BATCH_SIZE = 500;

  /**
   * Evict the oldest terminal (non-running/non-queued) runs for a job so that at
   * most `cap` rows remain for it, deleting matching run_outputs first (run_outputs
   * has no FK/cascade — see docs/implementation/storage.md) so a crash between the
   * two deletes can only ever leave a run with no output, never an orphaned output
   * row with no parent run. In-flight runs are excluded from the candidate set
   * so an active run is never evicted no matter how old it is; this can let a
   * job's total row count temporarily exceed `cap` by the number of active runs.
   *
   * Eviction happens in bounded batches (see EVICTION_BATCH_SIZE) rather than
   * one unbounded statement: each batch is its own transaction, so a crash or
   * thrown error mid-run can only roll back the batch in progress — every
   * previously committed batch stays evicted, and no batch's run_outputs delete
   * can ever be separated from its runs delete. The loop recomputes the
   * remaining-to-evict count from the DB every iteration (rather than just
   * looping until a fixed pre-computed total), so it converges to `cap` and
   * always terminates: it stops the instant a SELECT returns zero candidates,
   * or as soon as a batch comes back smaller than EVICTION_BATCH_SIZE (proof
   * the remainder has reached zero without needing one more round trip).
   */
  private pruneRunsForJob(jobId: string, cap: number = this.runRetentionCap): number {
    const selectBatch = this.db.prepare(
      `SELECT id FROM runs
       WHERE job_id = ?
         AND status NOT IN ('running', 'queued')
       ORDER BY started_at ASC, rowid ASC
       LIMIT MIN(?, MAX(0, (SELECT COUNT(*) FROM runs WHERE job_id = ?) - ?))`,
    );

    let totalEvicted = 0;
    for (;;) {
      const candidates = selectBatch.all(
        jobId,
        Store.EVICTION_BATCH_SIZE,
        jobId,
        cap,
      ) as Array<{ id: string }>;
      if (candidates.length === 0) break;

      const ids = candidates.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');

      this.db.exec('BEGIN;');
      try {
        this.db.prepare(`DELETE FROM run_outputs WHERE run_id IN (${placeholders})`).run(...ids);
        this.db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...ids);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      totalEvicted += ids.length;
      if (ids.length < Store.EVICTION_BATCH_SIZE) break; // fewer than a full batch ⇒ nothing left to evict
    }

    if (totalEvicted > 0) {
      this.logger.info('Evicted runs exceeding retention cap', { jobId, evicted: totalEvicted, cap });
    }
    return totalEvicted;
  }

  /**
   * Cap-reconciliation pass, not an upgrade/backfill step: applies
   * pruneRunsForJob() to every job_id present in `runs` so a job whose
   * backlog already exceeds a cap lowered via `crontick daemon reload` (and
   * hasn't ticked since, so its own pruneRunsForJob() call on next insert
   * hasn't fired yet) still gets truncated. Safe and cheap to call on every
   * daemon startup — a no-op when every job is already within the cap.
   */
  pruneAllJobsRunHistory(cap: number = this.runRetentionCap): number {
    const jobIds = this.db
      .prepare('SELECT DISTINCT job_id FROM runs')
      .all() as Array<{ job_id: string }>;
    let total = 0;
    for (const { job_id } of jobIds) {
      // Best-effort per job: retention is maintenance, not correctness — one
      // job's prune failure must not abort the backfill for every other job,
      // and must never be allowed to stop the daemon from starting.
      try {
        total += this.pruneRunsForJob(job_id, cap);
      } catch (err) {
        this.logger.error('Run retention backfill failed for job; continuing with other jobs', { jobId: job_id, error: String(err) });
      }
    }
    // info (not debug): this is startup history loss the user should be able to
    // see without turning on --verbose, but only logged when it actually pruned
    // something, so a healthy startup stays silent.
    if (total > 0) {
      this.logger.info(`Pruned run history on startup: ${total} run(s) removed across ${jobIds.length} job(s) (cap ${cap})`, { jobsScanned: jobIds.length, evicted: total, cap });
    }
    return total;
  }
}

// ── After-trigger graph validation ────────────────────────────────────────────

export interface AfterGraphError {
  code: 'AFTER_CYCLE' | 'AFTER_UPSTREAM_NOT_FOUND';
  message: string;
}

/**
 * Validates the `after` upstream chain of a (proposed) job against `jobs`. Each node has one
 * upstream, so this is a pointer walk: a cycle iff the walk reaches `job.id`; a visited set
 * guards against corrupt data that loops without including `job`. The proposed `job` replaces
 * any stored job with the same id. Only the first hop is checked for existence (a missing
 * ancestor is that ancestor's own problem). Returns undefined when valid or not an after-job.
 */
export function validateAfterGraph(job: Job, jobs: readonly Job[]): AfterGraphError | undefined {
  if (job.schedule.kind !== 'after') return undefined;
  const byId = new Map(jobs.map((j) => [j.id, j] as const));
  byId.set(job.id, job);
  const visited = new Set<string>();
  let cur: string = job.schedule.jobId;
  let first = true;
  for (;;) {
    if (cur === job.id) {
      return { code: 'AFTER_CYCLE', message: `After-trigger cycle: job ${job.id} is (transitively) its own upstream` };
    }
    if (visited.has(cur)) {
      return { code: 'AFTER_CYCLE', message: `After-trigger cycle in the upstream chain of job ${job.id} (at ${cur})` };
    }
    visited.add(cur);
    const next = byId.get(cur);
    if (!next) {
      return first
        ? { code: 'AFTER_UPSTREAM_NOT_FOUND', message: `Upstream job ${cur} not found` }
        : undefined;
    }
    first = false;
    if (next.schedule.kind !== 'after') return undefined;
    cur = next.schedule.jobId;
  }
}

// ── Internal row types ────────────────────────────────────────────────────────

interface DbRunRow {
  id: string;
  job_id: string;
  started_at: number;
  ended_at: number | null;
  status: RunStatus;
  exit_code: number | null;
  error: string | null;
  duration_ms: number | null;
  pid: number | null;
  output_truncated: number;
  session_id: string | null;
  command: string | null;
  cost_usd: number | null;
  turns: number | null;
  usage_json: string | null;
  transcript_path: string | null;
  engine_status: string | null;
}

interface DbOutputRow {
  run_id: string;
  format: string;
  result: string | null;
  engine_error: string | null;
  stderr: string;
}

interface DbScheduleStateRow {
  job_id: string;
  last_tick_at: number;
  updated_at: number;
}

function rowToRun(row: DbRunRow): Run {
  const r: Run = {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    status: row.status,
    outputTruncated: row.output_truncated === 1,
  };
  if (row.ended_at !== null) r.endedAt = row.ended_at;
  if (row.exit_code !== null) r.exitCode = row.exit_code;
  if (row.error !== null) r.error = row.error;
  if (row.duration_ms !== null) r.durationMs = row.duration_ms;
  if (row.pid !== null) r.pid = row.pid;
  if (row.session_id !== null) r.sessionId = row.session_id;
  if (row.command !== null) r.command = row.command;
  if (row.cost_usd !== null) r.costUsd = row.cost_usd;
  if (row.turns !== null) r.turns = row.turns;
  if (row.usage_json !== null) r.usageJson = row.usage_json;
  if (row.transcript_path !== null) r.transcriptPath = row.transcript_path;
  if (row.engine_status !== null) r.engineStatus = row.engine_status;
  return r;
}

function isSamePromptCaptureTarget(current: PromptAction, expected: PromptAction): boolean {
  return (
    current.prompt === expected.prompt
    && current.engine === expected.engine
    && JSON.stringify(current.args ?? []) === JSON.stringify(expected.args ?? [])
    && current.cwd === expected.cwd
    && current.envFile === expected.envFile
    && current.timeoutSec === expected.timeoutSec
    && JSON.stringify(current.env ?? {}) === JSON.stringify(expected.env ?? {})
  );
}

/**
 * Clears reuseSession once a sessionId has been captured, preventing the
 * capture logic from running again on subsequent daemon starts.
 */
function normalizeJobForPersistence(job: Job): Job {
  if (job.action.kind !== 'prompt' || !job.action.sessionId || !job.action.reuseSession) return job;
  return {
    ...job,
    action: {
      ...job.action,
      reuseSession: false,
    },
  };
}

// Owner-only (rw-------), matching the mode config.ts already applies to
// config.json: job files can contain inline scripts and prompt text, so they
// should not be world-readable under a typical umask. writeFileSync's mode
// option only takes effect when the file is newly created, so an explicit
// chmodSync also re-hardens a file that already existed on disk (created by
// a prior process, a hand-edit, or a permissive umask). chmodSync is a
// best-effort no-op on Windows (POSIX modes aren't enforced there) and never
// throws for that reason.
const PRIVATE_FILE_MODE = 0o600;

function writeJobFileHardened(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best-effort hardening only; must never block a job write
  }
}
