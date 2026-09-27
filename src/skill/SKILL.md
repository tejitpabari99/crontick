---
name: crontick
description: Schedule and manage AI cron jobs on the local machine with the crontick CLI. Use when asked to run an AI prompt on a cron, interval, or one-shot schedule, or to inspect, trigger, or clean up those scheduled jobs and their run history.
allowed-tools: shell
---

# crontick — run AI cron jobs from the CLI

## Purpose / when to use

This **crontick** skill lets you schedule and manage AI cron jobs on the local machine from the shell. Use it when asked to run an AI prompt on a cron, interval, or one-shot schedule, or to inspect, trigger, or clean up those scheduled jobs and their run history.

crontick is **AI-native local cron**: a demand-started local daemon plus a `crontick` CLI (and MCP server). The default job is a **prompt job** — a natural-language prompt scheduled to run against an AI **engine** (`copilot` by default, i.e. `copilot --allow-all-tools -p "<prompt>"`). Everything runs on one machine; the daemon auto-starts on first use.

**Identity:** every job has an immutable GUID `id` (assigned by crontick — never invent it) plus an optional human `alias` (kebab-case, auto-generated when omitted, e.g. `fern-270`). Pass **either** the `id` or the `alias` anywhere an identifier is expected.

Drive crontick by running the `crontick` CLI in the shell. All commands below are copy-exact and verified against `--help`.

## Core workflow

### Step 1 — Create a prompt job

The prompt MUST be passed with `--prompt`. Positional text is treated as engine passthrough args, **not** the prompt, and the job will fail with no prompt. Pick exactly one schedule flag.

```sh
# cron expression (quote it; add --tz for a timezone)
crontick jobs new --desc "daily standup" --cron "0 9 * * *" --prompt "Summarize my open GitHub PRs"

# fixed interval, in seconds
crontick jobs new --desc "hourly build check" --every 3600 --prompt "Check the build and report failures"

# one-shot at an ISO-8601 time
crontick jobs new --desc "release reminder" --at "2026-08-01T09:00:00" --prompt "Remind me to cut the release"
```

No `id` is needed — crontick assigns the GUID and auto-generates an `alias`. Options:

- `--alias <name>` — set a memorable kebab-case alias instead of the generated one.
- `--tz <tz>` — timezone for cron schedules (e.g. `America/Los_Angeles`).
- `--engine <name>` — pick a configured engine (default: `copilot`).
- `--prompt-file <path>` — read the prompt from a UTF-8 `.txt` file instead of `--prompt` (mutually exclusive with `--prompt`; contents are stored, not the path).
- `--timeout <sec>`, `--overlap skip|queue|cancel-previous` (default `skip`), `--retry <max>` (default `0`).
- `--force` — replace an existing job with the same alias.
- Anything after the flags (`engineArgs...`) is passed verbatim to the engine, e.g. `crontick jobs new --cron "0 9 * * *" --prompt "…" --allow-all-tools --add-dir Q:\Repos\crontick`.

### Step 2 — Inspect

```sh
crontick jobs list                 # all jobs with status and next run
crontick jobs get <id|alias>       # full definition of one job
crontick jobs schedule <id|alias> -n 5   # preview the next N fire times (default 5)
```

### Step 3 — Run and observe

```sh
crontick jobs run-now <id|alias>   # trigger an immediate run
crontick runs list                 # recent runs across all jobs
crontick runs list --job <id|alias>   # runs for one job (also --status, --limit, --since)
crontick runs get <runId>          # resolved command, status, timing, engine session id
crontick runs logs <runId>         # both log streams
crontick runs logs <runId> engine  # only the AI engine stdout/stderr
crontick runs logs <runId> crontick  # only crontick lifecycle events (start, timeout, retry, exit)
```

### Step 4 — Manage

```sh
crontick jobs update <id|alias> --disable   # also --enable, or any create flag to change fields
crontick jobs update <id|alias> --cron "0 8 * * *" --tz America/Los_Angeles
crontick jobs delete <id|alias>    # delete one job (confirm with the user first)
crontick runs cancel <runId>       # cancel an in-progress run
```

### Step 5 — Environment / troubleshooting

```sh
crontick info      # version, runtime, config path, storage paths, daemon status, dashboard URL
crontick info doctor    # health check: Node.js, SQLite, data dir, daemon
crontick info daemon stop   # stop the daemon when you really need a restart cycle
crontick info daemon reload # reload jobs from disk after manual edits
```

The dashboard (job/run browser) is served by the daemon; open the `dashboardUrl` from `crontick info` (`http://127.0.0.1:<port>/dashboard`).

## Engines

A prompt engine is the AI CLI crontick invokes. The built-in default is `copilot`:

```jsonc
{ "command": "copilot", "args": ["--allow-all-tools", "-p"], "env": {} }
```

At run time crontick appends the prompt after the engine args → `copilot --allow-all-tools -p "<prompt>"`, then any `engineArgs...`, then a package-owned `--session-id=<id>` when session continuity is on.

- Select a configured engine per job with `--engine <name>` (default `copilot`).
- Add or edit engines (e.g. `claude`) by editing the `config.json` whose path `crontick info` prints. The prompt-taking flag (`-p`) must stay **last** in an engine's `args`.

**Multi-turn continuity** (carry the AI session across runs) — use at most one:

- `--session-id <id>` — reuse a fixed engine session id every run.
- `--reuse-session` — capture the session id from the first successful run and reuse it thereafter.

```sh
crontick jobs new --cron "0 * * * *" --prompt "Continue triaging the incident queue" --reuse-session --alias triage
```

## Command reference

| Group | Command | Purpose |
|-------|---------|---------|
| **jobs** | `jobs new [options] [engineArgs...]` | Create a job (alias auto-generated) |
| | `jobs list` | List all jobs |
| | `jobs get <id\|alias>` | Show one job |
| | `jobs update <id\|alias> [--enable\|--disable\|…]` | Update fields / enable / disable |
| | `jobs schedule <id\|alias> -n <count>` | Preview upcoming fire times |
| | `jobs run-now <id\|alias>` | Trigger an immediate run |
| | `jobs delete <id\|alias>` | Delete one job |
| | `jobs delete all --force` | Delete every job (CLI reserves the literal `all` keyword) |
| **runs** | `runs list [--job <id\|alias>] [--status …] [--limit …] [--since <ms>]` | List runs |
| | `runs get <runId>` | Run details + session id |
| | `runs logs <runId> [engine\|crontick] [--tail <n>]` | Run logs |
| | `runs cancel <runId>` | Cancel an in-progress run |
| **share** | `share export` / `share import <file>` | Export / import jobs |
| **stats** | `stats summary` / `stats job <id\|alias>` | Aggregate / per-job stats |
| **info** | `info` | Version, config path, paths, daemon status, dashboard URL |
| | `info doctor` | System health check |
| | `info daemon stop\|reload` | Stop or reload the daemon from the info group |
| **mcp** | `mcp` | Start the MCP server on stdio |

## Gotchas for the agent

- The prompt goes in `--prompt` (or `--prompt-file`). Bare positional text is engine passthrough, not the prompt.
- Always quote cron expressions: `--cron "0 9 * * *"`.
- Exactly one schedule source per job: `--cron`, `--every <sec>`, or `--at <iso>`.
- The daemon auto-starts on first use — do not run setup, install services, or register OS login; the only remaining CLI admin helpers are `info daemon stop` and `info daemon reload`.
- Each run captures engine stdout/stderr, a separate `crontick` lifecycle log stream, and the engine session id (visible in `runs get`).
- Confirm before `jobs delete`, `jobs update --disable`, or any `jobs delete all --force` clear.
- `info` prints the config path — there are no `config get/set/engines` subcommands; edit `config.json` by hand.
- crontick is prompt-only: every job's action is `kind: "prompt"`. There is no shell-script or raw-executable action kind.

## Prompt action shape / session continuity

Under the hood a prompt job stores its behavior as JSON with `action.kind: "prompt"`. The CLI writes this for you, but MCP hosts and `--file` jobs use it directly:

```json
{ "alias": "triage",
  "schedule": { "kind": "cron", "cron": "0 * * * *" },
  "action": { "kind": "prompt", "prompt": "Continue triaging the incident queue", "reuseSession": true } }
```

- `reuseSession: true` captures the engine `sessionId` from the first successful run and reuses it on every later run, so the AI carries context across runs (equivalent to `--reuse-session`).
- The captured `sessionId` is visible in `crontick runs get <runId>`; a fixed id can be pinned instead via `--session-id`.

## Example

A daily standup summary at 9am local time:

```sh
crontick jobs new --desc "daily standup" --cron "0 9 * * *" \
  --prompt "Summarize my open GitHub PRs and today's calendar" --reuse-session
```

Then inspect and trigger it:

```sh
crontick jobs schedule daily-standup -n 5   # preview the next 5 fire times
crontick jobs run-now daily-standup         # run it immediately once
```

## Safe shell invocation

When wrapping a crontick call in a shell script, make the shell fail fast so errors surface as run failures:

```sh
#!/usr/bin/env bash
set -euo pipefail
crontick jobs run-now daily-standup
```

```powershell
$ErrorActionPreference = 'Stop'
crontick jobs run-now daily-standup
```

## Use from an MCP host

crontick also ships an MCP server that mirrors these commands one-to-one (tool prefix `crontick_`). Start it with `crontick mcp` over stdio and wire it into an MCP host (Copilot, Claude Desktop, Cursor). Prefer the CLI when you can run a shell; use MCP tools when operating through an MCP host.

| MCP tool | CLI equivalent |
|----------|----------------|
| `crontick_job_create` | `jobs new` |
| `crontick_job_list` | `jobs list` |
| `crontick_job_schedule` | `jobs schedule` |
| `crontick_job_run_now` | `jobs run-now` |
| `crontick_run_list` | `runs list` |
| `crontick_run_logs_tail` | `runs logs` |
| `crontick_info` | `info` |
| `crontick_daemon_stop` | `info daemon stop` |
| `crontick_daemon_reload` | `info daemon reload` |

MCP hosts can also read the job JSON schema from the resource `crontick://schemas/job` to validate job definitions before calling `crontick_job_create`.
