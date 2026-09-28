# 006: State and Persistence

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors changing the store, schema, or retention behavior. Non-duplication: this
spec is the normative contract; for the user-facing model see
[concepts/state-and-storage.md](../concepts/state-and-storage.md), and for the schema/column
detail see [internals/storage.md](../internals/storage.md).

## Summary

Crontick persists job definitions as individual JSON files (source of truth) and run history in
a SQLite database with WAL journaling. This spec defines the durability guarantees, on-disk
layout, schema shape, retention policies, and missed-fire/orphan recovery behavior.

## Motivation

Reliable persistence ensures jobs survive daemon restarts, run history is queryable, and a
daemon that starts back up after any gap (crash, reboot, laptop sleep) can account for what
happened while it was down. The dual-storage model (JSON + SQLite) optimizes for both
human-editability of jobs and efficient querying of run history.

## Terminology

| Term | Definition |
|------|-----------|
| Data directory | Platform-specific root for all crontick state; resolved by `env-paths`. |
| Jobs directory | `<dataDir>/jobs/`; one JSON file per job. |
| runs.db | SQLite database (WAL) containing `jobs` (cache), `runs`, `run_logs`, and `job_schedule_state`. |
| Schema creation | The full schema is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`. There is no migration ledger; a `runs.db` created by a crontick version before 1.0.0 is not a supported input (see ADR 0001). |
| Orphan run | A `queued` or `running` run left behind after a daemon crash or unclean shutdown; resolved on the next startup via a process-liveness check. |
| Missed run | A terminal `missed`-status run recorded at daemon startup for a scheduled fire that occurred while no daemon was running; never executed (see spec 004 R-004-28). |
| Read-time redaction | Defensive masking applied when config values, run rows, log lines, or dashboard payloads are returned from user-facing read surfaces. |

## Requirements

### Functional requirements

- **R-006-1**: The data directory MUST be resolved from `CRONTICK_HOME` env var if set, otherwise from `env-paths('crontick', { suffix: '' }).data`.
- **R-006-2**: On Windows the default data directory MUST be `%LOCALAPPDATA%\crontick`.
- **R-006-3**: `ensureDirs` MUST create `<dataDir>/jobs/` and `<dataDir>/logs/` if they do not exist.
- **R-006-4**: Job JSON files MUST be the source of truth; on daemon start, `loadJobsFromDisk()` MUST reload all `.json` files (excluding `.schema.json`) into the SQLite `jobs` table.
- **R-006-5**: `upsertJob()` MUST write both the SQLite row and the JSON file atomically (write file, then upsert row).
- **R-006-6**: `upsertJob()` MUST write a JSON Schema sidecar alongside the job file.
- **R-006-7**: `deleteJob()` MUST remove the SQLite job row, the JSON file, and the schema sidecar. It MUST NOT cascade-delete `runs`/`run_logs`: deleted-job run history remains directly queryable by run id, but current-job aggregate views MUST exclude runs whose parent job row no longer exists.
- **R-006-8**: SQLite MUST use WAL journal mode with foreign keys enabled.
- **R-006-9**: The `runs` table MUST store: `id`, `job_id`, `started_at`, `ended_at`, `status`, `exit_code`, `error`, `duration_ms`, `pid` (nullable, absent for `missed`), `output_truncated`, `session_id` (nullable), `command` (nullable), `cost_usd`, `turns`, `usage_json`, and `transcript_path` (all nullable, Claude-only). The `jobs` table MUST store `id`, `alias`, `json`, `updated_at`.
- **R-006-10**: The `run_logs` table MUST store `id`, `run_id`, `stream`, `ts`, `chunk` (BLOB).
- **R-006-11**: Indexes MUST exist as `idx_runs_job_id_started_at`, `idx_runs_started_at`, `idx_run_logs_run_id`, and `idx_jobs_alias` (unique partial, `WHERE alias IS NOT NULL`). A narrower single-column `idx_runs_job_id` MUST NOT also be created.
- **R-006-12**: The full schema MUST be created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`, with no migration ledger, no versioned migration list, and no runtime schema-version check; a `runs.db` produced before 1.0.0 is unsupported input (see ADR 0001).
- **R-006-13**: On startup, `reconcileOrphanRuns(check)` MUST resolve every run left `queued`/`running`: `queued` runs are canceled unconditionally; `running` runs are checked against real process liveness (pid + start-time tolerance, to detect pid reuse) -- alive or inconclusive MUST be adopted back into the runner; confirmed-dead MUST first use a valid Claude completion marker (spec 004 R-004-34), or otherwise be canceled with `ORPHAN_RUN_ERROR_MESSAGE`/`ORPHAN_RUN_ERROR_CODE`.
- **R-006-14**: `listRuns()` MUST support filtering by `jobId`, `since`, `status`, and `limit`; results ordered by `started_at DESC`.
- **R-006-15**: `appendLog()` MUST insert a new row into `run_logs` with the current timestamp; text-like output is expected to have already passed through runner redaction.
- **R-006-16**: `getLogs()` MUST return all log entries for a run ordered by insertion order.
- **R-006-17**: Malformed job JSON files MUST be silently skipped during `loadJobsFromDisk()`.
- **R-006-18**: Config file MUST be at `<dataDir>/config.json`; read helpers MUST accept a leading UTF-8 BOM and report file path, parse position, and expected shape on malformed JSON via `CONFIG_READ_ERROR`.
- **R-006-19**: Config writes MUST be atomic (write to temp file, rename over original).
- **R-006-20**: The store MUST cap retained runs per job at `config.retention.maxRunsPerJob` (default 100, range 1-100,000), evicting the oldest terminal runs (and their `run_logs`) via `pruneRunsForJob()`, never evicting `running`/`queued` runs. `pruneAllJobsRunHistory()` MUST sweep every job on startup; `setRunRetentionCap()` MUST let a running daemon apply a changed cap without restart.
- **R-006-24**: A `job_schedule_state` table MUST exist, keyed by `job_id`, storing `last_tick_at` and `updated_at`. `recordTick(jobId, tickAtMs)` MUST upsert this row on every live tick.
- **R-006-25**: `getScheduleState(jobId)` MUST return the stored `last_tick_at`, or `undefined` if never ticked while a daemon was running.
- **R-006-26**: `recordMissedRun(jobId, firedAtMs)` MUST insert a terminal `missed` run with no `pid` and `error: MISSED_RUN_ERROR_MESSAGE`, subject to the same retention cap as any other run.
- **R-006-27**: `importRuns(runs)` MUST bulk-insert exported run rows as archival data only. Each row MUST be validated individually against `RunImportSchema`; an invalid row or one whose `job_id` does not exist MUST be skipped (recorded in `skipped`) without aborting the batch. It MUST be idempotent on `id` (`INSERT OR IGNORE`), returning `{ imported, skipped }`, then run `pruneRunsForJob()` once per affected job.
- **R-006-27a**: Imported run rows MUST NOT restore the internal Claude completion marker. An imported Claude job with a session ID lacking an independently trusted local completed run MUST have the ID cleared and start a fresh session; raw-engine jobs retain their stored session ID.
- **R-006-28**: Read surfaces serializing config values, run rows, run logs, or dashboard payloads MUST apply the shared redaction contract defensively at read time as well.
- **R-006-29**: Library config read helpers MUST redact returned secret-like values without mutating `config.json` on disk, using high-confidence normalized suffix matching for key hints.

### Non-functional requirements

- **R-006-21**: The data directory layout SHOULD remain stable across minor versions.
- **R-006-22**: New SQLite columns/tables SHOULD extend the single idempotent schema pass, never a migration ledger or `ALTER TABLE` upgrade step (see ADR 0001).
- **R-006-23**: The daemon SHOULD NOT hold exclusive locks on job JSON files.

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

**Store lifecycle**: `open()` (WAL + FK pragmas, idempotent schema pass) -> `loadJobsFromDisk()`
-> runtime CRUD (`upsertJob`, `deleteJob`, `insertRun`, `updateRun`, `appendLog`, `listRuns`,
`recordTick`, `recordMissedRun`, `importRuns`, `reconcileOrphanRuns`,
`pruneRunsForJob`/`pruneAllJobsRunHistory`/`setRunRetentionCap`) -> `close()`. There is no
`ALTER TABLE` upgrade step; every column is declared directly in its `CREATE TABLE`.

## Inputs and outputs

**Store constructor input**: `dbPath` (default `runsDbPath()`), `jobsPath` (default `jobsDir()`), `logger`.
**Job persistence output**: JSON file + schema sidecar + SQLite row.
**Run query output**: `Run` objects with camelCase field names.

## Edge cases and failure modes

- Data directory does not exist on first use: `ensureDirs` creates it recursively.
- SQLite file corrupted: daemon fails to start (user must delete/recreate).
- `runs.db` from a pre-1.0.0 crontick: unsupported; not detected or auto-upgraded.
- Job JSON file empty, invalid, or schema-invalid: silently skipped on load.
- Concurrent writes to `runs.db`: WAL mode allows a single writer; only one daemon runs.
- Deleting a job with historical runs: direct `getRun`/`getLogs` by run id still works; aggregate views exclude the archived rows.
- `importRuns()` given a run whose `job_id` no longer exists: that row is skipped and reported.
- `reconcileOrphanRuns()`'s liveness check throws or is inconclusive: the run is adopted rather than canceled.
- Secret-like text already present in persisted logs or config: read surfaces still redact it defensively.

## Acceptance criteria

- [x] Jobs loaded from disk on daemon start; malformed job files skipped (test file: `tests/store.test.ts`)
- [x] Orphan runs reconciled with liveness-checked adopt/cancel (test file: `tests/store.test.ts`; `tests/integration.persistence.test.ts`)
- [x] upsertJob writes both JSON file and SQLite; schema sidecar written (test file: `tests/store.test.ts`)
- [x] deleteJob removes the job file/row while preserving deleted-job run history for direct reads and excluding it from aggregate views (test files: `tests/store.test.ts`, `tests/stats-excludes-deleted-job-runs.test.ts`)
- [x] Schema created in one idempotent pass; re-opening the store does not error or duplicate schema objects (test file: `tests/store.test.ts`)
- [x] listRuns filters by jobId, since, status, and orders correctly (test files: `tests/store.test.ts`, `tests/cli.test.ts`)
- [x] Config atomic write; BOM-prefixed JSON accepted; structured parse diagnostics on malformed JSON (test file: `tests/config.test.ts`)
- [x] Data directory creation on fresh install (test file: `tests/integration.daemon-lifecycle.test.ts`)
- [x] Retention/purge policy enforced via `pruneRunsForJob()`/`pruneAllJobsRunHistory()`, reload-applicable via `setRunRetentionCap()` (test files: `tests/store.test.ts`, `tests/integration.persistence.test.ts`, `tests/config.test.ts`)
- [x] `job_schedule_state`: `recordTick`/`getScheduleState` seed and advance a job's watermark (test file: `tests/store.test.ts`)
- [x] `recordMissedRun` inserts a terminal `missed` run with no pid, subject to the same retention cap (test file: `tests/store.test.ts`)
- [x] `importRuns` validates each row individually, skips malformed rows without aborting, is idempotent on `id`, and prunes affected jobs afterward (test file: `tests/store.test.ts`; `tests/cli.test.ts`; `tests/mcp.test.ts`)
- [x] Read-time redaction applies consistently across config, run, log, and dashboard read surfaces (test file: `tests/secret-redaction.test.ts`)

## Out of scope

- Backup/restore tooling.
- Remote/cloud state sync.

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [004-daemon.md](004-daemon.md)
- [../internals/storage.md](../internals/storage.md)
- [../concepts/state-and-storage.md](../concepts/state-and-storage.md)
- [../decisions/0001-architecture-and-runtime-model.md](../decisions/0001-architecture-and-runtime-model.md)
