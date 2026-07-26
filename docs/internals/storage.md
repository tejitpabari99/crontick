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

## Schema

Database: `<root>/runs.db`. Opened with `node:sqlite` `DatabaseSync`. The full schema (tables and
indexes) is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS` pass on `open()` --
there is no migration ledger and no prior on-disk shape to reconcile. A `runs.db` created by a
crontick version before 1.0.0 is not a supported input; see
[ADR 0017](../decisions/0017-no-migrations-for-first-release.md).

### Pragma settings (set on every `open()`)

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
```

### Tables

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
| `status` | TEXT | NOT NULL (queued/running/success/failed/canceled/timeout/missed) |
| `exit_code` | INTEGER | nullable |
| `error` | TEXT | nullable |
| `duration_ms` | INTEGER | nullable |
| `pid` | INTEGER | nullable (set once the child process is spawned; absent for `missed` runs, which never spawn a process) |
| `output_truncated` | INTEGER | NOT NULL DEFAULT 0 (0/1; set once captured output hits `retention.maxOutputBytesPerRun`) |

#### `run_logs`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `run_id` | TEXT | NOT NULL |
| `stream` | TEXT | NOT NULL (stdout/stderr) |
| `ts` | INTEGER | NOT NULL (epoch ms) |
| `chunk` | BLOB | NOT NULL |

#### `job_schedule_state`

| Column | Type | Constraints |
|--------|------|-------------|
| `job_id` | TEXT | PRIMARY KEY |
| `last_tick_at` | INTEGER | NOT NULL (epoch ms; the last time this job was observed ticking live) |
| `updated_at` | INTEGER | NOT NULL (epoch ms) |

One row per job that has ticked at least once while a daemon was running (`Store.recordTick()`
upserts it on every tick). It is the watermark the daemon startup sequence uses to compute missed
fires -- see [Missed-Fire Reporting](#missed-fire-reporting) below. A job with no row here has
never been observed live, so no gap can be computed for it yet.

### Indexes

| Name | Table | Columns |
|------|-------|---------|
| `idx_runs_job_id_started_at` | runs | `job_id, started_at` |
| `idx_runs_started_at` | runs | `started_at` |
| `idx_run_logs_run_id` | run_logs | `run_id` |

`idx_runs_job_id_started_at` is a composite `(job_id, started_at)` index; the single-column
`idx_runs_job_id` it would otherwise shadow is deliberately never created, since every query the
narrower index could serve is served at least as well by this one, and retention eviction needs
an index-ordered `(job_id, started_at)` walk to avoid a scan-then-sort on every
`pruneRunsForJob()` call.

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
  updateRun(id: string, update: Partial<...>): void; // carries pid, outputTruncated, status incl. 'missed'
  getRun(id: string): Run | undefined;
  listRuns(opts?: ListRunsOptions): Run[]; // opts.status filters to a single RunStatus
  recordMissedRun(jobId: string, firedAt: number): Run; // inserts a terminal 'missed' run, no process spawned
  importRuns(runs: Run[]): { imported: number; skipped: number }; // bulk archival restore; INSERT OR IGNORE; skips rows for jobs that no longer exist

  // Log CRUD
  appendLog(runId, stream, chunk: Buffer): void;
  getLogs(runId: string): RunLog[];
  tailLogs(runId: string, sinceTs: number): RunLog[];

  // Schedule state (job_schedule_state table)
  recordTick(jobId: string, tickAt: number): void; // upserts the live-tick watermark
  getScheduleState(jobId: string): { lastTickAt: number } | undefined;

  // Maintenance
  reconcileOrphanRuns(check?: (pid: number, startedAt: number) => boolean | undefined): { canceled: number; adopted: number };
  setRunRetentionCap(cap: number): void; // used by `crontick daemon reload` to apply a changed cap live
  pruneAllJobsRunHistory(cap?: number): number; // reload-triggered cap-reconciliation sweep across every job_id in `runs`
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

On daemon startup, `reconcileOrphanRuns(check?)` walks every run left in status `'running'` or
`'queued'` from a previous daemon process (crash, kill, unclean shutdown) and resolves each one:

- **`queued`** runs never reached a spawn, so they are always canceled: `status: 'canceled'`,
  `error: ORPHAN_RUN_ERROR_MESSAGE`, `ended_at` set to now.
- **`running`** runs are checked against real process liveness using the recorded `pid` and
  `started_at`, via the `check(pid, startedAt)` callback (`createProcessLivenessCheck()` from
  `src/process-liveness.ts` in production; documented alongside the runner in
  [executors.md](./executors.md#process-liveness)):
  - `true` (process alive and its start time matches within tolerance) -> **adopted**: the run
    stays `running`; the daemon hands its `(jobId, runId, pid)` to `Runner.adoptRun()` so overlap
    tracking (`skip`/`cancel-previous`) and log tailing resume as if the daemon never restarted.
  - `false` (process confirmed dead, or a different process now holds that pid -- detected by
    comparing recorded vs. actual start time) -> **canceled**, same as a `queued` run.
  - `undefined` (liveness cannot be determined -- e.g. a platform call failed) -> **adopted**.
    Reconciliation is deliberately optimistic on inconclusive checks: adopting a run that already
    finished only costs one wasted poll before the adoption loop notices it exited, while
    canceling a run that is still legitimately running would falsely mark healthy work as
    orphaned. See [ADR 0016](../decisions/0016-detached-children-cross-platform.md) for why this
    matters equally on Windows and POSIX.

The function returns `{ canceled, adopted }` counts, both surfaced in the daemon's startup log.
This is a stored `runs.error` value, not a thrown `CrontickError` — see
[error-model.md](../concepts/error-model.md).

---

## Missed-Fire Reporting

Also on daemon startup, before jobs are (re)scheduled, the daemon compares each enabled job's
`job_schedule_state.last_tick_at` watermark against now, using `Scheduler.enumerateFiresBetween()`
(see [scheduler.md](./scheduler.md)) to compute exactly which scheduled fires happened while no
daemon process was running. For each missed fire, `Store.recordMissedRun(jobId, firedAt)` inserts
a terminal `runs` row with `status: 'missed'` and `error: MISSED_RUN_ERROR_MESSAGE` -- no process
is spawned, so `pid` stays null on these rows. A job that has never ticked (no
`job_schedule_state` row) gets its watermark seeded from the current time instead, since there is
no prior observation to diff against. Reporting per job is capped at
`MISSED_FIRE_CAP_PER_JOB` (500, `src/daemon/index.ts`); a job that exceeds the cap gets a single
capped summary instead of 500+ individual rows, to avoid the reconciliation pass itself flooding
`runs` on a long-idle machine. The results are aggregated into
`missedFireSummary: { jobsWithMissedFires, missedRunsRecorded, jobsCapped, capPerJob }`, returned
by `GET /api/daemon/status` (see [daemon.md](./daemon.md)).

Missed fires are **reported, never replayed**: the daemon never executes a job to "catch up" on
time it was not running. See [ADR 0015](../decisions/0015-report-missed-fires-not-replay.md) for
the reasoning, and [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md) for the
user-facing framing.

---

## Run Retention

Every `insertRun()` call also prunes that job's history down to
`retention.maxRunsPerJob` (default `100`, see
[configuration.md](../reference/configuration.md)). `pruneAllJobsRunHistory()` additionally
sweeps every job on daemon boot; its practical purpose is to reconcile a cap that was **lowered**
via `crontick daemon reload` while the daemon was down or between ticks for a quiet job, catching
up rows the per-insert prune had no opportunity to evict yet. It is not an upgrade step or a
schema migration — the schema itself needs no such step (see [Schema](#schema) above).

**What gets evicted.** For a given job, the oldest runs by `started_at ASC,
rowid ASC` are deleted first, but only from the *terminal* set — runs with
`status NOT IN ('running', 'queued')`. An in-flight run is never evicted no
matter how old it is; this can let a job's total row count temporarily exceed
the cap by the number of currently-active runs. `run_logs` rows for an evicted
run are deleted before the `runs` row itself (there is no `FK CASCADE`
between them — see the [Schema](#schema) section above), so a crash mid-eviction
can only ever leave a run with no logs, never an orphaned log row with no
parent run.

**Batching.** Eviction happens in batches of 500 ids per transaction
(`EVICTION_BATCH_SIZE` in `src/daemon/store.ts`), not as one unbounded
statement. This exists because `node:sqlite` rejects more than 32766 bound
parameters per statement (`SQLITE_LIMIT_VARIABLE_NUMBER`): an unbatched
`DELETE ... WHERE id IN (?,?,...)` with one placeholder per evicted row would
hit that ceiling on any job whose backlog grew past roughly 32766 terminal
runs before a cap reduction — exactly the databases the reload sweep is
meant to catch up, so the daemon could fail to start again. 500 ids per batch also
bounds how long any single transaction holds the table, which matters when
the sweep has to walk tens of thousands of rows across many jobs. Each
batch is its own `BEGIN`/`COMMIT` transaction, so a crash or thrown error
mid-run only rolls back the batch in progress; every previously committed
batch stays evicted. The loop recomputes the remaining-to-evict count from
the database every iteration and stops the instant a batch returns zero
candidates or fewer than `EVICTION_BATCH_SIZE` rows.

**Failure handling.** Both the per-insert prune and the reload sweep are
best-effort: retention is maintenance, not correctness. A failure is logged
(`Run retention prune failed; run was still recorded` / `...sweep failed
for job; continuing with other jobs`) and never fails the run insert or
blocks daemon startup — see [daemon.md](./daemon.md) for the startup
sequence. The sweep is also per-job try/catch, so one job's failure does
not abort the sweep for every other job.

**Reload.** `crontick daemon reload` re-reads `retention.maxRunsPerJob` from
config and calls `setRunRetentionCap()`, so a changed cap takes effect
immediately for both future inserts and the next sweep, without a daemon
restart — see [daemon.md](./daemon.md).

**Design boundaries.** The cap is a per-job *count* only; there is no
age-based limit. A job that runs every minute keeps roughly 100
minutes of history, while a job that runs monthly keeps years. A single run's captured
stdout/stderr is separately bounded by `retention.maxOutputBytesPerRun` (see
[executors.md](./executors.md#output-capture-cap)), so one run cannot itself produce an
unbounded `run_logs` row. Eviction is a hard delete with no automatic export, warning, dry-run,
or undo; a caller who wants to keep history past the cap must run
`crontick export --include-runs` *before* it is evicted (see
[cli.md](../reference/cli.md#export)) -- there is no automatic backup. See
[state-and-storage.md](../concepts/state-and-storage.md) for the
user-facing framing, and
[0012-run-history-retention.md](../decisions/0012-run-history-retention.md)
for the design rationale.

---

## JSON Job File Format

Each `<id>.json` contains the full `Job` object as serialized by
`JSON.stringify(normalizeJobForPersistence(job))`. The normalization step
clears `reuseSession` to `false` when a `sessionId` is already captured,
preventing the capture logic from running again on subsequent starts.
