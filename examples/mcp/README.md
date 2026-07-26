# crontick MCP server examples

How to register and use the crontick MCP server with an MCP-compatible client.

## Registering the server

The MCP server binary is `crontick-mcp` (see `package.json#bin`). It communicates over **stdio** using JSON-RPC 2.0.

Add the following to your MCP client configuration (e.g. Claude Desktop, Copilot, or any MCP-compatible host):

```json
{
  "mcpServers": {
    "crontick": {
      "command": "crontick-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

If crontick is installed locally (not globally), use the full path:

```json
{
  "mcpServers": {
    "crontick": {
      "command": "node",
      "args": ["./node_modules/crontick/dist/mcp/index.js"],
      "env": {}
    }
  }
}
```

### Environment variables

| Variable | Effect |
|----------|--------|
| `CRONTICK_MCP_START_DAEMON=0` | Disables automatic daemon demand-start from MCP |
| `CRONTICK_HOME` | Override the data directory |
| `CRONTICK_DAEMON_URL` | Point to a specific daemon instance |

---

## Available tools (37)

All tools accept an optional `verbose: boolean` parameter for diagnostics.

### Jobs

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_job_create` | Full job input (id, schedule, action, etc.) | Create a new scheduled job |
| `crontick_job_list` | - | List all jobs |
| `crontick_job_get` | `id` | Get a specific job |
| `crontick_job_update` | `id` + partial job fields | Update a job |
| `crontick_job_delete` | `id` | Delete a job |
| `crontick_job_enable` | `id` | Enable a disabled job |
| `crontick_job_disable` | `id` | Disable a job |
| `crontick_job_run_now` | `id` | Trigger immediate execution |
| `crontick_job_cancel_run` | `runId` | Cancel an active run |

### Runs

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_run_list` | `jobId?`, `limit?`, `since?`, `status?` | List run records |
| `crontick_run_get` | `runId` | Get a specific run (includes `pid` and `outputTruncated`) |
| `crontick_run_logs_tail` | `runId`, `lines?` (default 50) | Tail run output logs |

`status` accepts one of `queued`, `running`, `success`, `failed`, `canceled`, `timeout`, `missed`
(`missed` marks a schedule fire recorded but never executed because the daemon was down).

### Schedules

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_schedule_validate` | `schedule` | Validate a schedule object |
| `crontick_schedule_preview` | `schedule`, `n?` (max 20, default 5), `tz?` | Preview next N run times |

### Stats

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_stats_summary` | - | Aggregate stats across all jobs |
| `crontick_stats_job` | `id` | Stats for a single job |

### Daemon

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_daemon_start` | - | Start the daemon |
| `crontick_daemon_stop` | - | Stop the daemon |
| `crontick_daemon_status` | - | Get daemon status |
| `crontick_daemon_reload` | - | Reload daemon configuration |
| `crontick_daemon_restart` | - | Restart the daemon |

### Dashboard

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_dashboard_start` | - | Start dashboard serving |
| `crontick_dashboard_status` | - | Get dashboard status |
| `crontick_dashboard_data` | `jobId?`, `runsLimit?` | Get dashboard data |
| `crontick_dashboard_stop` | - | Stop dashboard |

### Config

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_config_get` | `path?` | Read config value (entire config if no path) |
| `crontick_config_set` | `path`, `value` | Set a config value |
| `crontick_config_unset` | `path` | Remove a config key |
| `crontick_config_engine_list` | - | List registered engines |
| `crontick_config_engine_add` | `name`, `engine` | Add a new engine |
| `crontick_config_engine_update` | `name`, `engine` (partial) | Update an engine |
| `crontick_config_engine_remove` | `name` | Remove an engine |
| `crontick_config_init` | `force?` | Initialize config file |
| `crontick_config_validate` | `path?` | Validate config file |

### Admin

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_export` | `includeRuns?` | Export all jobs (optionally with run history) |
| `crontick_import` | `jobs[]`, `runs?` | Import jobs (optionally restoring run history from an export) |

### Doctor

| Tool | Parameters | Description |
|------|-----------|-------------|
| `crontick_doctor` | - | Run health checks |

---

## Resources

| URI | MIME | Description |
|-----|------|-------------|
| `crontick://schemas/job` | `application/json` | JSON Schema for the job definition |

---

## Worked example: creating and running a job

### 1. Create a job

Tool call:

```json
{
  "name": "crontick_job_create",
  "arguments": {
    "id": "mcp-demo",
    "schedule": {
      "kind": "interval",
      "everySec": 60
    },
    "action": {
      "kind": "script",
      "script": "echo \"hello from MCP\""
    }
  }
}
```

Response (abbreviated):

```json
{
  "content": [{ "type": "text", "text": "{\"id\":\"mcp-demo\",\"enabled\":true,\"schedule\":{\"kind\":\"interval\",\"everySec\":60},\"action\":{\"kind\":\"script\",\"script\":\"echo \\\"hello from MCP\\\"\",\"shell\":\"auto\"},\"overlap\":\"skip\",\"retry\":{\"max\":0,\"backoffSec\":30}}" }]
}
```

### 2. Trigger immediate run

```json
{
  "name": "crontick_job_run_now",
  "arguments": {
    "id": "mcp-demo"
  }
}
```

Response:

```json
{
  "content": [{ "type": "text", "text": "{\"runId\":\"abc12345-...\"}" }]
}
```

### 3. Read run logs

```json
{
  "name": "crontick_run_logs_tail",
  "arguments": {
    "runId": "abc12345-...",
    "lines": 10
  }
}
```

### 4. Clean up

```json
{
  "name": "crontick_job_delete",
  "arguments": {
    "id": "mcp-demo"
  }
}
```

---

## Worked example: previewing a cron schedule

```json
{
  "name": "crontick_schedule_preview",
  "arguments": {
    "schedule": {
      "kind": "cron",
      "cron": "0 9 * * 1-5",
      "tz": "America/New_York"
    },
    "n": 3
  }
}
```

Response contains the next 3 ISO timestamps when the schedule would fire.
