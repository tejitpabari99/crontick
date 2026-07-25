# Feature batch design — daemon restart, schemas, sessions, removals

## Goals

- Keep CLI, MCP, and public API as thin adapters over one shared core/client.
- Make daemon demand-start behavior explicit: best-effort start/restart, not supervision.
- Improve user-facing failures with actionable core `CrontickError` messages.
- Keep only one public daemon-start option name: `startDaemon`.
- Always write the per-job JSON Schema sidecar from core persistence.
- Make prompt session-id precedence deterministic and persisted in job JSON.
- Delete speculative log-follow and token-budget surface area.

## Core APIs and ownership

- `CrontickClientOptions.startDaemon?: boolean` is the only public/client option controlling
  on-demand daemon start.
- `CrontickClient.uninstall({ purge })` delegates to core uninstall semantics. With `purge: true`,
  core checks for a live daemon and deletes the data directory; CLI only confirms and renders.
- `ensureDaemon()` owns best-effort demand-start/restart. When no healthy daemon is reachable,
  it starts the daemon once and polls with bounded backoff until healthy or timeout.
- `Store.upsertJob()` owns job JSON and per-job JSON Schema sidecar writes:
  `<dataDir>\jobs\<id>.json` and `<dataDir>\jobs\<id>.schema.json`.
- `Store.tryCapturePromptSession()` owns persisted session updates after a successful first
  reusable prompt run.

## Error shape

- Use `CrontickError(code, message, details)` from core.
- Messages include: attempted operation, underlying cause/path/exit code/stderr excerpt when known,
  and a concrete next step (`crontick daemon start`, log path, permission/path to inspect).
- Shims render errors; they do not construct domain semantics.

## Session-id state shape and precedence

- Prompt actions keep `sessionId?: string` and `reuseSession: boolean`.
- Explicit `sessionId` wins. If `reuseSession` is also supplied, core normalizes to
  `reuseSession: false` and returns/stores a notice explaining the ignored flag.
- `reuseSession` without `sessionId` starts with `reuseSession: true`; first successful run extracts
  the session id, persists `sessionId`, flips `reuseSession` to false, and logs the capture.
- Missing session id capture fails that run with an actionable message recommending explicit
  `--session-id`.

## Deleted surface area

- Remove all daemon-start option synonyms and keep only `startDaemon`.
- Rename CLI/MCP no-start controls to `--no-start-daemon` / `CRONTICK_MCP_START_DAEMON=0` only.
- Remove CLI log-follow docs/tests and any client/core follow-only API if present.
- Remove token-budget fields; keep only `budgets.maxRunsPerDay`.

## Drift tests

- Extend surface drift/removal tests to assert removed option names are absent and `startDaemon` is
  the only public daemon-start name.
- Add schema sidecar coverage for create via client, CLI, and MCP; compare sidecar content.
- Add prompt session precedence tests for explicit id, explicit id plus reuse notice, capture, and
  reuse.
