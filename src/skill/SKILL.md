# crontick — Scheduling Skill for MCP-Capable LLMs

> **Version**: 1.1 (prompt jobs)
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


## Workflow

Follow these steps in order. Do not skip validation or preview.

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
crontick new <id> [engineArgs...] --prompt "<text>" --engine agency -- <verbatim engine args>
crontick new <id> [engineArgs...] --prompt-file <path.txt> --engine agency -- <verbatim engine args>
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

#### Supported: script action

Use scripts for deterministic shell work:

**Windows (PowerShell):**

```powershell
$ErrorActionPreference = 'Stop'
# Your task here
```

**Unix/macOS (bash):**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Your task here
```

Script rules:

- Idempotent: running twice must not corrupt state.
- Self-contained: do not rely on ambient shell state.
- Explicit working directory: set `action.cwd` in JSON or use an explicit `crontick new` cwd-capable input if available.
- Secrets via `env` or `envFile`; never hardcode tokens or passwords.
- Timeout: set `timeoutSec` or `--timeout` to a reasonable upper bound.

#### Supported: exec action

For a simple executable without shell interpretation, use `--exec <cmd>` or `action.kind: "exec"` with `command` and `args`.

### Step 3 — Validate and Preview the Schedule

If MCP tools are available, validate before creating:

```json
{ "schedule": { "kind": "cron", "cron": "0 9 * * *", "tz": "America/Los_Angeles" } }
```

Use:

1. `crontick_schedule_validate`
2. `crontick_schedule_preview` with `n: 5`
3. Show the next 5 fire times to the user
4. Get confirmation before creating or mutating the job

There is no `crontick new --dry-run` flag in this CLI surface. The deterministic preview convention is schedule validation plus next-fire preview before the final create/update call. If only the CLI is available, show the exact `crontick new ...` command for confirmation before running it.

Supported schedule kinds:

- `cron` — cron expression plus optional timezone (`tz` / `--tz`)
- `interval` — `{ "kind": "interval", "everySec": 300 }` or `--every 300`
- `one-shot` — `{ "kind": "one-shot", "runAt": "2026-08-01T09:00:00Z" }` or `--at <iso>`

### Step 4 — Create the Job

Use the new prompt pathway for prompt jobs:

```text
crontick new daily-summary --cron "0 9 * * *" --tz America/Los_Angeles --prompt "Summarize repository status and write a concise report. If any step fails, print the error clearly and exit." --engine agency --reuse-session -- --add-dir Q:\Repos\crontick --allow-all-tools
```

Equivalent normalized MCP job shape:

```json
{
  "id": "daily-summary",
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
crontick new daily-copilot-summary --cron "0 9 * * *" --tz America/Los_Angeles --prompt-file .\daily-summary.txt --engine copilot --session-id 0cb916db-26aa-40f2-86b5-1ba81b225fd2 -- --add-dir Q:\Repos\crontick --allow-all-tools
```

For script work:

```json
{
  "id": "daily-backup",
  "description": "Back up projects every day at 10pm PT",
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

### Step 5 — Confirm and Report

After creation:

1. Report the returned `id` and `nextRunAt`.
2. Offer `crontick_job_run_now` / `crontick run-now <id>` for an immediate test.
3. For troubleshooting, use run details and logs rather than re-creating the job.
4. Show `crontick://schemas/job` if the user wants the full schema.

The daemon launches on demand when daemon-backed commands need it. Do not run setup commands, install services, or attempt to manage OS login registration.


## CLI Surface Reference

Create syntax:

```text
crontick new <id> [engineArgs...] --prompt "<text>" | --prompt-file <path.txt> --engine copilot|agency [--session-id <id> | --reuse-session] [-- <verbatim passthrough args>]
```

Common creation flags:

- Schedule: `--cron <expr>`, `--every <sec>`, or `--at <iso>`; use `--tz <tz>` for cron schedules.
- Action source: exactly one of `--prompt`, `--prompt-file`, `--script`, or `--exec`.
- Prompt engine: `--engine copilot|agency`; this skill uses `--engine agency` by default.
- Session: `--session-id <id>` wins; `--reuse-session` without a session id captures one after the first successful run.
- Prompt file: `--prompt-file <path.txt>` must point to a UTF-8 `.txt` file and is not persisted as a path.
- Engine passthrough: arguments after `--` are stored exactly as `action.args`.
- Shared fields: `--env-file <path>`, `--timeout <sec>`, `--overlap <skip|queue|cancel-previous>`, `--retry <max>`, `--desc <description>`.
- JSON input: `--file <path>` loads a full job; it is mutually exclusive with schedule/action flags and raw engine args.

Validation rules:

- Exactly one schedule source: `--cron`, `--every`, or `--at`.
- Exactly one action source: `--script`, `--exec`, `--prompt`, or `--prompt-file`, unless `--file` is used.
- Prompt-only flags and raw engine args are valid only in prompt mode.
- If `sessionId` and `reuseSession` are both supplied, crontick ignores `reuseSession` and reports a notice.
- Script and exec jobs remain supported unchanged.


## Engine Command Mapping

The runner does not wrap prompt jobs in a shell. It builds one of these commands with `shell:false`:

| Prompt engine | Child command |
|---|---|
| `agency` | `agency cp -p <prompt> <action.args...> [--session-id <id>]` |
| `copilot` | `copilot -p <prompt> <action.args...> [--session-id <id>]` |

Mapping details:

- `--prompt <text>` becomes `<prompt>` after `-p`.
- `--prompt-file <path.txt>` is read by crontick; the engine still receives prompt text via `--prompt=<text>`.
- Raw args after `--` become `<action.args...>` and are placed after the prompt.
- Package-owned `--session-id <id>` is appended after raw args for both engines.
- `--reuse-session` starts the first run without a session flag, captures the successful run's session id, persists it, and later runs use `--session-id <captured-id>`.
- `agency cp --help` exposes `-p, --prompt <PROMPT>` and forwards extra args to the underlying engine CLI.
- `copilot --help` exposes `-p, --prompt <text>` and `--session-id <id>`.

Examples of passthrough construction:

```text
crontick new hourly-map-check --every 3600 --prompt "Check map reliability and write findings." --engine agency -- --add-dir Q:\Repos\Mwc --allow-all-tools --model gpt-5.4
```

Runner command:

```text
agency cp -p "Check map reliability and write findings." --add-dir Q:\Repos\Mwc --allow-all-tools --model gpt-5.4
```

```text
crontick new daily-copilot-check --cron "0 8 * * *" --tz America/Los_Angeles --prompt "Review overnight failures." --engine copilot --session-id abc123 -- --add-dir Q:\Repos\crontick
```

Runner command:

```text
copilot -p "Review overnight failures." --add-dir Q:\Repos\crontick --session-id abc123
```


## Tool Reference

| Tool | Description |
|------|-------------|
| `crontick_job_create` | Create and schedule a new job |
| `crontick_job_list` | List all jobs with status and next run |
| `crontick_job_get` | Get full definition of a specific job |
| `crontick_job_update` | Update fields on an existing job |
| `crontick_job_delete` | Permanently delete a job; confirm first |
| `crontick_job_enable` | Re-enable a disabled job |
| `crontick_job_disable` | Disable without deleting; confirm first |
| `crontick_job_run_now` | Trigger an immediate run |
| `crontick_job_cancel_run` | Cancel an in-progress run |
| `crontick_run_list` | List recent runs |
| `crontick_run_get` | Get status and details for one run |
| `crontick_run_logs_tail` | Get recent run output |
| `crontick_schedule_validate` | Validate a schedule before using it |
| `crontick_schedule_preview` | Preview upcoming fire times |
| `crontick_stats_summary` | Aggregate stats for all jobs |
| `crontick_stats_job` | Per-job run statistics |
| `crontick_daemon_status` | Current daemon status without manual setup |
| `crontick_daemon_reload` | Reload job definitions from disk |
| `crontick_import` | Import normalized jobs from JSON |
| `crontick_dashboard_start` / `crontick_dashboard_status` / `crontick_dashboard_data` / `crontick_dashboard_stop` | Manage the local dashboard and inspect its shared data model |
| `crontick_doctor` | Health check for Node.js, SQLite, data dir, and daemon |


## Rules

1. **Default to prompt jobs** with `action.kind: "prompt"` for LLM work.
2. **Default prompt engine is Agency** for this skill; pass `--engine agency` explicitly.
3. **Use Copilot only on request**; pass `--engine copilot` and preserve Copilot args after `--`.
4. **Always validate and preview schedules first**: `crontick_schedule_validate` → `crontick_schedule_preview` → user confirms → create/update.
5. **Never invent a `crontick new --dry-run` flag**; use schedule preview and explicit confirmation.
6. **Always confirm before delete or disable**.
7. **Never start or set up the daemon yourself**; daemon-backed crontick commands handle demand-based launch.
8. **Use `--prompt-file` only for `.txt` files**; crontick stores prompt text, not the file path.
9. **Use either `--session-id` or `--reuse-session`**, never both.
10. **Scripts must be self-contained** with `set -euo pipefail` or `$ErrorActionPreference = 'Stop'`.
11. **Secrets via env or env files**; never put secrets in prompts, scripts, or job descriptions.
12. **Set timeouts** for long prompt or script jobs.
13. **Job IDs must be kebab-case**, e.g. `daily-summary`, `weekly-cleanup-2026`.
14. **Assume Windows if OS is unspecified**.


## Ban List

- ❌ Do NOT use `action.kind: "llm-prompt"`; use `action.kind: "prompt"`.
- ❌ Do NOT set `action.provider`; use `action.engine`.
- ❌ Do NOT wrap prompt jobs in script bodies that call `copilot -p` or `agency cp -p`.
- ❌ Do NOT pass both `--session-id` and `--reuse-session`.
- ❌ Do NOT call delete or disable tools without explicit confirmation.
- ❌ Do NOT edit crontick job JSON, run databases, or daemon state files directly.
- ❌ Do NOT add daemon setup or OS login instructions.


## Worked Examples

### Example 1 — Daily Agency prompt

**User**: "Every weekday at 9am, summarize this repo and write a report."

1. Infer prompt job, engine `agency`, timezone `America/Los_Angeles`, cwd `Q:\Repos\crontick`.
2. Validate schedule `{ "kind": "cron", "cron": "0 9 * * mon-fri", "tz": "America/Los_Angeles" }`.
3. Preview next 5 fires and ask for confirmation.
4. Create:

```text
crontick new weekday-repo-summary --cron "0 9 * * mon-fri" --tz America/Los_Angeles --prompt "Summarize Q:\Repos\crontick repository status and write a concise report. If any step fails, print the error clearly and exit." --engine agency --reuse-session --timeout 1800 -- --add-dir Q:\Repos\crontick --allow-all-tools
```

### Example 2 — Copilot prompt with prompt file

**User**: "Use Copilot for a daily code-health prompt from .\prompts\health.txt."

```text
crontick new daily-code-health --cron "0 8 * * *" --tz America/Los_Angeles --prompt-file .\prompts\health.txt --engine copilot --reuse-session -- --add-dir Q:\Repos\crontick --allow-all-tools
```

The `.txt` file is read before creation; the runner later calls `copilot -p <file contents> ...`.

### Example 3 — Weekly dependency cleanup script

**User**: "Clean old node_modules every Sunday."

Use a script job because this is deterministic filesystem cleanup:

```bash
#!/usr/bin/env bash
set -euo pipefail
find ~/projects -name node_modules -type d -maxdepth 3 -mtime +30 -print -exec rm -rf {} +
echo "Cleanup done."
```

Validate and preview `"0 3 * * 0"`, then create a script job with `shell: "bash"`, explicit `cwd`, and `timeoutSec`.
