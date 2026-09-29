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
crontick doctor
crontick daemon start [--foreground]
crontick daemon stop
crontick daemon restart
crontick daemon status
crontick daemon reload
crontick mcp [--no-start-daemon] [--daemon-url <url>]
```

Commands accept a job identifier as either the immutable GUID `id` or the human-friendly name (`--name`, stored as `alias`). `jobs new` assigns the GUID automatically; use `--name <name>` only when you want to control the human-friendly name.

---

## Job Commands

### crontick jobs new

Create a new job. The job's GUID `id` is always assigned by crontick. If `--name` is omitted, crontick auto-generates a unique name.

```bash
crontick jobs new [engineArgs...]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name <name>` | string | auto-generated | Unique, kebab-case job name; saved as the job's `alias` field |
| `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 text file to read into the prompt |
| `--cron <expr>` | string | — | Schedule: cron expression (for example, `"0 9 * * *"`) |
| `--every <interval>` | string | — | Schedule: repeat every N seconds, or with an `s`, `m`, `h`, or `d` suffix (for example `30m` = 1800 seconds) |
| `--at <datetime>` | string | — | Schedule: one-shot run time, ISO-8601 (for example `2026-10-01T09:00`). Interpreted in the machine's local timezone unless an offset (`Z`, `+02:00`) is given. Date-only values (`2026-10-01`) are parsed as UTC midnight, so include a time |
| `--tz <tz>` | string | — | IANA timezone for `--cron` schedules |
| `--runner <runner>` | string | config `defaultEngine` | Configured prompt engine name; saved as `action.engine` |
| `--session-id <id>` | string | — | Resume this existing prompt-engine (for example Claude) conversation session on every run of the job, instead of starting a fresh session each run |
| `--reuse-session` | boolean | `false` | Start a session on the first successful run, then keep resuming that same session on later runs (alternative to `--session-id`); resolved overlap must be `skip` |
| `--file <path>` | string | — | Create the job from a full prompt-job JSON file |
| `--timeout <sec>` | integer | config `defaults.timeoutSec` (unset by default) | Per-run timeout in seconds |
| `--overlap <policy>` | `skip` \| `queue` \| `cancel-previous` | config `defaults.overlap` (`skip` by default) | Overlap policy |
| `--retry <max>` | integer | config `defaults.retry.max` (`0` by default) | Retry count on failure |
| `--desc <description>` | string | — | Job description |
| `--force` | boolean | `false` | Replace an existing job when the same name already exists |

Exactly one schedule source (`--cron`, `--every`, `--at`) and one prompt source (`--prompt`, `--prompt-file`) are required unless `--file` is used. Supplying more than one schedule flag is an error (`VALIDATION_ERROR`: they cannot be combined); supplying none is `MISSING_ARG`. Bare `--every` numbers remain seconds; suffixes `s`, `m`, `h`, and `d` mean seconds, minutes, hours, and days. Unrecognized long flags, with a following value when that token is not flag-shaped, are stored verbatim in `action.args`. The same flags work after `--`, which also accepts positional arguments. Their order is preserved. Flags that crontick manages for the engine (`--prompt`, `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`, `--settings`, and the short forms `-p` and `-r`) are rejected, including `--flag=value` forms. Removed `--alias` and `--engine` switches are rejected as unknown options, including after `--`. If a token after `--` matches a crontick long flag, the CLI rejects it rather than silently storing it as a literal prompt arg.

Dedicated `--script`, `--exec`, `--arg`, `--shell`, and `--job-env-file` flags are not exposed on the CLI. The job schema supports prompt actions only; `--file` accepts a complete prompt-job definition.

```bash
crontick jobs new --every 30m --prompt "Summarize the current repository status" --name repo-summary --runner claude
crontick jobs new --every 300 --prompt "Review this repository" --permission-mode acceptEdits
crontick jobs new --file ./job.json
```

---

### crontick jobs update

Update an existing job by GUID or name.

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

Get a job by GUID or name.

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
| `--force` | boolean | `false` | Required to confirm `jobs delete all` (the reserved `all` keyword) |

Deleting a single job cancels its in-flight run, if any. Historical runs remain queryable by run id, but live aggregates exclude runs whose parent job was deleted.

`jobs delete all --force` removes every job atomically in a single daemon transaction, deleting all jobs together with their associated runs and logs (there is nothing left to query aggregates against). `--force` is required and is validated in the core client.

---

### crontick jobs run-now

Run a job once, right now, whether or not it is enabled. Returns `{ runId }`; follow it with `crontick runs get <runId>`.

```bash
crontick jobs run-now <id-or-name>
```

Run-now does not enable a disabled job and does not alter or reschedule anything: an enabled job keeps its normal schedule, a disabled job stays disabled (and never fires on its own). The job's overlap policy still applies: with `overlap: skip` and a run already active, the manual run is recorded as `skipped`; `queue` and `cancel-previous` behave as for scheduled fires.

---

## Run Commands

### crontick runs list

List recent runs.

```bash
crontick runs list
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--job <id>` | string | — | Filter by job GUID or name |
| `--limit <n>` | integer | — | Maximum runs to return |
| `--since <ms>` | integer | — | Only runs since epoch milliseconds |
| `--status <status>` | string | — | Filter by run status: `queued`\|`running`\|`success`\|`failed`\|`canceled`\|`skipped`\|`timeout`\|`missed` |
| `--json` | boolean | `false` | Print the raw run records as JSON: epoch-millisecond timestamps, `durationMs`, and full error text |

The default output is an aligned table with columns `RUN`, `JOB`, `STATUS`, `STARTED`, `ENDED` (ISO-8601 in the machine's local timezone, with offset), `DURATION` (seconds, for example `187s` or `1.23s`), `EXIT`, and `ERROR` (whitespace collapsed and truncated to 60 characters; use `runs get <runId>` or `--json` for the full text).

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
The response includes separate `canceled` and `skipped` counts (`skipped` = fires that never started a process because overlap `skip` found another run already active; `canceled` = runs that started and were then terminated), plus `totalCostUsd` and `totalTurns` summed over the included runs; runs without usage contribute zero.

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
With `--include-runs`, run history is exported for archival restore. Imported
history cannot establish which crontick job created a Claude transcript, so
it does not authorize Claude session reuse.

### crontick share import

Import jobs from a JSON file.

```bash
crontick share import <file>
```

Jobs are upserted. If the file includes exported run history, runs are restored archivally; they are not re-executed and do not affect the scheduler.
An imported Claude job with an unverified stored session starts a fresh
session. With `overlap: skip`, it captures that new session for later runs.
Raw-engine session IDs are preserved. Existing locally verified Claude
sessions remain eligible, subject to the transcript preflight.

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
- config file path (`configPath`), with `(not created yet - built-in defaults in use)` when the file does not exist (`configExists: false`)
- dashboard URL when the daemon is running
- `paths` block: `dataDir`, `jobsDir`, `logsDir`, `runsDb`, `portFile`, `pidFile`
- a `commands` section listing every available command with a one-line description, generated from the live command tree

`info` never starts the daemon; when the daemon is stopped it prints that state and notes that the dashboard becomes available again on the next daemon-backed command.

### crontick doctor

Check system health.

```bash
crontick doctor
```

Exits with code `1` if any check fails. Checks include Node.js version, SQLite availability, data directory (path shown), config file (path shown; reports when it has not been created yet and defaults are in use), daemon connectivity, dashboard reachability, and MCP server availability.

### crontick daemon start

Start the daemon explicitly. The daemon also starts automatically on first use, so this is optional.

```bash
crontick daemon start [--foreground]
```

By default the daemon is started in the background and the command prints its PID and URL (or reports it is already running). `--foreground` runs the daemon in the current terminal until it exits. This is an explicit, one-off start; it does not register the daemon to start at login or boot.

### crontick daemon status

Show whether the daemon is running (PID, port, uptime, job count). Exits `1` with a hint when it is not running. Never starts the daemon.

### crontick daemon restart

Stop the daemon and start it again.

### crontick daemon stop

Stop the daemon.

```bash
crontick daemon stop
```

### crontick daemon reload

Reload job definitions from disk without restarting the daemon.

```bash
crontick daemon reload
```

Running `crontick daemon` with no subcommand prints help. `crontick info daemon stop|reload` remains as a hidden, deprecated alias. Config edits normally do not require reload; see [configuration.md](configuration.md#when-config-edits-take-effect).

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
