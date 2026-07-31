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

Unless otherwise noted, read commands that surface config values, run errors, captured
output, or dashboard data redact common secret shapes before printing. The same shared
redaction contract applies on CLI, library, MCP, and HTTP read surfaces.

## Error Output

In text mode, command failures print `Error [CODE]: message` (or `Error: message` for non-
`CrontickError` exceptions). When an error includes structured `details` data, the CLI now prints
an additional `Details:` block with readable field-level lines such as `id: ...` or
`schedule.everySec: ...`.

In `--json` mode, failures still exit with code `1`, but stderr contains the full structured error
payload as JSON, including `code`, `message`, and `details` when present.

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
| `engineArgs` | no | Convenience form of the command/prompt's arguments (after `--`); mutually exclusive with `--arg` |

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--cron <expr>` | string | — | Cron expression (e.g. `"0 9 * * *"`) |
| `--every <sec>` | integer | — | Interval in seconds |
| `--at <iso>` | string | — | One-shot run-at ISO-8601 time |
| `--tz <tz>` | string | — | Timezone for cron schedule |
| `--script <body>` | string | — | Inline script body |
| `--exec <cmd>` | string | — | Command to exec, taken verbatim. Pass its arguments with repeatable `--arg <value>` (primary, always correct) or, as a convenience, everything after a literal `--` |
| `--arg <value>` | string (repeatable) | `[]` | Argument to pass to `--exec` or `--prompt`; repeatable. The documented way to pass arguments — round-trips spaces, embedded quotes, and leading dashes on every shell and every Windows shim. Cannot be combined with `--`/`engineArgs` in the same command |
| `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 `.txt` file to read into the prompt |
| `--engine <engine>` | string | config `defaultEngine` | Configured prompt engine name |
| `--session-id <id>` | string | — | Reuse this prompt engine session every run |
| `--reuse-session` | boolean | `false` | Capture first successful run session id and reuse it |
| `--file <path>` | string | — | Load job JSON from a file |
| `--force` | boolean | `false` | Replace an existing job when the same id already exists |
| `--shell <shell>` | string | `auto` (create only) | Shell: `auto`\|`bash`\|`pwsh`\|`cmd`\* |
| `--job-env-file <path>` | string | — | Load extra environment variables from a `.env` file |
| `--timeout <sec>` | integer | — | Timeout in seconds |
| `--overlap <policy>` | string | `skip` (create only) | Overlap policy: `skip`\|`queue`\|`cancel-previous`\* |
| `--retry <max>` | integer | `0` | Retry count |
| `--desc <description>` | string | — | Job description |

\* `--shell` and `--overlap` only receive their default (`auto` / `skip`) when creating a job
(`crontick new`). On `crontick update`, omitting either flag leaves the job's existing value
unchanged — there is no update-time default, so a partial update never silently resets these
fields. See [job-schema.md](job-schema.md#update-vs-create-semantics) and
[jobs.md](../concepts/jobs.md).

`--exec` takes `<cmd>` verbatim: it is never split on whitespace, so a command string containing
a space (e.g. a path) is passed through unchanged as one argv element. Pass its arguments with
repeatable `--arg <value>`, once per argument:

```bash
crontick new notify --every 30 --exec notify-send --arg "Deploy finished" --arg "with warnings"
```

`--arg` is the documented, always-correct way to pass arguments — it round-trips spaces, embedded
double quotes, leading dashes, and values that are spelled like crontick's own flags (`-v`,
`--json`, ...) identically across `crontick.ps1`, `crontick.cmd`, and `npx crontick`. See
[ADR 0019](../decisions/0019-arg-flag-primary-for-exec-and-prompt-args.md) for why.

As a convenience, everything after a literal `--` (Commander's standard separator) is also
collected as `[engineArgs...]` and used as the argument list, with no whitespace splitting:

```bash
crontick new notify --every 30 --exec notify-send -- "Deploy finished" "with warnings"
```

`--arg` and `--`/`engineArgs` are mutually exclusive in the same command; combining both fails
with `Cannot combine --arg with -- positional arguments in the same command...`. A crontick flag
placed after `--` (e.g. `-- --json`) is rejected with an explicit error rather than silently
stored as a literal job argument — pass it via `--arg` instead if you meant it literally.

Need shell features instead (pipes, redirects, globbing)? Use `--script`, which runs through a
shell. Need to set `action.args` directly without going through argv parsing at all? Use `--file`
with an explicit `action.args` array. See [job-schema.md](job-schema.md#kind-exec) for the `exec`
action's JSON shape.

On Windows, a PowerShell-backed `--script` job (`shell: auto` resolving to `pwsh`, or an
explicit `--shell pwsh` / `powershell`) is wrapped so uncaught terminating errors,
non-terminating `Write-Error`, command-not-found, missing-module errors, and native
non-zero exits all fail the run with a non-zero exit status instead of a false success.
An explicit `exit N` still wins. Captured stdout/stderr is emitted and stored as UTF-8,
independent of the console's OEM code page.

#### Windows shells: `--arg` vs `--`

`--arg` works correctly on every real entry point. `--` is a convenience that is not reliable
through npm's Windows shims. Verified behavior:

| Form | `crontick.ps1` | `crontick.cmd` | `npx crontick` |
|---|---|---|---|
| `--arg <value>`, incl. spaces / leading dash / flag-like value | works | works | works |
| `--arg <value>` with embedded double quotes | works | fails — `cmd.exe` strips embedded quotes | works |
| `--` passthrough | fails — the PowerShell shim drops the literal `--` | works (no embedded quotes) | works |
| crontick flag placed after `--` | rejected | rejected | rejected |

Neither shim behavior is a crontick defect: a bare `crontick` on Windows resolves to the
npm-generated `crontick.ps1` shim, and PowerShell's own parameter binding strips a literal `--`
token before the shim's argv ever includes it (true of any `.ps1` script); the npm-generated
`crontick.cmd` shim is subject to `cmd.exe`'s own quoting rules, which mangle embedded double
quotes before Node ever sees them.

**Guidance:** prefer `--arg` on Windows. If you need embedded double quotes and are using the
`.cmd` shim, switch to PowerShell (`crontick.ps1`/bare `crontick` in a PowerShell prompt) or
`npx crontick` instead — both forward `--arg` correctly, including embedded quotes.

Exactly one schedule source (`--cron`, `--every`, `--at`) and one action source (`--script`, `--exec`, `--prompt`, `--prompt-file`) are required unless `--file` is used.

When `--file` is used for create or update, crontick accepts UTF-8 JSON with an optional leading
BOM. Malformed JSON fails with `VALIDATION_ERROR` that names the file, reports line/column/position,
and states the expected job or job-patch shape.

Creating a job is no longer a silent upsert. If `<id>` already exists, `crontick new`
fails with `JOB_ALREADY_EXISTS` and leaves the existing definition unchanged. Use
`crontick update <id>` for in-place edits, or pass `--force` when you intentionally want
create to replace the existing job. Schedule validation also happens before any
persistence, so an invalid `--cron` / `--every` / `--at` value never leaves a broken job
behind.

`--job-env-file` loads extra environment variables from a `.env` file. In persisted job
JSON and the library/MCP/HTTP JSON surfaces, the same setting is stored as `action.envFile`
/ `envFile`. `crontick new` and `crontick update` preflight that file before persistence: if it is
missing or unreadable, the command fails with `ENV_FILE_ERROR`, resolves relative paths against
`action.cwd` when set (otherwise the current working directory), and leaves existing job state
unchanged.

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

`crontick update` shares `crontick new`'s `--file`, `--job-env-file`, and read-surface redaction
semantics. Its JSON result redacts secret-like `action.env` values with the same contract
used by `crontick new`, `crontick list`, and `crontick get`. Missing or unreadable
`--job-env-file` now fails before persistence with `ENV_FILE_ERROR`, so the stored job
remains unchanged.

```bash
crontick update daily-backup --cron "30 3 * * *"
```

---

### crontick list

List all jobs. Returned job JSON redacts secret-like `action.env` values while preserving benign trap names such as `NON_SECRET`.

```bash
crontick list
```

No additional options.

---

### crontick get

Get a job by ID. Returned job JSON redacts secret-like `action.env` values while preserving benign trap names such as `NON_SECRET`.

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

Cancels the job's in-flight run, if any, before removing the job -- a deleted job never leaves an
orphaned process running against a definition that no longer exists. Deleting a job removes only the
job definition; archived run and log history remain available via `crontick runs get <runId>` and
`crontick logs <runId>`, but those archived rows are excluded from live aggregates. See
[jobs.md](../concepts/jobs.md#lifecycle-create-update-remove).

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
| `--status <status>` | string | — | Filter by run status: `queued`\|`running`\|`success`\|`failed`\|`canceled`\|`timeout`\|`missed` |

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
| `--tail <n>` | integer | — | Show the last N text lines after reconstructing newline-delimited output from stored log chunks |

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

Only runs whose parent job still exists are counted. Deleting a job keeps its historical runs
archived for direct `crontick runs get <runId>` / `crontick logs <runId>` access, but those
archived rows are excluded from live aggregate totals.

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

Returns the effective config with secret-like values redacted. The shared contract masks
common provider tokens, `token=`/`password=`-style assignments, contextual or standalone AWS
secret-access-key values, and private keys (including lone PEM begin/end markers) while avoiding
broad substring matches such as `NON_SECRET`. The underlying `config.json` file on disk is not
rewritten; read it directly if you need the literal stored bytes.

---

### crontick config set

Set one config value. The printed updated config uses the same secret-redaction contract as `config get`.

```bash
crontick config set <path> <value>
```

`value` is parsed as JSON when possible; otherwise treated as a string. Benign trap names such as `NON_SECRET` remain visible in the returned config.

---

### crontick config unset

Remove one config value. The printed updated config uses the same secret-redaction contract as `config get`.

```bash
crontick config unset <path>
```

Removes the key from `config.json` itself. If the key has a built-in default (e.g.
`defaultEngine`, `retention.*`, or the built-in `copilot` engine's fields), `config get`
continues to report that default afterward — but the file no longer pins the value
explicitly. See [configuration.md](configuration.md#set-vs-inherited-values).

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

Exits with code `1` if validation fails. A leading UTF-8 BOM is accepted. Malformed JSON now
reports the file path, line, column, position, and the expected config shape instead of surfacing
a raw `SyntaxError`.

---

### crontick config engines

List configured engines. Add/update commands return the updated config with secret-like engine `env` values redacted while preserving benign trap names such as `NON_SECRET`.

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
| `--include-runs` | boolean | `false` | Also include run history (a `runs` array) in the export |

---

### crontick import

Import jobs from a JSON file.

```bash
crontick import <file>
```

Jobs are upserted (existing jobs with the same ID are updated). If the file was produced with
`--include-runs`, its `runs` array is restored archivally into `runs.db` (`INSERT OR IGNORE`,
keyed by run id; rows for a job that no longer exists are skipped) -- this is a plain data
restore, not re-execution, and does not touch the scheduler. A leading UTF-8 BOM is accepted.
Malformed import JSON fails with `VALIDATION_ERROR` that names the file, reports line/column/position,
and states that crontick expected either a JSON array of jobs or an export object with jobs and
optional runs.

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

In `--json` mode, background starts print the structured daemon-start result (`ok`, `started`,
`pid`, `port`, `baseUrl`). `--foreground --json` is rejected up front because foreground mode
streams daemon logs to stdout instead of producing a single JSON object.

---

### crontick daemon stop

Stop the daemon.

```bash
crontick daemon stop
```

Sends `POST /api/daemon/stop` to shut the daemon down in-process (works identically on every
platform) and reports `mode: "graceful"` on success. If the HTTP route is unreachable (an older
daemon binary or a stale port file), falls back to `process.kill(pid, 'SIGTERM')`; if the process
does not exit within the poll timeout after either path (graceful-accepted-but-stalled, or plain
SIGTERM), it escalates to `SIGKILL` and reports `mode: "hard-kill"` — not the normal path, but the
daemon is never left running indefinitely by a stalled stop. Reports `mode: "already-stopped"` if
no daemon was running. The response also reports any `activeRuns` (`{ id, jobId }`) still in
progress when the daemon stopped, since their processes keep running detached (see
[jobs.md](../concepts/jobs.md#lifecycle-create-update-remove)) and are not abandoned silently. See
[daemon-lifecycle.md](../concepts/daemon-lifecycle.md#shutdown).

---

### crontick daemon status

Show daemon status.

```bash
crontick daemon status
```

The result includes the daemon's loopback discovery fields (`port`, `baseUrl`) plus a
`missedFires` summary: `{ jobsWithMissedFires, missedRunsRecorded, jobsCapped, capPerJob }`,
describing fires the schedule would have produced while the daemon was not running, recorded on
the most recent daemon start (`capPerJob` is 500). In text mode these fields print as `key: value`
lines; with `--json` they are part of the structured status object. See
[daemon-lifecycle.md](../concepts/daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

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

In `--json` mode, restart prints the structured daemon-restart result (`ok`, `started`, `stopped`,
`previousPid`, `pid`, `port`, `baseUrl`) instead of only human text.

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

Aggregate run counts and the recent-runs list include only runs whose parent job still exists.
Deleting a job keeps its historical runs directly queryable by run id, but removes them from
these live dashboard views.

---

### crontick dashboard stop

Stop the dashboard server.

```bash
crontick dashboard stop
```

---

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
