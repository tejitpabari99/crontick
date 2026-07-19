# MCP server

crontick exposes a **stdio-only** MCP server. There is no HTTP MCP transport in v1.

## Start it

```sh
crontick mcp
```

Helpful flags:

- `--no-autostart` — do not start the daemon automatically
- `--daemon-url <url>` — override the daemon base URL

Environment variables:

- `CRONTICK_MCP_NO_AUTOSTART=1`
- `CRONTICK_DAEMON_URL=http://127.0.0.1:<port>`

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
- `crontick_autostart_status`
- `crontick_autostart_install`
- `crontick_autostart_remove`
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

Tool input is validated with Zod before daemon calls are made. Invalid inputs return structured MCP tool errors instead of crashing the server.

## Autostart behavior

On launch, the MCP server checks whether the daemon is already healthy. If not, it attempts to start the daemon unless `--no-autostart` or `CRONTICK_MCP_NO_AUTOSTART=1` is set.
