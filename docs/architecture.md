# Architecture

## High-level view

```text
+-----------------+        stdio         +-------------------+
| MCP host / LLM  | <------------------> | crontick-mcp      |
+-----------------+                      +-------------------+
                                               |
                                               | loopback HTTP
                                               v
+-----------------+   jobs/runs/logs   +-------------------+
| crontick CLI    | <----------------> | crontick-daemon   |
+-----------------+                    |  - API server     |
                                       |  - Scheduler      |
                                       |  - Runner         |
                                       |  - Store          |
                                       +-------------------+
                                                |        |
                                                |        +--> child processes
                                                +--> SQLite + job JSON files
```

## Module map

- `src/cli/index.ts` — Commander CLI and daemon client helpers
- `src/daemon/index.ts` — daemon startup, single-instance guard, reload, signal handling
- `src/daemon/api.ts` — loopback-only HTTP API and dashboard serving
- `src/daemon/scheduler.ts` — cron/interval/one-shot scheduling, preview, validation, catchup
- `src/daemon/runner.ts` — process execution, overlap, retry, timeout, budgets, log redaction
- `src/daemon/store.ts` — SQLite-backed runs/logs + JSON job persistence
- `src/mcp/index.ts` — MCP tool/resource/prompt layer over the local daemon API
- `src/autostart/*` — platform-specific autostart backends

## Data flow

1. Job is created through CLI, API, or MCP.
2. `JobSchema` validates the payload.
3. Store persists the job as JSON and mirrors it into SQLite metadata.
4. Scheduler registers cron/interval/one-shot timers.
5. On tick, daemon inserts a queued run and Runner executes the action.
6. Runner appends redacted stdout/stderr chunks to SQLite.
7. API and MCP expose run state, logs, stats, and health.

## Persistence

- jobs: `<dataDir>/jobs/*.json`
- runs/logs: `<dataDir>/runs.db`
- daemon state: pid/port files and daily daemon logs

On startup the daemon reloads jobs from disk and reconciles orphaned `running` runs to `canceled` with `error = daemon-restart`.
