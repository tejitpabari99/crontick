# Job Schema Reference

Canonical job definition schema derived from Zod schemas in `src/schemas/job.ts`.

---

## Job

Top-level job object.

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `id` | `string` (GUID) | no (server-assigned) | `randomUUID()` | UUID format | Immutable identifier assigned automatically at creation; never user-supplied. Primary key used internally by the store, `run.jobId`, and the scheduler. |
| `alias` | `string` | no | auto-generated (`<word>-<1-1000>`) | Regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case); unique among currently-defined (live) jobs | Optional, user-editable unique **alias** (the one user-facing name for a job; CLI `--alias`/`-a`). Auto-generation regenerates on collision and falls back to a short random suffix. Deleting a job frees its alias for reuse. |
| `description` | `string` | no | — | — | Human-readable description |
| `enabled` | `boolean` | no | `true` | — | Whether the job runs on schedule |
| `schedule` | `Schedule` | yes | — | Discriminated union on `kind` | When the job runs |
| `action` | `Action` | yes | — | Discriminated union on `kind` | What the job does |
| `overlap` | `"skip" \| "queue" \| "cancel-previous"` | no | `config.json` `defaults.overlap`, then `"skip"` | Enum | What happens when a new tick fires while a previous run is still active |
| `retry` | `Retry` | no | `config.json` `defaults.retry`, then `{ max: 0, backoffSec: 30 }` | — | Retry policy for failed runs |

### Identity: GUID `id` + `alias`

Every job's `id` is an immutable, server-assigned GUID -- it is the sole key
used internally by the store, run history (`run.jobId`), and the scheduler.
An optional, user-editable `alias` provides a human-friendly name that must be
unique among currently-defined jobs; when omitted on create, one is
auto-generated from a small built-in word list plus a random integer 1-1000
(retried on collision -- see `generateAlias` below). Anywhere a job identifier
is accepted (CLI, MCP, HTTP API), you may pass either the GUID `id` or the
`alias`; an exact GUID match is tried first, falling back to an alias lookup,
and an unresolved value returns `JOB_NOT_FOUND`.

---

## Schedule

Discriminated union on `kind`.

### kind: `cron`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"cron"` | yes | — | Literal | Schedule discriminator |
| `cron` | `string` | yes | — | Min length 1; parsed by croner v9 | Cron expression, evaluated in the machine's local timezone |

Cron schedules have no `tz` field. New input containing `tz` is rejected; a `tz` in an already-stored job file is silently ignored.

### kind: `interval`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"interval"` | yes | — | Literal | Schedule discriminator |
| `everySec` | `number` | yes | — | Positive | Interval in seconds |
| `startAt` | `string` | no | — | ISO-8601 datetime | When the first tick fires |

### kind: `one-shot`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"one-shot"` | yes | — | Literal | Schedule discriminator |
| `runAt` | `string` | yes | — | Min length 1; ISO-8601 datetime | Exact time to fire |

---

## Action

Discriminated union on `kind`. All action kinds share these common optional fields:

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `cwd` | `string` | no | invoking directory on create | Resolved to an absolute, existing directory (`INVALID_CWD`) | Working directory for execution (CLI `--cwd`/`-C`). For Claude jobs the folder must be trusted in Claude (see [cli.md](cli.md#working-directory-and-claude-trust)) |
| `env` | `Record<string, string>` | no | — | — | Additional environment variables |
| `envFile` | `string` | no | — | — | Path to `.env` file for extra env vars |
| `timeoutSec` | `number` | no | `config.json` `defaults.timeoutSec`, then unset | Positive | Kill the process after this many seconds |

### kind: `prompt`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"prompt"` | yes | — | Literal | Action discriminator |
| `prompt` | `string` | yes | — | Min length 1 | Prompt text sent to the engine |
| `engine` | `string` | no | config `defaultEngine` | Regex: `^[A-Za-z0-9_.-]+$` | Engine name from config |
| `args` | `string[]` | no | `[]` | — | Extra arguments passed to the engine |
| `sessionId` | `string` | no | — | Min length 1 | Fixed session ID to reuse across runs; Claude requires its transcript file to exist before resuming |
| `reuseSession` | `boolean` | no | `false` | Requires `overlap: "skip"` | Capture a reusable session ID (Claude requires a completed result line) |

Schema is `.strict()` — no extra fields allowed. Executed with `shell: false`. Subject to `promptRuntimeValidationMessage` refinement (Windows cmd-line length check, reserved arg detection). Reserved `action.args` flags include `-p`, `-r`, `--prompt`, `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`, and `--settings`; long `--flag=value` forms are also rejected.

When `reuseSession` is `true`, the job's resolved `overlap` must be `skip`. Omitting `overlap` uses the configured default, which is `skip` unless changed. `queue` and `cancel-previous` fail job validation so an in-flight reused session cannot receive another turn or be canceled by an overlapping fire.

For a Claude engine, `sessionId` must also match a completed prior run for the same job whose Claude result was parsed. A missing eligible run or transcript fails with `SESSION_NOT_FOUND` before the CLI starts. The transcript path is `<base>/projects/<encoded-cwd>/<sessionId>.jsonl` (`<base>` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), where every `/` and `.` in the absolute working directory becomes `-`. Prompt jobs run with stdin ignored.

---

## Retry

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `max` | `integer` | no | `0` | Min 0 | Maximum retry attempts |
| `backoffSec` | `number` | no | `30` | Positive | Seconds between retries |

---

## Input vs Stored Shape

The **input schema** (`JobCreateInputSchema`) differs from the stored `JobSchema` in one way: for prompt actions, the input accepts `promptFile` as an alternative to `prompt`. During normalization (`normalizeJobInput`), `promptFile` is read from disk and its contents become the `prompt` field. The persisted/stored shape always has `prompt` (never `promptFile`).

**`JobPatchInputSchema`** is a partial version: all top-level fields except `id` are optional, allowing partial updates.

---

## Update vs Create Semantics

The "Default" column above only applies **when creating a job** (`crontick jobs new`, `crontick_job_create`, or `client.createJob`). On a partial update (`crontick jobs update`, `crontick_job_update`, or `client.updateJob`), fields the caller does not mention are **preserved from the existing job**, not reset to the table's default. This applies identically across the CLI, MCP, and library surfaces, since all three funnel through the same `normalizeJobPatch()` logic.

Concretely:

- `overlap`, `action.envFile`, `action.timeoutSec`, `action.args`, `action.reuseSession`, and `retry.backoffSec` keep their previous values unless the patch explicitly sets them.
- `action.engine` is treated the same way: the config `defaultEngine` fill-in happens on create. An update that omits it preserves the stored engine.
- **Single-field prompt action patches** (for example, changing only `action.timeoutSec`) keep the existing prompt and other action fields. Use `crontick jobs update --file <patch.json>` for an advanced action patch.
- `retry.max` and the rest of `retry` follow the same partial-merge rule as `overlap`.

See [jobs.md](../concepts/jobs.md) for the conceptual explanation and [cli.md](cli.md) for the corresponding CLI defaults and update behavior.

---

## JSON Examples

### Prompt job with cron schedule

```json
{
  "alias": "morning-summary",
  "description": "Generate a daily summary via LLM",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "cron": "0 9 * * 1-5"
  },
  "action": {
    "kind": "prompt",
    "prompt": "Summarize yesterday's git commits in this repo.",
    "engine": "claude",
    "args": [],
    "reuseSession": true
  },
  "overlap": "skip",
  "retry": { "max": 1, "backoffSec": 30 }
}
```

### One-shot schedule

```json
{
  "alias": "release-reminder",
  "enabled": true,
  "schedule": {
    "kind": "one-shot",
    "runAt": "2026-08-01T03:00:00Z"
  },
  "action": {
    "kind": "prompt",
    "prompt": "Remind me to cut the release."
  },
  "overlap": "skip",
  "retry": { "max": 0, "backoffSec": 30 }
}
```

---

## Run Statuses

Runs stored in SQLite use these status values:

| Status | Meaning |
|--------|---------|
| `queued` | Scheduled but not yet started (overlap policy) |
| `running` | Currently executing |
| `success` | Completed with exit code 0 and no Claude `is_error` result |
| `failed` | Completed with non-zero exit code, Claude `is_error`, or another run error |
| `canceled` | Canceled by user, overlap policy `cancel-previous`, or orphan reconciliation on daemon restart (which can include queued runs) |
| `skipped` | A fire that never ran because another run was already active (`overlap: "skip"`); distinct from an active run terminated by cancellation |
| `timeout` | Killed due to `timeoutSec` |
| `missed` | No process ever ran: recorded at daemon startup for a fire that occurred while no daemon was running. See [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md#what-happens-while-the-daemon-is-down) |
