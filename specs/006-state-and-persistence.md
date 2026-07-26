# 006: State and Persistence

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

## Summary

Crontick persists job definitions as individual JSON files (source of truth) and run
history in a SQLite database with WAL journaling. This spec defines the durability
guarantees, on-disk layout, retention policies, migration strategy, and compatibility
expectations.

## Motivation

Reliable persistence ensures jobs survive daemon restarts, run history is queryable, and
upgrades do not lose user data. The dual-storage model (JSON + SQLite) optimizes for
both human-editability of jobs and efficient querying of run history.

## Terminology

| Term | Definition |
|------|-----------|
| Data directory | Platform-specific root for all crontick state; resolved by `env-paths`. |
| Jobs directory | `<dataDir>/jobs/`; one JSON file per job. |
| runs.db | SQLite database (WAL) containing runs, run_logs, jobs cache, migrations. |
| Schema sidecar | `<id>.schema.json` alongside each job JSON file. |
| Migration | A named SQL script applied once; tracked in the `migrations` table. |
| Orphan run | A run left in `queued` or `running` state after a daemon crash. |

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
- **R-006-9**: The `runs` table MUST store: `id` (UUID PK), `job_id`, `started_at` (epoch ms), `ended_at`, `status`, `exit_code`, `error`, `duration_ms`.
- **R-006-10**: The `run_logs` table MUST store: `id` (autoincrement PK), `run_id`, `stream` (stdout/stderr), `ts` (epoch ms), `chunk` (BLOB).
- **R-006-11**: Indexes MUST exist on `runs.job_id`, `runs.started_at`, and `run_logs.run_id`.
- **R-006-12**: Migrations MUST be tracked in a `migrations` table (`id`, `name` UNIQUE, `applied_at`).
- **R-006-13**: On startup, `reconcileOrphanRuns()` MUST set all `queued`/`running` runs to `canceled` with error set to `ORPHAN_RUN_ERROR_MESSAGE` (`"DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running"`, `src/errors.ts`), keyed by the structured code `ORPHAN_RUN_ERROR_CODE` (`"DAEMON_RESTART"`) rather than an ad hoc literal.
- **R-006-14**: `listRuns()` MUST support filtering by `jobId`, `since` (epoch ms), and `limit`; results MUST be ordered by `started_at DESC`.
- **R-006-15**: `appendLog()` MUST insert a new row into `run_logs` with the current timestamp.
- **R-006-16**: `getLogs()` MUST return all log entries for a run ordered by insertion order (id ASC).
- **R-006-17**: Malformed job JSON files (parse failure or schema validation failure) MUST be silently skipped during `loadJobsFromDisk()`.
- **R-006-18**: Config file MUST be located at `<dataDir>/config.json`.
- **R-006-19**: Config writes MUST be atomic (write to temp file, rename over original).
- **R-006-20**: The store MUST cap retained runs per job at `config.retention.maxRunsPerJob` (default 100, range 1-100,000). `Store.pruneRunsForJob()` MUST evict the oldest terminal runs (and their `run_logs`) once a job exceeds the cap, MUST NOT evict `running`/`queued` runs, and MUST tie-break same-timestamp evictions deterministically. `Store.pruneAllJobsRunHistory()` MUST run this backfill across every job on daemon startup, and `Store.setRunRetentionCap()` MUST let a running daemon apply an updated cap without restart (see R-004-21/reload).

### Non-functional requirements

- **R-006-21**: The data directory layout SHOULD remain stable across minor versions.
- **R-006-22**: Adding new SQLite columns SHOULD be done via new migrations, not by altering existing ones.
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
1. `store.open()` -> open SQLite, set WAL + FK pragmas, run migrations.
2. `store.loadJobsFromDisk()` -> read all valid job JSONs into SQLite `jobs` table.
3. Runtime: `upsertJob`, `deleteJob`, `insertRun`, `updateRun`, `appendLog`, `getLogs`, `listRuns`.
4. `store.close()` -> close SQLite connection.

**Migration application**:
1. Ensure `migrations` table exists.
2. Read applied migration names.
3. For each unapplied migration in order: exec SQL, insert into migrations.

Applied migrations include `001_initial` (base schema) and `002_run_retention_index` (adds the index `pruneRunsForJob`/`pruneAllJobsRunHistory` scan by, supporting R-006-20).

## Inputs and outputs

**Store constructor input**: `dbPath` (defaults to `runsDbPath()`), `jobsPath` (defaults to `jobsDir()`), `logger`.
**Job persistence input**: A validated `Job` object.
**Job persistence output**: JSON file + schema sidecar + SQLite row.
**Run query output**: `Run` objects with camelCase field names (mapped from snake_case DB columns).

## Edge cases and failure modes

- Data directory does not exist on first use: `ensureDirs` creates it recursively.
- SQLite file corrupted: Daemon fails to start (unhandled; user must delete/recreate).
- Job JSON file is empty or invalid JSON: Silently skipped on load.
- Job JSON validates structurally but has unknown keys: Zod strict mode rejects; file skipped.
- Concurrent writes to runs.db: WAL mode allows single-writer; only one daemon runs.
- Disk full on job write: Write throws; operation fails at API level.
- Config file has syntax errors: `CONFIG_READ_ERROR` thrown with fix instructions.

## Acceptance criteria

- [x] Jobs loaded from disk on daemon start (test file: `tests/store.test.ts`)
- [x] Malformed job files skipped (test file: `tests/store.test.ts`)
- [x] Orphan runs reconciled (test file: `tests/integration.persistence.test.ts`)
- [x] upsertJob writes both JSON file and SQLite (test file: `tests/store.test.ts`)
- [x] deleteJob removes file and row (test file: `tests/store.test.ts`)
- [x] Schema sidecar written (test file: `tests/store.test.ts`)
- [x] Migrations applied in order (test file: `tests/store.test.ts`)
- [x] listRuns filters and orders correctly (test file: `tests/store.test.ts`)
- [x] Config atomic write (test file: `tests/config.test.ts`)
- [x] Data directory creation on fresh install (test file: `tests/integration.daemon-lifecycle.test.ts`)
- [x] Retention/purge policy for old runs, capped at `retention.maxRunsPerJob` (default 100), enforced via `Store.pruneRunsForJob()`/`pruneAllJobsRunHistory()` and migration `002_run_retention_index` (test files: `tests/store.test.ts`, `tests/integration.persistence.test.ts`, `tests/config.test.ts`)

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
