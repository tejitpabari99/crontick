// Dual-persistence layer: JSON files (source of truth for jobs) + SQLite WAL (runs, logs, job cache).
// Only the daemon opens this store (single-writer invariant).
// See docs/internals/storage.md
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job, type PromptAction } from '../schemas/job.js';
import { CrontickError, ORPHAN_RUN_ERROR_MESSAGE } from '../errors.js';
import { jobJsonSchemaText } from '../schema-json.js';
import { nullLogger, type Logger } from '../logger.js';
import type { LogSource } from '../log-source.js';
import { readClaudeCompletionMarker } from '../claude-completion-marker.js';

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

/** Every RunStatus value, kept as a runtime array so RunImportSchema's z.enum
 *  stays in sync with the RunStatus type union above without hand-duplication
 *  drifting out of date. */
const RUN_STATUS_VALUES = ['queued', 'running', 'success', 'failed', 'canceled', 'skipped', 'timeout', 'missed'] as const;

/**
 * Validates one row of a `runs` import payload (see importRuns()). Mirrors
 * the Run interface field-for-field: required fields must be present and of
 * the right type (a missing/malformed `startedAt` or an out-of-union
 * `status` are the two concrete corruption cases this schema exists to
 * catch), while optional fields are genuinely optional so a valid partial
 * row round-trips. Unknown extra keys are ignored rather than rejected, so a
 * forward-compatible export (e.g. one with an added field) doesn't fail an
 * older import.
 */
export const RunImportSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(RUN_STATUS_VALUES),
  exitCode: z.number().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  pid: z.number().optional(),
  outputTruncated: z.boolean().optional(),
  sessionId: z.string().optional(),
  command: z.string().optional(),
  costUsd: z.number().optional(),
  turns: z.number().int().optional(),
  usageJson: z.string().optional(),
  transcriptPath: z.string().optional(),
  engineStatus: z.string().optional(),
});

export interface RunLog {
  runId: string;
  stream: LogStream;
  ts: number; // epoch ms
  chunk: Buffer;
}

/**
 * Log streams captured per run. `stdout`/`stderr` are the engine's process
 * output; `crontick` is crontick's own scheduling/execution lifecycle events
 * (job fired, resolved command, exit code, duration, cancellation, captured
 * session id, errors). See LogSource for the retrieval-side filter.
 */
export type LogStream = 'stdout' | 'stderr' | 'crontick';

/**
 * Retrieval-side filter for getLogs(): `all` (default) returns every stream,
 * `engine` returns only stdout+stderr, `crontick` returns only crontick-side
 * lifecycle events. Canonically defined in `src/log-source.ts` and re-exported
 * here for daemon consumers (api.ts).
 */
export type { LogSource };

export interface ListRunsOptions {
  jobId?: string;
  limit?: number;
  since?: number; // epoch ms
  status?: RunStatus;
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
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Sentinel value written to a recordMissedRun() row's `error` column,
 * following the `CODE: message` convention already used for
 * ORPHAN_RUN_ERROR_MESSAGE (src/errors.ts) and other runs.error values.
 */
export const MISSED_RUN_ERROR_MESSAGE = 'MISSED: daemon was not running at the scheduled fire time';

// Not exported: this is an internal fallback for the constructor default
// parameter below only. BUILT_IN_CONFIG.retention.maxRunsPerJob (src/config.ts)
// is the actual default consumers see; keeping this un-exported avoids a
// second, easily-drifting public source of the same "100" default.
const DEFAULT_RUN_RETENTION_CAP = 100;

export class Store {
  private db!: DatabaseSync;
  private dbPath: string;
  private jobsPath: string;
  private logger: Logger;
  private runRetentionCap: number;

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
   * already-initialized database (e.g. a second open()) is a no-op. There is
   * no migration ledger and no prior on-disk shape to reconcile: crontick has
   * a single fixed schema and always creates it in its final shape. Every
   * column (including `jobs.alias`, `runs.session_id`, and `runs.command`) is
   * declared directly in its `CREATE TABLE`, and the alias-uniqueness index is
   * created alongside the tables.
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
        engine_status TEXT
      );

      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        ts INTEGER NOT NULL,
        chunk BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_schedule_state (
        job_id TEXT PRIMARY KEY,
        last_tick_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- idx_runs_job_id (a single-column index) is deliberately never created:
      -- idx_runs_job_id_started_at is a strict left-prefix superset of it, so
      -- every query it would have served is served at least as well by this
      -- one. Retention eviction needs an index-ordered (job_id, started_at)
      -- walk to avoid a scan-then-sort per pruneRunsForJob() call.
      CREATE INDEX IF NOT EXISTS idx_runs_job_id_started_at ON runs(job_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);

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
    const byId = this.getJobRowById(idOrAlias);
    if (byId) {
      this.logger.debug('Read job from store by id', { jobId: idOrAlias });
      return byId;
    }
    const byAlias = this.getJobRowByAlias(idOrAlias);
    if (byAlias) {
      this.logger.debug('Read job from store by alias', { alias: idOrAlias, jobId: byAlias.id });
      return byAlias;
    }
    return undefined;
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

  /** Accepts either the GUID `id` or the `alias` (see getJob) and deletes the resolved job's row + files. */
  deleteJob(idOrAlias: string): boolean {
    const job = this.getJob(idOrAlias);
    if (!job) return false;
    const changes = (this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id) as { changes: number }).changes;
    this.removeJobFiles(job.id);
    this.logger.debug('Deleted job', { jobId: job.id, alias: job.alias, deleted: changes > 0 });
    return changes > 0;
  }

  /**
   * Atomically delete every job and all data associated with jobs: run history,
   * run logs, and per-job schedule state, in a single transaction. Returns the
   * number of job rows removed. Unlike single-job delete (which archives run
   * history), a bulk wipe leaves nothing to archive against, so runs/logs are
   * removed too. Job JSON files are unlinked best-effort after the DB commit
   * (the SQLite rows are the transactional source of truth; files are a mirror).
   */
  deleteAllJobs(): number {
    const jobs = this.listJobs();
    this.db.exec('BEGIN;');
    let deleted: number;
    try {
      this.db.exec('DELETE FROM run_logs;');
      this.db.exec('DELETE FROM runs;');
      this.db.exec('DELETE FROM job_schedule_state;');
      deleted = (this.db.prepare('DELETE FROM jobs').run() as { changes: number }).changes;
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    for (const job of jobs) this.removeJobFiles(job.id);
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
    this.logger.debug('Loaded jobs from disk', { jobsPath: this.jobsPath, files: files.length, loaded });
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

  updateRun(
    id: string,
    update: Partial<Pick<Run, 'status' | 'exitCode' | 'error' | 'endedAt' | 'durationMs' | 'pid' | 'outputTruncated' | 'sessionId' | 'command' | 'costUsd' | 'turns' | 'usageJson' | 'transcriptPath' | 'engineStatus'>>,
  ): void {
    const run = this.getRun(id);
    if (!run) throw new CrontickError('NOT_FOUND', `Run ${id} not found`);

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

  /** Preflight eligibility requires a completed prior run for this job and ID. */
  hasCompletedClaudeSession(jobId: string, sessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM runs
      WHERE job_id = ? AND session_id = ? AND claude_result_completed = 1
        AND status IN ('success', 'failed') LIMIT 1`).get(jobId, sessionId) !== undefined;
  }


  private queryRuns(opts: ListRunsOptions = {}, existingJobsOnly = false): Run[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.jobId) {
      conditions.push('runs.job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.since !== undefined) {
      conditions.push('runs.started_at >= ?');
      params.push(opts.since);
    }
    if (opts.status !== undefined) {
      conditions.push('runs.status = ?');
      params.push(opts.status);
    }

    const join = existingJobsOnly ? 'INNER JOIN jobs ON jobs.id = runs.job_id' : '';
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
    const rows = this.db.prepare(`SELECT runs.* FROM runs ${join} ${where} ORDER BY runs.started_at DESC ${limitClause}`)
      .all(...params) as unknown as DbRunRow[];
    this.logger.debug('Listed runs', {
      count: rows.length,
      jobId: opts.jobId,
      limit: opts.limit,
      since: opts.since,
      status: opts.status,
      existingJobsOnly,
    });
    return rows.map(rowToRun);
  }

  listRuns(opts: ListRunsOptions = {}): Run[] {
    return this.queryRuns(opts, false);
  }

  /**
   * Current-job aggregate views exclude archived runs whose parent job row was
   * deleted, but direct run/log lookups by run id still use listRuns()/getRun().
   */
  listRunsForExistingJobs(opts: ListRunsOptions = {}): Run[] {
    return this.queryRuns(opts, true);
  }

  /**
   * Bulk-restores previously-exported run history (L7's `export --include-runs`
   * mitigation for hard-delete retention). Inserts are archival only: no
   * execution, no scheduler interaction. Idempotent on `id` (INSERT OR IGNORE
   * — a run already present, e.g. from re-importing the same backup, is left
   * untouched and not counted as imported).
   *
   * Every row is validated against RunImportSchema before it is ever bound to
   * a statement (mirrors the per-item validate-and-collect pattern the jobs
   * loop in api.ts's POST /api/import already uses): a malformed row (bad
   * `status`, missing `startedAt`, wrong types, ...) is skipped individually
   * with a reason rather than throwing and aborting the whole batch. Rows
   * referencing a job that doesn't exist in this store are likewise skipped
   * individually. Each row is also its own try/catch around the INSERT itself
   * so an unexpected DB-level failure on one row can never take down the
   * rows around it — the loop has no surrounding transaction, so every row
   * that does succeed is durably committed independently of any row that
   * doesn't (atomic-per-row, not all-or-nothing).
   *
   * After the loop, retention is enforced (pruneRunsForJob) for every job
   * that received at least one imported row, so a large restore can't leave a
   * job permanently above its cap until its next real run.
   */
  importRuns(runs: unknown[]): { imported: number; skipped: Array<{ id: string; error: string }> } {
    const skipped: Array<{ id: string; error: string }> = [];
    let imported = 0;
    const affectedJobIds = new Set<string>();
    const jobExists = this.db.prepare('SELECT 1 FROM jobs WHERE id = ?');
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO runs
         (id, job_id, started_at, ended_at, status, exit_code, error, duration_ms, pid, output_truncated, session_id, command, cost_usd, turns, usage_json, transcript_path, engine_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const raw of runs) {
      const parsed = RunImportSchema.safeParse(raw);
      if (!parsed.success) {
        const idGuess = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?';
        skipped.push({ id: idGuess, error: `validation failed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` });
        continue;
      }
      const run = parsed.data;
      if (!jobExists.get(run.jobId)) {
        skipped.push({ id: run.id, error: 'job not found' });
        continue;
      }
      try {
        const result = insert.run(
          run.id,
          run.jobId,
          run.startedAt,
          run.endedAt ?? null,
          run.status,
          run.exitCode ?? null,
          run.error ?? null,
          run.durationMs ?? null,
          run.pid ?? null,
          run.outputTruncated ? 1 : 0,
          run.sessionId ?? null,
          run.command ?? null,
          run.costUsd ?? null,
          run.turns ?? null,
          run.usageJson ?? null,
          run.transcriptPath ?? null,
          run.engineStatus ?? null,
        ) as { changes: number };
        if (result.changes > 0) {
          imported += 1;
          affectedJobIds.add(run.jobId);
        }
        // else: id already present -- idempotent re-import, not an error.
      } catch (err) {
        skipped.push({ id: run.id, error: `insert failed: ${String(err)}` });
      }
    }
    for (const jobId of affectedJobIds) {
      // Best-effort per job, same as pruneAllJobsRunHistory(): retention is
      // maintenance, not correctness, so one job's prune failure must not
      // affect the reported import result or any other job's retention.
      try {
        this.pruneRunsForJob(jobId);
      } catch (err) {
        this.logger.error('Run retention prune failed after import; rows were still imported', { jobId, error: String(err) });
      }
    }
    this.logger.debug('Imported runs', { requested: runs.length, imported, skipped: skipped.length });
    return { imported, skipped };
  }

  // ── Log CRUD ────────────────────────────────────────────────────────────────

  appendLog(runId: string, stream: LogStream, chunk: Buffer): void {
    this.db
      .prepare('INSERT INTO run_logs (run_id, stream, ts, chunk) VALUES (?, ?, ?, ?)')
      .run(runId, stream, Date.now(), chunk);
  }

  /**
   * Returns a run's logs, optionally filtered by source: `all` (default)
   * returns every stream, `engine` returns only stdout+stderr, `crontick`
   * returns only crontick-side lifecycle events.
   */
  getLogs(runId: string, source: LogSource = 'all'): RunLog[] {
    const streams = logStreamsForSource(source);
    const rows = streams
      ? (this.db
          .prepare(`SELECT * FROM run_logs WHERE run_id = ? AND stream IN (${streams.map(() => '?').join(', ')}) ORDER BY id`)
          .all(runId, ...streams) as unknown as DbLogRow[])
      : (this.db
          .prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY id')
          .all(runId) as unknown as DbLogRow[]);
    return rows.map(rowToLog);
  }

  tailLogs(runId: string, sinceTs: number): RunLog[] {
    const rows = this.db
      .prepare('SELECT * FROM run_logs WHERE run_id = ? AND ts > ? ORDER BY id')
      .all(runId, sinceTs) as unknown as DbLogRow[];
    return rows.map(rowToLog);
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
        if (marker) {
          this.updateRun(row.id, {
            status: marker.exitStatus === 0 ? 'success' : 'failed',
            exitCode: marker.exitStatus,
            ...(marker.exitStatus === 0 ? {} : { error: `CLAUDE_HOOK: SessionEnd reported exit status ${marker.exitStatus}` }),
            endedAt: Date.now(),
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
    return { canceled, adopted };
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
   * most `cap` rows remain for it, deleting matching run_logs first (run_logs
   * has no FK/cascade — see docs/internals/storage.md) so a crash between the
   * two deletes can only ever leave a run with no logs, never an orphaned log
   * row with no parent run. In-flight runs are excluded from the candidate set
   * so an active run is never evicted no matter how old it is; this can let a
   * job's total row count temporarily exceed `cap` by the number of active runs.
   *
   * Eviction happens in bounded batches (see EVICTION_BATCH_SIZE) rather than
   * one unbounded statement: each batch is its own transaction, so a crash or
   * thrown error mid-run can only roll back the batch in progress — every
   * previously committed batch stays evicted, and no batch's run_logs delete
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
        this.db.prepare(`DELETE FROM run_logs WHERE run_id IN (${placeholders})`).run(...ids);
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

interface DbLogRow {
  id: number;
  run_id: string;
  stream: LogStream;
  ts: number;
  chunk: Buffer;
}

interface DbScheduleStateRow {
  job_id: string;
  last_tick_at: number;
  updated_at: number;
}

/** Type guard used by importRuns() to best-effort recover an `id` for the
 *  skipped-row report when a raw import row fails schema validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Maps a LogSource filter to the concrete stream list, or null for "all". */
function logStreamsForSource(source: LogSource): LogStream[] | null {
  if (source === 'engine') return ['stdout', 'stderr'];
  if (source === 'crontick') return ['crontick'];
  return null;
}

function rowToLog(row: DbLogRow): RunLog {
  return {
    runId: row.run_id,
    stream: row.stream,
    ts: row.ts,
    chunk: Buffer.from(row.chunk),
  };
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
