# 006: State and Persistence

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors changing the store, schema, or retention behavior. Non-duplication: this
spec is the normative contract; for the user-facing model see
[concepts/state-and-storage.md](../concepts/state-and-storage.md), and for the schema/column
detail see [implementation/storage.md](../implementation/storage.md).

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
| runs.db | SQLite database (WAL) containing `jobs` (cache), `runs`, `run_outputs`, and `job_schedule_state`. |
| Schema creation | The full schema is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`. There are no migrations (see ADR 0001). |
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
- **R-006-7**: `deleteJob()` MUST, in one transaction, remove the job's `run_outputs`, `runs` and `job_schedule_state` rows and the SQLite job row, then best-effort unlink the JSON file, the schema sidecar and the per-job log file. Deleted jobs leave no run history on any surface. `setRunOutput()`/`updateRun()` MUST NOT create or resurrect rows for a run that no longer exists.
- **R-006-8**: SQLite MUST use WAL journal mode with foreign keys enabled.
- **R-006-9**: The `runs` table MUST store: `id`, `job_id`, `started_at`, `ended_at`, `status`, `exit_code`, `error`, `duration_ms`, `pid` (nullable, absent for `missed`), `output_truncated`, `session_id` (nullable), `command` (nullable), `cost_usd`, `turns`, `usage_json`, and `transcript_path` (all nullable, Claude-only). The `jobs` table MUST store `id`, `alias`, `json`, `updated_at`.
- **R-006-10**: The `run_outputs` table MUST store `run_id` (primary key), `format`, `result`, `engine_error`, `output`, `stderr`, `truncated` -- the parsed engine output of a finished run. No table MAY store the engine's raw stdout/stderr.
- **R-006-11**: Indexes MUST exist as `idx_runs_job_id_started_at`, `idx_runs_started_at`, and `idx_jobs_alias` (unique partial, `WHERE alias IS NOT NULL`). A narrower single-column `idx_runs_job_id` MUST NOT also be created.
- **R-006-12**: The full schema MUST be created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()`, with no migration ledger, no versioned migration list, and no runtime schema-version check (see ADR 0001).
- **R-006-13**: On startup, `reconcileOrphanRuns(check)` MUST resolve every run left `queued`/`running`: `queued` runs are canceled unconditionally; `running` runs are checked against real process liveness (pid + start-time tolerance, to detect pid reuse) -- alive or inconclusive MUST be adopted back into the runner; confirmed-dead MUST first use a valid Claude completion marker (spec 004 R-004-34), or otherwise be canceled with `ORPHAN_RUN_ERROR_MESSAGE`/`ORPHAN_RUN_ERROR_CODE`.
- **R-006-14**: `listRuns()` MUST support filtering by `jobId`, `since`, `status`, and `limit`; results ordered by `started_at DESC`.
- **R-006-15**: `setRunOutput()` MUST insert or replace the run's `run_outputs` row, and MUST do nothing for a run that no longer exists; text-like output is expected to have already passed through runner redaction.
- **R-006-16**: `getRunOutput()` MUST return the stored parsed output of a run, or `undefined` when the run produced none (skipped, missed, still running).
- **R-006-17**: Malformed job JSON files MUST be silently skipped during `loadJobsFromDisk()`.
- **R-006-18**: Config file MUST be at `<dataDir>/config.json`; read helpers MUST accept a leading UTF-8 BOM and report file path, parse position, and expected shape on malformed JSON via `CONFIG_READ_ERROR`.
- **R-006-19**: Config writes MUST be atomic (write to temp file, rename over original).
- **R-006-20**: The store MUST cap retained runs per job at `config.retention.maxRunsPerJob` (default 100, range 1-100,000), evicting the oldest terminal runs (and their `run_outputs`) via `pruneRunsForJob()`, never evicting `running`/`queued` runs. `pruneAllJobsRunHistory()` MUST sweep every job on startup; `setRunRetentionCap()` MUST let a running daemon apply a changed cap without restart.
- **R-006-24**: A `job_schedule_state` table MUST exist, keyed by `job_id`, storing `last_tick_at` and `updated_at`. `recordTick(jobId, tickAtMs)` MUST upsert this row on every live tick.
- **R-006-25**: `getScheduleState(jobId)` MUST return the stored `last_tick_at`, or `undefined` if never ticked while a daemon was running.
- **R-006-26**: `recordMissedRun(jobId, firedAtMs)` MUST insert a terminal `missed` run with no `pid` and `error: MISSED_RUN_ERROR_MESSAGE`, subject to the same retention cap as any other run.
- **R-006-27**: Run history MUST NOT be importable: `importRuns` and `RunImportSchema` do not exist and `share import` ignores any `runs` payload.
- **R-006-27a**: An imported Claude job with a session ID lacking an independently trusted local completed run MUST have the ID cleared and start a fresh session; raw-engine jobs retain their stored session ID.
- **R-006-28**: Read surfaces serializing config values, run rows, run output, or dashboard payloads MUST apply the shared redaction contract defensively at read time as well.
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
-> runtime CRUD (`upsertJob`, `deleteJob`, `insertRun`, `updateRun`, `setRunOutput`, `listRuns`,
`recordTick`, `recordMissedRun`, `reconcileOrphanRuns`,
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
- Deleting a job with historical runs: its runs and stored output are deleted with it; `getRun` by a deleted run id returns `NOT_FOUND`.
- `reconcileOrphanRuns()`'s liveness check throws or is inconclusive: the run is adopted rather than canceled.
- Secret-like text already present in stored output or config: read surfaces still redact it defensively.

## Acceptance criteria

- [x] Jobs loaded from disk on daemon start; malformed job files skipped (test file: `tests/unit/store.test.ts`)
- [x] Orphan runs reconciled with liveness-checked adopt/cancel (test file: `tests/unit/store.test.ts`; `tests/unit/integration.persistence.test.ts`)
- [x] upsertJob writes both JSON file and SQLite; schema sidecar written (test file: `tests/unit/store.test.ts`)
- [x] deleteJob removes the job file/row together with its runs, stored output, schedule state and log file (test files: `tests/unit/store.test.ts`, `tests/unit/stats-excludes-deleted-job-runs.test.ts`)
- [x] Schema created in one idempotent pass; re-opening the store does not error or duplicate schema objects (test file: `tests/unit/store.test.ts`)
- [x] listRuns filters by jobId, since, status, and orders correctly (test files: `tests/unit/store.test.ts`, `tests/unit/cli.test.ts`)
- [x] Config atomic write; BOM-prefixed JSON accepted; structured parse diagnostics on malformed JSON (test file: `tests/unit/config.test.ts`)
- [x] Data directory creation on fresh install (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] Retention/purge policy enforced via `pruneRunsForJob()`/`pruneAllJobsRunHistory()`, reload-applicable via `setRunRetentionCap()` (test files: `tests/unit/store.test.ts`, `tests/unit/integration.persistence.test.ts`, `tests/unit/config.test.ts`)
- [x] `job_schedule_state`: `recordTick`/`getScheduleState` seed and advance a job's watermark (test file: `tests/unit/store.test.ts`)
- [x] `recordMissedRun` inserts a terminal `missed` run with no pid, subject to the same retention cap (test file: `tests/unit/store.test.ts`)
- [x] Share import validates the whole file, assigns new ids, suffixes alias collisions and never imports runs (test files: `tests/unit/api.test.ts`; `tests/unit/cli.test.ts`; `tests/unit/mcp.test.ts`)
- [x] Read-time redaction applies consistently across config, run, log, and dashboard read surfaces (test file: `tests/unit/secret-redaction.test.ts`)

## Out of scope

- Backup/restore tooling.
- Remote/cloud state sync.

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [004-daemon.md](004-daemon.md)
- [../implementation/storage.md](../implementation/storage.md)
- [../concepts/state-and-storage.md](../concepts/state-and-storage.md)
- [../decisions/0001-architecture-and-runtime-model.md](../decisions/0001-architecture-and-runtime-model.md)
