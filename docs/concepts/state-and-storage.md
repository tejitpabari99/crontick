# State and Storage

Audience: users and contributors reasoning about where data lives and how it's retained.
Non-duplication: for the exact SQLite schema see [implementation/storage.md](../implementation/storage.md);
for the normative contract see
[specs/006-state-and-persistence.md](../specs/006-state-and-persistence.md).

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
  config.json              User configuration (engines, defaultEngine, retention, logging, job defaults)
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
full schema is created in one idempotent pass on open -- there is no migration ledger; a
`runs.db` created before 1.0.0 is not a supported input (see
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md)). Tables: `jobs` (cache,
rebuilt from disk on start), `runs` (status, exit code, timing, spawned `pid`,
output-truncation flag, and for engine runs `sessionId`, `costUsd`, `turns`, `usageJson`, `transcriptPath`, `engineStatus`), `run_logs` (stdout/stderr chunks, ordered by insertion), and
`job_schedule_state` (per-job "last observed ticking" watermark for missed-fire computation). See
[implementation/storage.md](../implementation/storage.md) for exact columns and indexes.

Run statuses: `queued`, `running`, `success`, `failed`, `canceled` (a started run that was
terminated), `skipped` (an overlap-skip fire that never started a process), `timeout`, `missed` (a
fire the schedule would have produced while the daemon was not running, recorded but never
executed -- see [daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down)).

## Single-writer assumption

Only the daemon process writes to `runs.db` and the `jobs/` directory at runtime. The CLI, MCP server, and library API all go through the daemon's HTTP API. There is no multi-process locking on the database beyond SQLite's own WAL mechanism.

## Durability

- **Job definitions** are durable the moment `writeFileSync` returns for the JSON file.
- **Runs** are durable per SQLite WAL commit. Each `insertRun`, `updateRun`, and `appendLog` call is a separate synchronous statement.
- **Logs** (daemon runtime) use `appendFileSync` to the daily log file; they survive crashes up to the last flushed line.

## Run history retention

Each job retains at most `retention.maxRunsPerJob` runs (default `100`, configurable
`1..100000`). The oldest terminal runs (never active ones) are deleted along with their
`run_logs` once the cap is exceeded, on every new run and in a startup sweep that catches a cap
just lowered via `crontick info daemon reload`. Pruning is best-effort and count-based only (no
age limit): a job firing every minute keeps ~100 minutes of history, one firing monthly keeps
years. Eviction is a hard delete with no undo -- back up first with `crontick share export
--include-runs` if you need history past the cap. See
[implementation/storage.md](../implementation/storage.md) for the eviction algorithm and
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md) for the rationale.

A single run's own captured stdout/stderr is bounded separately by
`retention.maxOutputBytesPerRun` (default 2,000,000 bytes); once hit, further output is dropped
and `outputTruncated` is set, but the run itself completes normally. See
[execution.md](./execution.md#log-streams-and-capture).

## Daemon log retention

`retention.maxLogFiles` (default `30`) bounds how many daily `logs/daemon-YYYY-MM-DD.log` files
are kept, oldest deleted first, applied at startup and on `crontick info daemon reload` without a
restart. Best-effort: a pruning failure is logged but never blocks startup or reload. See
[configuration reference](../reference/configuration.md#retentionconfig).

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

1. **Stop the daemon first**: `crontick info daemon stop`
2. **Delete runs only**: remove `runs.db` (the daemon recreates it with a fresh schema on next start).
3. **Delete everything**: remove the entire data directory. Jobs, runs, logs, and config will all be lost.
4. **Delete one job**: `crontick jobs delete <id>` removes the JSON file, schema sidecar, and SQLite
   row, and cancels the job's in-flight run if it has one -- see
   [jobs.md](./jobs.md#lifecycle-create-update-remove).

## Further reading

- [Daemon lifecycle](./daemon-lifecycle.md) - startup, port/pid files, shutdown
- [Configuration reference](../reference/configuration.md) - `config.json` schema and CLI
- [Architecture](../architecture.md) - data flow diagram
