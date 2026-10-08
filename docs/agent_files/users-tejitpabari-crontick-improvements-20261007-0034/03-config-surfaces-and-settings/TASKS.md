---
status: draft
summary: Nine tasks - API request guard, locked config write core, daemon pause/resume, in-flight stop/wait, client config methods, /api/config, CLI+MCP+surface, dashboard Settings modal, tests/docs/changeset.
date: 2026-10-08
---
# Tasks: SP03 Config surfaces + Settings UI
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/03-config-surfaces-and-settings/PRD.md. All PRD Risks are [RESOLVED] or [DEFERRED]; no [OPEN] items. Depends on SP01 (CLI polish) and SP02 (`daemon.port` config section, rem scale) landing first. SP04 relies on the request guard (Task 1) and the Settings modal pattern (Task 8). No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | API request guard on all mutating routes | - | todo |
| 2 | Config write core: `applyOps`, lock, revision, secrets, daemon guard | - | todo |
| 3 | Daemon pause/resume state and surfaces | - | todo |
| 4 | In-flight run choice (stop vs wait) on config save | 2, 3 | todo |
| 5 | Client config methods, reload, engine warning, old API removal | 1, 2, 4 | todo |
| 6 | `GET/PATCH /api/config` routes | 1, 2, 4 | todo |
| 7 | CLI `config` group, MCP tools, surface entries | 3, 5 | todo |
| 8 | Dashboard Settings modal and paused state | 3, 6 | todo |
| 9 | Tests, docs, reference, spec, changeset | 1-8 | todo |

## Task 1 — API request guard on all mutating routes
What it is / what it means: Config PATCH can set an engine command the daemon spawns, so DNS-rebinding or cross-site requests must be blocked on every mutating route (R15, Risks resolved items 1 and 8).
What changes at a high level: Add a request-guard module applied to all POST/PUT/PATCH/DELETE routes under `/api`: loopback Host (with daemon port), strict `Content-Type: application/json` even on bodyless requests, and Origin, if present, equal to the daemon origin; otherwise a `REQUEST_REJECTED` 4xx with nothing executed. Make client, CLI, MCP and dashboard fetches always send the JSON header. No tokens.
Done when: A test enumerates every mutating route so an unguarded new one fails; wrong Host, non-JSON type and mismatching Origin are rejected; loopback Host, JSON and absent/matching Origin pass; existing client/CLI/MCP tests still pass.

## Task 2 — Config write core: `applyOps`, lock, revision, secrets, daemon guard
What it is / what it means: One shared mutator gives every surface identical validation, locking and secret handling (R5, R6, R7, R8, R10, R11, D2, D6, D7, D12, Risks 4, 5).
What changes at a high level: In the config module add the single `applyOps` path: lock file (retry, stale break), re-read raw, daemon-key guard (`CONFIG_KEY_READ_ONLY` only while a daemon is up), unredact submitted values (stray marker gives `CONFIG_REDACTED_VALUE`), apply to a clone, validate effective config, write tmp+rename, return a sha256 revision with `ifRevision` conflict check. Preserve existing file mode (0600 for new), retry on EPERM, refuse on an already-invalid file, add a read-side redaction helper. Add the notice and sentinel constants and a pure CLI value-parsing util. Replace stale "config init --force" messages with hand-edit guidance.
Done when: Unit tests cover sparse writes, atomic failure (file byte-identical), unredact restore and rejection, concurrent writers, stale revision, file mode, and the daemon guard with and without a daemon.

## Task 3 — Daemon pause/resume state and surfaces
What it is / what it means: SP03 owns a distinct `pause` state: process and dashboard stay up, scheduler starts no new runs (R16 item 4, R17, Risks 9, 10, 11).
What changes at a high level: Add an in-memory paused flag to the scheduler/daemon; fires due while paused are not run and are recorded `skipped`; restart comes up unpaused. Add daemon API pause/resume routes (guarded), paused indicator in daemon status, client methods, `daemon pause`/`daemon resume` CLI commands, MCP tools, and `SURFACE_CAPABILITIES` entries. `stop` is unchanged.
Done when: Paused daemon runs nothing and records skipped fires; resume restores scheduling; status shows paused; surface-drift test is green for the new entries.

## Task 4 — In-flight run choice (stop vs wait) on config save
What it is / what it means: Saving main config while runs are in flight needs an explicit choice, applied in the daemon (R16 items 1-3, Risks 11, 12).
What changes at a high level: Add a daemon-side apply-with-policy flow: `stop` cancels all in-flight runs (status `canceled`, no retry, no `--after` dependents, queued runs dropped) then applies in one request; `wait` pauses, waits with no timeout for runs to finish, applies, then resumes automatically. No choice with runs in flight returns an error listing them. A pending wait lost on restart is reported. Editing alone never stops or pauses anything.
Done when: Integration tests cover stop, wait (with auto-resume), no-choice error, canceled-run semantics, and a reload during active runs not disturbing them.

## Task 5 — Client config methods, reload, engine warning, old API removal
What it is / what it means: The library surface for config, file-direct so it works with the daemon down (R1, R9, R13, R4, D1, D3, D5, D11, Risk 2).
What changes at a high level: Add `configList/Get/Set/Unset` over `applyOps`, returning redacted config, changed keys, reload outcome, notice and warnings; accept the `inFlight` option and route in-flight handling through the daemon when one is up. Probe the port file without demand-start and best-effort reload; reload failure yields `failed` plus a warning, never a failed save. On engine removal with a daemon up, scan jobs and warn with ids/aliases. Delete superseded client methods and their `src/index.ts` exports; keep `getConfig` and `configPath`; update examples.
Done when: Writes work and report `daemon-not-running` without spawning a daemon; `reloaded` with one; engine removal warns; examples type-check against source and dist.

## Task 6 — `GET/PATCH /api/config` routes
What it is / what it means: Browser-facing config API that does the same write inside the daemon (R12, D2, D6).
What changes at a high level: `GET` returns path, revision, redacted effective config, redacted stored keys, `readOnly: ['daemon']` and notice. `PATCH` takes an op batch plus optional `ifRevision` and `inFlight` choice, performs one locked write, then reloads in-process; `daemon` ops always rejected as read-only here; stale revision gives 409 `CONFIG_CONFLICT`. No whole-object PUT.
Done when: API tests cover read shape, multi-op atomic write, 409 conflict, `daemon` rejection, secret round-trip, and guard coverage.

## Task 7 — CLI `config` group, MCP tools, surface entries
What it is / what it means: Thin shims exposing the four capabilities with parity (R2, R3, R13, R16 item 3, D3, D4).
What changes at a high level: Add `config list [--json]` (flat lines, `(default)` tags), `get`, `set [--string]` with JSON-then-string parsing, and `unset`; set/unset accept `--stop-running`/`--wait-running`, prompt when stdin is a TTY, and print the notice on stderr. Add four MCP tools taking typed JSON and `inFlight`. Add four `SURFACE_CAPABILITIES` rows and remove superseded test exemptions. Engine add/remove goes through `set`/`unset engines.<name>`.
Done when: Surface-drift test green; CLI and MCP tests cover each command, parsing, flags, prompt vs non-TTY error, and notice output.

## Task 8 — Dashboard Settings modal and paused state
What it is / what it means: Gear-opened Settings modal over the config API, plus pause visibility (R14, R16, D8, D9, D10).
What changes at a high level: Add a header gear button opening a read-only modal reusing the existing backdrop and rem units. Edit enables inputs; Save enabled only while editing; Cancel always enabled. Sections for General, Job defaults, Retention, Logging, Engines (cards, args rows, env rows, add/remove, default engine protected) and read-only Daemon port with stop-daemon guidance. Save sends only changed leaves plus `ifRevision`; zero diff makes no request. Error banner with field outline, 409 "Reload form", native discard confirm, success toast with notice. Save with in-flight runs asks stop/wait/cancel. Show paused state with pause/resume controls.
Done when: Dashboard test and screenshot confirm the acceptance behaviors; `daemon.port` is never editable; no px sizes.

## Task 9 — Tests, docs, reference, spec, changeset
What it is / what it means: Close out per AGENTS.md testing, documentation and release rules.
What changes at a high level: Fill remaining acceptance-criteria test gaps. Update `docs/reference/` (configuration, CLI, MCP tools, library API), add a config spec under `docs/specs/`, document the guard and pause concepts, and add an ADR for file-direct writes and pause vs stop. Add a changeset (minor, pre-1.0) noting removed client methods/exports as breaking. Run `npm run validate`.
Done when: `npm run validate` passes, docs match behavior, changeset exists.

## Manual steps
Owner runs a Windows manual test of the config write (lock and rename-over-open-file EPERM retry) after implementation (Risk 5). Guard wording and design are marked pending owner review in the PRD.
