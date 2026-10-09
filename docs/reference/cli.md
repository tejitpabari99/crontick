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
crontick jobs update <id|alias> [engineArgs...]
crontick jobs list
crontick jobs get <id|alias>
crontick jobs schedule <id|alias> [-n <count>]
crontick jobs delete <id|alias> [--force]
crontick jobs delete all --force
crontick jobs run-now <id|alias>
crontick jobs trigger <id|alias> [--payload <json>|@file|->]

crontick runs list [--job <id|alias>] [--limit <n>] [--since <ms>] [--status <status>]
crontick runs get <runId> [--json]
crontick runs cancel <runId>
crontick runs delete <runId...> | --job <id|alias> [--force] [--dry-run] [--json]

crontick stats summary
crontick stats job <id|alias>

crontick share export [--out <file>] [--only-jobs <id|alias,...>] [--include-secrets]
crontick share import <file> [--trust-folder]

crontick config list [--json]
crontick config get <key>
crontick config set <key> <value> [--string] [--stop-running | --wait-running]
crontick config unset <key> [--stop-running | --wait-running]

crontick info
crontick doctor
crontick daemon start [--foreground] [--home <dir>]
crontick daemon stop
crontick daemon restart
crontick daemon status
crontick daemon reload
crontick daemon pause
crontick daemon resume
crontick autostart enable
crontick autostart disable
crontick autostart status
crontick mcp [--no-start-daemon] [--daemon-url <url>]
```

The alias `all` is reserved (it is the `jobs delete all` keyword) and is rejected on create, update and import.

Commands accept a job identifier as either the immutable GUID `id` or the job's **alias** (the unique kebab-case name; `--alias`/`-a` sets it). `jobs new` assigns the GUID automatically; pass `--alias <alias>` only when you want to control the alias. Every command that takes a job (`jobs update/get/schedule/delete/run-now`, `stats job`, `runs list --job`, `share export --only-jobs`) resolves an id or an alias the same way. A missing job reports `Job X not found (id or alias)`.

---

## Job Commands

### crontick jobs new

Create a new job. The job's GUID `id` is always assigned by crontick. If `--alias` is omitted, crontick auto-generates a unique alias (a word plus a number, regenerated on collision; after many collisions a short random suffix is used).

```bash
crontick jobs new [engineArgs...]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-a`, `--alias <alias>` | string | auto-generated | Unique kebab-case job alias (saved as the job's `alias` field) |
| `-p`, `--prompt <text>` | string | — | Prompt text for a prompt action |
| `--prompt-file <path>` | string | — | UTF-8 text file to read into the prompt |
| `--cron <expr>` | string | — | Schedule: cron expression (for example, `"0 9 * * *"`). Fires in the machine's local timezone |
| `--every <interval>` | string | — | Schedule: repeat every N seconds, or with an `s`, `m`, `h`, or `d` suffix (for example `30m` = 1800 seconds) |
| `--at <datetime>` | string | — | Schedule: one-shot run time, ISO-8601 (for example `2026-10-01T09:00`). Interpreted in the machine's local timezone unless an offset (`Z`, `+02:00`) is given. Date-only values (`2026-10-01`) are parsed as UTC midnight, so include a time |
| `--after <id\|alias>` | string | — | Schedule: run when this upstream job finishes (resolved to its GUID). Cycles: `AFTER_CYCLE`; unknown upstream: `AFTER_UPSTREAM_NOT_FOUND` |
| `--after-status <status>` | string | `success` | With `--after`: `success`, `failure` (failed or timeout) or `any`. Without an after schedule it is an error |
| `--webhook` | boolean | `false` | Schedule: run on webhook events (via `--relay`) or local `jobs trigger`. See [Webhooks](../concepts/webhooks.md) |
| `--relay <url\|auto>` | string | — | With `--webhook`: relay channel URL (smee.io protocol; `http://` only for loopback hosts), or `auto` to create a smee.io channel (printed once; treat as a secret). Omit for local-trigger-only. Without `--webhook` it is an error |
| `--webhook-secret <secret>` | string | — | With `--webhook`: require a valid `x-hub-signature-256` on relay events. HMAC over smee is unverified against real GitHub deliveries (see [Webhooks](../concepts/webhooks.md#guards-relay-events-only)). Without `--webhook` it is an error |
| `--dir <path>` | string | the current directory | Directory the job runs in; stored as `action.cwd`. Must be an existing directory (`INVALID_CWD`). See [Working directory and Claude trust](#working-directory-and-claude-trust) |
| `--trust-folder` | boolean | `false` | Trust the working directory in Claude without asking when it is not trusted yet |
| `--runner <runner>` | string | config `defaultEngine` | Configured prompt engine name; saved as `action.engine` |
| `--session-id <id>` | string | — | Resume an existing session ID (may be one you started yourself) on every run; implies reuse and requires overlap `skip`; shown as the Runner Session ID |
| `--reuse-session` | boolean | `false` | Start a new session on the first run and resume it on succeeding runs (alternative to `--session-id`); resolved overlap must be `skip` |
| `--file <path>` | string | — | Create the job from a full prompt-job JSON file |
| `--timeout <sec>` | integer | config `defaults.timeoutSec` (unset by default) | Per-run timeout in seconds |
| `--overlap <policy>` | `skip` \| `queue` \| `cancel-previous` | `skip` (config `defaults.overlap`) | Overlap policy: skip\|queue\|cancel-previous (default: skip). On `jobs update`, omitting it leaves the job's policy unchanged |
| `--retry <max>` | integer | config `defaults.retry.max` (`0` by default) | Retry count on failure |
| `--desc <description>` | string | — | Job description |
| `--force` | boolean | `false` | Replace an existing job when the same alias already exists |

`jobs new --help` ends with a "How to schedule" footer ("Use exactly one of --cron, --every, --at, --after, --webhook.", generated from `SCHEDULE_FLAGS`); `jobs update --help` has the same option help but no footer. Exactly one schedule source (`--cron`, `--every`, `--at`, `--after`, `--webhook`) and one prompt source (`--prompt`, `--prompt-file`) are required unless `--file` is used. Supplying more than one schedule flag is an error (`VALIDATION_ERROR`: they cannot be combined); supplying none is `MISSING_ARG`. Bare `--every` numbers remain seconds; suffixes `s`, `m`, `h`, and `d` mean seconds, minutes, hours, and days. Unrecognized long flags, with a following value when that token is not flag-shaped, are stored verbatim in `action.args`. The same flags work after `--`, which also accepts positional arguments. Their order is preserved. Short flags before `--` belong to crontick (`-a`, `-p`); after `--` they pass through to the engine (for example `-v`). Flags that crontick manages for the engine (`--prompt`, `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`, `--settings`, and the short forms `-p` and `-r`) are rejected, including `--flag=value` forms. Removed `--engine`, `--job-env-file`, `--tz`, `--cwd` and `-C` switches are rejected as unknown options, including after `--`. If a token after `--` matches a crontick long flag, the CLI rejects it rather than silently storing it as a literal prompt arg.

Dedicated `--script`, `--exec`, `--arg`, `--shell`, and `--job-env-file` flags are not exposed on the CLI. The job schema supports prompt actions only; `--file` accepts a complete prompt-job definition.

```bash
crontick jobs new --every 30m --prompt "Summarize the current repository status" --alias repo-summary --runner claude
crontick jobs new --every 300 --prompt "Review this repository" --permission-mode acceptEdits
crontick jobs new --file ./job.json
```

---

### crontick jobs update

Update an existing job by GUID or alias.

```bash
crontick jobs update <id|alias> [engineArgs...]
```

`jobs update` accepts exactly the same job options as `jobs new` (both are built from one shared option list, and a test keeps them identical) except create-only `--force`, plus:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--enable` | boolean | — | Enable the job |
| `--disable` | boolean | — | Disable the job |
| `--unset <field>` | `timeout` \| `session-id` \| `desc` | — | Remove an optional field (repeatable and/or comma-separated, e.g. `--unset timeout,desc`). Maps to `null` in the patch. An unknown field, or `--unset X` together with the setter flag for X (`--timeout`, `--session-id`, `--desc`), is a usage error (`VALIDATION_ERROR`) |
| `--stop-running` | boolean | — | If the job has runs in flight, cancel them (status `canceled`, no retry, queued runs dropped, `--after` dependents not triggered), then apply |
| `--wait-running` | boolean | — | If the job has runs in flight, pause that job (other jobs keep firing), wait for them to finish with no timeout, apply, then resume it automatically |

With runs in flight and neither flag, a terminal prompts (stop / wait / cancel); a non-interactive session fails with `RUNS_IN_FLIGHT` listing the runs. The two flags are mutually exclusive.

Omitted options leave the existing job unchanged. `--enable` and `--disable` are mutually exclusive. A job that failed 3 consecutive runs is auto-disabled (see [execution concepts](../concepts/execution.md#auto-disable-after-consecutive-failures)); `--enable` re-enables it and resets the failure count.
Unknown long flags use the same argument passthrough as `jobs new`; include `--prompt` or `--prompt-file` when updating the runner or engine arguments.

```bash
crontick jobs update repo-summary --cron "0 9 * * 1-5"
crontick jobs update repo-summary --dir ~/code/other-repo   # changes only the working directory
crontick jobs update repo-summary --disable
crontick jobs update repo-summary --unset timeout --unset desc   # remove the timeout and description
```

---

### crontick jobs list

List all jobs.

```bash
crontick jobs list
```

---

### crontick jobs get

Get a job by GUID or alias. The output includes `cwd` and, when set, the `Runner Session ID`. This is the only command that prints a webhook job's full relay URL and secret in clear (every other output masks them: `https://smee.io/Uk…Sd`, `secret: set`). For a webhook job with a relay it also prints a `relay:` line with the redacted URL, state (`connecting|connected|backoff|error`), event count, last event time and last error (`relay: not connected (daemon not running or job disabled)` otherwise). `jobs update --relay auto` rotates the channel but prints the masked URL; use `jobs get` to read the new one.

```bash
crontick jobs get <id|alias>
```

---

### crontick jobs schedule

Show upcoming fire times for a job. The output prints `status: enabled|disabled` (a disabled job never fires on its own) and the job's `cwd` before the fire times; the library/MCP payload carries the same information as `enabled`.

```bash
crontick jobs schedule <id|alias>
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-n`, `--count <n>` | integer | `5` | Number of upcoming fire times to show |

This replaces the old raw `schedule preview` command: schedules are previewed in the context of an existing job.

---

### crontick jobs delete

Delete one job, or delete all jobs with explicit confirmation.

```bash
crontick jobs delete <id|alias> [--force]
crontick jobs delete all --force
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--force` | boolean | `false` | Required to confirm `jobs delete all` (the reserved `all` keyword). With a single job: delete it even though other jobs run `--after` it; the dependents are disabled and keep a dangling upstream (without `--force` the delete fails with `JOB_HAS_DEPENDENTS`, listing their aliases) |

Deleting a job cancels its in-flight run, if any, and deletes the job together with its runs, stored run output, schedule state and per-job log file, in one transaction. Nothing of the job remains in `runs list`, `runs get`, stats or the dashboard. Claude's own session transcripts are not touched.

`jobs delete all --force` removes every job atomically in a single daemon transaction, deleting all jobs together with their associated runs and logs. `--force` is required and is validated in the core client.

---

### crontick jobs run-now

Run a job once, right now, whether or not it is enabled. Returns `{ runId }`; follow it with `crontick runs get <runId>`.

```bash
crontick jobs run-now <id|alias>
```

Run-now does not enable a disabled job and does not alter or reschedule anything: an enabled job keeps its normal schedule, a disabled job stays disabled (and never fires on its own). The job's overlap policy still applies: with `overlap: skip` and a run already active, the manual run is recorded as `skipped`; `queue` and `cancel-previous` behave as for scheduled fires.

---

### crontick jobs trigger

Fire a webhook job once, right now, with an optional JSON payload. Same path as a relay event except there is no signature, dedupe or burst check. Returns `{ runId }`.

```bash
crontick jobs trigger <id|alias> [--payload <json>|@file|->]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--payload <json\|@file\|->` | string | none | Any JSON value: inline, `@path` to read a file, or `-` for stdin. Invalid or unreadable: `INVALID_PAYLOAD` |

Only webhook jobs: others fail with `NOT_WEBHOOK_JOB` (use `run-now`); a disabled job fails with `JOB_DISABLED`. The payload reaches the run as untrusted data (`CRONTICK_EVENT`, fenced prompt suffix); see [Webhooks](../concepts/webhooks.md).

---

## Run Commands

### crontick runs list

List recent runs.

```bash
crontick runs list
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--job <id|alias>` | string | — | Filter by job GUID or alias |
| `--limit <n>` | integer | — | Maximum runs to return |
| `--since <ms>` | integer | — | Only runs since epoch milliseconds |
| `--status <status>` | string | — | Filter by run status: `queued`\|`running`\|`success`\|`failed`\|`canceled`\|`skipped`\|`timeout`\|`missed` |
| `--json` | boolean | `false` | Print the raw run records as JSON: epoch-millisecond timestamps, `durationMs`, and full error text |

The default output is an aligned table with columns `RUN`, `JOB`, `STATUS`, `STARTED`, `ENDED` (ISO-8601 in the machine's local timezone, with offset), `DURATION` (seconds, for example `187s` or `1.23s`), `EXIT`, and `ERROR` (whitespace collapsed and truncated to 60 characters; use `runs get <runId>` or `--json` for the full text).

---

### crontick runs get

Show a run and its cleaned output. This command replaces the former `runs logs` and `runs output`.

```bash
crontick runs get <runId> [--json]
```

The default output is one `Label: value` line per run field with local ISO-8601 timestamps (`Run ID`, `Job ID`, `Status` (printed once), `Started`, `Ended`, `Duration`, `Exit code`, `Engine status`, the resolved redacted `Command`, `Runner Session ID`, and for Claude runs `Cost (USD)` and `Turns`), for webhook-triggered runs a `Trigger:` line (`webhook (relay|local) at <time>, delivery <id>`) with the payload beneath it (smee URLs masked), then `Transcript:` (Claude's session file, absolute path) with `Log file:` directly below it (each followed by `(file not found)` when the file does not exist on disk), a blank line, and the cleaned output: the `Error:` (if any), the engine's final answer and `[stderr]` only when there is no error. Tool calls, interim assistant text, thinking blocks and hook payloads are never kept. The command shows `--settings <session-end-hook>` in place of the hook JSON.

`Log file` is the absolute path of the job's single log file, which carries crontick's own lifecycle events (start, timeout, retry, exit) for all runs of the job (`(file logging is disabled)` when `logging.fileEnabled` is false). The same path is the run record's `logFile`.

`--json` prints `{ "run": <RunRecord with epoch-ms timestamps and logFile>, "output": <RunOutput> }`; see [`RunOutput`](library-api.md#runoutput). After a daemon restart, a Claude run that finished while crontick was unavailable can recover its exit status from a matching `SessionEnd` marker; if that marker is absent or incomplete, the usual orphan/adopted-run fallback applies.

---

### crontick runs cancel

Cancel an in-progress run.

```bash
crontick runs cancel <runId>
```

---

### crontick runs delete

Delete finished runs and their stored output, by run id or by job.

```bash
crontick runs delete <runId...> [--force] [--dry-run] [--json]
crontick runs delete --job <id|alias> [--force] [--dry-run] [--json]
```

| Flag | Description |
|------|-------------|
| `--job <id\|alias>` | Delete all runs of a job. Accepts an id, an alias, or the raw id of an already-deleted job (orphaned runs). Mutually exclusive with run ids |
| `--force` | Skip the confirmation prompt (required when stdin/stdout is not a TTY; otherwise `CONFIRMATION_REQUIRED`, exit 1) |
| `--dry-run` | Preview the result; nothing is deleted, no prompt |
| `--json` | Print the full result `{ deleted, skipped, notFound, jobLogRemoved }` |

Without `--force` the command runs a dry run first, then asks `Delete N run(s)[ of job X]? (y/N)`. `queued`/`running` runs are skipped (not canceled) and listed. Unknown run ids are reported and the exit code is 1 when any are present; other ids are still processed. When the job no longer exists and no runs remain, its per-job log file is removed; a live job's log is kept. Plain output: `Deleted N run(s); skipped M active; not found K.`

---

## Stats Commands

### crontick stats summary

Show aggregate statistics.

```bash
crontick stats summary
```

Deleted jobs leave no runs behind, so every stored run is counted.
The response includes separate `canceled` and `skipped` counts (`skipped` = fires that never started a process because overlap `skip` found another run already active; `canceled` = runs that started and were then terminated), plus `totalCostUsd` and `totalTurns` summed over the included runs; runs without usage contribute zero.

### crontick stats job

Show statistics for one job.

```bash
crontick stats job <id|alias>
```

The response includes separate `canceled` and `skipped` counts, `totalCostUsd`, and `totalTurns`, all computed over every retained run of the job (not just the latest 100). `lastRunAt` is printed as a local ISO-8601 timestamp (JSON/MCP/library keep epoch milliseconds). `totalTurns` is printed as `totalTurns (agent turns, summed over runs)`: it sums `runs.turns`, which for Claude is `result.num_turns` of the final stream-json event, the number of agentic model round-trips of a run (each assistant response, tool-use rounds included), accumulated across retry attempts. It is not a count of runs, messages or tokens.

---

## Share Commands

### crontick share export

Export jobs to a crontick export file.

```bash
crontick share export [--out <file>] [--only-jobs <id|alias,...>]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--out <file>` | string | stdout | Output file. The name is kept when it ends in `.json` (any case), otherwise `.json` is appended (`backup` becomes `backup.json`, `try_me.txt` becomes `try_me.txt.json`). Prints `Exported N job(s) to <absolute path>` |
| `--include-secrets` | boolean | `false` | Keep webhook `relay` URLs and `secret`s (bearer secrets) in the file; by default they are stripped, so an imported webhook job is local-trigger-only |
| `--only-jobs <list>` | string | all jobs | Comma-separated ids or aliases, resolved by the daemon. Any unknown entry fails with `JOB_NOT_FOUND` listing every miss, and nothing is written |

The file is `{ "schema": 1, "exportedAt": ..., "crontickVersion": ..., "jobs": [...] }`: jobs only (no run history), with job ids omitted (except on jobs another exported job runs `--after`, so chains survive) so an import mints new ones and remaps those references. `--include-runs` was removed.

### crontick share import

Import jobs from a crontick export file (schema 1). Jobs get new ids; `--after` references inside the file are remapped to them. A job whose upstream is not in the file nor known imports disabled with `AFTER_UPSTREAM_NOT_FOUND`; cycles are rejected.

```bash
crontick share import <file> [--trust-folder] [--include-secrets]
```

`--include-secrets` keeps webhook `relay` and `secret` values present in the file; by default they are dropped on import.

The whole file is validated before anything is imported: a bare array, a missing or different `schema`, or an invalid job fails with `VALIDATION_ERROR` naming the path (for example `jobs.2.schedule`) and imports nothing. Optional fields (description, retry, overlap, args, ...) are filled like on create. Every imported job gets a **new GUID** and imports never overwrite: when an alias is already used by a live job or by an earlier job in the same file it becomes `<alias>-2`, `-3`, ... and the result row reports `renamedFrom`. Run history is never imported. A job whose working directory does not exist fails on its own row (`INVALID_CWD`) while the others import; Claude folder trust is checked once per distinct folder (see below). An imported Claude job with an unverified stored session starts a fresh session; raw-engine session IDs are preserved.

### Working directory and Claude trust

Jobs run in `action.cwd`. `jobs new` stores the invoking directory unless `--dir` is given (library and MCP callers default to the client's `cwd` option or the process directory; MCP agents should pass the project folder). Changing the `cwd` of a job that has a session (`sessionId` or `reuseSession`) is rejected with `CWD_CHANGE_BREAKS_SESSION` because Claude sessions are stored per directory: also pass `--session-id <id>` for a session in the new directory, or `--reuse-session` to start a fresh one.

For Claude jobs, crontick checks that the folder is trusted in Claude's config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`): the folder or an ancestor must have `hasTrustDialogAccepted: true`. If not, creation fails with `TRUST_REQUIRED` and nothing is saved. On a terminal the CLI asks `Folder X is not trusted by Claude. Trust it? (y/N)` and, on `y`, records the trust and creates the job; otherwise it exits 1. Without a terminal it errors and tells you to re-run with `--trust-folder`, which answers yes. Only that one flag of `.claude.json` is changed (all other keys are preserved); an unparsable file aborts with `CLAUDE_CONFIG_UNREADABLE`. Engines without a trust concept (raw engines) skip the check. Note that `claude -p` itself skips Claude's interactive trust dialog; the persisted flag still governs project-scoped settings and hooks, so this check is a guardrail for your intent rather than a hard Claude requirement.

---

## Config Commands

File-direct: these commands read and write `config.json` themselves, work with the daemon down, and never start a daemon. After a write, a running daemon is reloaded best-effort. Behavior, locking, secrets and error codes: [configuration.md](configuration.md#editing-config) and [specs/008-config-editing.md](../specs/008-config-editing.md).

### crontick config list

```bash
crontick config list [--json]
```

Effective config (defaults merged with the file, secrets shown as `[REDACTED]`) as flat `key = value` lines; keys not present in the file are tagged `(default)`. `--json` prints `{ path, revision, config, stored, readOnly, notice }`.

### crontick config get

```bash
crontick config get <key>
```

Prints one effective value (raw text for strings, JSON otherwise). Unknown key: `CONFIG_KEY_NOT_FOUND`. Works for `daemon.port`.

### crontick config set / unset

```bash
crontick config set <key> <value> [--string] [--stop-running | --wait-running]
crontick config unset <key> [--stop-running | --wait-running]
```

| Option | Description |
|--------|-------------|
| `--string` | Treat `<value>` as a string instead of parsing it (e.g. an engine command literally named `123`) |
| `--stop-running` | If runs are in flight, cancel them (and drop queued runs), then apply |
| `--wait-running` | If runs are in flight, pause the daemon, wait for them to finish, apply, then resume |

`<value>` is parsed as JSON and falls back to the raw string, so `600`, `true`, `'["-p","--verbose"]'` and `'{"command":"echo","type":"raw"}'` work as expected. A negative number looks like an option to the CLI parser, so put `--` before the arguments: `crontick config set -- <key> -5`. `--stop-running` and `--wait-running` are mutually exclusive. With runs in flight and neither flag, a terminal session is prompted (stop / wait / cancel); a non-interactive one fails with `RUNS_IN_FLIGHT` listing the runs.

Engines: add or replace with `crontick config set engines.<name> '{"command":"...","type":"raw"}'`, remove with `crontick config unset engines.<name>`.

Output: `changed: <keys>` and `reload: reloaded|daemon-not-running|failed` on stdout; warnings and the edit notice on stderr. Invalid values, unknown keys, and (while a daemon runs) `daemon.*` keys exit non-zero and leave the file byte-identical.

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

There is no commands list: run `crontick --help` for the commands (`crontick daemon ...` and `crontick doctor` are top-level commands). `info` is read-only: it never starts the daemon and never creates `config.json`. The file is created automatically (full default config, mode 0600, never overwritten once it exists) the first time the daemon starts or a daemon-backed command runs; hand edits are never touched, but built-in defaults that change in a later crontick version will not reach a user who already has the file.

`info` never starts the daemon; when the daemon is stopped it prints that state and notes that the dashboard becomes available again on the next daemon-backed command.

### crontick doctor

Check system health.

```bash
crontick doctor
```

Exits with code `1` if any check fails. Checks include Node.js version, SQLite availability, data directory (path shown), config file (path shown; reports when it has not been created yet and defaults are in use), daemon connectivity, daemon port (default vs fallback; flags a foreign process on the default port while no daemon runs), dashboard reachability, MCP server availability, and a `relay:` check per webhook relay (state, event count; a WARN, never a failure, when a relay is in persistent error).

### crontick daemon start

Start the daemon explicitly. The daemon also starts automatically on first use, so this is optional.

```bash
crontick daemon start [--foreground] [--home <dir>]
```

By default the daemon is started in the background and the command prints its PID and URL (plus `Note: started on fallback port N; default 47615 is in use` when port 47615 was taken) (or reports it is already running). `--foreground` runs the daemon in the current terminal until it exits. This is an explicit, one-off start; it never registers the daemon to start at login or boot (use [`crontick autostart enable`](#crontick-autostart-enable) for that). `--home <dir>` sets `CRONTICK_HOME` (the data directory) for the daemon this command starts. When the environment variable `CRONTICK_SUPERVISED=1` is set (autostart registrations set it), starting a daemon while one is already running exits `0` instead of `1`, so a service manager does not crash-loop when you demand-started first.

### crontick autostart enable

Opt in to starting the daemon at login by registering it with the OS user-level service manager. Idempotent: it rewrites the definition, reloads the manager and ensures it is enabled. Needs no daemon, no admin rights and no new dependencies.

```bash
crontick autostart enable
```

On Linux this writes `${XDG_CONFIG_HOME:-~/.config}/systemd/user/crontick.service` and runs `systemctl --user enable --now crontick.service`. The unit is a plain file you can read; it launches `node <dist>/daemon/index.js` with `Restart=on-failure`, `KillMode=process` (running jobs survive a daemon stop) and an environment of `CRONTICK_SUPERVISED=1`, `CRONTICK_HOME` (only if set when you ran `enable`) and a `PATH` snapshot taken at enable time. Re-run `enable` after you install an engine, change Node versions, or update crontick.

Refuses (see [errors](errors.md)) when systemd `--user` is unavailable, the daemon script does not exist (unbuilt checkout), or the install path is ephemeral (`_npx`). Linux (systemd `--user`), macOS (launchd LaunchAgent) and Windows (Task Scheduler logon task) are supported (see below); other platforms fail with `AUTOSTART_UNSUPPORTED`.

**Lifecycle caveat:** without systemd "linger", the user manager stops when you fully log out and stops the daemon, so jobs pause while you are logged out (a demand-started daemon survives logout; this differs). `status` prints the `loginctl enable-linger` hint; crontick does not change linger itself.

**Before uninstalling the package, run `crontick autostart disable`.** Uninstalling leaves the unit behind, and it would keep trying (bounded by systemd start limits) to launch a script that no longer exists.

**macOS (launchd).** `enable` writes `~/Library/LaunchAgents/dev.crontick.daemon.plist` (label `dev.crontick.daemon`) and runs `launchctl bootstrap gui/$UID <plist>` then `launchctl enable gui/$UID/dev.crontick.daemon`; if the label is already loaded it is booted out first, so re-running is safe. The plist is a plain file with `RunAtLoad`, `KeepAlive {SuccessfulExit: false}` (a crash restarts it; a graceful `daemon stop` stays stopped), `ThrottleInterval 30`, `AbandonProcessGroup` (detached runs survive a daemon stop), `WorkingDirectory` set to the crontick data dir, and the same environment as Linux (`CRONTICK_SUPERVISED=1`, `CRONTICK_HOME` if set, `PATH` snapshot). launchd output goes to `<data dir>/logs/launchd.out.log` and `launchd.err.log`.

- *Login only.* It starts when you log in to the desktop (GUI session), never at boot, and needs no admin rights or code signing. `enable` fails with `AUTOSTART_UNAVAILABLE` when there is no GUI launchd session (for example over SSH with no console user); nothing is written.
- *Login Items.* macOS 13+ shows a "Background Items Added" notification and lists the item in System Settings > General > Login Items & Extensions. Because the plist is unsigned, it appears as a generic "node" item from an unidentified developer. You may be asked to approve it. If you switch it off there, `status` reports it as not running with a note pointing at that panel; switch it back on, then re-run `crontick autostart enable`. If `enable` fails with `Input/output error` (5), check that panel first.
- *Folder access (TCC).* A launchd-started `node` has no Full Disk Access, so jobs whose directory is in `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive or a removable volume may be silently denied or prompt. Grant Full Disk Access to the `node` binary, or keep job directories outside protected folders. crontick does not manage this.
- *Claude engine login.* A daemon started by launchd may report Claude as "Not logged in" even with valid credentials. Workaround: set `CLAUDE_CODE_OAUTH_TOKEN` in the engine's env config (`crontick config set engines.<name> ...`), not in the plist. Whether this occurs on your macOS version is unverified (see the owner checklist in ADR 0034).
- *Stale registrations.* Moving or removing the Node version (nvm, Homebrew upgrades) makes the plist stale; `status` reports it. Re-run `enable`.
- Troubleshooting: `launchctl print gui/$(id -u)/dev.crontick.daemon` for live state, `launchctl print-disabled gui/$(id -u)` for the disabled flag, and the two `launchd.*.log` files. Crontick never uses legacy `launchctl load/unload/list`.

**Windows (Task Scheduler).** `enable` registers the logon task `\crontick\daemon` for the current user via `schtasks.exe /create /tn "\crontick\daemon" /xml <file> /f` (an absolute `%SystemRoot%\System32\schtasks.exe`, no shell). The definition is a plain XML file written (UTF-16LE) to `<data dir>\autostart\task.xml` and deleted after registration. It has a `LogonTrigger` scoped to your user SID with a 30 s delay, `InteractiveToken` + `LeastPrivilege` (no elevation, no SYSTEM, no registry or Run key), no execution time limit, no battery restrictions, `MultipleInstancesPolicy IgnoreNew`, `Hidden=false`, author `crontick` and a description saying how to remove it. The action is `node.exe <dist>\cli\index.js daemon start` (plus `--home "<dir>"` when `CRONTICK_HOME` was set at `enable`): a short-lived launcher that starts the usual detached daemon and exits; if a daemon is already running it reports that and exits `0`, so a demand-start followed by `enable` never produces a second daemon. Re-running `enable` overwrites the task (`/f`).

- *Login only.* It starts about 30 s after you log on, never at boot or while logged out, and needs no admin rights and no code signing (crontick ships JavaScript only; `node.exe` is signed by the OpenJS Foundation).
- *Console flash.* Task Scheduler cannot hide a console-subsystem `node.exe`, so a console window may flash for under a second at logon while the launcher runs. The daemon itself has no window. `status` prints this caveat.
- *Inspect.* Open `taskschd.msc` and the `\crontick` folder to see the task, its author and description. `status` reports the registered command, whether the task is enabled (`Settings/Enabled`), whether it is running, and the last result when available. Windows has no Settings > Startup apps toggle for tasks.
- *Stale registrations.* Moving or removing Node, or relocating crontick, makes the task stale; `status` reports it. Re-run `enable`.
- *Policy.* If group policy or an administrator prohibits task creation, `enable` fails with `AUTOSTART_UNAVAILABLE` (schtasks stderr as the reason) and writes nothing.
- *Security tools.* There is no official program that pre-clears a persistence mechanism; see [SECURITY.md](../../SECURITY.md#windows-autostart-and-security-tools) for what crontick does to look like what it is and how to allowlist it.
- *Task folder.* `disable` runs `schtasks /delete /tn "\crontick\daemon" /f`; `schtasks` cannot delete folders, so an empty `\crontick` folder remains. It is harmless.
- *Unverified.* Creating the `\crontick\` folder as a standard (non-admin) user is unproven (CI runners are administrators); a root-level `\crontick-daemon` fallback is pre-approved but not implemented. See the owner checklist in ADR 0034.

### crontick autostart disable

Remove the registration (Linux: `systemctl --user disable --now`, delete the unit file, reload; macOS: `launchctl bootout gui/$UID/dev.crontick.daemon` and delete the plist, which also removes the Login Items entry; Windows: `schtasks /delete /tn "\crontick\daemon" /f`). Idempotent: when nothing is registered it prints `Autostart was not enabled; nothing to remove` and exits `0`.

### crontick autostart status

Show `autostart` (`enabled`, `disabled` or `unsupported`), `mechanism`, `definition` path, registered `command`, whether the service is `active`, and a `stale` flag with reasons when the registered node path, daemon script path or `CRONTICK_HOME` differs from what `enable` would write now (fix: re-run `crontick autostart enable`). Never throws on an unsupported platform (prints a `reason`) and never starts the daemon.

### crontick daemon status

Show whether the daemon is running (PID, port, dashboard URL, uptime, job count; `portNote` when it is on a fallback port). Exits `1` with a hint when it is not running. Never starts the daemon.

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

### crontick daemon pause / resume

`pause` keeps the daemon (API + dashboard) up but starts no new runs; fires that come due while paused are not run, not replayed on resume, and are recorded as runs with status `skipped`. In-flight runs continue. `resume` restores scheduling. Paused state is in-memory only (a daemon restart comes up unpaused) and is shown as `paused` in `crontick daemon status`. `stop` is unchanged.

```bash
crontick daemon pause
crontick daemon resume
```

Running `crontick daemon` with no subcommand prints help. The former hidden `crontick info daemon` / `info doctor` aliases were removed. Config edits normally do not require reload; see [configuration.md](configuration.md#when-config-edits-take-effect).

---

## Dashboard

crontick has **no `dashboard` command group**. The dashboard is always served by the
daemon on its loopback origin whenever the daemon is running — there is nothing to start
or stop separately. To open it:

1. Run `crontick info` and copy the `dashboardUrl` line (for example
   `http://127.0.0.1:47615/dashboard`; the daemon prefers port `47615` and falls back to a free port, shown by `crontick info`, `crontick daemon status` and `crontick doctor`).
2. Open that URL in a browser.

If the daemon is not running yet, run any daemon-backed command (for example `crontick jobs list`) and it will start automatically; then `crontick info` will report the URL.

The former `crontick dashboard start`, `crontick dashboard status`, `crontick dashboard
stop`, and `crontick dashboard data` CLI commands have been removed.

### Dashboard web UI

Mutating `/api` calls (anything but GET) are rejected with `REQUEST_REJECTED` unless the request has a loopback `Host` with the daemon port, `Content-Type: application/json` (even with no body, e.g. `DELETE /api/jobs/:id`), and, if an `Origin` header is sent, the daemon's own origin. Anyone calling the HTTP API directly must send the JSON header. See [specs/004-daemon.md](../specs/004-daemon.md#api-request-guard).

The dashboard is a dependency-free web page served on the daemon's loopback origin
(`/` and `/dashboard`). It renders live snapshots from `GET /api/dashboard` and drives
job/run actions through the existing `/api/*` routes.

- **Header** — shows the real daemon `version`, pid, node version and job count, plus an
  uptime badge (hover for a "daemon uptime" tooltip).
- **Job editor** — a **+** button in the header (before the gear) opens a create modal; a pencil in each job row and in the details drawer opens it for editing. The form mirrors `jobs new`/`jobs update`: alias, prompt, schedule (Cron / Every / At, with a live preview of the next fires from `POST /api/schedules/preview`; `At` is interpreted in local time), working directory (free-text absolute path, required on create, no default), runner (defaults to `defaultEngine`), and under *Advanced* args, session id, reuse session, timeout, overlap, retry max and backoff, description. Defaults come from `GET /api/jobs/editor-meta`. Create sends `POST /api/jobs?prepare=1`; edit loads the job and sends only changed fields to `PUT /api/jobs/:id?prepare=1` (cleared optional fields are sent as `null`; `env`/`envFile` are not shown and are preserved). Server errors appear in a banner with edits kept and the offending field highlighted. For an untrusted folder with a Claude runner a **Trust this folder** checkbox appears (never pre-checked; sends `trustFolder=1`). If the job has runs in flight, Save asks to stop them or pause and wait (`inFlight=stop|wait`). Cancel/Esc/backdrop on a dirty form asks "Discard unsaved changes?". Not in the editor: directory autocomplete, duplicate job, env editing.
- **Settings** — a gear button at the far right of the header opens a modal over `GET`/`PATCH /api/config`. It opens read-only; **Edit** enables the inputs (General, Job defaults, Retention, Logging, Engines with command/type/args rows/env rows and add/remove, Daemon). `daemon.port` is shown but never editable (stop the daemon and use `crontick config set daemon.port <n>`). **Save** sends only the changed keys plus the loaded `revision`; zero changes sends nothing. Errors show in a banner with edits intact; a `409` offers **Reload form**. If runs are in flight, Save asks whether to stop them or pause and wait. Cancel/Esc/backdrop on a dirty form asks "Discard unsaved changes?".
- **Webhook jobs** — the editor has a Webhook kind: relay URL (with a **Create channel** button calling `POST /api/relay/new`), secret (password input) and a read-only relay with **Copy** in the drawer (fetches the full job). The drawer shows a relay status dot and a **Trigger now** button with an optional JSON payload; the run-log modal shows the trigger source, delivery id and a collapsible payload.
- **Pause** — a Pause/Resume button and a "Paused" badge in the header drive `POST /api/daemon/pause|resume`.
- **Theme** — an icon-only System (monitor) / Light (sun) / Dark (moon) radio group in the header (each button has an `aria-label` and `title`). Colors are CSS custom properties
  on `:root`; by default the dashboard follows `prefers-color-scheme`. Choosing Light or Dark
  sets `data-theme` on `<html>` and is persisted in `localStorage` (`crontick.theme`); choosing
  System clears it. An inline script in `<head>` applies the saved theme before first paint to
  avoid a flash of the wrong theme.
- **Top bar** — runs limit, an **Auto-refresh** segmented control
  (`Off`, `5s`, `10s`, `15s`, `30s`), and an icon-only refresh button (`↻`) at the far right. The default is `Off`; the choice is persisted in
  `localStorage` and the refresh timer honors it.
- **Jobs table** — columns are `Alias` (falls back to `—`), `ID` (the full GUID, wrapping if needed, with a
  copy icon), `Description`, `Schedule`, `Action`, `Last status`,
  `Next run`, and an `Actions` cell. Actions are icon buttons: **Run once now** (bolt icon,
  `POST /api/jobs/:id/run-now`; works for disabled jobs and does not enable the job; shows a
  toast), enable (`▶`) / disable (`⏹`, prompts for confirmation) and delete (`🗑`, prompts
  for confirmation). A search icon at the top right expands into a text box that filters jobs
  client-side over alias, id, working directory, description, and the whole job config (schedule, prompt, runner, ...).
- **Job details** — clicking a job row (outside the action buttons) opens a right-hand
  drawer with the job config (alias, id, description, enabled, schedule, runner, overlap,
  timeout, retry, working directory, next/last run), the prompt, quick stats from
  `GET /api/stats/jobs/:id` (runs, success rate, average duration in seconds), the ten most
  recent runs (click one to open its run detail), and actions (Run now, Enable/Disable,
  Filter runs). `Esc`, the ✕ button or a backdrop click closes it; focus is trapped inside
  and restored on close.
- **Recent runs toolbar** — beside the heading: a search icon (leftmost; expands into an
  input) that searches run id, job name/id, status, error, session id **and the stored run output**,
  then multi-select **Filter Job** and **Filter Status** dropdowns. Options are checkboxes and
  the menu stays open while toggling. Filtering is server-side: `GET /api/dashboard` (and
  `GET /api/runs`) accept `jobId` and `status` as comma-separated lists and `q` for the
  text search (a bounded, parameterised `LIKE`; `%`/`_` are literal). Search input is
  debounced. Every active filter also appears as a removable chip (`alias:trial`,
  `status:failed`, ...; job chips read `alias:<alias>`) under the toolbar; the chip's ✕ shows on hover, on keyboard focus and
  always on touch devices, and removing it also unchecks the option.
- **Runs table** — shows the full run id and **Runner Session ID**, each with a copy icon, plus Job
  (`jobAlias || jobId`), Status, Started and Duration (in seconds, e.g. `12.4 s`). The Job,
  Status, Started and Duration headers are sort buttons (`aria-sort`, ▲/▼ indicator): default
  Started descending; a first click on another column sorts ascending, clicking again toggles.
  Clicking a run row opens the run detail.
- **Run detail modal** — titled `Run log – <id> – <Status badge>`. It fetches the cleaned
  `GET /api/runs/:id/output` view and `GET /api/runs/:id`, and shows the final answer (**Result**),
  the **Error** (when present) and **stderr** (when present). Below are the absolute paths of the
  per-job **Log file** (crontick-side events only; it holds all runs of the job, each line tagged with its run id) and the
  Claude **Transcript** (`transcriptPath`) as plain selectable monospace text (not links), each with a
  Copy button; a path whose file is missing on disk shows `file not found`. File contents are never
  displayed. Close with the ✕ button, a backdrop click, or `Esc`.
- **Durations** — average and per-run durations are shown in seconds (`avgDurationSec`);
  `—` when unknown.

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
