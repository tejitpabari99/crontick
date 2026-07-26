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
| `idx_runs_job_id_started_at` | runs | `job_id, started_at` |
| `idx_runs_started_at` | runs | `started_at` |
| `idx_run_logs_run_id` | run_logs | `run_id` |

`idx_runs_job_id_started_at` (added by migration `002_run_retention_index`) replaced the
former single-column `idx_runs_job_id`: every query the old index served is served at
least as well by this composite index, and retention eviction needs an index-ordered
`(job_id, started_at)` walk to avoid a scan-then-sort on every `pruneRunsForJob()` call.

---

## Migrations

Defined in `MIGRATIONS` array in `src/daemon/store.ts`. Applied in order on `open()`,
tracked in the `migrations` table (by `name`).

| Migration | Effect |
|-----------|--------|
| `001_initial` | Creates all tables and the original indexes |
| `002_run_retention_index` | Drops `idx_runs_job_id`; adds `idx_runs_job_id_started_at` (see above) |

---

## Store Class

```ts
class Store {
  constructor(dbPath?: string, jobsPath?: string, logger?: Logger, runRetentionCap?: number);
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
  insertRun(jobId: string, startedAt?: number): Run; // also prunes the job's history to the cap, best-effort
  updateRun(id: string, update: Partial<...>): void;
  getRun(id: string): Run | undefined;
  listRuns(opts?: ListRunsOptions): Run[];

  // Log CRUD
  appendLog(runId, stream, chunk: Buffer): void;
  getLogs(runId: string): RunLog[];
  tailLogs(runId: string, sinceTs: number): RunLog[];

  // Maintenance
  reconcileOrphanRuns(): number;
  setRunRetentionCap(cap: number): void; // used by `crontick daemon reload` to apply a changed cap live
  pruneAllJobsRunHistory(cap?: number): number; // startup backfill across every job_id in `runs`
}
```

`runRetentionCap` defaults to `100` inside `Store` itself, but that internal default is not
the public one — the public default lives in `BUILT_IN_CONFIG.retention.maxRunsPerJob`
(`src/config.ts`) and is what `crontick daemon` actually passes in. The constructor default
only matters for callers (mostly tests) that construct a `Store` directly without going
through config loading.

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
`'running'` or `'queued'` to `'canceled'` with `error` set to
`ORPHAN_RUN_ERROR_MESSAGE` (`'DAEMON_RESTART: run was canceled because the
daemon restarted while it was queued or running'`, exported from
`src/errors.ts` and re-exported from the package root) and current timestamp
as `ended_at`. This handles the case where the daemon crashed while runs were
in progress. This is a stored `runs.error` value, not a thrown `CrontickError`
— see [error-model.md](../concepts/error-model.md).

---

## Run Retention

Every `insertRun()` call also prunes that job's history down to
`retention.maxRunsPerJob` (default `100`, see
[configuration.md](../reference/configuration.md)). A startup backfill
(`pruneAllJobsRunHistory()`) additionally sweeps every job on daemon boot, to
catch databases that grew past the cap before retention existed, or after the
cap was lowered.

**What gets evicted.** For a given job, the oldest runs by `started_at ASC,
rowid ASC` are deleted first, but only from the *terminal* set — runs with
`status NOT IN ('running', 'queued')`. An in-flight run is never evicted no
matter how old it is; this can let a job's total row count temporarily exceed
the cap by the number of currently-active runs. `run_logs` rows for an evicted
run are deleted before the `runs` row itself (there is no `FK CASCADE`
between them — see the SQLite Schema section above), so a crash mid-eviction
can only ever leave a run with no logs, never an orphaned log row with no
parent run.

**Batching.** Eviction happens in batches of 500 ids per transaction
(`EVICTION_BATCH_SIZE` in `src/daemon/store.ts`), not as one unbounded
statement. This exists because `node:sqlite` rejects more than 32766 bound
parameters per statement (`SQLITE_LIMIT_VARIABLE_NUMBER`): an unbatched
`DELETE ... WHERE id IN (?,?,...)` with one placeholder per evicted row would
hit that ceiling on any job whose backlog grew past roughly 32766 terminal
runs before the cap existed — exactly the databases the startup backfill is
meant to fix, so the daemon could fail to start again. 500 ids per batch also
bounds how long any single transaction holds the table, which matters when
the backfill has to walk tens of thousands of rows across many jobs. Each
batch is its own `BEGIN`/`COMMIT` transaction, so a crash or thrown error
mid-run only rolls back the batch in progress; every previously committed
batch stays evicted. The loop recomputes the remaining-to-evict count from
the database every iteration and stops the instant a batch returns zero
candidates or fewer than `EVICTION_BATCH_SIZE` rows.

**Failure handling.** Both the per-insert prune and the startup backfill are
best-effort: retention is maintenance, not correctness. A failure is logged
(`Run retention prune failed; run was still recorded` / `...backfill failed
for job; continuing with other jobs`) and never fails the run insert or
blocks daemon startup — see [daemon.md](./daemon.md) for the startup
sequence. The backfill is also per-job try/catch, so one job's failure does
not abort the sweep for every other job.

**Reload.** `crontick daemon reload` re-reads `retention.maxRunsPerJob` from
config and calls `setRunRetentionCap()`, so a changed cap takes effect
immediately for both future inserts and the next backfill, without a daemon
restart — see [daemon.md](./daemon.md).

**Known limitation.** The cap is a per-job *count* only; there is no
age-based or byte-based limit. A job that runs every minute keeps roughly 100
minutes of history, while a job that runs monthly keeps years. Nothing bounds
the size of a single run's captured output, so one run with very large
stdout/stderr can still produce a large `run_logs` row regardless of the run
count. Eviction is a hard delete: there is no export, warning, dry-run, or
undo for removed run history. See
[state-and-storage.md](../concepts/state-and-storage.md) for the
user-facing framing of these limitations, and
[0012-run-history-retention.md](../decisions/0012-run-history-retention.md)
for the design rationale.

---

## JSON Job File Format

Each `<id>.json` contains the full `Job` object as serialized by
`JSON.stringify(normalizeJobForPersistence(job))`. The normalization step
clears `reuseSession` to `false` when a `sessionId` is already captured,
preventing the capture logic from running again on subsequent starts.
