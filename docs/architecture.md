# Architecture

## High-level view

```text
+-----------------+        stdio         +-------------------+
| MCP host / LLM  | <------------------> | crontick-mcp      |
+-----------------+                      +-------------------+
                                               |
                                               v
+-----------------+                  +-------------------+
| crontick CLI    | ----------------> | CrontickClient    |
+-----------------+                  | shared core       |
                                     +-------------------+
                                               |
                                               | loopback HTTP
                                               v
                                      +-------------------+
                                      | crontick-daemon   |
                                      |  - API server     |
                                      |  - Scheduler      |
                                      |  - Runner         |
                                      |  - Store          |
                                      +-------------------+
                                               |        |
                                               |        +--> child processes
                                               +--> SQLite + job JSON files
```

## Module map

- `src/cli/index.ts` — Commander CLI adapter over `CrontickClient`
- `src/client.ts` — exported programmatic client and shared daemon transport surface
- `src/logger.ts` — shared structured logger, level filtering, and redaction
- `src/doctor.ts` — shared structured health checks for CLI/MCP/client
- `src/dashboard.ts` — shared dashboard status/data model and asset resolution
- `src/schema-json.ts` — shared JSON Schema generation for job sidecars and MCP schema resource
- `src/daemon/index.ts` — daemon startup, single-instance guard, reload, signal handling
- `src/daemon/api.ts` — loopback-only HTTP API and dashboard serving
- `src/daemon/ensure.ts` — shared on-demand daemon start/probe logic for CLI, MCP, and client
- `src/daemon/lifecycle.ts` — shared explicit start/stop/restart helpers
- `src/daemon/prompt-session.ts` — prompt-engine session id extraction helpers
- `src/daemon/scheduler.ts` — cron/interval/one-shot scheduling, preview, validation
- `src/daemon/runner.ts` — process execution, overlap, retry, timeout, log redaction
- `src/daemon/store.ts` — SQLite-backed runs/logs + JSON job persistence
- `src/job-input.ts` — shared create/update/import normalization and prompt-file handling
- `src/mcp/index.ts` — MCP tools and job-schema resource over `CrontickClient`

## Daemon lifecycle

The daemon is demand-started by daemon-backed CLI, MCP, and client operations, but it is not
supervised. A daemon-backed operation checks for a healthy loopback daemon, makes a best-effort start
or reconnect with bounded retry if needed, then returns an actionable error if startup/connect still
fails. crontick does not install an OS service or keep-alive process; if the daemon dies while idle,
scheduled jobs pause until the next daemon-backed operation or `crontick daemon start`.

## Data flow

1. Job is created through CLI, client, or MCP; CLI and MCP only parse inputs and call `CrontickClient`.
2. Client/core inputs are normalized (`promptFile` is read into `prompt`); persisted payloads are validated by `JobSchema`.
3. Store persists the job as JSON and mirrors it into SQLite metadata.
4. Scheduler registers cron/interval/one-shot timers.
5. On tick, daemon inserts a queued run and Runner executes a `script`, `exec`, or `prompt` action.
6. Runner appends redacted stdout/stderr chunks to SQLite; verbose daemon runs add concise
   crontick diagnostic lines without dumping model output.
7. Client/core exposes run state, logs, stats, health, dashboard status/data, doctor, and daemon lifecycle; CLI/MCP format those results and render structured log events per transport.

## Persistence

- jobs: `<dataDir>/jobs/*.json`
- runs/logs: `<dataDir>/runs.db`
- daemon state: pid/port files and daemon logs in `<dataDir>/logs/`

On startup the daemon reloads jobs from disk and reconciles orphaned `running` runs to `canceled` with `error = daemon-restart`.

## Logging and verbose mode

Core modules emit `error`, `warn`, `info`, or `debug` events through `src/logger.ts`; they do not
write to stdout/stderr. CLI renders verbose events to stderr, MCP returns diagnostics in tool results,
the public client exposes `verbose`/`onLog`, and the daemon writes JSON lines to
`<dataDir>/logs/daemon-YYYY-MM-DD.log` plus demand-start output in `daemon.ensure.log`.
