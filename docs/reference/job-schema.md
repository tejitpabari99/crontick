# Job Schema Reference

Canonical job definition schema derived from Zod schemas in `src/schemas/job.ts`.

---

## Job

Top-level job object.

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `id` | `string` | yes | — | Regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case) | Unique job identifier |
| `description` | `string` | no | — | — | Human-readable description |
| `enabled` | `boolean` | no | `true` | — | Whether the job runs on schedule |
| `schedule` | `Schedule` | yes | — | Discriminated union on `kind` | When the job runs |
| `action` | `Action` | yes | — | Discriminated union on `kind` | What the job does |
| `overlap` | `"skip" \| "queue" \| "cancel-previous"` | no | `"skip"` | Enum | What happens when a new tick fires while a previous run is still active |
| `retry` | `Retry` | no | `{ max: 0, backoffSec: 30 }` | — | Retry policy for failed runs |

---

## Schedule

Discriminated union on `kind`.

### kind: `cron`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"cron"` | yes | — | Literal | Schedule discriminator |
| `cron` | `string` | yes | — | Min length 1; parsed by croner v9 | Cron expression |
| `tz` | `string` | no | — | IANA timezone | Timezone for evaluation |

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
| `cwd` | `string` | no | — | — | Working directory for execution |
| `env` | `Record<string, string>` | no | — | — | Additional environment variables |
| `envFile` | `string` | no | — | — | Path to `.env` file for extra env vars |
| `timeoutSec` | `number` | no | — | Positive | Kill the process after this many seconds |

### kind: `script`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"script"` | yes | — | Literal | Action discriminator |
| `script` | `string` | yes | — | Min length 1 | Inline script body |
| `shell` | `"auto" \| "bash" \| "pwsh" \| "cmd"` | no | `"auto"` | Enum | Shell to use (`auto` = pwsh on Windows, bash elsewhere) |

Schema is `.strict()` — no extra fields allowed.

### kind: `exec`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"exec"` | yes | — | Literal | Action discriminator |
| `command` | `string` | yes | — | Min length 1 | Executable command |
| `args` | `string[]` | no | `[]` | — | Command arguments |

Schema is `.strict()` — no extra fields allowed. Executed with `shell: false`.

### kind: `prompt`

| Field | Type | Required | Default | Constraints | Description |
|-------|------|----------|---------|-------------|-------------|
| `kind` | `"prompt"` | yes | — | Literal | Action discriminator |
| `prompt` | `string` | yes | — | Min length 1 | Prompt text sent to the engine |
| `engine` | `string` | no | config `defaultEngine` | Regex: `^[A-Za-z0-9_.-]+$` | Engine name from config |
| `args` | `string[]` | no | `[]` | — | Extra arguments passed to the engine |
| `sessionId` | `string` | no | — | Min length 1 | Fixed session ID to reuse across runs |
| `reuseSession` | `boolean` | no | `false` | — | Capture first successful session ID and reuse it |

Schema is `.strict()` — no extra fields allowed. Executed with `shell: false`. Subject to `promptRuntimeValidationMessage` refinement (Windows cmd-line length check, reserved arg detection).

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

## JSON Examples

### Script job with cron schedule

```json
{
  "id": "daily-backup",
  "description": "Nightly database backup",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "cron": "0 2 * * *",
    "tz": "America/New_York"
  },
  "action": {
    "kind": "script",
    "script": "pg_dump mydb > /backups/db.sql",
    "shell": "bash"
  },
  "overlap": "skip",
  "retry": { "max": 2, "backoffSec": 60 }
}
```

### Exec job with interval schedule

```json
{
  "id": "health-check",
  "enabled": true,
  "schedule": {
    "kind": "interval",
    "everySec": 300
  },
  "action": {
    "kind": "exec",
    "command": "curl",
    "args": ["-sf", "http://localhost:8080/health"]
  },
  "overlap": "skip",
  "retry": { "max": 0, "backoffSec": 30 }
}
```

### Prompt job with cron schedule

```json
{
  "id": "morning-summary",
  "description": "Generate a daily summary via LLM",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "cron": "0 9 * * 1-5",
    "tz": "America/Los_Angeles"
  },
  "action": {
    "kind": "prompt",
    "prompt": "Summarize yesterday's git commits in this repo.",
    "engine": "copilot",
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
  "id": "migration-run",
  "enabled": true,
  "schedule": {
    "kind": "one-shot",
    "runAt": "2026-08-01T03:00:00Z"
  },
  "action": {
    "kind": "exec",
    "command": "node",
    "args": ["scripts/migrate.mjs"]
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
| `success` | Completed with exit code 0 |
| `failed` | Completed with non-zero exit code or error |
| `canceled` | Canceled by user or overlap policy `cancel-previous` |
| `timeout` | Killed due to `timeoutSec` |
