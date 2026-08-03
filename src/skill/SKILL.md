# crontick — Scheduling Skill for MCP-Capable LLMs

> **Version**: 1.2 (GUID identity + grouped commands)
> **Purpose**: Teach any MCP-capable LLM to schedule prompt-based cron jobs first, while still supporting scripts and exec commands, using the local `crontick` daemon.


## When to Use This Skill

Use `crontick` tools or the `crontick` CLI when the user asks to:

- Run a Copilot or Agency prompt on a schedule (daily summary, periodic investigation, recurring report)
- Run a script, command, or maintenance task on a schedule
- Trigger a CLI tool such as `git`, `npm`, or a shell script on a timer
- Monitor a condition and take action periodically
- Set up a one-shot delayed task ("in 30 minutes", "at midnight tonight")

Default to a first-class prompt job unless the user explicitly needs shell logic, local scripting, or a raw executable.

**Do NOT use** for interactive tasks that require human input during the scheduled run, browser/GUI automation, or jobs that modify crontick state from inside their own prompt.


## Job Identity

Every job has two identity fields:

- `id` — an immutable GUID assigned automatically by crontick at creation. Never supply it; never invent it.
- `alias` — an optional, user-editable, unique, kebab-case name. When omitted on create, crontick auto-generates one (`<word>-<1-1000>`). Provide `--alias <name>` (CLI) or `alias` (MCP) when the user wants a memorable name.

Anywhere a job identifier is accepted (CLI positional `<id>`, MCP `id`, run `--job`/`jobId` filter), you may pass **either** the GUID `id` **or** the `alias`. crontick resolves an exact GUID match first, then falls back to the alias, and returns `JOB_NOT_FOUND` when neither matches.


## Workflow

Follow these steps in order. Do not skip the schedule confirmation.

### Step 1 — Understand the Intent

Ask or infer:

- What should run? Prefer a self-contained prompt; use a script only when shell logic is required.
- When should it run? Capture cadence, timezone, and whether it is one-shot or recurring.
- What working directory and filesystem access does it need?
- What side effects are expected? Examples: writes files, sends alerts, pushes commits, opens network connections.
- Should runs share context? Use either a known `--session-id` or `--reuse-session`, never both.
- Which engine? **Skill default is `agency`**. Use `copilot` only when the user asks for Copilot specifically.

Assume Windows paths and PowerShell for script jobs unless the user says otherwise.

### Step 2 — Draft the Action

#### Preferred: prompt action

Use prompt mode for scheduled LLM work:

```text
crontick jobs new [--alias <name>] --prompt "<text>" --engine agency [engineArgs...] -- <verbatim engine args>
crontick jobs new [--alias <name>] --prompt-file <path.txt> --engine agency [engineArgs...] -- <verbatim engine args>
```

Prompt jobs created by this skill must pass `--engine agency` explicitly unless the user requested Copilot. This is a skill-level default; the package default is `copilot` when `--engine` is omitted.

Prompt rules:

- Prompts must be self-contained and non-interactive.
- State exact outputs, target paths, failure behavior, and time budget.
- End failure-sensitive prompts with: `If any step fails, print the error clearly and exit.`
- Use `--prompt-file <path.txt>` for long prompts. The file must be `.txt`; crontick reads it into persisted prompt text.
- Put all extra Copilot/Agency flags after `--`; crontick preserves them verbatim in order.
- Add filesystem allowlists in engine args as needed, e.g. `-- --add-dir Q:\Repos\crontick --allow-all-tools`.
- Use `--timeout <sec>` for long-running work.

#### Supported: script and exec actions

Script and exec actions remain fully supported by the job schema, the daemon executors, and the library API. The CLI no longer has dedicated `--script`, `--exec`, `--arg`, `--shell`, or `--job-env-file` flags. Create these jobs from a full job-definition JSON file with `crontick jobs new --file <job.json>`, or programmatically with `client.createJob()`.

Script action JSON:

```json
{
  "schedule": { "kind": "cron", "cron": "0 22 * * *", "tz": "America/Los_Angeles" },
  "action": {
    "kind": "script",
    "script": "$ErrorActionPreference = 'Stop'\nCopy-Item -Recurse C:\\Users\\alice\\projects E:\\Backups\\projects -Force",
    "shell": "pwsh",
    "cwd": "C:\\Users\\alice",
    "timeoutSec": 600
  },
  "overlap": "skip"
}
```

Exec action JSON (a raw executable without shell interpretation) uses `action.kind: "exec"` with `command`, `args`, and optional `cwd`, e.g. `{ "kind": "exec", "command": "git", "args": ["fetch", "--all"], "cwd": "Q:\\Repos\\crontick" }`.

Script rules:

- Idempotent: running twice must not corrupt state.
- Self-contained: do not rely on ambient shell state.
- Explicit working directory: set `action.cwd`.
- Secrets via `action.env` or `action.envFile`; never hardcode tokens or passwords.
- Timeout: set `action.timeoutSec` to a reasonable upper bound.

### Step 3 — Confirm the Schedule

crontick validates the schedule server-side when the job is created. There is no standalone pre-create schedule validator on the CLI/MCP surface, and there is no `crontick jobs new --dry-run` flag.

Preview convention:

1. Describe the resolved schedule to the user (kind, cron/interval/at, timezone) and get confirmation of the cadence before creating.
2. Create the job (Step 4).
3. Preview the next fire times with `crontick jobs schedule <id> -n 5` (CLI) or the `crontick_job_schedule` MCP tool (`id`, `n: 5`), and show them to the user.

If only the CLI is available, also show the exact `crontick jobs new ...` command for confirmation before running it.

Supported schedule kinds:

- `cron` — cron expression plus optional timezone (`tz` / `--tz`)
- `interval` — `{ "kind": "interval", "everySec": 300 }` or `--every 300`
- `one-shot` — `{ "kind": "one-shot", "runAt": "2026-08-01T09:00:00Z" }` or `--at <iso>`

### Step 4 — Create the Job

Use the prompt pathway for prompt jobs:

```text
crontick jobs new --alias daily-summary --cron "0 9 * * *" --tz America/Los_Angeles --prompt "Summarize repository status and write a concise report. If any step fails, print the error clearly and exit." --engine agency --reuse-session -- --add-dir Q:\Repos\crontick --allow-all-tools
```

Equivalent normalized MCP job shape (omit `id`; crontick assigns the GUID):

```json
{
  "alias": "daily-summary",
  "description": "Summarize repository status every day at 9am PT",
  "schedule": { "kind": "cron", "cron": "0 9 * * *", "tz": "America/Los_Angeles" },
  "action": {
    "kind": "prompt",
    "prompt": "Summarize repository status and write a concise report. If any step fails, print the error clearly and exit.",
    "engine": "agency",
    "args": ["--add-dir", "Q:\\Repos\\crontick", "--allow-all-tools"],
    "reuseSession": true,
    "timeoutSec": 1800
  },
  "overlap": "skip",
  "retry": { "max": 1, "backoffSec": 60 }
}
```

For Copilot on request:

```text
crontick jobs new --alias daily-copilot-summary --cron "0 9 * * *" --tz America/Los_Angeles --prompt-file .\daily-summary.txt --engine copilot --session-id 0cb916db-26aa-40f2-86b5-1ba81b225fd2 -- --add-dir Q:\Repos\crontick --allow-all-tools
```

For a script job, write the JSON from Step 2 and create it with `crontick jobs new --file .\backup.json`.

### Step 5 — Confirm and Report

After creation:

1. Report the returned `id` (GUID), `alias`, and `nextRunAt`.
2. Preview upcoming fire times with `crontick jobs schedule <id>` / `crontick_job_schedule`.
3. Offer `crontick_job_run_now` / `crontick jobs run-now <id>` for an immediate test.
4. For troubleshooting, use `crontick runs get <runId>` and `crontick runs logs <runId>` rather than re-creating the job.
5. Show `crontick://schemas/job` if the user wants the full schema.

The daemon launches on demand when daemon-backed commands need it. Do not run setup commands, install services, or attempt to manage OS login registration.


## CLI Surface Reference

Create syntax:

```text
crontick jobs new [--alias <name>] --prompt "<text>" | --prompt-file <path.txt> --engine copilot|agency [--session-id <id> | --reuse-session] [-- <verbatim passthrough args>]
```

Common creation flags:

- Identity: `--alias <name>` (optional; auto-generated when omitted). The GUID `id` is always assigned by crontick.
- Schedule: `--cron <expr>`, `--every <sec>`, or `--at <iso>`; use `--tz <tz>` for cron schedules.
- Action source: exactly one of `--prompt` or `--prompt-file` (prompt jobs). Script and exec jobs are created via `--file <job.json>`.
- Prompt engine: `--engine copilot|agency`; this skill uses `--engine agency` by default.
- Session: `--session-id <id>` wins; `--reuse-session` without a session id captures one after the first successful run.
- Prompt file: `--prompt-file <path.txt>` must point to a UTF-8 `.txt` file and is not persisted as a path.
- Engine passthrough: arguments after `--` are stored exactly as `action.args`.
- Shared fields: `--timeout <sec>`, `--overlap <skip|queue|cancel-previous>` (default `skip`), `--retry <max>` (default `0`), `--desc <description>`.
- JSON input: `--file <path>` loads a full job (all action kinds); it is mutually exclusive with schedule/action flags and raw engine args.

Command groups:

- `crontick jobs new|update|list|get|schedule|delete|run-now` — manage jobs (identifier is a GUID or alias).
- `crontick runs list|get|logs|cancel|delete` — inspect and manage run history. `runs logs <runId> [engine|crontick]` filters the log source; `runs delete --all --force` clears all runs.
- `crontick stats summary|job <id>` — statistics.
- `crontick share export|import` — export/import jobs (top-level `export`/`import` are gone).
- `crontick config` — prints the config file path (edit `config.json` by hand). No `config get/set/unset/init/validate/engines` subcommands.
- `crontick info` — version, runtime, storage paths, daemon status, and the dashboard URL (`dashboardUrl`).
- `crontick doctor`, `crontick daemon ...`, `crontick mcp`. There is no `dashboard` command group: the dashboard is always served by the daemon; open the `dashboardUrl` from `crontick info` in a browser.

Enable/disable are folded into update: `crontick jobs update <id> --enable` / `--disable`.

Validation rules:

- Exactly one schedule source: `--cron`, `--every`, or `--at`.
- Exactly one prompt source in prompt mode: `--prompt` or `--prompt-file`, unless `--file` is used.
- Prompt-only flags and raw engine args are valid only in prompt mode.
- If `sessionId` and `reuseSession` are both supplied, crontick ignores `reuseSession` and reports a notice.
- Script and exec jobs remain supported unchanged via `--file` / the library.


## Engine Command Mapping

The runner does not wrap prompt jobs in a shell. It builds one of these commands with `shell:false`:

| Prompt engine | Child command |
|---|---|
| `agency` | `agency cp -p <prompt> <action.args...> [--session-id <id>]` |
| `copilot` | `copilot --allow-all-tools -p <prompt> <action.args...> [--session-id <id>]` |

Mapping details:

- `--prompt <text>` becomes `<prompt>` after `-p`.
- `--prompt-file <path.txt>` is read by crontick; the engine still receives prompt text via `-p <text>`.
- Raw args after `--` become `<action.args...>` and are placed after the prompt.
- Package-owned `--session-id <id>` is appended after raw args for both engines.
- `--reuse-session` starts the first run without a session flag, captures the successful run's session id (matching the Copilot CLI's `--resume=<uuid>` stats footer and `--session-id`/`session id:` forms), persists it, and later runs use `--session-id <captured-id>`.
- `agency cp --help` exposes `-p, --prompt <PROMPT>` and forwards extra args to the underlying engine CLI.
- `copilot --help` exposes `-p, --prompt <text>` and `--session-id <id>`.

Examples of passthrough construction:

```text
crontick jobs new --alias hourly-map-check --every 3600 --prompt "Check map reliability and write findings." --engine agency -- --add-dir Q:\Repos\Mwc --allow-all-tools --model gpt-5.4
```

Runner command:

```text
agency cp -p "Check map reliability and write findings." --add-dir Q:\Repos\Mwc --allow-all-tools --model gpt-5.4
```

For Copilot, `crontick jobs new --alias daily-copilot-check ... --engine copilot --session-id abc123 -- --add-dir Q:\Repos\crontick` builds `copilot --allow-all-tools -p "..." --add-dir Q:\Repos\crontick --session-id abc123`.


## Tool Reference

| Tool | Description |
|------|-------------|
| `crontick_job_create` | Create and schedule a new job (omit `id`; pass optional `alias`) |
| `crontick_job_list` | List all jobs with status and next run |
| `crontick_job_get` | Get full definition of a specific job (by GUID or alias) |
| `crontick_job_update` | Update fields on an existing job; also enables/disables via `enabled` |
| `crontick_job_enable` | Re-enable a disabled job |
| `crontick_job_disable` | Disable without deleting; confirm first |
| `crontick_job_delete` | Permanently delete a job; confirm first |
| `crontick_job_run_now` | Trigger an immediate run |
| `crontick_job_schedule` | Preview an existing job's upcoming fire times (`id`, `n`) |
| `crontick_job_cancel_run` | Cancel an in-progress run |
| `crontick_run_list` | List recent runs (filter by `jobId`, `status`) |
| `crontick_run_get` | Get status/details for one run, including `sessionId` |
| `crontick_run_logs_tail` | Get recent run output (`source`: `all`\|`engine`\|`crontick`) |
| `crontick_run_delete` | Delete one run (or all with `all` + `force`) and its log rows |
| `crontick_stats_summary` | Aggregate stats for all jobs |
| `crontick_stats_job` | Per-job run statistics |
| `crontick_export` | Export job definitions (optional run history) |
| `crontick_import` | Import normalized jobs from JSON |
| `crontick_daemon_start` / `crontick_daemon_stop` / `crontick_daemon_status` / `crontick_daemon_reload` / `crontick_daemon_restart` | Manage the daemon |
| `crontick_config_path` | Return the config file path and how edits apply |
| `crontick_info` | Version, runtime, storage paths, daemon status, and dashboard URL (`dashboardUrl`) |
| `crontick_doctor` | Health check for Node.js, SQLite, data dir, and daemon |

Removed tools (do not call): `crontick_schedule_validate`, `crontick_schedule_preview` (use `crontick_job_schedule` after create), `crontick_dashboard_data`, `crontick_dashboard_start` / `crontick_dashboard_status` / `crontick_dashboard_stop` (the dashboard is served by the daemon — get its URL from `crontick_info`), and every `crontick_config_*` get/set/unset/init/validate/engine tool (use `crontick_config_path` and edit `config.json`).


## Rules

1. **Default to prompt jobs** with `action.kind: "prompt"` for LLM work.
2. **Default prompt engine is Agency** for this skill; pass `--engine agency` explicitly.
3. **Use Copilot only on request**; pass `--engine copilot` and preserve Copilot args after `--`.
4. **Confirm the schedule cadence first**, then create, then preview fire times with `crontick jobs schedule` / `crontick_job_schedule` and show them to the user.
5. **Never invent a `crontick jobs new --dry-run` flag**; use schedule preview after create and explicit confirmation before create.
6. **Always confirm before delete or disable**.
7. **Never start or set up the daemon yourself**; daemon-backed crontick commands handle demand-based launch.
8. **Use `--prompt-file` only for `.txt` files**; crontick stores prompt text, not the file path.
9. **Use either `--session-id` or `--reuse-session`**, never both.
10. **Scripts must be self-contained** with `set -euo pipefail` or `$ErrorActionPreference = 'Stop'`.
11. **Secrets via `action.env` or `action.envFile`**; never put secrets in prompts, scripts, or job descriptions.
12. **Set timeouts** for long prompt or script jobs.
13. **Aliases must be kebab-case**, e.g. `daily-summary`, `weekly-cleanup-2026`. Never supply the GUID `id`.
14. **Assume Windows if OS is unspecified**.
15. **Create script and exec jobs via `--file <job.json>`** (or the library); there are no `--script`/`--exec` CLI flags.


## Ban List

- ❌ Do NOT use `action.kind: "llm-prompt"`; use `action.kind: "prompt"`.
- ❌ Do NOT set `action.provider`; use `action.engine`.
- ❌ Do NOT supply a job `id`; it is a server-assigned GUID. Use `--alias` / `alias` instead.
- ❌ Do NOT wrap prompt jobs in script bodies that call `copilot --allow-all-tools -p` or `agency cp -p`.
- ❌ Do NOT pass both `--session-id` and `--reuse-session`.
- ❌ Do NOT call `crontick_schedule_validate`, `crontick_schedule_preview`, `crontick_dashboard_data`, `crontick_dashboard_start` / `crontick_dashboard_status` / `crontick_dashboard_stop`, or any `crontick_config_*` mutation tool — they no longer exist.
- ❌ Do NOT call delete or disable tools without explicit confirmation.
- ❌ Do NOT edit crontick job JSON, run databases, or daemon state files directly.
- ❌ Do NOT add daemon setup or OS login instructions.


## Worked Examples

### Example 1 — Daily Agency prompt

**User**: "Every weekday at 9am, summarize this repo and write a report."

1. Infer prompt job, engine `agency`, timezone `America/Los_Angeles`, cwd `Q:\Repos\crontick`.
2. Confirm the cadence `0 9 * * mon-fri` (America/Los_Angeles) with the user.
3. Create:

```text
crontick jobs new --alias weekday-repo-summary --cron "0 9 * * mon-fri" --tz America/Los_Angeles --prompt "Summarize Q:\Repos\crontick repository status and write a concise report. If any step fails, print the error clearly and exit." --engine agency --reuse-session --timeout 1800 -- --add-dir Q:\Repos\crontick --allow-all-tools
```

4. Preview the next 5 fires with `crontick jobs schedule weekday-repo-summary -n 5` and report the GUID `id` + `alias`.

### Example 2 — Copilot prompt with prompt file

**User**: "Use Copilot for a daily code-health prompt from .\prompts\health.txt."

```text
crontick jobs new --alias daily-code-health --cron "0 8 * * *" --tz America/Los_Angeles --prompt-file .\prompts\health.txt --engine copilot --reuse-session -- --add-dir Q:\Repos\crontick --allow-all-tools
```

The `.txt` file is read before creation; the runner later calls `copilot --allow-all-tools -p <file contents> ...`.

### Example 3 — Weekly dependency cleanup script

**User**: "Clean old node_modules every Sunday."

Use a script job because this is deterministic filesystem cleanup. Write a JSON file (a `script` action with an inline `#!/usr/bin/env bash` / `set -euo pipefail` body, `shell: "bash"`, explicit `cwd`, and `timeoutSec`) like the Step 2 script example, then create it with `crontick jobs new --file .\cleanup.json`. Confirm the cadence `0 3 * * 0`, and preview with `crontick jobs schedule <id>`.
