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
| `1` | Error, failed `info doctor`, or validation/usage failure |

Errors are rendered as a single clean line on stderr; see [errors.md](errors.md#cli).

---

## Command Tree

```text
crontick jobs new [engineArgs...]
crontick jobs update <id> [engineArgs...]
crontick jobs list
crontick jobs get <id>
crontick jobs schedule <id> [-n <count>]
crontick jobs delete <idOrAlias>
crontick jobs delete all --force
crontick jobs run-now <id>

crontick runs list [--job <id>] [--limit <n>] [--since <ms>] [--status <status>]
crontick runs get <runId>
crontick runs logs <runId> [engine|crontick] [--tail <n>]
crontick runs cancel <runId>

crontick stats summary
crontick stats job <id>

crontick share export [--out <file>] [--include-runs]
crontick share import <file>

crontick info
crontick info doctor
crontick info daemon stop
crontick info daemon reload
crontick mcp [--no-start-daemon] [--daemon-url <url>]
```

Commands accept a job identifier as either the immutable GUID `id` or the human-friendly `alias`. `jobs new` assigns the GUID automatically; use `--name <name>` only when you want to control the human-friendly name.

---

## Job Commands

### crontick jobs new

Create a new job. The job's GUID `id` is always assigned by crontick. If `--name` is omitted, crontick auto-generates a unique alias.

```bash
crontick jobs new [engineArgs...]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--desc <description>` | string | — | Job description |
| `--cron <expr>` | string | — | Cron expression (for example, `"0 9 * * *"`) |
| `--every <interval>` | string | — | Interval in seconds, or with an `s`, `m`, `h`, or `d` suffix (for example `30m` = 1800 seconds) |
| `--at <iso>` | string | — | One-shot run-at ISO-8601 time |
| `--tz <tz>` | string | — | IANA timezone for cron schedules |
| `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 text file to read into the prompt |
| `--runner <runner>` | string | config `defaultEngine` | Configured prompt engine name; saved as `action.engine` |
| `--session-id <id>` | string | — | Reuse this prompt engine session every run |
| `--reuse-session` | boolean | `false` | Capture a reusable session ID; resolved overlap must be `skip` |
| `--file <path>` | string | — | Create the job from a full prompt-job JSON file |
| `--name <name>` | string | auto-generated | Human-friendly, unique, kebab-case job identifier; saved as `alias` |
| `--timeout <sec>` | integer | config `defaults.timeoutSec` (unset by default) | Per-run timeout in seconds |
| `--overlap <policy>` | `skip` \| `queue` \| `cancel-previous` | config `defaults.overlap` (`skip` by default) | Overlap policy |
| `--retry <max>` | integer | config `defaults.retry.max` (`0` by default) | Retry count on failure |
| `--force` | boolean | `false` | Replace an existing job when the same alias already exists |

Exactly one schedule source (`--cron`, `--every`, `--at`) and one prompt source (`--prompt`, `--prompt-file`) are required unless `--file` is used. Bare `--every` numbers remain seconds; suffixes `s`, `m`, `h`, and `d` mean seconds, minutes, hours, and days. Unrecognized long flags, with a following value when that token is not flag-shaped, are stored verbatim in `action.args`. The same flags work after `--`, which also accepts positional arguments. Their order is preserved. Flags that crontick manages for the engine (`--prompt`, `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`, `--settings`, and the short forms `-p` and `-r`) are rejected, including `--flag=value` forms. Removed `--alias` and `--engine` switches are rejected as unknown options, including after `--`. If a token after `--` matches a crontick long flag, the CLI rejects it rather than silently storing it as a literal prompt arg.

Dedicated `--script`, `--exec`, `--arg`, `--shell`, and `--job-env-file` flags are not exposed on the CLI. The job schema supports prompt actions only; `--file` accepts a complete prompt-job definition.

```bash
crontick jobs new --every 30m --prompt "Summarize the current repository status" --name repo-summary --runner claude
crontick jobs new --every 300 --prompt "Review this repository" --permission-mode acceptEdits
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
Unknown long flags use the same argument passthrough as `jobs new`; include `--prompt` or `--prompt-file` when updating the runner or engine arguments.

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
crontick jobs delete <idOrAlias>
crontick jobs delete all --force
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--all` | boolean | `false` | Delete every job |
| `--force` | boolean | `false` | Required with `--all` |

Deleting a single job cancels its in-flight run, if any. Historical runs remain queryable by run id, but live aggregates exclude runs whose parent job was deleted.

`jobs delete all --force` removes every job atomically in a single daemon transaction, deleting all jobs together with their associated runs and logs (there is nothing left to query aggregates against). `--force` is required and is validated in the core client.

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
| `--status <status>` | string | — | Filter by run status: `queued`\|`running`\|`success`\|`failed`\|`canceled`\|`skipped`\|`timeout`\|`missed` |

---

### crontick runs get

Get a run by ID.

```bash
crontick runs get <runId>
```

The output includes the resolved, redacted command, status/timing fields, and any captured `sessionId`. Claude runs with a complete result also include `costUsd`, `turns`, `usageJson` (a redacted JSON string), `transcriptPath` (a path pointer; crontick does not read the file for usage), and `engineStatus` (Claude's result subtype). Raw-engine runs omit these fields. After a daemon restart, a Claude run that finished while crontick was unavailable can recover its exit status from a matching `SessionEnd` marker; if that marker is absent or incomplete, the usual orphan/adopted-run fallback applies.

---

### crontick runs logs

Get logs for a run.

```bash
crontick runs logs <runId> [engine|crontick]
```

| Argument / flag | Type | Default | Description |
|-----------------|------|---------|-------------|
| `source` | `engine` \| `crontick` | both streams | Optional positional filter. `engine` = stdout/stderr from the spawned process; `crontick` = scheduling/execution lifecycle events. Any other value is rejected with `VALIDATION_ERROR` (validated in the core client) |
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

## Stats Commands

### crontick stats summary

Show aggregate statistics.

```bash
crontick stats summary
```

Only runs whose parent job still exists are counted.
The response includes separate `canceled` and `skipped` counts, plus `totalCostUsd` and `totalTurns` summed over the included runs; runs without usage contribute zero.

### crontick stats job

Show statistics for one job.

```bash
crontick stats job <id>
```

The response includes separate `canceled` and `skipped` counts, plus `totalCostUsd` and `totalTurns` summed over that job's recent runs.

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

## Info Commands

### crontick info

Show version, runtime, config path, storage locations, daemon status, and dashboard URL.

```bash
crontick info
```

The default output includes:

- crontick version
- Node.js version
- platform
- daemon running status, including PID and port when available
- config file path (`configPath`)
- dashboard URL when the daemon is running
- `paths` block: `dataDir`, `jobsDir`, `logsDir`, `runsDb`, `portFile`, `pidFile`

`info` never starts the daemon; when the daemon is stopped it prints that state and notes that the dashboard becomes available again on the next daemon-backed command.

### crontick info doctor

Check system health.

```bash
crontick info doctor
```

Exits with code `1` if any check fails. Checks include Node.js version, SQLite availability, data directory, daemon connectivity, dashboard reachability, and MCP server availability.

### crontick info daemon stop

Stop the daemon.

```bash
crontick info daemon stop
```

### crontick info daemon reload

Reload job definitions from disk without restarting the daemon.

```bash
crontick info daemon reload
```

Running `crontick info daemon` with no subcommand prints help. Config edits normally do not require reload; see [configuration.md](configuration.md#when-config-edits-take-effect).

---

## Dashboard

crontick has **no `dashboard` command group**. The dashboard is always served by the
daemon on its loopback origin whenever the daemon is running — there is nothing to start
or stop separately. To open it:

1. Run `crontick info` and copy the `dashboardUrl` line (for example
   `http://127.0.0.1:<port>/dashboard`).
2. Open that URL in a browser.

If the daemon is not running yet, run any daemon-backed command (for example `crontick jobs list`) and it will start automatically; then `crontick info` will report the URL.

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
