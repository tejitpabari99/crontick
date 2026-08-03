# CLI Reference

Complete reference for the `crontick` command-line interface.

## Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--version`, `-V` | boolean | — | Print version and exit |
| `-v`, `--verbose` | boolean | `false` | Write diagnostic logs to stderr (also enabled by `CRONTICK_VERBOSE=1`) |

There is no global `--json` flag. CLI output is always human-readable. Use the library or MCP surface when a structured JSON payload is required.

Running `crontick` with no subcommand prints help and exits `0`. `crontick --help` behaves the same way.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error, failed `doctor`, or validation/usage failure |

Errors are rendered as a single clean line on stderr; see [errors.md](errors.md#cli).

---

## Command Tree

```text
crontick jobs new [engineArgs...]
crontick jobs update <id> [engineArgs...]
crontick jobs list
crontick jobs get <id>
crontick jobs schedule <id> [-n <count>]
crontick jobs delete <id>
crontick jobs delete --all --force
crontick jobs run-now <id>

crontick runs list [--job <id>] [--limit <n>] [--since <ms>] [--status <status>]
crontick runs get <runId>
crontick runs logs <runId> [engine|crontick] [--tail <n>]
crontick runs cancel <runId>
crontick runs delete <runId>
crontick runs delete --all --force

crontick stats summary
crontick stats job <id>

crontick share export [--out <file>] [--include-runs]
crontick share import <file>

crontick config
crontick info
crontick doctor
crontick daemon start [--foreground]
crontick daemon stop
crontick daemon status
crontick daemon reload
crontick daemon restart
crontick mcp [--no-start-daemon] [--daemon-url <url>]
```

Commands accept a job identifier as either the immutable GUID `id` or the human-friendly `alias`. `jobs new` assigns the GUID automatically; use `--alias <name>` only when you want to control the human-friendly name.

---

## Job Commands

### crontick jobs new

Create a new job. The job's GUID `id` is always assigned by crontick. If `--alias` is omitted, crontick auto-generates a unique alias.

```bash
crontick jobs new [engineArgs...]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--desc <description>` | string | — | Job description |
| `--cron <expr>` | string | — | Cron expression (for example, `"0 9 * * *"`) |
| `--every <sec>` | integer | — | Interval in seconds |
| `--at <iso>` | string | — | One-shot run-at ISO-8601 time |
| `--tz <tz>` | string | — | IANA timezone for cron schedules |
| `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 text file to read into the prompt |
| `--engine <engine>` | string | config `defaultEngine` | Configured prompt engine name |
| `--session-id <id>` | string | — | Reuse this prompt engine session every run |
| `--reuse-session` | boolean | `false` | Capture the first successful run session id and reuse it |
| `--file <path>` | string | — | Create the job from a full job-definition JSON file (advanced; supports all action kinds including `script` and `exec`) |
| `--alias <alias>` | string | auto-generated | Human-friendly, unique, kebab-case job identifier |
| `--timeout <sec>` | integer | none / unbounded | Per-run timeout in seconds |
| `--overlap <policy>` | `skip` \| `queue` \| `cancel-previous` | `skip` | Overlap policy |
| `--retry <max>` | integer | `0` | Retry count on failure |
| `--force` | boolean | `false` | Replace an existing job when the same alias already exists |

Exactly one schedule source (`--cron`, `--every`, `--at`) and one prompt source (`--prompt`, `--prompt-file`) are required unless `--file` is used. Values after the command are stored as prompt action arguments (`action.args`). If a token after the positional separator matches a crontick long flag, the CLI rejects it rather than silently storing it as a literal prompt arg.

Dedicated `--script`, `--exec`, `--arg`, `--shell`, and `--job-env-file` flags are not exposed on the CLI. Script and exec actions remain supported by the job schema, daemon executors, and library API; create them with `crontick jobs new --file <job.json>` or `client.createJob()`.

```bash
crontick jobs new --every 300 --prompt "Summarize the current repository status" --alias repo-summary
crontick jobs new --file .\job.json
```

---

### crontick jobs update

Update an existing job by GUID or alias.

```bash
crontick jobs update <id> [engineArgs...]
```

`jobs update` accepts the same job options as `jobs new` except create-only `--force`, plus:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--enable` | boolean | — | Enable the job |
| `--disable` | boolean | — | Disable the job |

Omitted options leave the existing job unchanged. `--enable` and `--disable` are mutually exclusive.

```bash
crontick jobs update repo-summary --cron "0 9 * * 1-5" --tz America/Los_Angeles
crontick jobs update repo-summary --disable
```

---

### crontick jobs list

List all jobs.

```bash
crontick jobs list
```

---

### crontick jobs get

Get a job by GUID or alias.

```bash
crontick jobs get <id>
```

---

### crontick jobs schedule

Show upcoming fire times for a job.

```bash
crontick jobs schedule <id>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-n`, `--count <n>` | integer | `5` | Number of upcoming fire times to show |

This replaces the old raw `schedule preview` command: schedules are previewed in the context of an existing job.

---

### crontick jobs delete

Delete one job, or delete all jobs with explicit confirmation.

```bash
crontick jobs delete <id>
crontick jobs delete --all --force
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--all` | boolean | `false` | Delete every job |
| `--force` | boolean | `false` | Required with `--all` |

Deleting a job cancels its in-flight run, if any. Historical runs remain queryable by run id, but live aggregates exclude runs whose parent job was deleted.

---

### crontick jobs run-now

Trigger an immediate run of a job.

```bash
crontick jobs run-now <id>
```

---

## Run Commands

### crontick runs list

List recent runs.

```bash
crontick runs list
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--job <id>` | string | — | Filter by job GUID or alias |
| `--limit <n>` | integer | — | Maximum runs to return |
| `--since <ms>` | integer | — | Only runs since epoch milliseconds |
| `--status <status>` | string | — | Filter by run status: `queued`\|`running`\|`success`\|`failed`\|`canceled`\|`timeout`\|`missed` |

---

### crontick runs get

Get a run by ID.

```bash
crontick runs get <runId>
```

The output includes the resolved, redacted command for that run, the engine/status/timing fields, and any captured `sessionId`.

---

### crontick runs logs

Get logs for a run.

```bash
crontick runs logs <runId> [engine|crontick]
```

| Argument / flag | Type | Default | Description |
|-----------------|------|---------|-------------|
| `source` | `engine` \| `crontick` | both streams | Optional positional filter. `engine` = stdout/stderr from the spawned process; `crontick` = scheduling/execution lifecycle events |
| `--tail <n>` | integer | — | Show the last N logical lines |

Output is one line per stored entry in this form:

```text
[<stream>] <data>
```

---

### crontick runs cancel

Cancel an in-progress run.

```bash
crontick runs cancel <runId>
```

---

### crontick runs delete

Delete one run and its crontick-side log rows, or delete all runs with explicit confirmation.

```bash
crontick runs delete <runId>
crontick runs delete --all --force
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--all` | boolean | `false` | Delete every run |
| `--force` | boolean | `false` | Required with `--all` |

---

## Stats Commands

### crontick stats summary

Show aggregate statistics.

```bash
crontick stats summary
```

Only runs whose parent job still exists are counted.

### crontick stats job

Show statistics for one job.

```bash
crontick stats job <id>
```

---

## Share Commands

### crontick share export

Export all jobs.

```bash
crontick share export
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--out <file>` | string | stdout | Output file path |
| `--include-runs` | boolean | `false` | Also include run history |

When `--out` is omitted, JSON is printed to stdout.

### crontick share import

Import jobs from a JSON file.

```bash
crontick share import <file>
```

Jobs are upserted. If the file includes exported run history, runs are restored archivally; they are not re-executed and do not affect the scheduler.

---

## Config and Info Commands

### crontick config

Print the config file path, a blank line, and the runtime-application note.

```bash
crontick config
```

Configuration is edited by hand in `config.json`. There are no `config get`, `config set`, `config unset`, `config init`, `config validate`, or `config engines` CLI subcommands.

Most config is read fresh for each run and applies automatically on the next run: engine definitions, the resolved prompt command, logging settings, `retention.maxOutputBytesPerRun`, and other per-run settings. The exception is `retention.maxRunsPerJob`, which is cached by the daemon's Store at startup; changing it requires `crontick daemon restart`.

### crontick info

Show version, runtime, storage locations, and daemon status.

```bash
crontick info
```

The output includes:

- crontick version
- Node.js version
- platform
- `paths` block: `dataDir`, `jobsDir`, `runsDb`, `logsDir`, `configFile`, `portFile`, `pidFile`
- daemon running status, including PID and port when available
- `dashboardUrl`: the URL of the daemon-served dashboard (for example `http://127.0.0.1:<port>/dashboard`), or `null` when it cannot be resolved (no running daemon and no readable port file). Open this URL in a browser. `info` never starts the daemon; the dashboard is served automatically whenever the daemon is up.

### crontick doctor

Check system health.

```bash
crontick doctor
```

Exits with code `1` if any check fails. Checks include Node.js version, SQLite availability, data directory, daemon connectivity, dashboard reachability, and MCP server availability.

---

## Daemon Commands

### crontick daemon start

Start the daemon.

```bash
crontick daemon start
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--foreground` | boolean | `false` | Run in foreground (blocking) |

### crontick daemon stop

Stop the daemon.

```bash
crontick daemon stop
```

### crontick daemon status

Show daemon status.

```bash
crontick daemon status
```

### crontick daemon reload

Reload job definitions from disk without restarting the daemon.

```bash
crontick daemon reload
```

Config edits normally do not require reload; see [configuration.md](configuration.md#when-config-edits-take-effect).

### crontick daemon restart

Restart the daemon.

```bash
crontick daemon restart
```

Required after changing `retention.maxRunsPerJob`.

---

## Dashboard

crontick has **no `dashboard` command group**. The dashboard is always served by the
daemon on its loopback origin whenever the daemon is running — there is nothing to start
or stop separately. To open it:

1. Run `crontick info` and copy the `dashboardUrl` line (for example
   `http://127.0.0.1:<port>/dashboard`).
2. Open that URL in a browser.

If the daemon is not running yet, run any daemon-backed command (or `crontick daemon
start`) and it will start automatically; then `crontick info` will report the URL.

The former `crontick dashboard start`, `crontick dashboard status`, `crontick dashboard
stop`, and `crontick dashboard data` CLI commands have been removed.

### Dashboard web UI

The dashboard is a dependency-free web page served on the daemon's loopback origin
(`/` and `/dashboard`). It renders live snapshots from `GET /api/dashboard` and drives
job/run actions through the existing `/api/*` routes.

- **Header** — shows the real daemon `version`, pid, node version and job count, plus an
  uptime badge (hover for a "daemon uptime" tooltip).
- **Jobs table** — columns are `Alias` (falls back to `—`), `ID` (shortened GUID with a
  copy icon for the full id), `Description`, `Schedule`, `Action`, `Last status`,
  `Next run`, and an `Actions` cell. Actions are icon buttons: enable (`▶`) / disable
  (`⏹`, prompts for confirmation) and delete (`🗑`, prompts for confirmation). Clicking a
  job row (outside the action buttons) sets the runs "Filter Job" control to that job and
  reloads the filtered snapshot.
- **Recent runs toolbar** — beside the heading: a **Filter Job** dropdown (server-side
  filter via `jobId`, so it reflects all of a job's runs), a client-side **Filter Status**
  dropdown, a **Sort** control (Time / Duration, ascending or descending; default Time ↓),
  and the runs-limit input in the top toolbar.
- **Runs table** — shows the full run id and session id, each with a copy icon, plus Job
  (`jobAlias || jobId`), Status, Started and Duration. Clicking a run row opens a log modal.
- **Run log modal** — fetches `GET /api/runs/:id/logs?source=all` and renders two stacked,
  independently scrollable panes: **Output** (stdout + crontick streams) and **Error**
  (stderr plus the run's recorded `error`). Close with the ✕ button, a backdrop click, or
  `Esc`.

---

## MCP Command

### crontick mcp

Start the crontick MCP server on stdio. This command launches the MCP server process rather than proxying a daemon operation, so it is not listed in `SURFACE_CAPABILITIES`.

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
