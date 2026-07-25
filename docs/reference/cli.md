# CLI Reference

Complete reference for the `crontick` command-line interface.

## Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--version`, `-V` | boolean | — | Print version and exit |
| `--json` | boolean | `false` | Format all output as JSON |
| `-v`, `--verbose` | boolean | `false` | Write diagnostic logs to stderr (also enabled by `CRONTICK_VERBOSE=1`) |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (any `CrontickError`, failed `doctor`, or failed `config validate`) |

---

## Commands

### crontick new

Create a new job.

```bash
crontick new <id> [engineArgs...]
```

**Positional arguments:**

| Name | Required | Description |
|------|----------|-------------|
| `id` | yes | Job ID (kebab-case: `^[a-z0-9]+(?:-[a-z0-9]+)*$`) |
| `engineArgs` | no | Extra args passed to the prompt engine (after `--`) |

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--cron <expr>` | string | — | Cron expression (e.g. `"0 9 * * *"`) |
| `--every <sec>` | integer | — | Interval in seconds |
| `--at <iso>` | string | — | One-shot run-at ISO-8601 time |
| `--tz <tz>` | string | — | Timezone for cron schedule |
| `--script <body>` | string | — | Inline script body |
| `--exec <cmd>` | string | — | Command to exec (use `--` for args) |
| `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 `.txt` file to read into the prompt |
| `--engine <engine>` | string | config `defaultEngine` | Configured prompt engine name |
| `--session-id <id>` | string | — | Reuse this prompt engine session every run |
| `--reuse-session` | boolean | `false` | Capture first successful run session id and reuse it |
| `--file <path>` | string | — | Load job JSON from a file |
| `--shell <shell>` | string | `auto` | Shell: `auto`\|`bash`\|`pwsh`\|`cmd` |
| `--env-file <path>` | string | — | Load extra environment variables from a `.env` file |
| `--timeout <sec>` | integer | — | Timeout in seconds |
| `--overlap <policy>` | string | `skip` | Overlap policy: `skip`\|`queue`\|`cancel-previous` |
| `--retry <max>` | integer | `0` | Retry count |
| `--desc <description>` | string | — | Job description |

Exactly one schedule source (`--cron`, `--every`, `--at`) and one action source (`--script`, `--exec`, `--prompt`, `--prompt-file`) are required unless `--file` is used.

```bash
crontick new daily-backup --cron "0 2 * * *" --script "pg_dump mydb > /backups/db.sql"
```

---

### crontick update

Update an existing job.

```bash
crontick update <id> [engineArgs...]
```

Accepts all options from `crontick new` plus:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--enable` | boolean | — | Enable the job |
| `--disable` | boolean | — | Disable the job |

`--enable` and `--disable` are mutually exclusive.

```bash
crontick update daily-backup --cron "30 3 * * *"
```

---

### crontick list

List all jobs.

```bash
crontick list
```

No additional options.

---

### crontick get

Get a job by ID.

```bash
crontick get <id>
```

---

### crontick enable

Enable a job.

```bash
crontick enable <id>
```

---

### crontick disable

Disable a job.

```bash
crontick disable <id>
```

---

### crontick delete

Delete a job.

```bash
crontick delete <id>
```

---

### crontick run-now

Trigger an immediate run of a job.

```bash
crontick run-now <id>
```

---

### crontick cancel-run

Cancel an in-progress run.

```bash
crontick cancel-run <runId>
```

---

### crontick runs list

List recent runs.

```bash
crontick runs list
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--job <id>` | string | — | Filter by job ID |
| `--limit <n>` | integer | — | Maximum runs to return |
| `--since <ms>` | integer | — | Only runs since epoch milliseconds |

---

### crontick runs get

Get a run by ID.

```bash
crontick runs get <runId>
```

---

### crontick logs

Get logs for a run.

```bash
crontick logs <runId>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tail <n>` | integer | — | Show last N lines |

---

### crontick schedule validate

Validate a schedule JSON object.

```bash
crontick schedule validate '<scheduleJson>'
```

| Positional | Type | Description |
|------------|------|-------------|
| `scheduleJson` | string (JSON) | Schedule object as JSON string |

```bash
crontick schedule validate '{"kind":"cron","cron":"0 9 * * *"}'
```

---

### crontick schedule preview

Preview upcoming fire times for a schedule.

```bash
crontick schedule preview '<scheduleJson>'
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--limit <n>` | integer | — | Number of fire times to return |
| `--tz <tz>` | string | — | Timezone override |

```bash
crontick schedule preview '{"kind":"interval","everySec":3600}' --limit 5
```

---

### crontick stats summary

Show aggregate statistics.

```bash
crontick stats summary
```

---

### crontick stats job

Show statistics for one job.

```bash
crontick stats job <id>
```

---

### crontick config get

Get the effective config or one config value.

```bash
crontick config get [path]
```

| Positional | Type | Description |
|------------|------|-------------|
| `path` | string (optional) | Dot-separated config path (e.g. `engines.copilot.command`) |

---

### crontick config set

Set one config value.

```bash
crontick config set <path> <value>
```

`value` is parsed as JSON when possible; otherwise treated as a string.

---

### crontick config unset

Remove one config value.

```bash
crontick config unset <path>
```

---

### crontick config init

Create the default config file.

```bash
crontick config init
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | boolean | `false` | Replace an existing config file |

---

### crontick config validate

Validate the config file.

```bash
crontick config validate [path]
```

| Positional | Type | Description |
|------------|------|-------------|
| `path` | string (optional) | File path to validate (defaults to the standard config path) |

Exits with code `1` if validation fails.

---

### crontick config engines

List configured engines.

```bash
crontick config engines
```

---

### crontick config engines add

Add an engine.

```bash
crontick config engines add <name>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--command <cmd>` | string | **required** | Engine executable |
| `--arg <arg>` | string (repeatable) | `[]` | Default engine argument |
| `--env <KEY=VALUE>` | string (repeatable) | `{}` | Default engine environment variable |

```bash
crontick config engines add my-llm --command "my-llm-cli" --arg "--model=gpt-4" --env "API_KEY=abc"
```

---

### crontick config engines update

Update an engine.

```bash
crontick config engines update <name>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--command <cmd>` | string | — | Engine executable |
| `--arg <arg>` | string (repeatable) | — | Replaces the current args when provided |
| `--env <KEY=VALUE>` | string (repeatable) | — | Replaces current env when provided |

---

### crontick config engines remove

Remove an engine.

```bash
crontick config engines remove <name>
```

Cannot remove the current `defaultEngine` or built-in engines.

---

### crontick export

Export all jobs.

```bash
crontick export
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--out <file>` | string | stdout | Output file path |

---

### crontick import

Import jobs from a JSON file.

```bash
crontick import <file>
```

Jobs are upserted (existing jobs with the same ID are updated).

---

### crontick doctor

Check system health.

```bash
crontick doctor
```

Exits with code `1` if any check fails. Checks: Node.js version, SQLite availability, data directory, daemon connectivity, dashboard reachability, MCP server.

---

### crontick daemon start

Start the daemon.

```bash
crontick daemon start
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--foreground` | boolean | `false` | Run in foreground (blocking) |

---

### crontick daemon stop

Stop the daemon.

```bash
crontick daemon stop
```

---

### crontick daemon status

Show daemon status.

```bash
crontick daemon status
```

---

### crontick daemon reload

Reload jobs from disk.

```bash
crontick daemon reload
```

---

### crontick daemon restart

Restart the daemon.

```bash
crontick daemon restart
```

---

### crontick dashboard start

Start the dashboard server.

```bash
crontick dashboard start
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--open` | boolean | `false` | Open in the default browser |

---

### crontick dashboard status

Show dashboard status.

```bash
crontick dashboard status
```

---

### crontick dashboard data

Return the dashboard data model.

```bash
crontick dashboard data
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--job <id>` | string | — | Filter runs by job ID |
| `--runs-limit <n>` | integer | — | Maximum recent runs to return |

---

### crontick dashboard stop

Stop the dashboard server.

```bash
crontick dashboard stop
```

---

### crontick mcp

Start the crontick MCP server on stdio.

```bash
crontick mcp
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--no-start-daemon` | boolean | `false` | Set `startDaemon=false` for MCP daemon-backed tools |
| `--daemon-url <url>` | string | — | Override the daemon URL (default: resolved from port file) |

Transport: stdio (JSON-RPC 2.0 over stdin/stdout). Tool prefix: `crontick_`.

```json
{
  "mcpServers": {
    "crontick": { "command": "crontick", "args": ["mcp"] }
  }
}
```
