---
status: draft
summary: SP03 - `crontick config list|get|set|unset` (client/CLI/MCP, file-direct so it works with the daemon down) plus `GET/PATCH /api/config` and a dashboard Settings modal; `daemon.port` editable only by config-file edit with no daemon running (dashboard read-only); in-flight-run choice (stop vs wait) on config save; owns the daemon `pause`/`resume` state; secrets redacted on read with a restore-on-write rule; locked + revisioned writes; auto reload after save.
date: 2026-10-07
---

# PRD: Config surfaces + Settings UI

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: SP02 (`daemon` config section, rem scale) · Owns: `src/config.ts` (write path, key guard, lock, revision, unredact), `src/schemas/config.ts` (no new keys; reuse `PersistedConfigSchema`), `src/constants/config.ts` (new: notice text, sentinel), `src/client.ts` (config block ~552-598), `src/surface.ts`, `src/cli/index.ts` (`config` group), `src/mcp/index.ts` (4 tools), `src/daemon/api.ts` (`/api/config` routes, guard wiring), `src/daemon/request-guard.ts` (new), `src/index.ts` (exports), `src/dashboard/{index.html,dashboard.js,dashboard.css}` (gear + Settings modal), `tests/unit/{config,surface-drift}.test.ts` + new config-surface/api/dashboard tests, `docs/reference/{configuration,cli,mcp-tools,library-api}.md`, `docs/specs/` (config spec), changeset.

## TL;DR

Four capabilities (`config list|get|set|unset`) across client, CLI, MCP, `SURFACE_CAPABILITIES`; dashboard gets a gear-opened Settings modal over `GET`/`PATCH /api/config`. CLI/MCP/library write `config.json` **directly** (works with the daemon down, never demand-starts it), then best-effort reload a running daemon. The API route does the same write inside the daemon. One shared core in `src/config.ts` gives all surfaces identical validation, the `daemon.*` read-only guard, locking, and secret handling. Every successful write returns the same notice: running runs are unaffected; defaults apply to new jobs only; engine changes apply on the next run.

## Problem

| Fact | Evidence |
|---|---|
| Config mutation exists only as library methods; no CLI/MCP/API | [verified: client.ts:559-598; `grep config src/cli/index.ts` → only `info` line; `NON_PARITY_CLIENT_METHODS` lacks them but they are not in SURFACE_CAPABILITIES, covered by test exemption list] |
| Error messages tell users to run `crontick config init --force`, a command that does not exist | [verified: config.ts:370,385; `grep "config init" src` → config.ts + schemas only] |
| Writes: tmp `<path>.<pid>.tmp` mode 0600, rename; no lock, no read-merge-write protection, mode always reset to 0600 | [verified: config.ts:390-397] |
| Write base is the raw persisted file (not merged defaults), so `unset` really removes keys | [verified: config.ts:408-414] |
| Both schemas `.strict()`; one unknown key makes `loadConfig` throw, so reload fails and keeps old schedule | [verified: schemas/config.ts; index.ts:309-326 comment] |
| `redactValue` redacts sensitive-named keys AND pattern-matches inside every string (e.g. an arg `--api-key=x`), so round-tripping redacted output corrupts data | [verified: logger.ts:743-761; config.ts:89] |
| Engine command resolved per run; a missing engine fails that run with `CONFIG_ENGINE_NOT_FOUND` | [verified: config.ts:281-296] |
| Reload re-reads config (retention cap, log prune, jobs) but never rebinds the port | [verified: index.ts:318-342] |
| Dashboard already uses `.modal-backdrop`/`.drawer-backdrop` and native `window.confirm` | [verified: index.html:128-150; dashboard.js:378,383] |

## Goals / Non-Goals

**Goals:** edit any config key from CLI, MCP, API, dashboard; atomic, validated, nothing written on error; `daemon.port` visible but immutable; auto reload; consistent notice; no secret leakage on read.
**Non-Goals:** `config init/validate/path` CLI commands; per-key hot-apply; auth tokens (global); comment-preserving file edits; apply-defaults-to-existing-jobs; dashboard job editor (SP04).

## Requirements

| # | Requirement |
|---|---|
| R1 | Client: `configList()`, `configGet(key)`, `configSet(key, value)`, `configUnset(key)`. `set`/`unset` return `{ config (redacted effective), changed: string[], reload: 'reloaded'\|'daemon-not-running'\|'failed', notice, warnings }`. |
| R2 | CLI: `config list [--json]` (effective values; flat `key = value` lines, keys absent from the file tagged `(default)`), `config get <key>`, `config set <key> <value> [--string]`, `config unset <key>`. Dotted keys per `ConfigKeySchema` (`defaults.timeoutSec`, `engines.claude.command`). |
| R3 | Value parsing (CLI only): `JSON.parse(value)`, falling back to the raw string; `--string` forces a string (e.g. command `123`). Arrays/objects are JSON: `config set engines.x.args '["-p","--verbose"]'`. MCP/API take typed JSON, no parsing. Keys containing `.` inside a map (env var `A.B`) cannot be addressed by dotted path; set the parent `env` object instead. |
| R4 | Engines: add/replace = `set engines.<name> '{"command":"...","type":"raw"}'` (validated by `PersistedEngineConfigSchema`); remove = `unset engines.<name>`. Post-write effective-config validation blocks removing the engine named by `defaultEngine` (existing `superRefine`) and the last engine. Removing a stored copy of built-in `claude` just reverts it to the built-in. Engines referenced by jobs: warn only when a daemon is up (see D5). |
| R5 | `daemon.*` guard in core [amended by owner decision, see R16]: `daemon.port` is editable only by direct config-file edit (CLI/MCP/library `config set`) while NO daemon process is running; if a daemon is up, any `set`/`unset` whose path is `daemon` or under it (and any PATCH op, or any value object, touching `daemon`) throws `CONFIG_KEY_READ_ONLY`: `daemon.port can only be changed while the daemon is stopped: run "crontick daemon stop" first`. The API route (`PATCH /api/config`) and dashboard always treat it as read-only (the dashboard is down whenever port is editable). Reads show it. |
| R6 | Atomicity: all ops validated against the effective schema on a clone first; the file is written only on success (tmp + rename). Invalid or unparsable-existing file: error names key + file, nothing written; `set`/`unset` refuse on an already-invalid file (hand-fix). |
| R7 | Concurrency: write path = lock (`config.json.lock`, exclusive create, retry ≤2 s, break if older than 10 s) → re-read → apply → write → unlock. `GET /api/config` returns `revision` (sha256 of file bytes, or `absent`); `PATCH` may send `ifRevision`; mismatch → 409 `CONFIG_CONFLICT`. |
| R8 | File mode: new file 0600; existing file keeps its current mode (stat before write, apply to tmp). No-op on Windows. |
| R9 | Reload: after a successful write, library/CLI/MCP probe the port file (no demand-start); if a daemon is up, `POST /api/daemon/reload`. Reload failure never fails the save: result `reload:'failed'` + warning "saved; run `crontick daemon reload`". API route calls `ctx.reload()` in-process. |
| R10 | Notice constant `CONFIG_EDIT_NOTICE` (in `src/constants/config.ts`): "Saved. Running runs are not affected. Default changes apply to new jobs only. Engine changes apply on the next run. `daemon.port` needs a restart." Returned by every write on every surface; CLI prints it on stderr, dashboard shows it as a toast + persistent line in the modal. |
| R11 | Secrets: all reads (CLI, MCP, API, UI) use `redactConfigForRead`. Writes run `unredact(submitted, stored)`: a submitted leaf equal to `redacted(stored leaf)` at the same path/array index is replaced by the stored value; any other string containing the redaction marker → `CONFIG_REDACTED_VALUE` error. Typing a real value into a redacted field replaces it. |
| R12 | API: `GET /api/config` → `{ path, revision, config (effective, redacted), stored (raw keys present, redacted), readOnly: ['daemon'], notice }`. `PATCH /api/config` body `{ ops: [{op:'set'\|'unset', key, value?}], ifRevision? }` → one locked write, same result shape as R1. No whole-object PUT. |
| R13 | Parity: 4 new `SURFACE_CAPABILITIES` rows (`config-list/get/set/unset` → `configList/Get/Set/Unset`, `['config','list'…]`, `crontick_config_list/get/set/unset`). Remove superseded client methods (`getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine`); keep `getConfig`, `configPath` as non-parity. Also remove the superseded exports from `src/index.ts` (no back-compat); update `docs/reference/library-api.md` and examples accordingly. Fix stale "config init --force" messages to hand-edit guidance. |
| R14 | Dashboard Settings: see Architecture. |
| R15 | API request guard (`src/daemon/request-guard.ts`, applied to ALL mutating routes: POST/PUT/PATCH/DELETE under `/api`): `Host` must be `127.0.0.1`/`localhost`/`[::1]` (with the daemon port); `Content-Type: application/json` (strict: required on every mutating request, bodyless ones like `DELETE /api/jobs/:id`, `POST .../run-now`, `/enable` included); `Origin`, if present, must equal the daemon origin; else 4xx `REQUEST_REJECTED`, nothing executed. No tokens. Client/CLI/MCP/dashboard fetches always send the JSON header. SP04/05/06 rely on it and add no guard of their own. |
| R16 | In-flight-run choice (owner decision "apply edits while runs are in flight"). (1) Confirmation happens at Save, never at Edit: an open edit form stops/pauses nothing. (2) Main-config save with in-flight runs: user picks (a) stop all in-flight runs, then apply (daemon cancels them and applies in one request), or (b) pause the daemon, wait for all in-flight runs to complete, apply, then resume automatically; or cancels the save. Stopped runs: status `canceled`, no retry, no `--after` dependents triggered; queued runs dropped. (3) Non-interactive: CLI prompts when stdin is a TTY, else flags `--stop-running` / `--wait-running`; MCP and library take `inFlight: 'stop' \| 'wait'`; in-flight runs and no choice given = error listing the in-flight runs. (4) `pause` vs `stop` are distinct: `pause` = daemon process stays up (HTTP API + dashboard reachable) but the scheduler starts no new runs; `resume` undoes it; `stop` = process exits (unchanged). Paused is an explicit state shown in daemon status and the dashboard. |
| R17 | SP03 owns the pause state. `pause`/`resume` as a capability MUST follow surface parity: client methods, CLI, MCP tools, `SURFACE_CAPABILITIES` entries (and the `surface-drift` test). SP04 references it for the per-job variant of R16. |

## Architecture

```
CLI / MCP / library ──► client.configSet ──► config.ts applyOps() ──► config.json
                              └─ if daemon up: POST /api/daemon/reload
Dashboard ──PATCH /api/config──► api.ts ──► config.ts applyOps() ──► config.json ──► ctx.reload()
```

`applyOps(ops, {env, ifRevision})` in `src/config.ts` is the only mutator (lock → read raw → guard `daemon` → unredact → apply on clone → `parseConfig` → write → revision). `set`/`unset` are one-op calls; PATCH is N ops in one write. Shims only parse input and print. `src/utils/` gets `parseConfigValue(text, {string})` (pure) for the CLI.

**Direct vs daemon-backed.** Config is a local file, not daemon state, and the daemon reads it from disk anyway. File-direct means `config set` is usable to fix a broken setup (including a daemon that fails to start) and never spawns a daemon as a side effect, unlike other client commands that demand-start. The dashboard needs the API because the browser cannot touch the file.

**Settings modal** (reuses `.modal-backdrop`, rem scale from SP02; no px sizes).
- Gear icon button at far right of header (after theme toggle) opens it. A modal, not a drawer: form is long, needs focus-trap and a sticky footer; drawer already means "job details".
- Read-only on open (inputs `disabled`). Top-right of modal body: **Edit** (hidden once editing). Footer: **Save** (disabled unless editing) and **Cancel** (always enabled).
- Sections: General (`defaultEngine` select fed by engine names, `maxConsecutiveFailures`), Job defaults (`overlap` select, `timeoutSec` optional, `retry.max`, `retry.backoffSec`), Retention (3 numbers), Logging (`fileEnabled` checkbox, `dir`), Engines, Daemon (`port` shown read-only with "stop the daemon, then `crontick config set daemon.port <n>` or hand-edit config.json" - never enabled in the dashboard).
- Engines: one card per engine: name (fixed), `command`, `type` select, `args` as an ordered row list (add/remove), `env` as key/value rows (add/remove). "Add engine" appends an empty card with an editable name; "Remove" per card, disabled on the current `defaultEngine`. Optional fields left blank = unset (placeholder shows effective default).
- Save computes a diff of form vs the loaded effective config and sends only changed leaves as `ops` (engine add/remove = whole-object `set`/`unset`), plus `ifRevision`. So untouched defaults are never baked into the file. Zero diff: no request, just leaves edit mode.
- Errors: server `message` + `details.key` shown in a banner at the top of the modal, field outlined when the key maps to an input; modal stays in edit mode, nothing lost. 409: banner "Config changed on disk" with **Reload form** (discards edits).
- Cancel / backdrop click / Esc / ✕ when dirty → `window.confirm('Discard unsaved changes? Changes will be lost.')`; clean → leaves edit mode (if already read-only, closes).
- After success: toast with R10 notice, form refreshed from the response, back to read-only.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| D1 | CLI/client write path | File-direct, then best-effort reload | Always via daemon API (demand-start) | Works when daemon is down/broken; no spawn side effect; same file either way |
| D2 | API shape | `GET` + `PATCH` op batch | Whole-object `PUT`; per-key PUT | Diff-ops keep file sparse, reuse CLI semantics, atomic multi-key save; whole-object round-trips redacted secrets and bakes defaults |
| D3 | Engine add/remove | `set engines.<name> <json>` / `unset engines.<name>` | Keep `add/remove-engine` commands | One mechanism, no extra surface rows; schema `superRefine` already guards default/last engine |
| D4 | Value parsing | JSON-then-string, `--string` escape hatch | Schema-typed coercion; always string | Simple, predictable, scriptable; arrays/objects need JSON anyway |
| D5 | Engine used by jobs on removal | Warn, don't block: on engine removal via any surface, if a daemon is up, `GET /api/jobs` and add a warning listing job ids/aliases using that engine (save still succeeds); daemon down: no scan, keep generic `CONFIG_ENGINE_NOT_FOUND` notice | Block via daemon job scan; no check | Direct path has no store access, so scan only when daemon is up; failure stays loud per run and fixable by re-adding. See OPEN-3 |
| D6 | Concurrent writers | Lock file + `ifRevision` for UI | Last write wins; revision only | CLI RMW and a long-open dashboard form can interleave; lock covers ms-scale RMW, revision covers minutes-scale edit sessions |
| D7 | Secrets | Redact on every read; restore-on-write via `unredact`; reject stray marker | Return plaintext to the local UI; make env read-only | Brief wants all keys editable; plaintext in MCP output reaches LLM context; sentinel restore needs no reveal endpoint |
| D8 | Save enablement | Enabled whenever in edit mode (owner spec); clean save is a no-op | Disable unless dirty | Matches owner request; avoids a confusing dead button |
| D9 | Confirm dialog | Native `window.confirm` | Custom dialog | Existing pattern in dashboard.js:378,383; zero new UI |
| D10 | Modal vs drawer | Modal | Drawer | Long form + sticky footer; drawer is job details |
| D11 | Superseded client methods | Delete engine CRUD + old get/set/remove names | Keep as non-parity | Brief: no back-compat; two write paths drift |
| D12 | Unknown keys in file | Rejected (strict), unchanged | Preserve unknown keys | A typo must fail loudly; nothing can be "preserved" because load already throws. Settings shows the error and read-only raw path |

## Risks / Open Questions

- [RESOLVED: guard moved into SP03, applies to ALL mutating routes; pending owner review] **Security ordering (high).** `PATCH /api/config` can set `engines.<name>.command`, which the daemon spawns: a DNS-rebinding or cross-site page could achieve code execution. Brief item 10 (Host/Content-Type/Origin hardening) moved here from SP04 (small `src/daemon/request-guard.ts`); it covers every mutating `/api` route, not only `/api/config`. See R15.
- [RESOLVED-8: strict; all mutating requests need Host+Origin+`Content-Type: application/json`, bodyless included; client/CLI/MCP/dashboard always send the header] Bodyless mutating requests (`DELETE /api/jobs/:id`, `POST .../run-now`, `/enable`): require `Content-Type: application/json` too (client/CLI must always send it) or only Host+Origin for those? Leaning: require all three, client always sends the header.
- [RESOLVED-2: remove superseded exports from `src/index.ts` (no back-compat, no users); update `docs/reference/library-api.md` + examples as part of SP03 scope] Public exports in `src/index.ts` (lines ~54-67: `addEngine`, `removeEngine`, `setConfigValue`, ...) — remove or keep as low-level helpers? Leaning remove those superseded by `applyOps`; confirm no examples/tests depend (`typecheck:examples`).
- [RESOLVED-3: WARN (not block, not defer); on engine removal, if daemon up, fetch `GET /api/jobs` and warn with job ids/aliases using it; save succeeds; daemon down: no scan, generic notice] Warn (not block) on removing an engine that jobs use when a daemon is up? Leaning DEFERRED; cheap later via `GET /api/jobs`.
- [RESOLVED-4: wording fix only (hand-edit guidance), no `config reset`] `readJsonFile` error text mentions `config init --force`; no such command. Replace with hand-edit guidance (R13) vs add a `config reset`. Leaning wording fix only.
- [RESOLVED-5: add retry-on-EPERM in the write; owner runs Windows manual test after implementation] Lock behavior on network/odd filesystems and on Windows rename-over-open-file (`EPERM`) untested; need retry-on-EPERM in write. Windows manual test.
- [RESOLVED-6: accepted, no `--reveal`] `redactValue` also scrubs patterns inside non-secret strings (args), so display of such an arg shows `[REDACTED]` and cannot be inspected in UI/CLI; edit-by-restore still works. Accepted unless owner wants a `--reveal` flag (not planned).
- [RESOLVED-7: confirm via integration spot-check test] Reload re-applies jobs from store; confirm a reload while runs are active does not disturb them (existing `daemon reload` behavior, assumed) - spot-check in integration test.
- [RESOLVED: daemon down] file-direct, no demand-start.
- [RESOLVED: file mode] stat-and-reuse; default 0600.
- [RESOLVED: unknown keys] strict rejection kept.
- [RESOLVED: owner decision, in-flight edits] Stop vs wait at Save, daemon pause state, port editable only with no daemon running (replaces "read-only everywhere"). See R5, R16, R17.
- [OPEN-9] Should `daemon pause` / `daemon resume` also be user-facing commands (CLI/MCP/dashboard button), or internal-only to the edit flow? Rec: user-facing, cheap once the state exists.
- [OPEN-10] Fires that come due while paused: skip, or run once on resume? Rec: skip, recorded like overlap-skip `skipped`.
- [OPEN-11] Does paused state persist across a daemon restart? Rec: no; restart comes up unpaused, and a pending wait-then-apply is lost/reported.
- [OPEN-12] Timeout for "wait for runs to complete"? Rec: none by default; user can switch to stop.
- [DEFERRED] Config change history/undo; env-var-named keys with dots in dotted paths.

## Acceptance Criteria

- `crontick config set defaults.timeoutSec 600` writes `{"defaults":{"timeoutSec":600}}` only (no baked defaults); `unset` removes it; invalid (`retention.maxRunsPerJob 0`, unknown key, bad type) exits non-zero, file byte-identical.
- `set engines.x '{"command":"echo","type":"raw"}'` adds; `unset engines.x` removes; `unset engines.<defaultEngine>` and `set defaultEngine nope` rejected.
- `set/unset daemon.port` (and `daemon`, and PATCH op on it) → `CONFIG_KEY_READ_ONLY` on API always, and on CLI/MCP/library while a daemon is running (allowed when none is); `config get daemon.port` works.
- With daemon stopped: `config set` succeeds, reports `daemon-not-running`, and does not start a daemon. With daemon running: reports `reloaded`; changing `retention.maxRunsPerJob` takes effect without restart.
- Two concurrent `config set` processes on different keys both persist; a PATCH with stale `ifRevision` → 409, file unchanged.
- Existing file with mode 0640 keeps 0640 after set; new file is 0600 (POSIX).
- `config list`/`get`/API/MCP never emit an `env` secret value; PATCH echoing a redacted value keeps the stored secret; a literal marker for a changed key is rejected.
- Every write response carries the R10 notice on all four surfaces.
- Guard (R15): every mutating route (`/api/config`, `/api/jobs*`, `/api/runs` delete, `/api/daemon/*`, schedules) rejects a wrong `Host` (e.g. `evil.com`, rebinding), non-JSON `Content-Type`, and mismatching `Origin`; accepts loopback Host with port, JSON, and absent or matching Origin; a test enumerates all mutating routes so a new one without the guard fails; existing client/CLI/MCP tests still pass.
- `surface-drift.test.ts` green with 4 new rows and removed exemptions; `docs/reference/{configuration,cli,mcp-tools,library-api}.md`, spec, changeset updated; `npm run validate` green.
- Dashboard (verified via dashboard test + screenshot): gear opens modal read-only; Edit enables inputs; Save disabled until Edit; Cancel always enabled; dirty Cancel prompts "changes will be lost"; `daemon.port` never editable; engine add/remove and args/env rows work; validation error shows in banner with edits intact; sizes use rem only.
