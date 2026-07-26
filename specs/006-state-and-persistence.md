# 006: State and Persistence

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

## Summary

Crontick persists job definitions as individual JSON files (source of truth) and run
history in a SQLite database with WAL journaling. This spec defines the durability
guarantees, on-disk layout, schema shape, retention policies, and missed-fire/orphan
recovery behavior.

## Motivation

Reliable persistence ensures jobs survive daemon restarts, run history is queryable, and
a daemon that starts back up after any gap (crash, reboot, laptop sleep) can account for
what happened while it was down. The dual-storage model (JSON + SQLite) optimizes for
both human-editability of jobs and efficient querying of run history.

## Terminology

| Term | Definition |
|------|-----------|
| Data directory | Platform-specific root for all crontick state; resolved by `env-paths`. |
| Jobs directory | `<dataDir>/jobs/`; one JSON file per job. |
| runs.db | SQLite database (WAL) containing `jobs` (cache), `runs`, `run_logs`, and `job_schedule_state`. |
| Schema sidecar | `<id>.schema.json` alongside each job JSON file. |
| Schema creation | The full schema is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`. There is no migration ledger; a `runs.db` created by a crontick version before 1.0.0 is not a supported input (see ADR 0017). |
| Orphan run | A `queued` or `running` run left behind after a daemon crash or unclean shutdown; resolved on the next startup via a process-liveness check (see R-006-13). |
| Missed run | A terminal `missed`-status run recorded at daemon startup for a scheduled fire that occurred while no daemon process was running; never executed (see spec 004 R-004-28). |
| Schedule state | The `job_schedule_state` row for a job: its last-observed live tick, used to compute missed fires. |

## Requirements

### Functional requirements

- **R-006-1**: The data directory MUST be resolved from `CRONTICK_HOME` env var if set, otherwise from `env-paths('crontick', { suffix: '' }).data`.
- **R-006-2**: On Windows the default data directory MUST be `%LOCALAPPDATA%\crontick`.
- **R-006-3**: The `ensureDirs` function MUST create `<dataDir>/jobs/` and `<dataDir>/logs/` if they do not exist.
- **R-006-4**: Job JSON files MUST be the source of truth; on daemon start, `loadJobsFromDisk()` MUST reload all `.json` files (excluding `.schema.json`) from the jobs directory into the SQLite `jobs` table.
- **R-006-5**: `upsertJob()` MUST write both the SQLite row and the JSON file atomically (write file, then upsert row).
- **R-006-6**: `upsertJob()` MUST write a JSON Schema sidecar alongside the job file.
- **R-006-7**: `deleteJob()` MUST remove the SQLite row, the JSON file, and the schema sidecar.
- **R-006-8**: SQLite MUST use WAL journal mode and foreign keys enabled.
- **R-006-9**: The `runs` table MUST store: `id` (UUID PK), `job_id`, `started_at` (epoch ms), `ended_at`, `status`, `exit_code`, `error`, `duration_ms`, `pid` (nullable; the spawned child's process id, absent for `missed` runs), `output_truncated` (NOT NULL, default 0; set when captured output hits `retention.maxOutputBytesPerRun` -- see spec 003 R-003-27).
- **R-006-10**: The `run_logs` table MUST store: `id` (autoincrement PK), `run_id`, `stream` (stdout/stderr), `ts` (epoch ms), `chunk` (BLOB).
- **R-006-11**: Indexes MUST exist as `idx_runs_job_id_started_at` (`runs(job_id, started_at)`), `idx_runs_started_at` (`runs(started_at)`), and `idx_run_logs_run_id` (`run_logs(run_id)`). A narrower single-column `idx_runs_job_id` MUST NOT also be created, since the composite index serves every query it would.
- **R-006-12**: The full schema (all tables and indexes above, plus `job_schedule_state` per R-006-24) MUST be created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`. There MUST be no migration ledger, no versioned migration list, and no runtime schema-version check; a `runs.db` produced by a crontick version before 1.0.0 is explicitly unsupported input (see ADR 0017).
- **R-006-13**: On startup, `reconcileOrphanRuns(check)` MUST resolve every run left `queued` or `running` by a prior daemon process: `queued` runs (never spawned) MUST be canceled unconditionally; `running` runs MUST be checked against real process liveness using the recorded `pid` and `started_at` (comparing the process's actual start time within a tolerance, to detect pid reuse) -- a run whose process is confirmed alive, or whose check is inconclusive, MUST be adopted back into the runner rather than canceled; a run whose process is confirmed dead MUST be canceled with error set to `ORPHAN_RUN_ERROR_MESSAGE` (`"DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running"`, `src/errors.ts`), keyed by the structured code `ORPHAN_RUN_ERROR_CODE` (`"DAEMON_RESTART"`) rather than an ad hoc literal.
- **R-006-14**: `listRuns()` MUST support filtering by `jobId`, `since` (epoch ms), `status`, and `limit`; results MUST be ordered by `started_at DESC`.
- **R-006-15**: `appendLog()` MUST insert a new row into `run_logs` with the current timestamp.
- **R-006-16**: `getLogs()` MUST return all log entries for a run ordered by insertion order (id ASC).
- **R-006-17**: Malformed job JSON files (parse failure or schema validation failure) MUST be silently skipped during `loadJobsFromDisk()`.
- **R-006-18**: Config file MUST be located at `<dataDir>/config.json`.
- **R-006-19**: Config writes MUST be atomic (write to temp file, rename over original).
- **R-006-20**: The store MUST cap retained runs per job at `config.retention.maxRunsPerJob` (default 100, range 1-100,000). `Store.pruneRunsForJob()` MUST evict the oldest terminal runs (and their `run_logs`) once a job exceeds the cap, MUST NOT evict `running`/`queued` runs, and MUST tie-break same-timestamp evictions deterministically. `Store.pruneAllJobsRunHistory()` MUST run this reconciliation sweep across every job on daemon startup (reconciling any cap value that was changed while the daemon was not running), and `Store.setRunRetentionCap()` MUST let a running daemon apply an updated cap without restart, e.g. via `daemon reload` (see R-004-21).
- **R-006-24**: A `job_schedule_state` table MUST exist, keyed by `job_id` (PK, references `jobs.id`), storing `last_tick_at` (epoch ms, nullable) and `updated_at` (epoch ms). `recordTick(jobId, tickAtMs)` MUST upsert this row every time the scheduler observes a live tick for that job while the daemon is running.
- **R-006-25**: `getScheduleState(jobId)` MUST return the stored `last_tick_at` for a job, or `undefined` if the job has never ticked while a daemon was running (e.g. a brand-new job, or one created since the last daemon start).
- **R-006-26**: `recordMissedRun(jobId, firedAtMs)` MUST insert a terminal run row with `status = 'missed'`, no `pid`, `error` set to `MISSED_RUN_ERROR_MESSAGE` (`"MISSED: daemon was not running at the scheduled fire time"`, `src/daemon/store.ts`), and `started_at`/`ended_at` both set to the missed fire time. Missed runs MUST be ordinary rows subject to the same retention cap and `listRuns`/export behavior as any other terminal run.
- **R-006-27**: `importRuns(runs)` MUST bulk-insert previously-exported run rows (from `crontick export --include-runs`) as archival data only -- no execution, no scheduler interaction. It MUST be idempotent on `id` (`INSERT OR IGNORE`: a row already present is left untouched and not counted as imported), and MUST skip (without failing the whole call) any row whose `job_id` does not exist in this store, returning `{ imported, skipped: Array<{ id, error }> }`.

### Non-functional requirements

- **R-006-21**: The data directory layout SHOULD remain stable across minor versions.
- **R-006-22**: Adding new SQLite columns or tables SHOULD extend the single idempotent `CREATE TABLE/INDEX IF NOT EXISTS` schema pass (`IF NOT EXISTS` guards and `ALTER TABLE ... ADD COLUMN` where needed), not introduce a migration ledger; crontick 1.0.0 has no migration framework by design (see ADR 0017).
- **R-006-23**: The daemon SHOULD NOT hold exclusive locks on job JSON files (allow external inspection).

## Behavior

**On-disk layout**:
```
<dataDir>/
  config.json
  daemon.pid
  daemon.port
  daemon.ensure.lock
  jobs/
    <job-id>.json
    <job-id>.schema.json
  runs.db
  runs.db-wal
  runs.db-shm
  logs/
    daemon-YYYY-MM-DD.log
    daemon.ensure.log
```

**Store lifecycle**:
1. `store.open()` -> open SQLite, set WAL + FK pragmas, create the full schema in one idempotent pass (`CREATE TABLE/INDEX IF NOT EXISTS`; see R-006-12).
2. `store.loadJobsFromDisk()` -> read all valid job JSONs into SQLite `jobs` table.
3. Runtime: `upsertJob`, `deleteJob`, `insertRun`, `updateRun`, `appendLog`, `getLogs`, `listRuns`, `recordTick`, `getScheduleState`, `recordMissedRun`, `importRuns`, `reconcileOrphanRuns(check)`, `pruneRunsForJob`/`pruneAllJobsRunHistory`/`setRunRetentionCap`.
4. `store.close()` -> close SQLite connection.

**Schema creation**: There is no migration ledger and no schema-version table. `createSchema()` runs `CREATE TABLE IF NOT EXISTS` for `jobs`, `runs`, `run_logs`, and `job_schedule_state`, and `CREATE INDEX IF NOT EXISTS` for `idx_runs_job_id_started_at`, `idx_runs_started_at`, `idx_run_logs_run_id`, every time the store opens. A `runs.db` file produced by a crontick version before 1.0.0 (which used a `migrations` table and a different schema shape) is not a supported input; see ADR 0017 for the reasoning.

## Inputs and outputs

**Store constructor input**: `dbPath` (defaults to `runsDbPath()`), `jobsPath` (defaults to `jobsDir()`), `logger`.
**Job persistence input**: A validated `Job` object.
**Job persistence output**: JSON file + schema sidecar + SQLite row.
**Run query output**: `Run` objects with camelCase field names (mapped from snake_case DB columns).

## Edge cases and failure modes

- Data directory does not exist on first use: `ensureDirs` creates it recursively.
- SQLite file corrupted: Daemon fails to start (unhandled; user must delete/recreate).
- `runs.db` from a pre-1.0.0 crontick (with a `migrations` table and older schema shape): unsupported; not detected or auto-upgraded (see ADR 0017).
- Job JSON file is empty or invalid JSON: Silently skipped on load.
- Job JSON validates structurally but has unknown keys: Zod strict mode rejects; file skipped.
- Concurrent writes to runs.db: WAL mode allows single-writer; only one daemon runs.
- Disk full on job write: Write throws; operation fails at API level.
- Config file has syntax errors: `CONFIG_READ_ERROR` thrown with fix instructions.
- `importRuns()` given a run whose `job_id` no longer exists: that row is skipped and reported, the rest of the batch still imports.
- `reconcileOrphanRuns()`'s liveness check throws or cannot determine an answer: treated as inconclusive, and the run is adopted rather than canceled (favors not silently losing in-flight work over the smaller risk of double-running).

## Acceptance criteria

- [x] Jobs loaded from disk on daemon start (test file: `tests/store.test.ts`)
- [x] Malformed job files skipped (test file: `tests/store.test.ts`)
- [x] Orphan runs reconciled with liveness-checked adopt/cancel, not unconditional cancellation (test file: `tests/store.test.ts`, "reconcileOrphanRuns ..." describe block, lines 295-352; `tests/integration.persistence.test.ts`)
- [x] upsertJob writes both JSON file and SQLite (test file: `tests/store.test.ts`)
- [x] deleteJob removes file and row (test file: `tests/store.test.ts`)
- [x] Schema sidecar written (test file: `tests/store.test.ts`)
- [x] Schema created in one idempotent pass; re-opening the store does not error or duplicate schema objects (test file: `tests/store.test.ts`, "open() is idempotent...")
- [x] listRuns filters by jobId, since, status, and orders correctly (test file: `tests/store.test.ts`, "listRuns filters by status, surfacing missed runs distinctly..."; `tests/cli.test.ts`, "crontick runs list --status filters to the requested run status")
- [x] Config atomic write (test file: `tests/config.test.ts`)
- [x] Data directory creation on fresh install (test file: `tests/integration.daemon-lifecycle.test.ts`)
- [x] Retention/purge policy for old runs, capped at `retention.maxRunsPerJob` (default 100), enforced via `Store.pruneRunsForJob()`/`pruneAllJobsRunHistory()`, reload-applicable via `setRunRetentionCap()` without a restart (test files: `tests/store.test.ts`, `tests/integration.persistence.test.ts`, `tests/config.test.ts`)
- [x] `job_schedule_state`: `recordTick`/`getScheduleState` seed and advance a job's watermark (test file: `tests/store.test.ts`, "getScheduleState ..." / "recordTick ..." describe block, lines 275-294)
- [x] `recordMissedRun` inserts a terminal `missed` run with no pid, subject to the same retention cap as any other run (test file: `tests/store.test.ts`, lines 210-238)
- [x] `importRuns` bulk-restores exported run history idempotently, skipping rows for missing jobs (test file: `tests/cli.test.ts`, line ~760; `tests/mcp.test.ts`, line ~709)

## Out of scope

- Backup/restore tooling.
- Remote/cloud state sync.

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [004-daemon.md](004-daemon.md)
- `../docs/reference/`
- `../docs/architecture.md`
- `../docs/decisions/0017-no-migrations-for-first-release.md`
