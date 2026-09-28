# MCP Tools Reference

Complete reference for the crontick MCP server tool surface.

## Server Registration

- **Name:** `crontick`
- **Version:** build-injected from `package.json`
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

Every tool accepts an optional `verbose: boolean` parameter. When `true` (or when `CRONTICK_VERBOSE` is set), the tool result wraps the payload in `{ result: ..., diagnostics: [...] }` instead of returning the raw result when diagnostics are available.

## Result Shape

Success:

```json
{ "content": [{ "type": "text", "text": "<JSON payload>" }] }
```

Error:

```json
{ "content": [{ "type": "text", "text": "<JSON with error key>" }], "isError": true }
```

Error messages are redacted via `redactForLlm()`: loopback addresses become `<daemon-addr>` and filesystem paths become `<path>`.

Tools that expose run rows or log text apply the shared redaction contract before serializing successful results.

---

## Tool Inventory

The MCP server exposes 21 `crontick_*` tools, matching `SURFACE_CAPABILITIES`.

Removed tools are not present: the `crontick_config_*` get/set/unset/init/validate/engine tools, `crontick_schedule_validate`, `crontick_schedule_preview`, `crontick_dashboard_data`, `crontick_run_delete`, and the `crontick_daemon_start`/`crontick_daemon_status`/`crontick_daemon_restart` plus `crontick_dashboard_start`/`crontick_dashboard_status`/`crontick_dashboard_stop` tools. The dashboard is always served by the daemon; call `crontick_info`, read `configPath`, and open its `dashboardUrl`. Use `crontick_job_schedule` to preview an existing job's upcoming fire times.

---

## Tools

### crontick_job_create

Create and schedule a new job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` (GUID) | no | generated | Immutable GUID; omit and let one be generated automatically |
| `alias` | `string` | no | auto-generated | Human-friendly unique job alias |
| `description` | `string` | no | — | Job description |
| `enabled` | `boolean` | no | `true` | Whether job is active |
| `schedule` | `Schedule` | yes | — | Schedule object (see [job-schema.md](job-schema.md)) |
| `action` | `ActionInput` | yes | — | Action with `kind` discriminator (`script`, `exec`, or `prompt`) |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | `"skip"` | Overlap policy |
| `retry` | `{ max?: number, backoffSec?: number }` | no | `{ max: 0, backoffSec: 30 }` | Retry config |
| `force` | `boolean` | no | `false` | Replace an existing job with the same alias/id |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** The created `Job` object, with secret-like `action.env` values redacted.

If `action.reuseSession` is `true`, `overlap` must be `skip` (its default). Other overlap values return `VALIDATION_ERROR`.

---

### crontick_job_list

List all scheduled jobs with their current status and next run time.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Array of `Job` objects.

---

### crontick_job_get

Get the full definition and status of a specific job by GUID or alias.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `Job` object.

---

### crontick_job_update

Update an existing job by GUID or alias. The patch is merged with the existing definition; omitted fields remain unchanged.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `alias` | `string` | no | — | New human-friendly alias |
| `description` | `string` | no | — | Job description |
| `enabled` | `boolean` | no | — | Enable/disable |
| `schedule` | `Schedule` | no | — | New schedule |
| `action` | `ActionInput` | no | — | New or patched action (`script`, `exec`, or `prompt`) |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | — | Overlap policy |
| `retry` | `{ max?: number, backoffSec?: number }` | no | — | Retry config |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

The merged job must still use `overlap: "skip"` when `action.reuseSession` is `true`; incompatible updates return `VALIDATION_ERROR`.

---

### crontick_job_enable

Enable a disabled job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

---

### crontick_job_disable

Disable a job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

---

### crontick_job_delete

Permanently delete one job definition by GUID or alias, or delete every job with explicit confirmation.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | no | — | Job GUID or alias for a single delete |
| `all` | `boolean` | no | `false` | Delete every job |
| `force` | `boolean` | no | `false` | Required when `all: true` |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true }` for a single delete, or `{ ok: true, deleted: number }` when `all: true`. The literal CLI keyword `all` is only reserved on the CLI; MCP callers may still delete an alias `all` job by passing `id: "all"`.

---

### crontick_job_run_now

Trigger an immediate run of a job, bypassing its schedule.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ runId: string }`

---

### crontick_job_schedule

Show upcoming fire times for an existing job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `n` | `integer` (1-20) | no | `5` | Number of upcoming fire times |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobId, alias, schedule, ...preview }`.

---

### crontick_job_cancel_run

Cancel an in-progress run by run ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Run ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true, canceled: boolean }`

---

### crontick_run_list

List recent runs, optionally filtered by job and/or status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jobId` | `string` | no | — | Job GUID or alias |
| `limit` | `integer` (positive) | no | — | Maximum runs to return |
| `since` | `integer` | no | — | Only runs since epoch milliseconds |
| `status` | `enum` | no | — | `queued`, `running`, `success`, `failed`, `canceled`, `skipped`, `timeout`, or `missed` |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Array of run objects.

---

### crontick_run_get

Get the details and current status of a run.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Run ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Run object, including resolved/redacted `command`, engine/status/timing fields, `pid` when spawned, `sessionId` when available, and `outputTruncated`. Claude runs with a complete result include `costUsd`, `turns`, redacted `usageJson` (JSON string), `transcriptPath`, and `engineStatus` (Claude result subtype). Raw-engine runs omit these fields.

---

### crontick_run_logs_tail

Get the last N logical lines of output for a run.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Run ID |
| `lines` | `integer` (positive) | no | `50` | Number of logical lines |
| `source` | `"all"\|"engine"\|"crontick"` | no | `all` | `engine` = stdout/stderr, `crontick` = lifecycle events, `all` = both |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ runId: string, lines: LogEntry[] }`.

---

### crontick_stats_summary

Get aggregate summary of all jobs.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ totalJobs, enabledJobs, totalRuns, succeeded, failed, canceled, skipped, avgDurationMs, totalCostUsd, totalTurns }`. `skipped` counts fires that never ran due to overlap; `canceled` counts terminated runs. Cost and turns sum the included runs; missing usage contributes zero.

---

### crontick_stats_job

Get run statistics for a specific job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobId, totalRuns, succeeded, failed, canceled, skipped, lastStatus, lastRunAt, totalCostUsd, totalTurns }`.

---

### crontick_export

Export all job definitions as a JSON object.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `includeRuns` | `boolean` | no | `false` | Include run history in the export |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobs: Job[], runs?: Run[] }`.

---

### crontick_import

Import job definitions. An optional `runs` array from `crontick_export` is restored archivally: no execution, no scheduler interaction.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jobs` | `unknown[]` | yes | — | Array of job definitions |
| `runs` | `unknown[]` | no | — | Run records to restore |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Import summary.

---

### crontick_daemon_stop

Stop the local crontick daemon.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `DaemonStopResult`.

---

### crontick_daemon_reload

Reload job definitions from disk without restarting.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: true }`

---

### crontick_doctor

Run health checks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ ok: boolean, checks: Array<{ name, ok, note? }> }`.

---

### crontick_info

Return crontick environment info.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ version, node, platform, configPath, paths, daemon, dashboardUrl }`, where `configPath` repeats `paths.configFile` for convenience, `paths` includes `dataDir`, `jobsDir`, `runsDb`, `logsDir`, `configFile`, `portFile`, and `pidFile`, `daemon` reports `{ running, pid?, port? }`, and `dashboardUrl` is the daemon-served dashboard URL when the daemon is running (otherwise `null`).

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

Tool schemas are derived from shared core/client Zod schemas. The MCP server validates tool input, then calls `CrontickClient`; normalization, prompt runtime checks, daemon lifecycle, doctor checks, and JSON schema generation all live in shared core modules. The MCP server owns only:

- Tool registration schemas (derived from shared Zod schemas)
- The `crontick://schemas/job` resource (serves `client.jobJsonSchema()`)
- `redactForLlm()` redaction before returning errors
- JSON-RPC formatting
