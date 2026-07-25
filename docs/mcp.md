# MCP server

crontick exposes a **stdio-only** MCP server. There is no HTTP MCP transport in v1.

## Start it

```sh
crontick mcp
```

Helpful flags:

- `--daemon-url <url>` — override the daemon base URL
- `--no-start-daemon` — set `startDaemon=false` so tools do not demand-start the daemon
- global `--verbose` / `-v` on `crontick mcp` — pass verbose diagnostics through to clients/daemon

Environment variables:

- `CRONTICK_DAEMON_URL=http://127.0.0.1:<port>`
- `CRONTICK_MCP_START_DAEMON=0` — disable MCP demand-start
- `CRONTICK_VERBOSE=1` — enable crontick diagnostics

By default MCP tools use `startDaemon=true`: daemon-backed tools make a best-effort demand-start if
no healthy daemon is reachable. This is not supervision; if the daemon dies while idle, it stays down
until the next daemon-backed operation or an explicit `crontick daemon start`.

Every `crontick_*` tool accepts optional `verbose: true`. When enabled, tool JSON is wrapped as
`{ "result": ..., "diagnostics": [...] }` (or `{ "error": ..., "diagnostics": [...] }` on errors).
Diagnostics are structured, redacted crontick events; MCP stdout remains reserved for JSON-RPC.

## Tool groups

### Jobs

- `crontick_job_create`
- `crontick_job_list`
- `crontick_job_get`
- `crontick_job_update`
- `crontick_job_delete`
- `crontick_job_enable`
- `crontick_job_disable`
- `crontick_job_run_now`
- `crontick_job_cancel_run`

`crontick_job_create` and `crontick_job_update` accept action kinds `script`, `exec`, and `prompt`.
Prompt actions use exactly one of `prompt` or `promptFile`, optional configured `engine`, raw
`args`, and session controls. Explicit `sessionId` wins over `reuseSession`; if both
are provided, the shared client/core stores `reuseSession: false` and returns a notice. `promptFile`
is resolved and read by the shared client/core before the normalized job is persisted.

### Runs

- `crontick_run_list`
- `crontick_run_get`
- `crontick_run_logs_tail`

### Scheduling and stats

- `crontick_schedule_validate`
- `crontick_schedule_preview`
- `crontick_stats_summary`
- `crontick_stats_job`

### Daemon and admin

- `crontick_daemon_status`
- `crontick_daemon_reload`
- `crontick_daemon_restart`
- `crontick_export`
- `crontick_import`
- `crontick_doctor`

### Dashboard

- `crontick_dashboard_start`
- `crontick_dashboard_status`
- `crontick_dashboard_data`
- `crontick_dashboard_stop`

### Config

- `crontick_config_get`
- `crontick_config_set`
- `crontick_config_unset`
- `crontick_config_engine_list`
- `crontick_config_engine_add`
- `crontick_config_engine_update`
- `crontick_config_engine_remove`
- `crontick_config_init`
- `crontick_config_validate`

## Resources

- `crontick://schemas/job`

## Validation model

Tool schemas are derived from the shared core/client schemas. The MCP server validates tool input,
then calls `CrontickClient`; normalization, prompt runtime checks, daemon lifecycle, doctor checks,
and JSON schema generation all live in shared core modules.
