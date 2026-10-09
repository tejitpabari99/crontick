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

The MCP server exposes 23 `crontick_*` tools, matching `SURFACE_CAPABILITIES`.

Removed tools are not present: the `crontick_config_*` get/set/unset/init/validate/engine tools, `crontick_schedule_validate`, `crontick_schedule_preview`, `crontick_dashboard_data`, `crontick_run_logs_tail` and `crontick_run_output` (folded into `crontick_run_get`), and the `crontick_daemon_start`/`crontick_daemon_status`/`crontick_daemon_restart` plus `crontick_dashboard_start`/`crontick_dashboard_status`/`crontick_dashboard_stop` tools. The dashboard is always served by the daemon; call `crontick_info`, read `configPath`, and open its `dashboardUrl`. Use `crontick_job_schedule` to preview an existing job's upcoming fire times.

---

## Tools

### crontick_job_create

Create and schedule a new job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` (GUID) | no | generated | Immutable GUID; omit and let one be generated automatically |
| `alias` | `string` | no | auto-generated | Unique kebab-case job alias (set via CLI `--alias`/`-a`) |
| `description` | `string` | no | — | Job description |
| `enabled` | `boolean` | no | `true` | Whether job is active |
| `schedule` | `Schedule` | yes | — | Schedule object (see [job-schema.md](job-schema.md)) |
| `action` | `ActionInput` | yes | — | Prompt action with `kind: "prompt"` |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | config `defaults.overlap`, then `"skip"` | Overlap policy |
| `retry` | `{ max?: number, backoffSec?: number }` | no | config `defaults.retry`, then `{ max: 0, backoffSec: 30 }` | Retry config |
| `force` | `boolean` | no | `false` | Replace an existing job with the same alias or id |
| `trustFolder` | `boolean` | no | `false` | Claude jobs only: trust `action.cwd` when it is not trusted yet. On `TRUST_REQUIRED`, ask the user, then call again with `true` |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** The created `Job` object, with secret-like `action.env` values redacted.

If `action.reuseSession` is `true` or `action.sessionId` is set (resumes an existing session, including one created outside crontick, on every run), resolved `overlap` must be `skip`. Other overlap values return `VALIDATION_ERROR`.

**Working directory:** the job runs in `action.cwd`. Always pass the absolute path of the project folder: MCP hosts often start the server in an unrelated directory such as `/`, which would otherwise be stored as the default (the server process's directory). A nonexistent folder fails with `INVALID_CWD`. For Claude jobs the folder must be trusted in Claude's config; otherwise the call fails with `TRUST_REQUIRED` and nothing is saved. Ask the user, then call again with `trustFolder: true`. Cron schedules fire in the machine's local timezone (there is no `tz` field).

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
| `action` | `ActionInput` | no | — | New or patched prompt action |
| `overlap` | `"skip"\|"queue"\|"cancel-previous"` | no | — | Overlap policy |
| `retry` | `{ max?: number, backoffSec?: number }` | no | — | Retry config |
| `trustFolder` | `boolean` | no | `false` | See `crontick_job_create`; checked only when `action.cwd` or the engine changes |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Updated `Job` object.

Changing `action.cwd` of a job that has a session (`sessionId`/`reuseSession`) fails with `CWD_CHANGE_BREAKS_SESSION` unless the patch also sets a new `sessionId` or `reuseSession: true` (fresh session). The merged job must still use `overlap: "skip"` when `action.reuseSession` is `true`; incompatible updates return `VALIDATION_ERROR`.

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

Deleting a job also deletes its runs, stored run output, schedule state and per-job log file; Claude's session transcripts are untouched.

**Result:** `{ ok: true, canceledRun: boolean, deletedRuns: number }` for a single delete, or `{ ok: true, deleted: number }` when `all: true`. The literal CLI keyword `all` is only reserved on the CLI; MCP callers may still delete an alias `all` job by passing `id: "all"`.

---

### crontick_job_run_now

Run a job once immediately, even if it is disabled. Does not enable the job or change its schedule; the overlap policy still applies (a run blocked by `overlap: skip` is recorded as `skipped`). Returns `{ runId }`.

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

**Result:** `{ jobId, alias, enabled, cwd, schedule, next }`; `enabled: false` means the job will not fire on its own.

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

### crontick_run_delete

Permanently delete run history and stored output, by run ids or for all runs of one job. Destructive and idempotent; confirm with the user first and consider `dryRun`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runIds` | `string[]` | one of `runIds`/`job` | — | Run IDs to delete |
| `job` | `string` | one of `runIds`/`job` | — | Job id or alias; deletes all its runs |
| `dryRun` | `boolean` | no | `false` | Preview only; nothing is deleted |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ deleted, skipped: [{ id, status }], notFound, jobLogRemoved }`. Active runs are skipped.

---

### crontick_run_get

Get the details and current status of a run.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Run ID |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** Run object, including the cleaned `output` (a `RunOutput`: the engine's final answer `result`, `error`, and the full `stderr`; see [library-api.md](library-api.md#runoutput)), resolved/redacted `command`, engine/status/timing fields, `pid` when spawned, `sessionId` (the Runner Session ID) when available, `outputTruncated`, and `logFile` (absolute path of the per-job file of crontick-side events for all runs of the job, or `null` when file logging is off, with `logFileExists`/`transcriptExists` booleans that are `false` when the file is missing on disk; crontick does not store the engine's raw logs, see `transcriptPath` for the engine's own transcript). Claude runs with a complete result include `costUsd`, `turns`, redacted `usageJson` (JSON string), `transcriptPath`, and `engineStatus` (Claude result subtype). Raw-engine runs omit these fields.

---

### crontick_stats_summary

Get aggregate summary of all jobs.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ totalJobs, enabledJobs, succeeded, failed, canceled, skipped, avgDurationSec, totalCostUsd, totalTurns }`. `avgDurationSec` is the average execution time in seconds (2 decimals). Per-job stats also include `avgDurationSec`. `skipped` counts fires that never ran due to overlap; `canceled` counts terminated runs. Cost and turns sum the included runs; missing usage contributes zero.

---

### crontick_stats_job

Get run statistics for a specific job.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | yes | — | Job GUID or alias |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ jobId, succeeded, failed, canceled, skipped, lastStatus, lastRunAt (epoch ms), avgDurationSec, totalCostUsd, totalTurns }`, over every retained run of the job. `totalTurns` sums the agent turns (Claude `num_turns`: model round-trips) of all runs.

---

### crontick_export

Export job definitions as a crontick export file. Jobs only: no run history, and job ids are omitted (an import assigns new ones).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `onlyJobs` | `string[]` | no | all jobs | Ids or aliases to export. Any unknown entry fails with `JOB_NOT_FOUND` listing every miss |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ schema: 1, exportedAt, crontickVersion, jobs }`.

---

### crontick_import

Import jobs from a crontick export file (pass the object `crontick_export` returned). The whole file is validated first; a bad file imports nothing (`VALIDATION_ERROR` naming the path). Every job gets a new id, an alias already in use becomes `<alias>-2`, `-3`, ... (`renamedFrom` in the result row), existing jobs are never overwritten, and run history is never imported.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | `number` | yes | — | Export format version; must be `1` |
| `jobs` | `unknown[]` | yes | — | Job definitions |
| `exportedAt` | `string` | no | — | Informational |
| `crontickVersion` | `string` | no | — | Informational |
| `trustFolder` | `boolean` | no | `false` | Trust the jobs' working directories in Claude when needed (see `crontick_job_create`) |
| `verbose` | `boolean` | no | `false` | Include diagnostics |

**Result:** `{ imported, results: [{ id, alias, ok, renamedFrom?, error? }] }`. A job whose `cwd` does not exist fails on its own row (`INVALID_CWD`).

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

### crontick_daemon_pause

Pause scheduling (daemon stays up; due fires are recorded `skipped`; not persisted across restart). Parameter: `verbose`. **Result:** `{ ok: true, paused: true }`

---

### crontick_daemon_resume

Resume scheduling after a pause. Parameter: `verbose`. **Result:** `{ ok: true, paused: false }`

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
