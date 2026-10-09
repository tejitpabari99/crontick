# Error Model

Audience: users and contributors reasoning about how failures surface. Non-duplication: for the
exhaustive code-by-code reference see [reference/errors.md](../reference/errors.md) -- this page
only covers the shared shape and per-surface presentation.

After reading this page you will understand how crontick classifies failures, how the same underlying error is presented differently by each surface, and where failures are recorded.

## CrontickError

All domain errors are instances of `CrontickError` (defined in `src/errors.ts`), which extends `Error` with structured fields:

```typescript
class CrontickError extends Error {
  code: string;       // Machine-readable error code
  message: string;    // Human-readable description
  details?: unknown;  // Additional context (paths, actions, pids)
}
```

The `toJSON()` method returns `{ code, message, details }` for serialization.

## Error codes

Errors are grouped by origin: daemon connectivity (`DAEMON_NOT_RUNNING`,
`DAEMON_REQUEST_FAILED`, `DAEMON_START_FAILED`, `DAEMON_TIMEOUT`, ...), validation
(`VALIDATION_ERROR`, `PARSE_ERROR`), not-found (`NOT_FOUND`), configuration
(`CONFIG_EXISTS`, `CONFIG_READ_ERROR`, `CONFIG_ENGINE_NOT_FOUND`, ...), and runtime/build
(`ENV_FILE_ERROR`, `API_ERROR`, `FORBIDDEN`, `NOT_BUILT`, `INTERNAL_ERROR`). See
[reference/errors.md](../reference/errors.md) for the exhaustive, per-code table (when each is
thrown, message shape, and `details`).

## Error presentation by surface

The same `CrontickError` is rendered differently depending on the consumer:

### CLI

The CLI's `handleError` function prints one clean `error: [CODE] message` line to stderr and exits with code 1. `--verbose` adds details and stack output for debugging.

### MCP server

The MCP layer wraps errors in the standard MCP result format:

```json
{ "content": [{ "type": "text", "text": "{\"error\": \"...\"}" }], "isError": true }
```

Before returning, `redactForLlm()` strips loopback addresses (`127.0.0.1:<port>` becomes `<daemon-addr>`) and filesystem paths (both Windows and POSIX) to avoid leaking machine-specific details to the LLM.

When `verbose: true` is passed, the result additionally includes a `diagnostics` array of internal log events.

### Library API

`CrontickClient` methods throw `CrontickError` directly. Callers receive the full structured error with code, message, and details for programmatic handling.

## Daemon HTTP API errors

The daemon API responds with appropriate HTTP status codes and a JSON body:

```json
{ "error": { "code": "NOT_FOUND", "message": "Job foo not found" } }
```

The client interprets non-2xx responses and constructs a `CrontickError` with code `DAEMON_REQUEST_FAILED` (or the code from the response body when available).

## Retryable vs fatal

| Retryable | Fatal |
|-----------|-------|
| `DAEMON_NOT_RUNNING` (daemon will be demand-started) | `NOT_BUILT` (requires manual build) |
| `DAEMON_TIMEOUT` (transient startup race) | `VALIDATION_ERROR` (bad input) |
| `DAEMON_START_LOCK_TIMEOUT` (another start in progress) | `CONFIG_KEY_ERROR` (bad config key path) |
| `DAEMON_REQUEST_FAILED` (transient network) | `FORBIDDEN` (non-loopback access) |

The client's `ensureDaemon` logic already handles the retryable daemon errors internally (probe, lock, retry loop). Consumers generally only see fatal errors or daemon errors that exhausted the retry window.

## Where failures are recorded

| Location | What is recorded |
|----------|-----------------|
| SQLite `runs.error` column | Run-level failure message (exit info, timeout, overlap skip) |
| SQLite `run_outputs` table | Parsed engine output, including the full stderr of the child process |
| `logs/<job-id>.log` | crontick-side events of the job's runs (one line per event, tagged with the run id) |
| `logs/daemon-YYYY-MM-DD.log` | Daemon-level errors (startup, scheduler, unhandled) |
| `logs/daemon.ensure.log` | Demand-start failure output |

### Stored `runs.error` values are not `CrontickError` codes

The `runs.error` column stores free-text failure descriptions, not thrown
`CrontickError` instances — nothing constructs a `CrontickError` for a failed
run; the runner writes a string directly into SQLite. Several of those
strings follow a `CODE: message` convention that looks like an error code but
is a distinct, smaller vocabulary scoped to run outcomes:

| Stored value prefix | Meaning |
|----------------------|---------|
| `DAEMON_RESTART: ...` | `Store.reconcileOrphanRuns()` canceled a run that was `running`/`queued` when the daemon last stopped, exported as `ORPHAN_RUN_ERROR_CODE`/`ORPHAN_RUN_ERROR_MESSAGE` from `src/errors.ts` (and the package root) |
| `RUNNER_CALLBACK_FAILED: ...` | A user-supplied run callback threw |
| `SESSION_NOT_FOUND: ...` | Claude resume preflight found no completed run or no transcript for the session id; the run fails without spawning a process |
| `SESSION_ID_NOT_FOUND: ...` | `reuseSession` capture could not find a session id in prompt engine output |
| `SESSION_PERSIST_FAILED: ...` | Persisting a captured session id back to the job file failed |

These prefixes are conventions for readability, not a closed enum validated
anywhere, and they are unrelated to the `CrontickError` `code` table above —
do not confuse a `runs.error` value like `DAEMON_RESTART: ...` with a thrown
error code. See [storage internals](../implementation/storage.md#orphan-reconciliation)
and [errors reference](../reference/errors.md).

## Actionable error messages

Every `CrontickError` in the daemon startup path includes a `details.action` string suggesting the next command to run. For example:

```
DAEMON_START_FAILED: Failed to start daemon ... Run: npm run build
```

This convention ensures that even when errors propagate through multiple layers, the user receives a concrete remediation step.

## Further reading

- [Surface parity](./surface-parity.md) - how errors are adapted per surface
- [Daemon lifecycle](./daemon-lifecycle.md) - startup error flow
- [Errors reference](../reference/errors.md) - exhaustive code table
