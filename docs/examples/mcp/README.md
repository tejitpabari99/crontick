# crontick MCP server examples

How to register and use the crontick MCP server with an MCP-compatible client.

## Registering the server

Use `crontick mcp` so the npm-installed CLI launches the stdio MCP server.

```json
{
  "mcpServers": {
    "crontick": {
      "command": "crontick",
      "args": ["mcp"],
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
| `CRONTICK_VERBOSE` | Enables verbose diagnostics |

---

## Available tools (29)

All tools accept an optional `verbose: boolean` parameter for diagnostics.

### Jobs

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_job_create` | Full job input (`schedule`, `action`, optional `alias`, etc.), `force?` | Create a new scheduled job |
| `crontick_job_list` | - | List all jobs |
| `crontick_job_get` | `id` | Get a job by GUID or alias |
| `crontick_job_update` | `id` + partial job fields | Update a job |
| `crontick_job_enable` | `id` | Enable a disabled job |
| `crontick_job_disable` | `id` | Disable a job |
| `crontick_job_delete` | `id` | Delete a job |
| `crontick_job_run_now` | `id` | Trigger immediate execution |
| `crontick_job_schedule` | `id`, `n?` (default 5, max 20) | Preview upcoming fire times for an existing job |
| `crontick_job_cancel_run` | `id` | Cancel an active run by run id |

### Runs

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_run_list` | `jobId?`, `limit?`, `since?`, `status?` | List run records |
| `crontick_run_get` | `id` | Get a specific run |
| `crontick_run_logs_tail` | `id`, `lines?` (default 50), `source?` (`all`, `engine`, `crontick`) | Tail run output logs |

`status` accepts one of `queued`, `running`, `success`, `failed`, `canceled`, `timeout`, `missed` (`missed` marks a schedule fire recorded but never executed because the daemon was down).

### Stats

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_stats_summary` | - | Aggregate stats across all jobs |
| `crontick_stats_job` | `id` | Stats for a single job |

### Daemon

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_daemon_stop` | - | Stop the daemon |
| `crontick_daemon_reload` | - | Reload job definitions from disk |

### Config and info

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_info` | - | Return version, runtime, configPath, paths, daemon status, and dashboard URL (`dashboardUrl`) |

> The dashboard has no dedicated MCP tools: it is always served by the daemon on its
> loopback origin. Call `crontick_info` and open the returned `dashboardUrl` in a browser.

### Share

| Tool | Parameters | Description |
|------|------------|-------------|
| `crontick_export` | `includeRuns?` | Export all jobs (optionally with run history) |
| `crontick_import` | `jobs[]`, `runs?` | Import jobs (optionally restoring run history from an export) |

### Doctor

| Tool | Parameters | Description |
|------|------------|-------------|
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
    "alias": "mcp-demo",
    "schedule": {
      "kind": "interval",
      "everySec": 60
    },
    "action": {
      "kind": "prompt",
      "prompt": "Summarize recent activity",
      "engine": "claude"
    }
  }
}
```

Response (abbreviated):

```json
{
  "content": [{ "type": "text", "text": "{\"id\":\"<guid>\",\"alias\":\"mcp-demo\",\"enabled\":true}" }]
}
```

### 2. Preview the job schedule

```json
{
  "name": "crontick_job_schedule",
  "arguments": {
    "id": "mcp-demo",
    "n": 3
  }
}
```

### 3. Trigger immediate run

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

### 4. Read run logs

```json
{
  "name": "crontick_run_logs_tail",
  "arguments": {
    "id": "abc12345-...",
    "lines": 10,
    "source": "all"
  }
}
```

### 5. Clean up

```json
{
  "name": "crontick_job_delete",
  "arguments": {
    "id": "mcp-demo"
  }
}
```

---

## Alternate: prompt job with session reuse

A prompt job can carry an engine session across runs so the agent keeps prior context. This requires `overlap: "skip"` (the default):

```json
{
  "name": "crontick_job_create",
  "arguments": {
    "alias": "mcp-session-demo",
    "schedule": {
      "kind": "interval",
      "everySec": 3600
    },
    "action": {
      "kind": "prompt",
      "prompt": "Continue reviewing open PRs",
      "engine": "claude",
      "reuseSession": true
    },
    "overlap": "skip"
  }
}
```
