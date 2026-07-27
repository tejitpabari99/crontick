# State and Storage

After reading this page you will understand where crontick stores data, what format each piece uses, and how to safely inspect or reset state.

## Data directory location

The data directory root is resolved by `src/paths.ts`:

1. If `CRONTICK_HOME` is set, use that path.
2. Otherwise, use `env-paths('crontick', { suffix: '' }).data`, which resolves to:
   - **Windows**: `%LOCALAPPDATA%\crontick`
   - **macOS**: `~/Library/Application Support/crontick`
   - **Linux**: `~/.local/share/crontick`

## Directory layout

```
<dataDir>/
  config.json              User configuration (engines, defaultEngine)
  daemon.pid               PID of running daemon
  daemon.port              Port of daemon API
  daemon.ensure.lock       Startup coordination lock
  jobs/
    <id>.json              Job definition (source of truth)
    <id>.schema.json       JSON Schema sidecar for editor support
  runs.db                  SQLite database (WAL mode)
  logs/
    daemon-YYYY-MM-DD.log  Daemon runtime logs (JSON lines)
    daemon.ensure.log      Demand-start output capture
```

## JSON files: the source of truth for jobs

Each job is stored as a standalone JSON file in `jobs/<id>.json`. These files are the authoritative job definitions. On daemon startup, `Store.loadJobsFromDisk()` reads every `.json` file (excluding `.schema.json` sidecars), validates each through `JobSchema`, and upserts into the SQLite `jobs` table.

The `.schema.json` sidecar is a JSON Schema generated from the Zod `JobSchema` via `zod-to-json-schema`. It enables IDE validation and autocompletion when editing job files directly.

## SQLite: runs, logs, schedule state

The `runs.db` file is opened with `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. The
full schema is created in one idempotent pass on open -- there is no migration ledger and no
prior on-disk shape to reconcile; a `runs.db` created by a crontick version before 1.0.0 is not a
supported input (see [ADR 0017](../decisions/0017-no-migrations-for-first-release.md)). It
contains:

| Table | Purpose |
|-------|---------|
| `jobs` | Cache of job definitions (rebuilt from disk on start) |
| `runs` | Run execution records: status, exit code, timing, spawned `pid`, output-truncation flag |
| `run_logs` | Stdout/stderr chunks per run, ordered by insertion |
| `job_schedule_state` | Per-job "last observed ticking" watermark, used to compute missed fires on restart |

Run statuses: `queued`, `running`, `success`, `failed`, `canceled`, `timeout`, `missed` (a fire
the schedule would have produced while the daemon was not running, recorded but never executed --
see [daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down)).

Key indexes: `idx_runs_job_id_started_at`, `idx_runs_started_at`, `idx_run_logs_run_id`.

## Single-writer assumption

Only the daemon process writes to `runs.db` and the `jobs/` directory at runtime. The CLI, MCP server, and library API all go through the daemon's HTTP API. There is no multi-process locking on the database beyond SQLite's own WAL mechanism.

## Durability

- **Job definitions** are durable the moment `writeFileSync` returns for the JSON file.
- **Runs** are durable per SQLite WAL commit. Each `insertRun`, `updateRun`, and `appendLog` call is a separate synchronous statement.
- **Logs** (daemon runtime) use `appendFileSync` to the daily log file; they survive crashes up to the last flushed line.

## Run history retention

Each job retains at most `retention.maxRunsPerJob` runs (default `100`,
configurable `1..100000` — see [configuration reference](../reference/configuration.md)).
When a job's terminal run count (runs not currently `running` or `queued`)
exceeds the cap, the oldest terminal runs are deleted, along with their
`run_logs`. Active runs are never evicted. Pruning runs on every new run, and
also as a startup pass (`pruneAllJobsRunHistory()`) that catches a job whose
cap was just lowered via `crontick daemon reload` but that hasn't ticked since
-- not an upgrade or backfill step. Pruning is best-effort: a pruning failure
is logged but never fails a run or blocks daemon startup. Lowering or raising
`retention.maxRunsPerJob` takes effect on `crontick daemon reload`, without a
restart. See [storage internals](../internals/storage.md) for the eviction algorithm.

**Design boundaries** (deliberate, not oversights):

- The cap is a per-job **count** only — there is no age-based limit. A job that fires every
  minute keeps roughly 100 minutes of history; a job that fires monthly keeps years of history
  under the same cap.
- Eviction is a hard delete with no dry-run or confirmation prompt. If you need to keep runs
  beyond the cap, back them up first with `crontick export --include-runs` (round-trips via
  `crontick import`), or raise `retention.maxRunsPerJob` before the cap would evict them.

A single run's own captured stdout/stderr is bounded separately by
`retention.maxOutputBytesPerRun` (default 2,000,000 bytes, range `1024..1_000_000_000`); once a
run hits that cap, further output is dropped and `outputTruncated` is set on the run, but its
`run_logs` size no longer grows without bound. See
[execution.md](./execution.md#stdoutstderr-capture) for the truncation behavior.

See [ADR 0012](../decisions/0012-run-history-retention.md) for why the cap is
count-based rather than age-based, and why eviction is best-effort.

## Daemon log retention

`retention.maxLogFiles` (default `30`, configurable `1..3650`) bounds how many daily
`logs/daemon-YYYY-MM-DD.log` files are kept; the oldest files beyond the cap are deleted, keeping
the newest. Applied at daemon startup and again on `crontick daemon reload` (a lowered value
takes effect immediately, without a restart). Pruning is best-effort: a failure is logged but
never blocks startup or reload. See [configuration reference](../reference/configuration.md#retentionconfig).

## Inspecting state

```bash
# View all job definitions
ls <dataDir>/jobs/*.json

# Query runs
sqlite3 <dataDir>/runs.db "SELECT id, job_id, status, started_at FROM runs ORDER BY started_at DESC LIMIT 10;"

# View daemon logs
cat <dataDir>/logs/daemon-$(date +%F).log | jq .
```

## Resetting state safely

1. **Stop the daemon first**: `crontick daemon stop`
2. **Delete runs only**: remove `runs.db` (the daemon recreates it with a fresh schema on next start).
3. **Delete everything**: remove the entire data directory. Jobs, runs, logs, and config will all be lost.
4. **Delete one job**: `crontick delete <id>` removes the JSON file, schema sidecar, and SQLite
   row, and cancels the job's in-flight run if it has one -- see
   [jobs.md](./jobs.md#lifecycle-create-update-remove).

## Further reading

- [Daemon lifecycle](./daemon-lifecycle.md) - startup, port/pid files, shutdown
- [Configuration reference](../reference/configuration.md) - `config.json` schema and CLI
- [Architecture](../architecture.md) - data flow diagram
