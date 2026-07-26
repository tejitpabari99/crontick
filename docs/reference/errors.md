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
| **When** | `--env-file` path does not exist or cannot be read |
| **Message shape** | Includes file path |
| **Details** | — |

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
