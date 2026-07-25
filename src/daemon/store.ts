import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job, type PromptAction } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
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
];

// ── Store ─────────────────────────────────────────────────────────────────────

export class Store {
  private db!: DatabaseSync;
  private dbPath: string;
  private jobsPath: string;
  private logger: Logger;

  constructor(dbPath?: string, jobsPath?: string, logger: Logger = nullLogger) {
    this.dbPath = dbPath ?? runsDbPath();
    this.jobsPath = jobsPath ?? jobsDir();
    this.logger = logger.child('store');
  }

  open(): void {
    this.logger.debug('Opening store', { dbPath: this.dbPath, jobsPath: this.jobsPath });
    this.db = new DatabaseSync(this.dbPath);
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

  upsertJob(job: Job): void {
    const persisted = normalizeJobForPersistence(job);
    const json = JSON.stringify(persisted);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO jobs (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
      )
      .run(persisted.id, json, now);
    // File-based persistence: jobs dir is source of truth
    const filePath = join(this.jobsPath, `${persisted.id}.json`);
    writeFileSync(filePath, json, 'utf-8');
    writeFileSync(join(this.jobsPath, `${persisted.id}.schema.json`), jobJsonSchemaText(), 'utf-8');
    this.logger.debug('Persisted job files', { jobId: persisted.id, filePath, schemaPath: join(this.jobsPath, `${persisted.id}.schema.json`) });
  }

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

  /** Load jobs from the jobs directory (disk is source of truth on daemon start). */
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

  /** On daemon startup, cancel any runs that were left in 'running' or 'queued' state (daemon crashed). */
  reconcileOrphanRuns(): number {
    const result = this.db
      .prepare(
        "UPDATE runs SET status = 'canceled', error = 'daemon-restart', ended_at = ? WHERE status IN ('running', 'queued')",
      )
      .run(Date.now()) as { changes: number };
    this.logger.debug('Reconciled orphan runs', { changes: result.changes });
    return result.changes;
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
