# MCP Tools Reference

Complete reference for the crontick MCP server tool surface.

## Server Registration

- **Name:** `crontick`
- **Version:** build-injected from `package.json` (currently `0.1.1`)
- **Transport:** `StdioServerTransport` (stdio, JSON-RPC 2.0)
- **SDK:** `@modelcontextprotocol/sdk` v1.17

### Launch

```bash
crontick mcp
```

Or directly:

```bash
node dist/mcp/index.js
```

### MCP Host Configuration (Claude Desktop / Copilot / Cursor)

```json
{
  "mcpServers": {
    "crontick": { "command": "crontick", "args": ["mcp"] }
  }
}
```

### Environment Variables Affecting MCP

| Variable | Effect |
|----------|--------|
| `CRONTICK_MCP_START_DAEMON` | Set to `"0"` to disable demand-start of the daemon |
| `CRONTICK_VERBOSE` | `1\|true\|yes\|on\|debug` enables verbose diagnostics in results |

---

## Common Input: `verbose`

Every tool accepts an optional `verbose: boolean` parameter. When `true` (or when `CRONTICK_VERBOSE` is set), the tool result wraps the payload in `{ result: ..., diagnostics: [...] }` instead of returning the raw result.

## Result Shape

Success:

```json
{ "content": [{ "type": "text", "text": "<JSON payload>" }] }
```

Error:

```json
{ "content": [{ "type": "text", "text": "<JSON with error key>" }], "isError": true }
```

Error messages are redacted via `redactForLlm()`: loopback addresses become `<daemon-addr>`, filesystem paths become `<path>`.

---

## Tools

### crontick_job_create

Create and schedule a new cron job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID (kebab-case) |
| `description` | `string` | no | — | Job description |
| `enabled` | `boolean` | no | `true` | Whether job is active |
| `schedule` | `Schedule` | yes | — | Schedule object (see [job-schema.md](job-schema.md)) |
| `action` | `ActionInput` | yes | — | Action with `kind` discriminator; prompt actions accept `promptFile` instead of `prompt` |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | `"skip"` | Overlap policy |
| `retry` | `{ max: number, backoffSec: number }` | no | `{ max: 0, backoffSec: 30 }` | Retry config |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** The created `Job` object.

---

### crontick_job_list

List all scheduled jobs with their current status and next run time.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Array of `Job` objects.

---

### crontick_job_get

Get the full definition and status of a specific job by ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `Job` object.

---

### crontick_job_update

Update an existing job (partial update merged with existing definition).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `description` | `string` | no | — | Job description |
| `enabled` | `boolean` | no | — | Enable/disable |
| `schedule` | `Schedule` | no | — | New schedule |
| `action` | `ActionInput` | no | — | New action |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | — | Overlap policy |
| `retry` | `{ max: number, backoffSec: number }` | no | — | Retry config |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

---

### crontick_job_delete

Permanently delete a job and all its run history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true, canceledRun: boolean }` — `canceledRun` is `true` when the job had an
in-flight run that was canceled as part of the delete (see
[jobs.md](../concepts/jobs.md#lifecycle-create-update-remove)).

---

### crontick_job_enable

Enable a disabled job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

---

### crontick_job_disable

Disable a job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

---

### crontick_job_run_now

Trigger an immediate run of a job, bypassing its schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ runId: string }`

---

### crontick_job_cancel_run

Cancel an in-progress run by its run ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | yes | — | Run ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true, canceled: boolean }`

---

### crontick_run_list

List recent runs, optionally filtered by job ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jobId` | `string` | no | — | Filter by job ID |
| `status` | `enum` | no | — | Filter by run status: `queued`, `running`, `success`, `failed`, `canceled`, `timeout`, `missed` |
| `limit` | `integer` (positive) | no | — | Maximum runs to return |
| `since` | `integer` | no | — | Only runs since epoch ms |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Array of run objects.

---

### crontick_run_get

Get the details and current status of a specific run, including its `pid` (if it was spawned)
and whether its captured output was truncated by the retention output cap.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | yes | — | Run ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Run object, including `pid` (number, absent for `missed` runs) and `outputTruncated`
(boolean).

---

### crontick_run_logs_tail

Get the last N lines of output for a run.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | yes | — | Run ID |
| `lines` | `integer` (positive) | no | `50` | Number of lines to return |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ runId: string, lines: LogEntry[] }`

---

### crontick_schedule_validate

Validate a schedule definition.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schedule` | `Schedule` | yes | — | Schedule object |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true }` on success; `{ ok: false, error: string }` on failure.

---

### crontick_schedule_preview

Preview the next N fire times for a schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schedule` | `Schedule` | yes | — | Schedule object |
| `n` | `integer` (1–20) | no | `5` | Number of fire times |
| `tz` | `string` | no | — | Timezone override |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Array of ISO-8601 datetime strings.

---

### crontick_stats_summary

Get aggregate summary of all jobs.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ totalJobs, enabledJobs, totalRuns, succeeded, failed, avgDurationMs }` --
`avgDurationMs` excludes `missed`/`queued`/`running`/`canceled` runs, averaging only runs that
actually finished executing (see [library-api.md](./library-api.md#statssummary)).

---

### crontick_stats_job

Get run statistics for a specific job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobId, totalRuns, succeeded, failed, lastStatus, lastRunAt }`

---

### crontick_daemon_start

Start the local crontick daemon.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ port, started, ... }`

---

### crontick_daemon_stop

Stop the local crontick daemon.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `DaemonStopResult` — `{ ok: true, running, pid?, stopped, message, mode, activeRuns? }`.
`mode` is `'already-stopped' | 'graceful' | 'hard-kill'` (escalated to `SIGTERM` then `SIGKILL`
when the graceful HTTP stop stalls or is unreachable); `activeRuns` (`{ id, jobId }[]`) lists any
runs still in progress that the stop did not cancel. See
[library-api.md](./library-api.md#daemonstopresult) and
[internals/daemon.md](../internals/daemon.md#shutdown).

---

### crontick_daemon_status

Get daemon process status: PID, version, uptime, job counts, and a `missedFires` summary.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Health object (including `missedFires: { jobsWithMissedFires, missedRunsRecorded,
jobsCapped, capPerJob }`, report-only — see `crontick_run_list` with `status: "missed"`) or
`{ running: false, error: string }` if not running.

---

### crontick_daemon_reload

Reload job definitions from disk without restarting.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true }`

---

### crontick_daemon_restart

Restart the crontick daemon (stop + start).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `DaemonRestartResult` — `{ ok: true, baseUrl, port?, pid?, started, stopped, previousPid?
}`. Does not report `mode`/`activeRuns` (that is `DaemonStopResult`-only, returned by
`crontick_daemon_stop`); a restart's stop phase runs the same escalation internally but only
surfaces whether the daemon was `stopped` and its `previousPid`.

---

### crontick_export

Export all job definitions as a JSON object. Set `includeRuns` to also include run history —
the mitigation for retention's hard-delete of old runs.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `includeRuns` | `boolean` | no | `false` | Include each job's run history in the export |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobs: Job[], runs?: Run[] }` (`runs` present only when `includeRuns` is set).

---

### crontick_import

Import job definitions from a JSON array (upsert). An optional `runs` array (as produced by
`crontick_export` with `includeRuns`) is restored archivally — no execution, no scheduler
interaction.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jobs` | `unknown[]` | yes | — | Array of job definitions |
| `runs` | `unknown[]` | no | — | Array of run records to restore, from a prior `crontick_export --includeRuns` |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Import summary, including `runsImported`/`runsSkipped` when `runs` was provided.

---

### crontick_dashboard_start

Start the crontick dashboard server.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true, running: true, url: string, startedDaemon: boolean }`

---

### crontick_dashboard_status

Return dashboard server status without starting it.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true, running: boolean, url: string }`

---

### crontick_dashboard_data

Return the core dashboard data model.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jobId` | `string` | no | — | Filter runs by job ID |
| `runsLimit` | `integer` (positive) | no | — | Maximum recent runs |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `DashboardData` object (health, stats, jobs, runs).

---

### crontick_dashboard_stop

Stop the daemon-backed dashboard server.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ message: string }`

---

### crontick_doctor

Run health checks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: boolean, checks: Array<{ name, ok, note? }> }`

---

### crontick_config_get

Get effective crontick config, or a single value by dot-separated path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | no | — | Dot-separated config path |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** The config value or full config object.

---

### crontick_config_set

Set one config value by dot-separated path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | yes | — | Dot-separated config path |
| `value` | `unknown` | yes | — | Value to set |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `CrontickConfig`.

---

### crontick_config_unset

Remove one config value by dot-separated path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | yes | — | Dot-separated config path |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `CrontickConfig`.

---

### crontick_config_engine_list

List configured prompt engines.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `Record<string, EngineConfig>`

---

### crontick_config_engine_add

Add a prompt engine.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Engine name |
| `engine` | `EngineConfig` | yes | — | `{ command, args, env }` |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `CrontickConfig`.

---

### crontick_config_engine_update

Update a prompt engine (provided fields replace existing values).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Engine name |
| `engine` | `Partial<EngineConfig>` | yes | — | Fields to update |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `CrontickConfig`.

---

### crontick_config_engine_remove

Remove a prompt engine.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Engine name |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `CrontickConfig`.

---

### crontick_config_init

Create the default crontick config file.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `force` | `boolean` | no | `false` | Replace existing file |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ path: string, config: CrontickConfig, created: boolean }`

---

### crontick_config_validate

Validate the current crontick config file.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | no | — | Specific config file to validate |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: boolean, path: string, config?: CrontickConfig, problems: string[] }`

---

## Resources

| ID | URI | MIME Type | Description |
|----|-----|-----------|-------------|
| `crontick-schema-job` | `crontick://schemas/job` | `application/json` | JSON Schema for a crontick job definition |

---

## CLI Flags for MCP Launch

| Flag | Effect |
|------|--------|
| `--no-start-daemon` | Set `startDaemon=false` so tools do not demand-start the daemon |
| `--daemon-url <url>` | Override the daemon base URL |
| `--verbose` / `-v` | Pass verbose diagnostics through to clients/daemon |

---

## Validation Model

Tool schemas are derived from the shared core/client Zod schemas. The MCP server validates tool input, then calls `CrontickClient`; normalization, prompt runtime checks, daemon lifecycle, doctor checks, and JSON schema generation all live in shared core modules. The MCP server owns only:

- Tool registration schemas (derived from shared Zod schemas)
- The `crontick://schemas/job` resource (serves `client.jobJsonSchema()`)
- `redactForLlm()` redaction before returning errors
- JSON-RPC formatting
