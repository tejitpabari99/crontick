# Error Reference

All error codes raised by crontick, how they are triggered, and how each surface presents them.

---

## Error Class

```ts
class CrontickError extends Error {
  name: 'CrontickError';
  code: string;
  message: string;
  details?: unknown;

  toJSON(): { code: string; message: string; details?: unknown };
}
```

---

## Error Codes

### DAEMON_NOT_RUNNING

| | |
|---|---|
| **When** | Client attempts to reach the daemon but no PID/port file exists and `startDaemon` is `false` |
| **Message shape** | Static description; includes data directory path |
| **Details** | — |

### DAEMON_REQUEST_FAILED

| | |
|---|---|
| **When** | HTTP request to the daemon fails (connection refused, timeout, network error) after optional retry |
| **Message shape** | `Failed to reach the crontick daemon at <url><path> while attempting <method>: <cause>. ...` |
| **Details** | `{ baseUrl, method, path }` |

### DAEMON_START_FAILED

| | |
|---|---|
| **When** | Daemon process exits non-zero or fails to produce a port file within the startup timeout |
| **Message shape** | Includes stderr snippet from daemon process |
| **Details** | — |

### DAEMON_TIMEOUT

| | |
|---|---|
| **When** | Daemon started but did not respond to health probes within `startupTimeoutMs` (default 10000) |
| **Message shape** | Describes the timeout |
| **Details** | — |

### DAEMON_START_LOCK_TIMEOUT

| | |
|---|---|
| **When** | Another process holds `daemon.ensure.lock` and the overall startup timeout (`startupTimeoutMs`, default 10000) expires before the lock is acquired |
| **Message shape** | Lock file path and timeout |
| **Details** | — |

### DAEMON_STOP_FAILED

| | |
|---|---|
| **When** | `daemon stop` or `daemonStop()` fails to terminate the running daemon process |
| **Message shape** | Includes PID |
| **Details** | — |

### NOT_BUILT

| | |
|---|---|
| **When** | MCP or daemon script file does not exist (not built) |
| **Message shape** | `MCP server script not found: <path>. Run: npm run build` |
| **Details** | — |

### NOT_FOUND

| | |
|---|---|
| **When** | A job or run ID does not exist |
| **Message shape** | Includes the requested ID |
| **Details** | — |

### JOB_ALREADY_EXISTS

| | |
|---|---|
| **When** | `createJob`, `crontick new`, MCP `crontick_job_create`, or HTTP `POST /api/jobs` attempts to create an ID that already exists without explicit overwrite intent |
| **Message shape** | `Job "<id>" already exists. Use "crontick update <id>" ... or re-run create with --force / force: true ...` |
| **Details** | — |

### PARSE_ERROR

| | |
|---|---|
| **When** | Daemon returns non-JSON or unparseable response |
| **Message shape** | `Unexpected response: <truncated text>` |
| **Details** | — |

### API_ERROR

| | |
|---|---|
| **When** | Daemon returns an HTTP error without a recognized error code |
| **Message shape** | `HTTP <status>` or daemon-provided message |
| **Details** | Daemon-provided details if any |

### VALIDATION_ERROR

| | |
|---|---|
| **When** | Input fails Zod schema validation (job creation, update, schedule, action) |
| **Message shape** | `Invalid job` or specific validation failure |
| **Details** | Zod formatted error (`.format()`) |

### MISSING_ARG

| | |
|---|---|
| **When** | CLI invocation omits a required argument (e.g., no schedule or action source) |
| **Message shape** | `Provide --cron, --every <sec>, or --at <iso>` (or similar) |
| **Details** | — |

### ENV_FILE_ERROR

| | |
|---|---|
| **When** | Job `action.envFile` / CLI `--job-env-file` path does not exist or cannot be read **at job-creation time** (the daemon `env-file.ts` loader tries to read the file immediately on `POST /api/jobs`). |
| **Message shape** | Includes file path |
| **Details** | — |

> **Why `update --job-env-file` alone gives `VALIDATION_ERROR` instead:** On update, the CLI requires
> at least one action-source flag (`--script`, `--exec`, `--prompt`) alongside modifier flags such as
> `--job-env-file`. If no action-source is present, the CLI `maybeBuildAction()` gate raises
> `VALIDATION_ERROR: "--job-env-file … requires an action source on update"` **before** reaching the
> file-existence check. These two error codes answer different questions and the distinct messages are
> intentional: `ENV_FILE_ERROR` = "the file was reached and is missing/unreadable"; `VALIDATION_ERROR`
> here = "insufficient patch context — the file path was never inspected".
>
> **Known limitation (PLAN-001):** `envFile` stores a **file path only** in the job record. The
> file's content is loaded exclusively at run time by the daemon runner and is never persisted, echoed,
> or returned on any read surface (job-get, list, dashboard). Assertions against env-file content via
> read surfaces are not possible by design.

### CONFIG_EXISTS

| | |
|---|---|
| **When** | `config init` without `--force` when `config.json` already exists |
| **Message shape** | `Config file already exists at <path>. Use --force to replace it, or edit that file directly.` |
| **Details** | `{ path }` |

### CONFIG_READ_ERROR

| | |
|---|---|
| **When** | `config.json` exists but cannot be parsed as JSON |
| **Message shape** | `Failed to read config file <path>: <cause>. ...` |
| **Details** | `{ path }` |

### CONFIG_VALIDATION_ERROR

| | |
|---|---|
| **When** | `config.json` content fails `ConfigSchema` validation |
| **Message shape** | `Invalid config file <path> at <key>: <expected>. ...` |
| **Details** | `{ path, key, issues }` |

### CONFIG_KEY_ERROR

| | |
|---|---|
| **When** | Config key path is syntactically invalid (does not match `^[A-Za-z0-9_.-]+$`) or is empty |
| **Message shape** | `Invalid config key path "<path>". Use dot-separated keys...` |
| **Details** | `{ key }` |

### CONFIG_KEY_NOT_FOUND

| | |
|---|---|
| **When** | `config get/unset` with a path that does not exist in the config |
| **Message shape** | `Config key "<path>" was not found. Run "crontick config get" to inspect available keys.` |
| **Details** | `{ key }` |

### CONFIG_ENGINE_NOT_FOUND

| | |
|---|---|
| **When** | `config engines update/remove` or prompt job references a non-existent engine |
| **Message shape** | `Engine "<name>" is not defined in <path>. ...` |
| **Details** | `{ path, key }` |

### CONFIG_ENGINE_EXISTS

| | |
|---|---|
| **When** | `config engines add` with a name that already exists |
| **Message shape** | `Engine "<name>" already exists in <path>. Use update if you want to change it.` |
| **Details** | `{ path, key }` |

### CONFIG_BUILTIN_ENGINE

| | |
|---|---|
| **When** | Attempting to remove a built-in engine (e.g., `copilot`) |
| **Message shape** | `Engine "<name>" is a built-in fallback engine and cannot be removed...` |
| **Details** | `{ path, key }` |

### FORBIDDEN

| | |
|---|---|
| **When** | API request blocked by security policy (non-loopback access) |
| **Message shape** | — |
| **Details** | — |

### DASHBOARD_ASSET_NOT_FOUND

| | |
|---|---|
| **When** | Dashboard static assets directory does not exist (not built) |
| **Message shape** | `Dashboard assets were not found at <dir>. Run: npm run build` |
| **Details** | `{ dashboardDir, action }` |

### BAD_DASHBOARD_ASSET

| | |
|---|---|
| **When** | Dashboard asset request path is outside the dashboard directory or is not a file |
| **Message shape** | `Dashboard asset path is outside the dashboard directory...` |
| **Details** | `{ requestedPath, action }` |

### INTERNAL_ERROR

| | |
|---|---|
| **When** | Unexpected internal failure |
| **Message shape** | Variable |
| **Details** | Variable |

---

## Stored Run Error Values (not `CrontickError` codes)

The values above are all thrown `CrontickError` instances (`code` + `message` + optional
`details`). Separately, the SQLite `runs.error` column stores plain failure strings for a run —
these are written directly by the runner/store, never thrown, and are not `CrontickError`
instances. Several use a `CODE: message` convention that looks similar to the codes above but is
an unrelated, run-scoped vocabulary; do not conflate the two.

| Stored `runs.error` prefix | Set by | Meaning |
|-----------------------------|--------|---------|
| `DAEMON_RESTART: run was canceled ...` | `Store.reconcileOrphanRuns()` | A run left `queued` (never spawned), or left `running` and confirmed dead by a process-liveness check, when the daemon last stopped. Exported as `ORPHAN_RUN_ERROR_CODE` (`'DAEMON_RESTART'`) and `ORPHAN_RUN_ERROR_MESSAGE` from `src/errors.ts` and the package root — see [library-api.md](./library-api.md). A run whose liveness check finds the process still alive (or the check was inconclusive) is *adopted* instead of canceled — see [storage internals](../internals/storage.md#orphan-reconciliation) — and does not get this error. |
| `DAEMON_RESTART: adopted run was terminated` | `Runner.cancelRun()`/`cancelJob()` | An adopted run (see above) was explicitly canceled by a user or overlap policy after being re-attached to a new daemon process. |
| `DAEMON_RESTART: process exited while the daemon was not running or between adoption and this check; exit code unknown` | `Runner` adoption poll, exported as `ADOPTED_RUN_EXITED_MESSAGE` from `src/daemon/runner.ts` (internal, not re-exported from the package root) | An adopted run's process had already exited by the time the adoption poll first checked it, so no exit code could be captured. Distinct from the orphan-cancellation message above: this run *did* run to completion, just without a daemon present to observe how. |
| `MISSED: daemon was not running at the scheduled fire time` | `Store.recordMissedRun()`, exported as `MISSED_RUN_ERROR_MESSAGE` from `src/daemon/store.ts` (internal, not re-exported from the package root) | A scheduled fire that occurred while no daemon process was running; recorded, never executed. See [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md#what-happens-while-the-daemon-is-down). |
| `run exceeded timeoutSec (<n>s)` | `Runner`'s per-action timer (`src/daemon/runner.ts`) | The job's `timeoutSec` elapsed before the process exited; the runner sent `SIGTERM` itself and recorded `status: 'timeout'`. Distinct from `status: 'canceled'`, which is a user- or overlap-policy-initiated stop — see [concepts/execution.md](../concepts/execution.md#timeouts). |
| `RUNNER_CALLBACK_FAILED: ...` | `src/daemon/runner.ts` | A user-supplied run callback threw. |
| `SESSION_ID_NOT_FOUND: ...` | `src/daemon/runner.ts` | `reuseSession` capture found no session id in prompt engine output. |
| `SESSION_PERSIST_FAILED: ...` | `src/daemon/runner.ts` | Persisting a captured session id back to the job file failed. |

See [error-model.md](../concepts/error-model.md#stored-runserror-values-are-not-crontickerror-codes)
and [storage internals](../internals/storage.md#orphan-reconciliation).

---

## Surface Presentation

### CLI

- Errors print to stderr: `Error [<code>]: <message>`
- Process exits with code `1`
- `--json` mode: same behavior (error is not JSON-formatted; it goes to stderr)

### MCP

- Returned as tool result with `isError: true`
- Payload: `{ "error": "<redacted message>" }` (or with `diagnostics` when verbose)
- `redactForLlm()` replaces loopback addresses with `<daemon-addr>` and filesystem paths with `<path>`

### Library

- Throws `CrontickError` instances directly
- Callers use `instanceof CrontickError` and inspect `.code` for programmatic handling
- `.toJSON()` provides a serializable representation
