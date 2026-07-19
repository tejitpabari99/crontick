# crontick — Scheduling Skill for MCP-Capable LLMs

> **Version**: 1.0 (M4)
> **Purpose**: Teach any MCP-capable LLM to schedule recurring or one-shot scripts on a local machine using the `crontick` daemon.

---

## When to Use This Skill

Use `crontick` tools when the user asks to:

- Run a script, command, or task on a schedule ("every day at 9am", "every 5 minutes", "every Monday")
- Back up files, clean up directories, or run maintenance automatically
- Trigger a CLI tool (e.g. `git push`, `copilot -p "..."`, `claude`) on a timer
- Monitor a condition and take action periodically
- Set up a one-shot delayed task ("in 30 minutes", "at midnight tonight")

**Do NOT use** for: interactive tasks requiring human input, long-running LLM reasoning sessions that need a session ID, or tasks that require browser or GUI automation.

---

## Workflow

Follow these steps in order. Do not skip validation.

### Step 1 — Understand the Intent

Ask (or infer from context):
- What should the script _do_? (write a 1-sentence summary)
- When should it run? (schedule cadence, timezone)
- Any side effects? (writes files, network calls, sends alerts)
- On which OS? (Windows → PowerShell; Unix/macOS → bash; **assume Windows if unspecified**)
- Required environment (working directory, secrets, binaries that must be on PATH)

### Step 2 — Draft a Self-Contained Script

Write a script that accomplishes the task:

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

Rules for the script:
- **Idempotent**: running it twice must not corrupt state
- **Self-contained**: do not rely on external session state or env vars (except those explicitly declared in `action.env`)
- **Explicit working directory**: always set `action.cwd` — never rely on the daemon's working directory
- **Secrets via env**: do not hardcode tokens or passwords; put them in `action.env` or reference a secrets file
- **Timeout**: set `action.timeoutSec` to a reasonable upper bound (default: 3600 for long jobs, 60 for short ones)
- **Concise description**: fill `description` with a one-line plain-English explanation
- The script may shell out to other CLIs: `copilot -p "..."`, `claude`, `git`, `npm run`, etc. — those invocations happen inside the script, not in `crontick` itself

### Step 3 — Validate the Schedule

Call `crontick_schedule_validate` with the proposed schedule:

```json
{ "schedule": { "kind": "cron", "cron": "0 9 * * *", "tz": "America/Los_Angeles" } }
```

Supported schedule kinds:
- `cron` — cron expression + optional timezone (`tz`)
- `interval` — `{ "kind": "interval", "everySec": 300 }` for "every N seconds"
- `one-shot` — `{ "kind": "one-shot", "runAt": "2026-08-01T09:00:00Z" }` for a single future run

Then call `crontick_schedule_preview` to show the next 5 fire times. Always show these to the user for confirmation before creating the job.

### Step 4 — Create the Job

Once the user confirms the schedule, call `crontick_job_create`:

```json
{
  "id": "daily-backup",
  "description": "Back up ~/projects to ~/backups every day at 9am PT",
  "schedule": { "kind": "cron", "cron": "0 9 * * *", "tz": "America/Los_Angeles" },
  "action": {
    "kind": "script",
    "script": "$ErrorActionPreference = 'Stop'\nCopy-Item -Recurse ~/projects ~/backups/$(Get-Date -f yyyyMMdd) -Force",
    "shell": "pwsh",
    "cwd": "~",
    "timeoutSec": 300
  },
  "overlap": "skip",
  "retry": { "max": 1, "backoffSec": 60 }
}
```

For a simple command (no shell), use `action.kind: "exec"`:
```json
{ "action": { "kind": "exec", "command": "git", "args": ["-C", "/path/to/repo", "push"] } }
```

### Step 5 — Confirm and Report

After `crontick_job_create` returns:
1. Report the returned `id` and `nextRunAt` to the user
2. Offer to run immediately with `crontick_job_run_now` if they want to test it
3. Show `crontick://schemas/job` if the user wants to see the full schema

---

## Tool Reference

| Tool | Description |
|------|-------------|
| `crontick_job_create` | Create and schedule a new job |
| `crontick_job_list` | List all jobs with status and next run |
| `crontick_job_get` | Get full definition of a specific job |
| `crontick_job_update` | Update fields on an existing job (partial) |
| `crontick_job_delete` | Permanently delete a job (confirm first!) |
| `crontick_job_enable` | Re-enable a disabled job |
| `crontick_job_disable` | Disable without deleting |
| `crontick_job_run_now` | Trigger an immediate run |
| `crontick_job_cancel_run` | Cancel an in-progress run |
| `crontick_run_list` | List recent runs (filterable by job ID) |
| `crontick_run_get` | Get status and details of a specific run |
| `crontick_run_logs_tail` | Get last N lines of a run's output |
| `crontick_schedule_validate` | Validate a schedule before using it |
| `crontick_schedule_preview` | Preview next N fire times |
| `crontick_stats_summary` | Aggregate stats for all jobs |
| `crontick_stats_job` | Per-job run statistics |
| `crontick_daemon_status` | Daemon PID, version, uptime |
| `crontick_daemon_reload` | Reload job definitions from disk |
| `crontick_daemon_restart` | Restart the daemon (interrupts running jobs) |
| `crontick_autostart_status` | Check if daemon is registered for autostart |
| `crontick_autostart_install` | Register daemon for login autostart |
| `crontick_autostart_remove` | Unregister daemon from login autostart |
| `crontick_export` | Export all jobs as JSON |
| `crontick_import` | Import jobs from a JSON array (upsert) |
| `crontick_dashboard_open` | Get the URL for the local web dashboard |
| `crontick_doctor` | Health check: Node.js, SQLite, data dir, daemon |

---

## Rules

1. **Always validate the schedule first** (`crontick_schedule_validate` → `crontick_schedule_preview` → user confirms → create)
2. **Always confirm before delete or disable** — `crontick_job_delete` and `crontick_job_disable` are irreversible or disruptive; ask the user explicitly
3. **Scripts must be self-contained** — `action.script` must not rely on env vars or files set up by other scripts
4. **Use error-first shell settings** — `set -euo pipefail` in bash; `$ErrorActionPreference = 'Stop'` in pwsh
5. **Set explicit `cwd`** — never rely on the daemon's working directory
6. **Secrets via `action.env`** — `{ "GITHUB_TOKEN": "ghp_..." }` or reference a dotenv file; never hardcode secrets in the script body
7. **Set `timeoutSec`** — prevents runaway jobs from consuming resources
8. **Never invent an LLM sub-runtime** — do NOT create jobs with `action.kind: "llm-prompt"` or similar; that kind does not exist. If the user wants the script to invoke an LLM CLI, put `copilot -p "..."` or `claude -p "..."` inside the script body
9. **Job IDs must be kebab-case** — e.g. `daily-backup`, `weekly-cleanup-2026`
10. **Assume Windows if OS is unspecified** — use `shell: "pwsh"` and PowerShell syntax

---

## Ban List

- ❌ Do NOT use `action.kind: "llm-prompt"` — this kind does not exist
- ❌ Do NOT set `action.provider` — there is no provider field
- ❌ Do NOT use `action.resumeSessionId` — sessions are not supported
- ❌ Do NOT call `crontick_daemon_restart` without user confirmation — it interrupts running jobs
- ❌ Do NOT call `crontick_job_delete` without explicit user confirmation ("yes, delete it")

---

## Worked Examples

### Example 1 — Daily Backup (Windows)

**User**: "Back up my code repos to an external drive every day at 10pm"

1. Clarify: repos at `C:\Users\alice\code`, backup drive `E:\Backups`
2. Draft script (pwsh):
   ```powershell
   $ErrorActionPreference = 'Stop'
   $src = 'C:\Users\alice\code'
   $dst = "E:\Backups\code-$(Get-Date -f yyyyMMdd)"
   if (-not (Test-Path E:\Backups)) { throw 'Backup drive E: not mounted' }
   Copy-Item -Recurse $src $dst -Force
   Write-Output "Backup complete: $dst"
   ```
3. Validate: `crontick_schedule_validate { kind: "cron", cron: "0 22 * * *", tz: "America/New_York" }`
4. Preview next 5 fires → show user → user confirms
5. Create:
   ```json
   {
     "id": "daily-code-backup",
     "description": "Back up C:\\Users\\alice\\code to E:\\Backups daily at 10pm ET",
     "schedule": { "kind": "cron", "cron": "0 22 * * *", "tz": "America/New_York" },
     "action": {
       "kind": "script", "shell": "pwsh",
       "cwd": "C:\\Users\\alice",
       "script": "$ErrorActionPreference = 'Stop'\n...",
       "timeoutSec": 600
     },
     "overlap": "skip"
   }
   ```
6. Report: job `daily-code-backup` created, next run 2026-07-19T02:00:00Z

### Example 2 — Weekly Dependency Cleanup (macOS/Linux)

**User**: "Clean up old node_modules in my projects folder every Sunday"

1. Clarify: projects at `~/projects`, remove `node_modules` older than 30 days
2. Draft script (bash):
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   find ~/projects -name node_modules -type d -maxdepth 3 -mtime +30 -print -exec rm -rf {} +
   echo "Cleanup done."
   ```
3. Validate + preview for `"0 3 * * 0"` (Sunday 3am)
4. Create with `shell: "bash"`, `cwd: "~"`, `timeoutSec: 3600`

---

## Resources

- Job schema: `crontick://schemas/job`
- Jobs list: `crontick://jobs`
- Individual job: `crontick://jobs/{id}`
- Run record: `crontick://runs/{id}`
- Run logs: `crontick://runs/{id}/log`
