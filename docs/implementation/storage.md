# Storage

Implements: `src/daemon/store.ts`, `src/paths.ts`

Audience: contributors changing the SQLite schema, retention, or restart-recovery logic.
Non-duplication: for the normative requirements see
[specs/006-state-and-persistence.md](../specs/006-state-and-persistence.md); for the user-facing
model see [concepts/state-and-storage.md](../concepts/state-and-storage.md).

Crontick uses a dual-persistence model: JSON files are the source of truth for job definitions;
SQLite (WAL mode) stores runs, logs, and a job cache for fast queries.

---

## File locations

Resolved by `src/paths.ts`. Root: `CRONTICK_HOME` env var, or `envPaths('crontick', { suffix: ''
}).data`.

| Path | Content |
|------|---------|
| `<root>/jobs/<id>.json` / `<id>.schema.json` | Canonical job definition + JSON Schema sidecar |
| `<root>/runs.db` (`-wal`/`-shm`) | SQLite database |
| `<root>/logs/daemon-YYYY-MM-DD.log`, `daemon.ensure.log` | Daemon logs, demand-start capture |
| `<root>/config.json`, `daemon.pid`, `daemon.port`, `daemon.ensure.lock` | Config, PID, port, startup lock |

`ensureDirs(env)` creates `dataDir`/`jobsDir`/`logsDir` with `mkdirSync({ recursive: true })`.

## Schema

Opened with `node:sqlite` `DatabaseSync`. The full schema is created in one idempotent `CREATE
TABLE/INDEX IF NOT EXISTS` pass on `open()` -- no migrations (see
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md)). `PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;` are set on every `open()`.

| Table | Key columns |
|-------|-------------|
| `jobs` | `id` (PK GUID), `alias` (nullable, unique via `idx_jobs_alias`), `json`, `updated_at` |
| `runs` | `id` (PK UUID), `job_id`, `started_at`, `ended_at`, `status`, `exit_code`, `error`, `duration_ms`, `pid` (nullable, absent for `missed`), `output_truncated`, `session_id`, `command`, `claude_result_completed` (internal resume-eligibility flag), `cost_usd`, `turns`, `usage_json`, `transcript_path`, `engine_status`, `trigger_json` (nullable; `{kind, upstream}` for `after` runs, set via `setRunTrigger`) |
| `run_outputs` | `run_id` (PK), `format` (`claude-stream-json`/`text`), `result`, `engine_error`, `stderr` -- the parsed engine output written when a run finishes. The engine's raw stdout/stderr is never stored |
| `job_failure_state` | `job_id` (PK), `consecutive_failures` -- consecutive failed runs per job (absent = 0); drives auto-disable |
| `job_schedule_state` | `job_id` (PK), `last_tick_at`, `updated_at` -- one row per job that has ticked live at least once |

Indexes: `idx_runs_job_id_started_at` (composite, also serves single-`job_id` lookups so a
narrower `idx_runs_job_id` is deliberately never added), `idx_runs_started_at`,
`idx_jobs_alias` (UNIQUE partial, `WHERE alias IS NOT NULL`, a
defense-in-depth backstop behind the app-level alias check in `api.ts`).

Imported run rows never restore `claude_result_completed` -- a Claude transcript has no crontick
job provenance; import clears unverified stored Claude session IDs so those jobs start fresh.

## Job reference resolution

`src/utils/job-ref.ts` holds the only id-or-alias lookup: `resolveJobRef(ref, { byId, byAlias })` (id first, then alias). `Store.getJob`, the `runs list` job filter, `share export --only-jobs` and `runs delete --job` all call it. `RESERVED_JOB_REFS` (`['all']`) lists aliases rejected by job validation because `jobs delete all` uses that keyword.

## Store class (abridged)

```ts
class Store {
  constructor(dbPath?: string, jobsPath?: string, logger?: Logger, runRetentionCap?: number);
  open(): void; close(): void;
  upsertJob(job: Job): void; getJob(ref): Job | undefined /* id or alias via resolveJobRef */; deleteJob(id): boolean;
  deleteRuns({ runIds | jobId, dryRun }): { deleted; skipped; notFound; jobLogRemoved };  // skips queued/running; run_outputs then runs in one txn
  deleteJobAndRuns(id): { jobId; deletedRuns } | undefined;  // one transaction: run_outputs, runs, schedule state, job
  loadJobsFromDisk(): void; tryCapturePromptSession(jobId, expectedAction, sessionId): boolean;
  insertRun(jobId, startedAt?): Run;        // also prunes the job's history to the cap
  updateRun(id, update): void;              // pid, outputTruncated, status incl. 'missed'
  listRuns(opts?): Run[];                   // opts.status filters to one RunStatus
  recordMissedRun(jobId, firedAt): Run;
  setRunOutput(runId, out: EngineOutput): void; getRunOutput(runId): EngineOutput | undefined;
  listDependents(upstreamId): Job[];        // jobs whose `after` schedule targets upstreamId (full scan)
  getBrokenJobs(): Map<id, AfterGraphError>; isJobBroken(id): boolean;  // set by loadJobsFromDisk's post-pass
  setRunTrigger(runId, trigger): void; getRunTrigger(runId): object | undefined;
  recordTick(jobId, tickAt): void; getScheduleState(jobId): { lastTickAt } | undefined;
  reconcileOrphanRuns(check?): { canceled: number; adopted: number };
  setRunRetentionCap(cap): void; pruneAllJobsRunHistory(cap?): number;
}
```

The constructor's `runRetentionCap` default (`100`) only matters for tests constructing a `Store`
directly; the public default is `BUILT_IN_CONFIG.retention.maxRunsPerJob`.

**Access pattern**: single writer (only the daemon opens `runs.db`); WAL allows concurrent reads.
`upsertJob()` writes both SQLite and the JSON file, which stays the source of truth
(`loadJobsFromDisk()` re-syncs SQLite from it on every startup).

## After-trigger graph

`validateAfterGraph(job, jobs)` (exported from `store.ts`) walks `after.jobId` pointers: `AFTER_CYCLE` when the walk reaches the job's own id (or loops on corrupt data), `AFTER_UPSTREAM_NOT_FOUND` when the first upstream is absent. `loadJobsFromDisk` still loads such jobs but records them in `getBrokenJobs()` with a warn log; they must not fire.

## Orphan reconciliation

On startup, `reconcileOrphanRuns(check?)` resolves every run left `running`/`queued` by a prior
daemon process:

- **`queued`**: never spawned, always canceled (`ORPHAN_RUN_ERROR_MESSAGE`).
- **`running`**, liveness `true` (alive, start time matches within tolerance): **adopted** --
  handed to `Runner.adoptRun()` so overlap tracking resumes (see
  [prompt-execution.md](./prompt-execution.md#adopting-runs-across-a-restart)).
- **`running`**, liveness `false` (confirmed dead, or pid reused): a valid Claude completion
  marker determines `success`/`failed` from its exit status; otherwise **canceled** like a
  `queued` run.
- **`running`**, liveness `undefined` (inconclusive): **adopted** -- optimistic, since adopting an
  already-finished run only costs one wasted poll, while canceling a live one falsely orphans real
  work.

Returns `{ canceled, adopted }`, logged at startup. `ORPHAN_RUN_ERROR_MESSAGE` is a stored
`runs.error` string, not a thrown `CrontickError` -- see [error-model.md](../concepts/error-model.md).

## Missed-fire reporting

Before jobs are (re)scheduled, the daemon compares each enabled job's
`job_schedule_state.last_tick_at` against now via `Scheduler.enumerateFiresBetween()` (see
[scheduler.md](./scheduler.md)) and records each missed fire with `recordMissedRun(jobId,
firedAt)` -- a terminal `runs` row, `status: 'missed'`, no `pid`. A job with no watermark yet has
one seeded instead. Capped at `MISSED_FIRE_CAP_PER_JOB` (500) per job. Results aggregate into
`missedFireSummary`, returned by `GET /api/daemon/status`. Missed fires are reported, never
replayed -- see [ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

## Run retention

Every `insertRun()` prunes that job's terminal runs (`status NOT IN ('running', 'queued')`) down
to `retention.maxRunsPerJob`, oldest-first; `run_outputs` rows are deleted before their parent `runs`
row (no FK cascade -- a crash mid-eviction leaves at worst a run without output). `pruneAllJobsRunHistory()`
sweeps every job at startup to catch a cap lowered while the daemon was down;
`setRunRetentionCap()` applies a reload-time change live. Eviction batches 500 ids per transaction
(`node:sqlite`'s ~32766 bound-parameter ceiling). Both paths are best-effort -- logged on failure,
never fail a run or block startup. See [ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

## Job deletion

`deleteJobAndRuns()` deletes a job's `run_outputs`, `runs`, `job_schedule_state` and `job_failure_state` rows and the job row in
one transaction, then unlinks the job JSON files and the per-job log file (`resolveJobLogPath`)
best-effort. Run history is not archived and there is no run import (`importRuns`/`RunImportSchema`
were removed with `share export --include-runs`). `setRunOutput()` only inserts for runs that still
exist and `updateRun()` ignores a vanished run, so a run that is still in flight when its job is
deleted cannot leave orphan rows.

## JSON job file format

Each `<id>.json` is `JSON.stringify(normalizeJobForPersistence(job))`; normalization clears
`reuseSession` to `false` once a `sessionId` has been captured, so capture never re-runs.
