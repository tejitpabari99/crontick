---
"crontick": patch
---

Review fixes and hardening:

- Captured-session-id lifecycle events are now written to the `crontick` log stream (retrievable via `getLogs(runId, 'crontick')`) instead of the engine stdout stream, matching every other lifecycle event.
- `getLogs` `source` validation now lives solely in the core `CrontickClient` (throws `VALIDATION_ERROR` for values outside `all`/`engine`/`crontick`); the duplicate CLI-shim guard was removed. `LOG_SOURCES` and `LogSource` are now exported from the public API.
- Bulk delete (`jobs delete all --force`) is now atomic: a new internal daemon `DELETE /api/jobs` route deletes every job together with its runs, logs, and schedule state in a single store transaction via `Store.deleteAllJobs()`, instead of looping per-job HTTP requests.
- `GET /api/runs` `limit`/`since` are validated as positive integers, returning a clean `VALIDATION_ERROR` instead of a 500 for `NaN`/negative/`Infinity`; `queryRuns` binds `LIMIT` as a parameter.
- MCP `redactForLlm` now also redacts single-segment POSIX absolute paths (e.g. `/tmp`) and IPv6 loopback forms (`::1`, `[::1]:port`), and applies redaction to `ENV_FILE_ERROR` messages.
- Domain validation (`--enable`/`--disable` mutual exclusion, `jobs delete all` force requirement) moved out of the CLI shim into the core, keeping shims logic-free.
