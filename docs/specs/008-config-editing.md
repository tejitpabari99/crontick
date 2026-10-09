# 008: Config Editing

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-10-09

Audience: contributors changing config writes, the config CLI/MCP/API surfaces, the dashboard Settings modal, or daemon pause. Non-duplication: this spec is the normative contract; user-facing behavior is in [reference/configuration.md](../reference/configuration.md#editing-config), [reference/cli.md](../reference/cli.md), [reference/mcp-tools.md](../reference/mcp-tools.md) and [reference/library-api.md](../reference/library-api.md); rationale is [ADR 0004](../decisions/0004-config-writes-file-direct-and-pause.md).

## Summary

`config list|get|set|unset` on the client, CLI and MCP, plus `GET`/`PATCH /api/config` and a dashboard Settings modal, all backed by one write core (`applyOps` in `src/config.ts`). It also defines daemon `pause`/`resume` and the in-flight-run choice on save.

## Motivation

Config could only be changed by hand or via library-only methods, with no locking, no secret handling and stale `config init --force` guidance. Surfaces need identical, safe, atomic edits that also work when the daemon is down.

## Terminology

| Term | Definition |
|------|-----------|
| Effective config | Built-in defaults deep-merged with `config.json` |
| Stored config | The keys actually present in `config.json` |
| Revision | sha256 of the file bytes, or `absent` |
| In-flight run | A run that is executing, queued or adopted |

## Requirements

### Functional requirements

- **R-008-1**: The client MUST expose `configList()`, `configGet(key)`, `configSet(key, value, opts?)`, `configUnset(key, opts?)`; each has a CLI command, an MCP tool and a `SURFACE_CAPABILITIES` row. The superseded `getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine` methods and package exports are removed.
- **R-008-2**: CLI, MCP and library writes MUST go file-direct (no daemon demand-start), then best-effort reload a running daemon; result `reload` is `reloaded`, `daemon-not-running` or `failed`. A reload failure MUST NOT fail the save.
- **R-008-3**: All ops MUST be validated against the full schema on a clone before anything is written; any error leaves the file byte-identical. `set`/`unset` MUST refuse an already-invalid or unparsable file. Only set keys are stored (no baked defaults).
- **R-008-4**: `daemon` and keys under it MUST fail with `CONFIG_KEY_READ_ONLY` while a daemon process runs, and always via `PATCH /api/config`. Reads always work.
- **R-008-5**: Writes MUST take `config.json.lock` (retry up to 2 s, break after 10 s, else `CONFIG_LOCKED`), re-read, apply and rename a temp file; `EPERM`/`EBUSY` on rename is retried. Existing file mode is preserved; a new file is 0600.
- **R-008-6**: `GET /api/config` and `configList` MUST return `revision`; a write with a stale `ifRevision` MUST fail with `CONFIG_CONFLICT` (HTTP 409) and leave the file unchanged.
- **R-008-7**: Every read MUST redact secrets as `[REDACTED]`. A write echoing a redacted value at the same path MUST keep the stored value; any other string containing the marker MUST fail with `CONFIG_REDACTED_VALUE`.
- **R-008-8**: Every successful write MUST return `CONFIG_EDIT_NOTICE` on all surfaces. Removing an engine MUST warn (not block) about jobs using it when a daemon is up.
- **R-008-9**: `GET /api/config` returns `{ path, revision, config, stored, readOnly, notice }`; `PATCH /api/config` takes `{ ops: [{op, key, value?}], ifRevision?, inFlight? }` and applies all ops in one locked write.
- **R-008-10**: `daemon pause`/`resume` (client, CLI, MCP, API, dashboard): pause keeps the daemon up but starts no new runs; fires due while paused are recorded `skipped` and not replayed; state is not persisted across restart.
- **R-008-11**: With runs in flight, a save MUST fail with `RUNS_IN_FLIGHT` (listing them) unless `inFlight` is given. `stop` cancels in-flight runs (`canceled`, no retry, no dependents; queued runs dropped), applies, reloads. `wait` pauses, waits with no timeout, applies, reloads, resumes (a user pause is kept). A wait lost to a daemon restart is reported as `lostPendingConfigApply` in daemon status.
- **R-008-12**: Mutating `/api` routes are protected by the request guard ([spec 004](004-daemon.md#api-request-guard)).

### Non-functional requirements

- **R-008-13**: Shims MUST contain no config logic; CLI value parsing (`parseConfigValue`) is pure and lives in `src/utils/`.

## Behavior

See [reference/configuration.md](../reference/configuration.md#editing-config) for the full write pipeline and [implementation/daemon.md](../implementation/daemon.md) for `applyConfigWithPolicy`.

## Inputs and outputs

Write result: `{ path, config, stored, changed, revision, notice, reload, warnings }`. Errors: `CONFIG_CONFLICT`, `CONFIG_KEY_READ_ONLY`, `CONFIG_REDACTED_VALUE`, `CONFIG_LOCKED`, `RUNS_IN_FLIGHT`, plus the existing config validation codes ([errors.md](../reference/errors.md)).

## Edge cases and failure modes

- Unknown keys in the file are rejected (strict schema); the file must be hand-fixed.
- Env var names containing `.` cannot be addressed by dotted path; set the parent `env` object.
- Secret-looking substrings inside non-secret strings (e.g. an arg) are shown as `[REDACTED]`; editing by restore still works. No `--reveal`.
- Windows lock and rename-over-open-file behavior has not been verified on Windows (manual step, below).

## Acceptance criteria

- [x] `set defaults.timeoutSec 600` writes only that key; `unset` removes it; invalid input leaves the file byte-identical (`tests/unit/config-apply-ops.test.ts`, `tests/unit/cli-config.test.ts`)
- [x] Engine add/remove; removing the default engine rejected (`tests/unit/config-apply-ops.test.ts`)
- [x] `daemon.*` read-only while a daemon runs and always on the API; allowed with none (`tests/unit/config-apply-ops.test.ts`, `tests/unit/api-config.test.ts`)
- [x] Daemon stopped: `daemon-not-running`, no daemon started; running: `reloaded` (`tests/unit/client-config.test.ts`)
- [x] Concurrent writers both persist; stale `ifRevision` gives 409 (`tests/unit/config-apply-ops.test.ts`, `tests/unit/api-config.test.ts`)
- [x] Existing mode preserved, new file 0600 (`tests/unit/config-apply-ops.test.ts`)
- [x] Secrets never emitted on read; redacted echo keeps secret; stray marker rejected (`tests/unit/config-apply-ops.test.ts`, `tests/unit/api-config.test.ts`, `tests/unit/mcp-config.test.ts`)
- [x] Notice on every write on all surfaces (`tests/unit/cli-config.test.ts`, `tests/unit/mcp-config.test.ts`, `tests/unit/api-config.test.ts`)
- [x] Pause, in-flight stop/wait, lost pending apply, reload during runs undisturbed (`tests/unit/daemon-pause.test.ts`, `tests/unit/config-apply-inflight.test.ts`)
- [x] Request guard on every mutating route (`tests/unit/request-guard.test.ts`)
- [x] Surface drift green with the 4 config and 2 pause rows (`tests/unit/surface-drift.test.ts`)
- [x] Dashboard Settings modal and pause controls (`tests/unit/dashboard-settings.test.ts`)
- [ ] Manual: owner runs a Windows test of the config write (lock plus rename-over-open-file `EPERM` retry)

## Out of scope

`config init/validate/path` CLI commands, per-key hot-apply, auth tokens, comment-preserving edits, applying defaults to existing jobs, a dashboard job editor, change history/undo.

## Open questions

- Guard and Settings wording are pending owner review.

## Related

[ADR 0004](../decisions/0004-config-writes-file-direct-and-pause.md), [004 Daemon](004-daemon.md), [005 Surface Parity](005-surface-parity.md).
