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

Every job also has an optional, user-editable **alias** (the one user-facing name; the CLI flag is `--alias`/`-a`): a kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) name, unique among all currently-defined (non-deleted) jobs. When you don't supply one on create, crontick auto-generates `<word>-<1-1000>` from a small built-in word list, retrying on collision (after many collisions a short random suffix is used, and a create race that trips the alias UNIQUE index is retried with a fresh alias). You can rename a job by editing its `alias` later via `update` -- no delete/recreate required.

Anywhere a job identifier is accepted (CLI positional `<id|alias>`, MCP `id` params, HTTP path segments), you may pass EITHER the GUID `id` OR the `alias`; crontick resolves an exact GUID match first, then falls back to an alias lookup, and returns `JOB_NOT_FOUND` ("Job X not found (id or alias)") if neither matches. All lookups share one resolver. The alias `all` is reserved (it is the `jobs delete all` keyword) and is rejected on create, update and import.

## The job's action: `prompt`

`action.kind` is a discriminant with a single member today, `"prompt"` (`script` and `exec` were
removed -- see [ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)). A prompt action sends
`prompt` text to a configured LLM engine on the job's schedule:

| Field | Purpose |
|-------|---------|
| `prompt` | The text sent to the engine. |
| `engine` | Named engine from `config.json` (defaults to `config.defaultEngine`, which is the built-in `claude` engine unless changed). |
| `args` | Extra arguments passed through to the engine CLI. On the CLI, unrecognized `--flags` given to `jobs new`/`jobs update` are forwarded into `args`; engine-reserved flags (for Claude, e.g. `--output-format`, `--settings`) are rejected. |
| `sessionId` / `reuseSession` | Multi-turn session reuse across scheduled runs -- see [execution.md](./execution.md#how-prompt-jobs-differ). |

The engine is resolved from `config.json` by an **adapter** keyed on the engine's `type`
(`raw` or `claude`); the adapter builds the actual command line and interprets the result. See
[implementation/engines.md](../implementation/engines.md) for the adapter contract.

All actions also share `cwd`, `env`, `envFile`, and `timeoutSec`.

## Enabled/disabled state

A job has a boolean `enabled` field (default `true`). Disabled jobs are persisted but not scheduled by the daemon. Re-enabling a job causes the scheduler to register it immediately.

## Overlap and retry policies

| Field | Default | Purpose |
|-------|---------|---------|
| `overlap` | `"skip"` | What happens when a tick fires while the previous run is still active |
| `retry.max` | `0` | How many times to retry after failure |
| `retry.backoffSec` | `30` | Seconds to wait between retries |

Overlap values: `skip` (finalize the new tick as `skipped`), `queue` (wait for the active run to finish), `cancel-previous` (abort the active run, start the new one). `reuseSession: true` or an explicit `sessionId` requires `overlap: "skip"`, since two concurrent runs cannot safely share one session.

When a create input omits `overlap`, `timeoutSec`, or `retry`, crontick fills them from the `defaults` section of `config.json`, falling back to the built-ins above. Precedence is CLI flag > job JSON > `config.json` `defaults` > built-in. The resolved values are saved with the job at create/update time, so later config edits do not change existing jobs (see [spec 007](../specs/007-prompt-jobs.md)).

## Lifecycle: create, update, remove

1. **Create** - the client validates the input against `JobSchema` (Zod), POSTs to the daemon, which persists both a JSON file and a SQLite row, then registers the schedule.
2. **Update** - a PATCH-style merge is applied to the existing job: fields the caller does not
   mention keep their previous value rather than resetting to a create-time default. This
   behavior is identical on the CLI, MCP, and library surfaces. See
   [job-schema.md](../reference/job-schema.md#update-vs-create-semantics) for the exact field
   list. The daemon re-persists and re-schedules after applying the merge.
3. **Delete** - unschedules the job, cancels its in-flight run, if any (`Runner.cancelJob()`, reported as
   `canceledRun: boolean`), then removes the JSON file, schema sidecar, SQLite row **and all of the job's
   runs, stored run output, schedule state and per-job log file** in one transaction (`deletedRuns` reports how
   many runs went). Nothing is archived; Claude's own session transcripts are untouched. See
   [reference/mcp-tools.md](../reference/mcp-tools.md#crontickjobdelete) and
   [reference/cli.md](../reference/cli.md#crontick-jobs-delete).

## Working directory

A job runs in `action.cwd`. `jobs new` records the invoking directory (or `--dir`), resolved to an absolute existing path (`INVALID_CWD` otherwise); library and MCP callers default to the client's `cwd` option or the process directory, so MCP agents should pass the project folder. For Claude jobs the folder must be trusted in Claude's config: creation fails with `TRUST_REQUIRED` unless the folder is trusted, the user answers `y` at the CLI prompt, or `--trust-folder`/`trustFolder: true` is given. (`claude -p` itself skips its trust dialog; the check is a guardrail for the owner's intent.) Claude sessions are stored per directory, so moving a job that has a session to another cwd needs `--session-id` or `--reuse-session` (`CWD_CHANGE_BREAKS_SESSION`). See [cli.md](../reference/cli.md#working-directory-and-claude-trust).

## What is persisted vs derived

| Persisted (source of truth) | Derived at runtime |
|-----------------------------|--------------------|
| `jobs/<id>.json` file | Active schedule timer |
| `jobs/<id>.schema.json` sidecar | Run queue / abort controller |
| SQLite `jobs` row (cache) | Next-run time |
| SQLite `runs` / `run_outputs` rows | Stats aggregates |

On daemon start, the JSON files in the `jobs/` directory are the source of truth; the SQLite `jobs` table is rebuilt from them via `Store.loadJobsFromDisk()`.

## Further reading

- [Scheduling](./scheduling.md) - how schedules trigger ticks
- [Execution](./execution.md) - how a run is carried out
- [Job schema reference](../reference/job-schema.md) - full field table
- [Configuration](../reference/configuration.md) - engine setup for prompt jobs
