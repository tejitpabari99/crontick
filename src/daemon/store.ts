import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runsDbPath, jobsDir } from '../paths.js';
import { JobSchema, type Job } from '../schemas/job.js';
import { CrontickError } from '../errors.js';

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

  constructor(dbPath?: string, jobsPath?: string) {
    this.dbPath = dbPath ?? runsDbPath();
    this.jobsPath = jobsPath ?? jobsDir();
  }

  open(): void {
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
    const json = JSON.stringify(job);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO jobs (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
      )
      .run(job.id, json, now);
    // File-based persistence: jobs dir is source of truth
    const filePath = join(this.jobsPath, `${job.id}.json`);
    writeFileSync(filePath, json, 'utf-8');
  }

  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT json FROM jobs WHERE id = ?').get(id) as
      | { json: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.json) as Job;
  }

  listJobs(): Job[] {
    const rows = this.db.prepare('SELECT json FROM jobs ORDER BY id').all() as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as Job);
  }

  deleteJob(id: string): boolean {
    const changes = (this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id) as { changes: number }).changes;
    const filePath = join(this.jobsPath, `${id}.json`);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    return changes > 0;
  }

  /** Load jobs from the jobs directory (disk is source of truth on daemon start). */
  loadJobsFromDisk(): void {
    if (!existsSync(this.jobsPath)) return;
    const files = readdirSync(this.jobsPath).filter((f) => f.endsWith('.json'));
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
        }
      } catch {
        // skip malformed job files
      }
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
    return rows.map(rowToRun);
  }

  /** Get the most recent successful run for a job (for catchup calculation). */
  getLastRun(jobId: string): Run | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE job_id = ? AND status IN ('success','failed','timeout') ORDER BY started_at DESC LIMIT 1",
      )
      .get(jobId) as DbRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /** Count runs for a job started after a given epoch ms. */
  countRunsSince(jobId: string, since: number, excludeId?: string): number {
    if (excludeId) {
      const result = this.db
        .prepare('SELECT COUNT(*) as cnt FROM runs WHERE job_id = ? AND started_at >= ? AND id != ?')
        .get(jobId, since, excludeId) as { cnt: number };
      return result.cnt;
    }
    const result = this.db
      .prepare('SELECT COUNT(*) as cnt FROM runs WHERE job_id = ? AND started_at >= ?')
      .get(jobId, since) as { cnt: number };
    return result.cnt;
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
