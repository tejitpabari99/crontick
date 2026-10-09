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

### DAEMON_PORT_IN_USE

| | |
|---|---|
| **When** | The daemon starts with an explicit `daemon.port` (> 0) that is already in use; it exits non-zero with no fallback |
| **Message shape** | `Port <p> (config daemon.port) is in use by another crontick daemon (pid N, data dir D); free it or change daemon.port in <configPath>` or `...by another process (not crontick)...`; same-data-dir holder says to run `crontick daemon stop` |
| **Details** | `{ port, occupant, configPath }`; surfaces to clients via the `DAEMON_START_FAILED` stderr excerpt |

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

### JOB_NOT_FOUND

| | |
|---|---|
| **When** | The daemon API cannot resolve a job identifier (GUID or alias) |
| **Message shape** | `Job <idOrAlias> not found` |
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
| **When** | `createJob`, `crontick jobs new`, MCP `crontick_job_create`, or HTTP `POST /api/jobs` attempts to create an ID that already exists without explicit overwrite intent |
| **Message shape** | `Job "<id>" already exists. Use "crontick jobs update <id>" ... or re-run create with --force / force: true ...` |
| **Details** | — |

### AFTER_CYCLE

| | |
|---|---|
| **When** | A job with an `after` schedule would create a cycle (including pointing at itself) on create, update, enable or import |
| **Message shape** | Names the cycle |
| **Details** | — |

### AFTER_UPSTREAM_NOT_FOUND

| | |
|---|---|
| **When** | The `after` upstream (id or alias) does not exist on create, update or enable. On import the job is instead imported disabled with this error recorded on its row |
| **Message shape** | Names the missing upstream |
| **Details** | — |

### JOB_HAS_DEPENDENTS

| | |
|---|---|
| **When** | Deleting a job that other jobs run `after`, without `force` |
| **Message shape** | Lists the dependents' aliases and mentions `--force` / `force: true` |
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

### ALIAS_GENERATION_FAILED

| | |
|---|---|
| **When** | `generateAlias()` could not find an unused auto-generated alias after 50 attempts |
| **Message shape** | `Could not generate a unique job alias after <n> attempts. Provide an explicit alias.` |
| **Details** | — |

### MISSING_ARG

| | |
|---|---|
| **When** | CLI invocation omits a required argument (e.g., no schedule or action source) |
| **Message shape** | `Provide exactly one schedule: --cron <expr>, --every <interval> ..., or --at <datetime> ...` (or similar) |
| **Details** | — |

### ENV_FILE_ERROR

| | |
|---|---|
| **When** | Job `action.envFile` path does not exist or cannot be read when the action is normalized or preflighted. The dedicated CLI `--job-env-file` flag is no longer exposed; use the job JSON schema (`action.envFile`) via `crontick jobs new --file <job.json>` or the library API. |
| **Message shape** | Includes file path |
| **Details** | — |

### CONFIG_EXISTS

| | |
|---|---|
| **When** | `CrontickClient.initConfig({ force: false })` when `config.json` already exists |
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
| **When** | `config get` / `config unset` (CLI, MCP, library) on a path that does not exist in the config |
| **Message shape** | `Config key "<path>" was not found. ...` |
| **Details** | `{ key }` |

### CONFIG_CONFLICT

| | |
|---|---|
| **When** | A config write passed `ifRevision` and `config.json` changed since that revision was read (HTTP 409) |
| **Message shape** | Names the file; re-read and retry |
| **Details** | `{ path, expected, actual }` |

### CONFIG_KEY_READ_ONLY

| | |
|---|---|
| **When** | `set`/`unset` of `daemon` or a key under it while a daemon process is running, or any `PATCH /api/config` op touching `daemon` |
| **Message shape** | `daemon.port can only be changed while the daemon is stopped: run "crontick daemon stop" first` |
| **Details** | `{ key }` |

### CONFIG_REDACTED_VALUE

| | |
|---|---|
| **When** | A config write submits a string containing the `[REDACTED]` marker that does not match the stored redacted value at the same path |
| **Message shape** | Names the key; submit the real value or leave the field untouched |
| **Details** | `{ key }` |

### CONFIG_LOCKED

| | |
|---|---|
| **When** | `config.json.lock` stayed held by another writer for 2 s (locks older than 10 s are broken automatically) |
| **Message shape** | `Config file <path> is locked by another writer (...)` |
| **Details** | `{ path, lock }` |

### RUNS_IN_FLIGHT

| | |
|---|---|
| **When** | A config save or job update found runs executing or queued (for a job update: that job's runs) and no `inFlight` choice (`stop`/`wait`; CLI `--stop-running`/`--wait-running`) was given (HTTP 409) |
| **Message shape** | Lists the in-flight runs |
| **Details** | `{ runs }` |

### REQUEST_REJECTED

| | |
|---|---|
| **When** | A mutating `/api` request (POST/PUT/PATCH/DELETE) has a non-loopback `Host`, a `Content-Type` other than `application/json` (required even when bodyless), or a mismatching `Origin`. Nothing is executed. HTTP 403 (Host/Origin) or 415 (Content-Type) |
| **Message shape** | `Rejected: ...` |
| **Details** | — |

### CONFIG_ENGINE_NOT_FOUND

| | |
|---|---|
| **When** | A prompt job references a non-existent engine (resolved per run) |
| **Message shape** | `Engine "<name>" is not defined in <path>. ...` |
| **Details** | `{ path, key }` |

### CONFIG_ENGINE_EXISTS

| | |
|---|---|
| **When** | Legacy engine-add path with a name that already exists (engines are now added or replaced with `config set engines.<name>`) |
| **Message shape** | `Engine "<name>" already exists in <path>. Use update if you want to change it.` |
| **Details** | `{ path, key }` |

### CONFIG_BUILTIN_ENGINE

| | |
|---|---|
| **When** | Attempting to remove a built-in engine (currently `claude`) |
| **Message shape** | `Engine "<name>" is a built-in fallback engine and cannot be removed...` |
| **Details** | `{ path, key }` |

### TRUST_REQUIRED

| | |
|---|---|
| **When** | A Claude job's working directory is not trusted in Claude's config (`hasTrustDialogAccepted`); thrown before anything is saved |
| **Message shape** | Names the folder and how to trust it (`--trust-folder` / `trustFolder: true`) |
| **Details** | — |

See [troubleshooting.md](../troubleshooting.md#trust_required-when-creating-a-claude-job).

### CLAUDE_CONFIG_UNREADABLE

| | |
|---|---|
| **When** | Recording folder trust needs Claude's `.claude.json`, which is not parsable JSON |
| **Details** | — |

### TRUST_DECLINED

| | |
|---|---|
| **When** | CLI only: an interactive `Trust it? (y/N)` prompt after `TRUST_REQUIRED` was answered with anything but `y`/`yes`; nothing is created or changed |
| **Details** | Same as `TRUST_REQUIRED` |

### CLAUDE_CONFIG_BUSY

| | |
|---|---|
| **When** | Recording folder trust: Claude's `.claude.json` kept changing during the atomic write, so crontick gave up after its retries and changed nothing. Try again |
| **Details** | `{ path }` |

### CWD_CHANGE_BREAKS_SESSION

| | |
|---|---|
| **When** | An update changes `cwd` of a job that has a session (`sessionId` or `reuseSession`) |
| **Fix** | Also pass `--session-id <id>` for the new directory, or `--reuse-session` for a fresh one |

### INVALID_CWD

| | |
|---|---|
| **When** | A job's working directory does not exist (also reported per row on `share import`) |

### NOT_IMPLEMENTED

| | |
|---|---|
| **When** | The daemon API route is reached in a context that does not support it (HTTP 501), e.g. graceful shutdown without a shutdown hook |
| **Message shape** | `Graceful shutdown is not wired for this context` |
| **Details** | — |

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

### AUTOSTART_UNSUPPORTED

| | |
|---|---|
| **When** | `autostartEnable()` / `autostartDisable()` on a platform with no autostart backend (Linux systemd `--user`, macOS launchd and Windows Task Scheduler are supported). `autostartStatus()` never throws; it returns `supported: false` with a reason |
| **Message shape** | Names the platform and what to do instead |
| **Details** | — |

### AUTOSTART_UNAVAILABLE

| | |
|---|---|
| **When** | The backend exists but the service manager is not usable (no `systemctl`, no user bus: WSL1, containers; macOS: no GUI launchd session, e.g. over SSH or no console user; Windows: `schtasks.exe` unusable, e.g. policy prohibits task creation). Nothing is written |
| **Message shape** | `Autostart is unavailable: <reason>` |
| **Details** | `{ mechanism }` |

### AUTOSTART_SCRIPT_MISSING

| | |
|---|---|
| **When** | `autostartEnable()` and the daemon script (`dist/daemon/index.js`) does not exist (unbuilt or dev checkout) |
| **Message shape** | `Refusing to enable autostart: daemon script not found at <path>. ...` |
| **Details** | `{ daemonScript }` |

### AUTOSTART_EPHEMERAL_PATH

| | |
|---|---|
| **When** | `autostartEnable()` and the daemon script lives in a temporary location (e.g. an `_npx` cache) |
| **Message shape** | `Refusing to enable autostart: the daemon script is in a temporary location (<path>). ...` |
| **Details** | `{ daemonScript }` |

### AUTOSTART_FAILED

| | |
|---|---|
| **When** | The backend threw while enabling or disabling (e.g. a `systemctl` or `launchctl` call failed; on macOS the cause includes launchctl stderr, and an opaque `Input/output error` (5) on bootstrap usually means the item is switched off in Login Items) |
| **Message shape** | `Failed to enable autostart: <cause>` / `Failed to disable autostart: <cause>` |
| **Details** | — |

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
| `DAEMON_RESTART: run was canceled ...` | `Store.reconcileOrphanRuns()` | A run left `queued` (never spawned), or left `running` and confirmed dead by a process-liveness check, when the daemon last stopped. Exported as `ORPHAN_RUN_ERROR_CODE` (`'DAEMON_RESTART'`) and `ORPHAN_RUN_ERROR_MESSAGE` from `src/errors.ts` and the package root — see [library-api.md](./library-api.md). A run whose liveness check finds the process still alive (or the check was inconclusive) is *adopted* instead of canceled — see [storage internals](../implementation/storage.md#orphan-reconciliation) — and does not get this error. |
| `DAEMON_RESTART: adopted run was terminated` | `Runner.cancelRun()`/`cancelJob()` | An adopted run (see above) was explicitly canceled by a user or overlap policy after being re-attached to a new daemon process. |
| `DAEMON_RESTART: process exited while the daemon was not running or between adoption and this check; exit code unknown` | `Runner` adoption poll, exported as `ADOPTED_RUN_EXITED_MESSAGE` from `src/daemon/runner.ts` (internal, not re-exported from the package root) | An adopted run's process had already exited by the time the adoption poll first checked it, so no exit code could be captured. Distinct from the orphan-cancellation message above: this run *did* run to completion, just without a daemon present to observe how. |
| `MISSED: daemon was not running at the scheduled fire time` | `Store.recordMissedRun()`, exported as `MISSED_RUN_ERROR_MESSAGE` from `src/daemon/store.ts` (internal, not re-exported from the package root) | A scheduled fire that occurred while no daemon process was running; recorded, never executed. See [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md#what-happens-while-the-daemon-is-down). |
| `overlap=skip: another run is already active` | `Runner.run()` (`src/daemon/runner.ts`) | The fire never started a process because overlap policy `skip` found another run for the job already active; recorded `status: 'skipped'`. Distinct from `canceled`, which stops a run that had already started. |
| `run exceeded timeoutSec (<n>s)` | `Runner`'s per-action timer (`src/daemon/runner.ts`) | The job's `timeoutSec` elapsed before the process exited; the runner sent `SIGTERM` itself and recorded `status: 'timeout'`. Distinct from `status: 'canceled'`, which is a user- or overlap-policy-initiated stop — see [concepts/execution.md](../concepts/execution.md#timeouts). |
| `RUNNER_CALLBACK_FAILED: ...` | `src/daemon/runner.ts` | A user-supplied run callback threw. |
| `SESSION_ID_NOT_FOUND: ...` | `src/daemon/runner.ts` | `reuseSession` capture found no session id in prompt engine output. |
| `SESSION_NOT_FOUND: ...` | `src/daemon/runner.ts` | Claude resume was rejected before spawn because no transcript exists for the session (or the session id is path-unsafe). Thrown as a `CrontickError` internally and recorded on the failed run. |
| `AUTO_DISABLED: job disabled after <n> consecutive failed runs; ...` | `Runner` (`src/daemon/runner.ts`) | Appended to the error of the run that reached `maxConsecutiveFailures` (config, default 3) consecutive `failed`/`timeout` runs (including adopted and restart-reconciled runs); the job was set `enabled: false`. Re-enable with `crontick jobs update <id|alias> --enable` to resume (resets the count). |
| `ACTION_CWD_INVALID: ...` | `src/daemon/runner.ts` | The job's `action.cwd` does not exist or is not a directory; the run fails before spawn. |
| `SESSION_PERSIST_FAILED: ...` | `src/daemon/runner.ts` | Persisting a captured session id back to the job file failed. |

See [error-model.md](../concepts/error-model.md#stored-runserror-values-are-not-crontickerror-codes)
and [storage internals](../implementation/storage.md#orphan-reconciliation).

---

## Surface Presentation

### CLI

- Errors print a single clean line to stderr: `error: [CODE] message` for `CrontickError` values, or `error: message` when no code is available.
- The line is ANSI red when stderr is a TTY and `NO_COLOR` is not set.
- Color is suppressed when `NO_COLOR` is set or stderr is not a TTY.
- Process exits with code `1`.
- No Node stack trace is shown by default.
- `--verbose` adds a `Details:` block when structured details exist, then prints the stack for debugging.
- Commander usage errors (unknown command/option, missing argument) are rendered in the same clean red style.

Known PowerShell limitation: when `$PSNativeCommandUseErrorActionPreference` is enabled, any native command that exits non-zero can surface a shell-level `NativeCommandExitException` that references the npm shim's `.ps1` line. This is a PowerShell artifact of native commands exiting non-zero and cannot be suppressed from inside Node. crontick's own error remains the clean line described above.

### MCP

- Returned as tool result with `isError: true`.
- Payload: `{ "error": "<redacted message>" }` (or with `diagnostics` when verbose).
- `redactForLlm()` replaces loopback addresses with `<daemon-addr>` and filesystem paths with `<path>`.

### Library

- Throws `CrontickError` instances directly.
- Callers use `instanceof CrontickError` and inspect `.code` for programmatic handling.
- `.toJSON()` provides a serializable representation.
