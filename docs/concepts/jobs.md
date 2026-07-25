# Jobs

A job is the fundamental unit of work in crontick. After reading this page you will understand how jobs are identified, what kinds exist, and how they move through their lifecycle.

## What is a job

A job binds an **action** (what to do) to a **schedule** (when to do it) along with policies for overlap, retry, and enablement. Jobs are the only user-defined entity in the system; runs, logs, and stats are derived from them.

## Identity and naming

Every job has a unique `id` that must be kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`). The id is permanent and acts as the primary key in both JSON persistence and the SQLite cache. Renaming a job requires deleting and recreating it.

## The three action kinds

| Kind | When to use | Key fields |
|------|-------------|------------|
| `script` | Run shell code (multi-line scripts, pipelines) | `script`, `shell` |
| `exec` | Run a binary directly (no shell interpretation) | `command`, `args` |
| `prompt` | Send a prompt to an LLM engine on a schedule | `prompt`, `engine`, `args` |

**script** writes the body to a temp file and invokes it through a shell. The `shell` field accepts `auto`, `bash`, `pwsh`, or `cmd`; `auto` resolves to `pwsh` on Windows, `bash` elsewhere.

**exec** spawns the command directly (`shell: false` always). Use this when you need deterministic argument passing without shell quoting.

**prompt** resolves the engine from `config.json` (defaulting to the built-in `copilot` engine), constructs the full command line via `buildPromptRunCommand`, and spawns the engine binary. It supports session reuse (`reuseSession`, `sessionId`) for multi-turn conversations.

All three kinds share common optional fields: `cwd`, `env`, `envFile`, and `timeoutSec`.

## Enabled/disabled state

A job has a boolean `enabled` field (default `true`). Disabled jobs are persisted but not scheduled by the daemon. Re-enabling a job causes the scheduler to register it immediately.

## Overlap and retry policies

| Field | Default | Purpose |
|-------|---------|---------|
| `overlap` | `"skip"` | What happens when a tick fires while the previous run is still active |
| `retry.max` | `0` | How many times to retry after failure |
| `retry.backoffSec` | `30` | Seconds to wait between retries |

Overlap values: `skip` (discard the new run), `queue` (wait for the active run to finish), `cancel-previous` (abort the active run, start the new one).

## Lifecycle: create, update, remove

1. **Create** - the client validates the input against `JobSchema` (Zod), POSTs to the daemon, which persists both a JSON file and a SQLite row, then registers the schedule.
2. **Update** - a PATCH-style merge is applied to the existing job. The daemon re-persists and re-schedules.
3. **Delete** - removes the JSON file, SQLite row, schema sidecar, and unschedules.

## What is persisted vs derived

| Persisted (source of truth) | Derived at runtime |
|-----------------------------|--------------------|
| `jobs/<id>.json` file | Active schedule timer |
| `jobs/<id>.schema.json` sidecar | Run queue / abort controller |
| SQLite `jobs` row (cache) | Next-run time |
| SQLite `runs` / `run_logs` rows | Stats aggregates |

On daemon start, the JSON files in the `jobs/` directory are the source of truth; the SQLite `jobs` table is rebuilt from them via `Store.loadJobsFromDisk()`.

## Further reading

- [Scheduling](./scheduling.md) - how schedules trigger ticks
- [Execution](./execution.md) - how a run is carried out
- [Job schema reference](../reference/job-schema.md) - full field table
- [Configuration](../reference/configuration.md) - engine setup for prompt jobs
