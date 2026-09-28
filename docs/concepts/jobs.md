# Jobs

Audience: users and contributors who need the job mental model (identity, action shape,
lifecycle). Non-duplication: for the exact field-by-field schema see
[reference/job-schema.md](../reference/job-schema.md); for engine/adapter behavior see
[specs/007-prompt-jobs.md](../specs/007-prompt-jobs.md).

A job is the fundamental unit of work in crontick. After reading this page you will understand how jobs are identified, what a job's action looks like, and how they move through their lifecycle.

## What is a job

A job binds an **action** (what to do) to a **schedule** (when to do it) along with policies for overlap, retry, and enablement. Jobs are the only user-defined entity in the system; runs, logs, and stats are derived from them.

## Identity and naming

Every job has an immutable `id`: a GUID (`node:crypto` `randomUUID()`) assigned automatically at creation. It is never user-supplied, is the primary key in both JSON persistence and the SQLite cache, and is the value `run.jobId` references -- this guarantees a deleted-and-recreated job never inherits a previous job's run history or dashboard "last status", even if it reuses the same alias.

Every job also has an optional, user-editable `alias`: a kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) human-friendly name, unique among all currently-defined (non-deleted) jobs. When you don't supply one on create, crontick auto-generates `<word>-<1-1000>` from a small built-in word list, retrying on collision. You can rename a job by editing its `alias` later via `update` -- no delete/recreate required.

Anywhere a job identifier is accepted (CLI positional `<id>`, MCP `id` params, HTTP path segments), you may pass EITHER the GUID `id` OR the `alias`; crontick resolves an exact GUID match first, then falls back to an alias lookup, and returns `JOB_NOT_FOUND` if neither matches.

## The job's action: `prompt`

`action.kind` is a discriminant with a single member today, `"prompt"` (`script` and `exec` were
removed -- see [ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)). A prompt action sends
`prompt` text to a configured LLM engine on the job's schedule:

| Field | Purpose |
|-------|---------|
| `prompt` | The text sent to the engine. |
| `engine` | Named engine from `config.json` (defaults to `config.defaultEngine`, which is the built-in `claude` engine unless changed). |
| `args` | Extra arguments passed through to the engine CLI. |
| `sessionId` / `reuseSession` | Multi-turn session reuse across scheduled runs -- see [execution.md](./execution.md#how-prompt-jobs-differ). |

The engine is resolved from `config.json` by an **adapter** keyed on the engine's `type`
(`raw` or `claude`); the adapter builds the actual command line and interprets the result. See
[internals/engines.md](../internals/engines.md) for the adapter contract.

All actions also share `cwd`, `env`, `envFile`, and `timeoutSec`.

## Enabled/disabled state

A job has a boolean `enabled` field (default `true`). Disabled jobs are persisted but not scheduled by the daemon. Re-enabling a job causes the scheduler to register it immediately.

## Overlap and retry policies

| Field | Default | Purpose |
|-------|---------|---------|
| `overlap` | `"skip"` | What happens when a tick fires while the previous run is still active |
| `retry.max` | `0` | How many times to retry after failure |
| `retry.backoffSec` | `30` | Seconds to wait between retries |

Overlap values: `skip` (finalize the new tick as `skipped`), `queue` (wait for the active run to finish), `cancel-previous` (abort the active run, start the new one).

## Lifecycle: create, update, remove

1. **Create** - the client validates the input against `JobSchema` (Zod), POSTs to the daemon, which persists both a JSON file and a SQLite row, then registers the schedule.
2. **Update** - a PATCH-style merge is applied to the existing job: fields the caller does not
   mention keep their previous value rather than resetting to a create-time default. This
   behavior is identical on the CLI, MCP, and library surfaces. See
   [job-schema.md](../reference/job-schema.md#update-vs-create-semantics) for the exact field
   list. The daemon re-persists and re-schedules after applying the merge.
3. **Delete** - removes the JSON file, SQLite row, schema sidecar, and unschedules. It also
   cancels the job's in-flight run, if any (`Runner.cancelJob()`), reporting whether a run was
   actually canceled (`canceledRun: boolean`). See
   [reference/mcp-tools.md](../reference/mcp-tools.md#crontickjobdelete) and
   [reference/cli.md](../reference/cli.md#crontick-jobs-delete).

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
