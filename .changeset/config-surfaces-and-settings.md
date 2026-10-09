---
"crontick": minor
---

Add config editing on every surface: `crontick config list|get|set|unset` (value parsed as JSON else string, `--string`, `--stop-running`/`--wait-running`), four MCP tools `crontick_config_list|get|set|unset`, `GET`/`PATCH /api/config`, and a dashboard Settings modal (gear in the header) plus Pause/Resume controls. Writes go straight to `config.json` (works with the daemon down, never starts it) under a lock with atomic validate-then-rename, mode preservation, secret redaction with restore-on-write, `revision`/`ifRevision` conflict detection (`CONFIG_CONFLICT`), and a running daemon is reloaded afterwards. `daemon.*` is read-only while a daemon runs (`CONFIG_KEY_READ_ONLY`). Saving with runs in flight fails with `RUNS_IN_FLIGHT` unless you choose to stop them or pause and wait. The stale `config init --force` wording is replaced with hand-edit guidance.

BREAKING (HTTP API): every mutating `/api` request (POST/PUT/PATCH/DELETE, including bodyless ones such as `DELETE /api/jobs/:id`) must now send `Content-Type: application/json`, a loopback `Host` with the daemon port, and (if present) a matching `Origin`; otherwise it is rejected with `REQUEST_REJECTED`. Direct callers (curl, scripts) must add the header. The client, CLI, MCP server and dashboard already do.

BREAKING (library): removed the `getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine` client methods and package exports; use `configList`/`configGet`/`configSet`/`configUnset` (`configSet('engines.<name>', {...})` / `configUnset('engines.<name>')` for engines).
