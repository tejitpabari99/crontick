// Dual-persistence layer: JSON files (source of truth for jobs) + SQLite WAL (runs, logs, job cache).
// Only the daemon opens this store (single-writer invariant).
// See docs/internals/storage.md
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job, type PromptAction } from '../schemas/job.js';
import { CrontickError, ORPHAN_RUN_ERROR_MESSAGE } from '../errors.js';
import { jobJsonSchemaText } from '../schema-json.js';
import { nullLogger, type Logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'timeout';

export interface Run {
  id: string;
  jobId: string;
  startedAt: number; // epoch ms
  endedAt?: number;
  status: RunStatus;
  exitCode?: number;
  error?: string;
  durationMs?: number;
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
}

// ── Migrations ────────────────────────────────────────────────────────────────

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_initial',
    sql: `
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
        duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        ts INTEGER NOT NULL,
        chunk BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
    `,
  },
  {
    // idx_runs_job_id is a strict left-prefix subset of this composite index
    // (every query it served is served at least as well by this one), so it
    // is dropped rather than kept redundant on every runs INSERT/UPDATE/DELETE.
    // Retention eviction needs an index-ordered (job_id, started_at) walk to
    // avoid a scan-then-sort per pruneRunsForJob() call.
    name: '002_run_retention_index',
    sql: `
      DROP INDEX IF EXISTS idx_runs_job_id;
      CREATE INDEX IF NOT EXISTS idx_runs_job_id_started_at ON runs(job_id, started_at);
    `,
  },
];

// ── Store ─────────────────────────────────────────────────────────────────────

export const DEFAULT_RUN_RETENTION_CAP = 100;

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

  /** Open the SQLite database, enable WAL + foreign keys, and apply pending migrations. */
  open(): void {
    this.logger.debug('Opening store', { dbPath: this.dbPath, jobsPath: this.jobsPath });
    this.db = new DatabaseSync(this.dbPath);
    // WAL enables concurrent reads from HTTP handlers without blocking writes.
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.runMigrations();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = this.db
      .prepare('SELECT name FROM migrations')
      .all() as Array<{ name: string }>;
    const appliedSet = new Set(applied.map((r) => r.name));

    for (const migration of MIGRATIONS) {
      if (!appliedSet.has(migration.name)) {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')
          .run(migration.name, Date.now());
      }
    }
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
    writeFileSync(filePath, json, 'utf-8');
    writeFileSync(join(this.jobsPath, `${persisted.id}.schema.json`), jobJsonSchemaText(), 'utf-8');
    this.logger.debug('Persisted job files', { jobId: persisted.id, filePath, schemaPath: join(this.jobsPath, `${persisted.id}.schema.json`) });
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
      try {
        const raw = readFileSync(join(this.jobsPath, file), 'utf-8');
        const parsed = JobSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          const json = JSON.stringify(parsed.data);
          this.db
            .prepare(
              'INSERT INTO jobs (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
            )
            .run(parsed.data.id, json, Date.now());
          loaded++;
        }
      } catch {
        // skip malformed job files
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
    this.pruneRunsForJob(jobId);
    return { id, jobId, startedAt: now, status: 'queued' };
  }

  updateRun(
    id: string,
    update: Partial<Pick<Run, 'status' | 'exitCode' | 'error' | 'endedAt' | 'durationMs'>>,
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : '';
    const rows = this.db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC ${limit}`)
      .all(...params) as unknown as DbRunRow[];
    this.logger.debug('Listed runs', { count: rows.length, jobId: opts.jobId, limit: opts.limit, since: opts.since });
    return rows.map(rowToRun);
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

  /**
   * On daemon startup, cancel runs stuck in non-terminal state from a prior crash.
   * Invariant: no run appears permanently stuck after a daemon restart.
   */
  reconcileOrphanRuns(): number {
    const result = this.db
      .prepare(
        "UPDATE runs SET status = 'canceled', error = ?, ended_at = ? WHERE status IN ('running', 'queued')",
      )
      .run(ORPHAN_RUN_ERROR_MESSAGE, Date.now()) as { changes: number };
    this.logger.debug('Reconciled orphan runs', { changes: result.changes });
    return result.changes;
  }

  // ── Run retention ─────────────────────────────────────────────────────────────

  /**
   * Evict the oldest terminal (non-running/non-queued) runs for a job so that at
   * most `cap` rows remain for it, deleting matching run_logs first (run_logs
   * has no FK/cascade — see docs/internals/storage.md) so a crash between the
   * two deletes can only ever leave a run with no logs, never an orphaned log
   * row with no parent run. In-flight runs are excluded from the candidate set
   * so an active run is never evicted no matter how old it is; this can let a
   * job's total row count temporarily exceed `cap` by the number of active runs.
   */
  private pruneRunsForJob(jobId: string, cap: number = this.runRetentionCap): number {
    const candidates = this.db
      .prepare(
        `SELECT id FROM runs
         WHERE job_id = ?
           AND status NOT IN ('running', 'queued')
         ORDER BY started_at ASC, rowid ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM runs WHERE job_id = ?) - ?)`,
      )
      .all(jobId, jobId, cap) as Array<{ id: string }>;

    if (candidates.length === 0) return 0;

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

    this.logger.debug('Evicted runs exceeding retention cap', { jobId, evicted: ids.length, cap });
    return ids.length;
  }

  /**
   * Backfill pass for databases that predate the retention cap (or whose cap was
   * lowered): applies pruneRunsForJob() to every job_id present in `runs`. Safe
   * and cheap to call on every daemon startup — a no-op when every job is already
   * within the cap.
   */
  pruneAllJobsRunHistory(cap: number = this.runRetentionCap): number {
    const jobIds = this.db
      .prepare('SELECT DISTINCT job_id FROM runs')
      .all() as Array<{ job_id: string }>;
    let total = 0;
    for (const { job_id } of jobIds) {
      total += this.pruneRunsForJob(job_id, cap);
    }
    if (total > 0) {
      this.logger.debug('Pruned run history across all jobs on startup', { jobsScanned: jobIds.length, evicted: total, cap });
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
}

interface DbLogRow {
  id: number;
  run_id: string;
  stream: 'stdout' | 'stderr';
  ts: number;
  chunk: Buffer;
}

function rowToRun(row: DbRunRow): Run {
  const r: Run = {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    status: row.status,
  };
  if (row.ended_at !== null) r.endedAt = row.ended_at;
  if (row.exit_code !== null) r.exitCode = row.exit_code;
  if (row.error !== null) r.error = row.error;
  if (row.duration_ms !== null) r.durationMs = row.duration_ms;
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
