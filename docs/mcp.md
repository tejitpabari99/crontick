# MCP server

crontick exposes a **stdio-only** MCP server. There is no HTTP MCP transport in v1.

## Start it

```sh
crontick mcp
```

Helpful flags:

- `--daemon-url <url>` — override the daemon base URL
- `--no-daemon-start` — do not start the daemon if it is not already running

Environment variables:

- `CRONTICK_DAEMON_URL=http://127.0.0.1:<port>`
- `CRONTICK_MCP_NO_DAEMON_START=1`

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
Prompt actions use exactly one of `prompt` or `promptFile`, optional `engine` (`copilot` or
`agency`), raw `args`, and either `sessionId` or `reuseSession`. `promptFile` is resolved and read
by the shared client/core before the normalized job is persisted.

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
- `crontick_dashboard_open`
- `crontick_doctor`

## Resources

- `crontick://jobs`
- `crontick://jobs/{id}`
- `crontick://runs/{id}`
- `crontick://runs/{id}/log`
- `crontick://schemas/job`

## Prompts

- `create-scheduled-script`
- `investigate-failed-run`

## Validation model

Tool schemas are derived from the shared core/client schemas. The MCP server validates tool input,
then calls `CrontickClient`; normalization, prompt runtime checks, daemon lifecycle, doctor checks,
and JSON schema generation all live in shared core modules.
