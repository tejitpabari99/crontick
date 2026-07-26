// Dual-persistence layer: JSON files (source of truth for jobs) + SQLite WAL (runs, logs, job cache).
// Only the daemon opens this store (single-writer invariant).
// See docs/internals/storage.md
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job, type PromptAction } from '../schemas/job.js';
import { CrontickError, ORPHAN_RUN_ERROR_MESSAGE } from '../errors.js';
import { jobJsonSchemaText } from '../schema-json.js';
import { nullLogger, type Logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

// 'missed' is a terminal status recorded by recordMissedRun() for a scheduled
// fire the daemon was down for. It is never a success or a failure — it is
// its own outcome — but it IS terminal for retention purposes (see
// pruneRunsForJob(), which excludes only 'running'/'queued').
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'timeout' | 'missed';

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
}

export interface RunLog {
  runId: string;
  stream: 'stdout' | 'stderr';
  ts: number; // epoch ms
  chunk: Buffer;
}

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
   * already-initialized database (e.g. a second open()) is a no-op — there is
   * no migration ledger and no prior on-disk shape to reconcile: databases
   * created by crontick versions before 1.0.0 are not a supported input.
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
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
        output_truncated INTEGER NOT NULL DEFAULT 0
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
    `);
  }

  // ── Job CRUD ────────────────────────────────────────────────────────────────

  /** Write job to both SQLite cache and JSON file on disk (JSON is source of truth). */
  upsertJob(job: Job): void {
    const persisted = normalizeJobForPersistence(job);
    const json = JSON.stringify(persisted);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO jobs (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
      )
      .run(persisted.id, json, now);
    const filePath = join(this.jobsPath, `${persisted.id}.json`);
    const schemaPath = join(this.jobsPath, `${persisted.id}.schema.json`);
    writeJobFileHardened(filePath, json);
    writeJobFileHardened(schemaPath, jobJsonSchemaText());
    this.logger.debug('Persisted job files', { jobId: persisted.id, filePath, schemaPath });
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

  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT json FROM jobs WHERE id = ?').get(id) as
      | { json: string }
      | undefined;
    if (!row) return undefined;
    this.logger.debug('Read job from store', { jobId: id });
    return JSON.parse(row.json) as Job;
  }

  listJobs(): Job[] {
    const rows = this.db.prepare('SELECT json FROM jobs ORDER BY id').all() as Array<{
      json: string;
    }>;
    this.logger.debug('Listed jobs', { count: rows.length });
    return rows.map((r) => JSON.parse(r.json) as Job);
  }

  deleteJob(id: string): boolean {
    const changes = (this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id) as { changes: number }).changes;
    const filePath = join(this.jobsPath, `${id}.json`);
    const schemaPath = join(this.jobsPath, `${id}.schema.json`);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    if (existsSync(schemaPath)) {
      try {
        unlinkSync(schemaPath);
      } catch {
        // ignore
      }
    }
    this.logger.debug('Deleted job', { jobId: id, deleted: changes > 0, filePath, schemaPath });
    return changes > 0;
  }

  /** Load jobs from the jobs directory (JSON files are source of truth on daemon start). */
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
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JobSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          const json = JSON.stringify(parsed.data);
          this.db
            .prepare(
              'INSERT INTO jobs (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
            )
            .run(parsed.data.id, json, Date.now());
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
    update: Partial<Pick<Run, 'status' | 'exitCode' | 'error' | 'endedAt' | 'durationMs' | 'pid' | 'outputTruncated'>>,
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

  listRuns(opts: ListRunsOptions = {}): Run[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.jobId) {
      conditions.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.since !== undefined) {
      conditions.push('started_at >= ?');
      params.push(opts.since);
    }
    if (opts.status !== undefined) {
      conditions.push('status = ?');
      params.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : '';
    const rows = this.db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC ${limit}`)
      .all(...params) as unknown as DbRunRow[];
    this.logger.debug('Listed runs', { count: rows.length, jobId: opts.jobId, limit: opts.limit, since: opts.since, status: opts.status });
    return rows.map(rowToRun);
  }

  /**
   * Bulk-restores previously-exported run history (L7's `export --include-runs`
   * mitigation for hard-delete retention). Inserts are archival only: no
   * execution, no scheduler interaction. Idempotent on `id` (INSERT OR IGNORE
   * — a run already present, e.g. from re-importing the same backup, is left
   * untouched and not counted as imported). Rows referencing a job that
   * doesn't exist in this store are skipped individually so a partial restore
   * still succeeds for everything else.
   */
  importRuns(runs: Run[]): { imported: number; skipped: Array<{ id: string; error: string }> } {
    const skipped: Array<{ id: string; error: string }> = [];
    let imported = 0;
    const jobExists = this.db.prepare('SELECT 1 FROM jobs WHERE id = ?');
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO runs
         (id, job_id, started_at, ended_at, status, exit_code, error, duration_ms, pid, output_truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const run of runs) {
      if (!jobExists.get(run.jobId)) {
        skipped.push({ id: run.id, error: 'job not found' });
        continue;
      }
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
      ) as { changes: number };
      if (result.changes > 0) imported += 1;
      // else: id already present -- idempotent re-import, not an error.
    }
    this.logger.debug('Imported runs', { requested: runs.length, imported, skipped: skipped.length });
    return { imported, skipped };
  }

  // ── Log CRUD ────────────────────────────────────────────────────────────────

  appendLog(runId: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.db
      .prepare('INSERT INTO run_logs (run_id, stream, ts, chunk) VALUES (?, ?, ?, ?)')
      .run(runId, stream, Date.now(), chunk);
  }

  getLogs(runId: string): RunLog[] {
    const rows = this.db
      .prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as DbLogRow[];
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
}

interface DbLogRow {
  id: number;
  run_id: string;
  stream: 'stdout' | 'stderr';
  ts: number;
  chunk: Buffer;
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
  return r;
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
