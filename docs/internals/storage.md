# Storage

Implements: `src/daemon/store.ts`, `src/paths.ts`

Crontick uses a dual-persistence model: JSON files are the source of truth for
job definitions, while SQLite (WAL mode) stores runs, logs, and a job cache for
fast queries.

---

## File Locations

Resolved by `src/paths.ts`. Root: `CRONTICK_HOME` env var, or
`envPaths('crontick', { suffix: '' }).data` (on Windows: `%LOCALAPPDATA%\crontick`).

| Path | Function | Content |
|------|----------|---------|
| `<root>/` | `dataDir()` | Top-level data directory |
| `<root>/jobs/` | `jobsDir()` | Per-job JSON files |
| `<root>/jobs/<id>.json` | - | Canonical job definition |
| `<root>/jobs/<id>.schema.json` | - | JSON Schema sidecar for editors |
| `<root>/runs.db` | `runsDbPath()` | SQLite database |
| `<root>/logs/` | `logsDir()` | Daemon log files |
| `<root>/logs/daemon-YYYY-MM-DD.log` | - | Daily structured JSON log |
| `<root>/logs/daemon.ensure.log` | - | Demand-start output capture |
| `<root>/config.json` | `configPath()` | User configuration |
| `<root>/daemon.pid` | `pidFilePath()` | PID of running daemon |
| `<root>/daemon.port` | `portFilePath()` | Port of daemon HTTP API |
| `<root>/daemon.ensure.lock` | - | Exclusive startup lock |

`ensureDirs(env)` creates `dataDir`, `jobsDir`, and `logsDir` with
`mkdirSync({ recursive: true })`.

---

## SQLite Schema

Database: `<root>/runs.db`. Opened with `node:sqlite` `DatabaseSync`.

### Pragma settings (set on every `open()`)

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
```

### Tables

#### `migrations`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL UNIQUE |
| `applied_at` | INTEGER | NOT NULL (epoch ms) |

#### `jobs`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `json` | TEXT | NOT NULL (full Job JSON) |
| `updated_at` | INTEGER | NOT NULL (epoch ms) |

#### `runs`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `job_id` | TEXT | NOT NULL |
| `started_at` | INTEGER | NOT NULL (epoch ms) |
| `ended_at` | INTEGER | nullable |
| `status` | TEXT | NOT NULL (queued/running/success/failed/canceled/timeout) |
| `exit_code` | INTEGER | nullable |
| `error` | TEXT | nullable |
| `duration_ms` | INTEGER | nullable |

#### `run_logs`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `run_id` | TEXT | NOT NULL |
| `stream` | TEXT | NOT NULL (stdout/stderr) |
| `ts` | INTEGER | NOT NULL (epoch ms) |
| `chunk` | BLOB | NOT NULL |

### Indexes

| Name | Table | Columns |
|------|-------|---------|
| `idx_runs_job_id` | runs | `job_id` |
| `idx_runs_started_at` | runs | `started_at` |
| `idx_run_logs_run_id` | run_logs | `run_id` |

---

## Migrations

Defined in `MIGRATIONS` array in `src/daemon/store.ts`. Currently one migration
(`001_initial`) creates all tables and indexes. The `migrations` table tracks
which migrations have been applied (by `name`). New migrations are appended to
the array and applied in order on `open()`.

---

## Store Class

```ts
class Store {
  constructor(dbPath?: string, jobsPath?: string, logger?: Logger);
  open(): void;
  close(): void;

  // Job CRUD
  upsertJob(job: Job): void;
  getJob(id: string): Job | undefined;
  listJobs(): Job[];
  deleteJob(id: string): boolean;
  loadJobsFromDisk(): void;
  tryCapturePromptSession(jobId, expectedAction, sessionId): boolean;

  // Run CRUD
  insertRun(jobId: string, startedAt?: number): Run;
  updateRun(id: string, update: Partial<...>): void;
  getRun(id: string): Run | undefined;
  listRuns(opts?: ListRunsOptions): Run[];

  // Log CRUD
  appendLog(runId, stream, chunk: Buffer): void;
  getLogs(runId: string): RunLog[];
  tailLogs(runId: string, sinceTs: number): RunLog[];

  // Maintenance
  reconcileOrphanRuns(): number;
}
```

---

## Read/Write Access Patterns

- **Single writer**: only the daemon process opens the database.
- **WAL mode**: allows concurrent reads from the same process without blocking
  writes. No external readers are expected.
- **Job persistence**: `upsertJob()` writes to both SQLite and the JSON file.
  The JSON file is the source of truth; on daemon start `loadJobsFromDisk()`
  re-syncs SQLite from disk.
- **Schema sidecar**: alongside each `<id>.json`, a `<id>.schema.json` is
  written containing the JSON Schema output of `jobJsonSchemaText()`.

---

## Orphan Reconciliation

On daemon startup, `reconcileOrphanRuns()` sets all runs with status
`'running'` or `'queued'` to `'canceled'` with `error = 'daemon-restart'` and
current timestamp as `ended_at`. This handles the case where the daemon crashed
while runs were in progress.

---

## JSON Job File Format

Each `<id>.json` contains the full `Job` object as serialized by
`JSON.stringify(normalizeJobForPersistence(job))`. The normalization step
clears `reuseSession` to `false` when a `sessionId` is already captured,
preventing the capture logic from running again on subsequent starts.
