---
status: draft
summary: SP02 - `daemon.port` config key replaces CRONTICK_DAEMON_PORT (explicit port busy = start fails with DAEMON_PORT_IN_USE), dashboard shrunk ~80% via a rem scale, header trimmed to `v... · pid ...` plus an error badge.
date: 2026-10-07
---

# PRD: Port config + dashboard polish

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: none (Phase 1, parallel with SP01) · Owns: `src/daemon/bind-port.ts`, `src/daemon/index.ts` (listen block only), `src/schemas/config.ts`, `src/config.ts` (BUILT_IN_CONFIG/type only), `src/constants/daemon.ts`, `src/errors.ts` (new code), `src/doctor.ts` + `src/daemon/lifecycle.ts` + `src/daemon/api.ts` (callers of `describeDaemonPort`/`preferredDaemonPort`), `src/dashboard/{dashboard.css,dashboard.js,index.html}` (zoom + header only), `vitest.config.ts`, tests `bind-port`/`daemon-port`/`daemon-port-surfaces`, `docs/reference/configuration.md`, `docs/specs/004-daemon.md`, `docs/implementation/daemon.md`, `docs/troubleshooting.md`.

## TL;DR

Daemon port moves from env `CRONTICK_DAEMON_PORT` to `config.json` `daemon.port`. Unset: 47615 with today's silent-ish random fallback. Set and busy: the daemon exits non-zero with `DAEMON_PORT_IN_USE`, naming the port and occupant. Env var is deleted everywhere. Dashboard shrinks ~80% by converting CSS px to rem against one root font-size variable (so SP03/SP04 inherit the scale). Header drops node version, job count, and uptime badge; the badge stays only as an unreachable-error signal.

## Problem

| Fact | Evidence |
|---|---|
| Port override is env-only; invalid values silently become 47615 | [verified: bind-port.ts:29-35] |
| `daemon` is not a config key; schema is `.strict()` so `daemon.port` in file is rejected today | [verified: ConfigSchema/PersistedConfigSchema `.strict()`, no `daemon`] |
| Test isolation relies on vitest `env: CRONTICK_DAEMON_PORT='0'` for all 58 CRONTICK_HOME-using test files | [verified: vitest.config.ts:48; grep CRONTICK_HOME tests → 58 files] |
| Env var referenced in 4 test files, vitest config, constants comment, 4 docs, spec R-004-1 | [verified: grep CRONTICK_DAEMON_PORT] |
| Dashboard CSS: ~140 px values, body 18px, h1 22px, th/td 16px, no variables for size | [verified: dashboard.css:78-133] |
| Header shows `v.. · pid .. · node .. · N jobs` plus `✓ up Xm` badge; `/health` IS `buildDashboardData(...).health` | [verified: dashboard.js:118-125; api.ts:93-95] |

## Goals / Non-Goals

**Goals:** one source of truth for the port; explicit port honored or fail loudly; env var gone; dashboard ~80% scale; quieter header with a failure signal.
**Non-Goals:** `--port` flag; editing `daemon.port` via CLI/MCP/API/Settings (SP03); live port rebind on config change; dashboard redesign; theme/layout changes beyond scale.

## Requirements

| # | Requirement |
|---|---|
| R1 | Schema: `daemon: { port?: int 0..65535 }` (`.strict()`) in `ConfigSchema` + `PersistedConfigSchema` (+ `PersistedDaemonConfigSchema`). `BUILT_IN_CONFIG.daemon = {}` (port absent = "unset"); NOT in `defaultConfigTemplate`, so `ensureConfigFile` never writes it. Invalid value (e.g. 70000, "abc") fails `loadConfig` with the existing config error (no silent fallback to default). |
| R2 | `preferredDaemonPort(config)` returns `{ port, explicit }`: unset → `{47615, false}`; set → `{n, true}`. Env no longer read. |
| R3 | `bindPort`: unset behaves exactly as today (EADDRINUSE → probe → `notify` → listen 0). Explicit `n>0`: EADDRINUSE → probe → throw `CrontickError('DAEMON_PORT_IN_USE')`, no fallback. Explicit `0`: OS-assigned, never an error, never a "fallback" note. Non-EADDRINUSE listen errors (EACCES) rethrow for both. |
| R4 | Message (probe reused): `Port 5000 (config daemon.port) is in use by another crontick daemon (pid N, data dir D); free it or change daemon.port in <configPath>` / `...by another process (not crontick)...`. Details: `{port, occupant, configPath}`. |
| R5 | Daemon `main()` already logs + `process.exit(1)` on throw [verified: index.ts:411-414]; error text lands on stderr and in `daemon.ensure.log`. `ensureDaemon` surfaces it through the existing `DAEMON_START_FAILED` path (`stderrHint` tail) [verified: ensure.ts startDaemonAndWait]. Need: assert the tail contains the DAEMON_PORT_IN_USE message in a CLI-level test; no new ensure code unless the tail is truncated (STDERR_LIMIT 4096 is ample). |
| R6 | `describeDaemonPort(port, config)`: explicit port → `null` (it bound or daemon is dead); unset and `port !== 47615` → existing fallback note; explicit 0 → `null`. `doctor` "daemon port" check reads config: explicit → `"<port> (config)"`; busy-by-foreign pre-check says "daemon will fail to start". |
| R7 | Remove `CRONTICK_DAEMON_PORT` from src, constants comment, vitest env, 3 test files (rewritten), `configuration.md` (move row to a `daemon.port` section), spec R-004-1 (+ new R-004-1a "explicit port"), `implementation/daemon.md`, `troubleshooting.md`. CHANGELOG history untouched. |
| R8 | Dashboard scale: see Decisions D3. Visual result ≈80% (body 18px→14.4px). |
| R9 | Header: `#version-info` = `v${version} · pid ${pid}`; `#health-badge` hidden on success, shown (`badge-error`, `✗ <message>`) on fetch failure [existing catch at dashboard.js:781-785]; remove `formatUptime` if unused elsewhere [verified: only caller is renderHealth line 121]. |
| R10 | Changeset (minor: public config schema + removed env). Docs: `reference/configuration.md`, spec 004. |

## Architecture

```ts
// bind-port.ts
export interface PreferredPort { port: number; explicit: boolean }
export function preferredDaemonPort(config: CrontickConfig): PreferredPort
export async function bindPort(pref: PreferredPort, deps: BindPortDeps): Promise<BindPortResult>
// daemon/index.ts: reuse `startupConfig` (already loaded at index.ts:167) before listen.
```

- **Test isolation without the env var.** Port resolution is now per-`CRONTICK_HOME`. Tests that spawn a real daemon must not all contend for 47615. Plan: add `tests/helpers/test-home.ts#writeTestConfig(dir, extra?)` writing `{"daemon":{"port":0}}` into `<dir>/config.json`, and call it from the existing spawn helpers/`mkdtemp` sites that start a real daemon (daemon-port.test, daemon-port-surfaces.test, daemon.ensure.test, integration/e2e helpers, `api-harness` unaffected: it calls `createApiServer` on ephemeral port directly). Remove vitest `CRONTICK_DAEMON_PORT`. Explicit-0 is silent, so no probe delay or noisy notices. Fallback if a test forgets: default 47615 + fallback still works (slower by ≤1s probe, noisy), so omission degrades rather than breaks; a lint-ish guard test greps tests that spawn `dist/daemon/index.js`/`ensureDaemon` without the helper (see OPEN-2).
- **Same data dir, port busy by own daemon.** Not an error: `ensureDaemon` probes the port file first and connects [verified: ensure.ts probePortFile before spawn]; the daemon also exits earlier via `checkSingleInstance` (pid file) [verified: index.ts:119-126]. In `bindPort`, if occupant is crontick with same `dataDir` (stale pid file, e.g. pid reuse), message says "held by a crontick daemon for this data dir (pid N); run `crontick daemon stop`".
- **Config edit vs running daemon.** `daemon.port` is read only at startup. Editing the file does nothing until `daemon restart`; reload (`loadConfig()` at index.ts:318) must NOT rebind. `describeDaemonPort` should surface "config says X, running on Y" in `daemon status`/`info` when they differ (cheap: compare, no new fields). SP03 treats `daemon.port` as read-only; `config list/get` shows it, `set/unset` rejects with a message pointing to hand-edit + `crontick daemon restart`.
- **Dashboard scale.** Define `:root { --ui-scale: 0.8; font-size: calc(18px * var(--ui-scale)) }`; convert px → rem for font sizes, paddings, gaps, widths (1px borders stay px). Pure mechanical conversion at `rem = old_px/18`.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| D1 | Error code | `DAEMON_PORT_IN_USE` | reuse `DAEMON_START_FAILED` | Distinct, testable, matches existing `DAEMON_*` family |
| D2 | Invalid `daemon.port` | Config validation error | Fall back to 47615 (old env behavior) | "Explicit must be honored or fail loudly" |
| D3 | Zoom approach | rem scale from one root font-size variable | Multiply px ×0.8; CSS `zoom` | rem makes SP03 settings panel/SP04 forms scale for free and one knob tunes it; `zoom` is non-standard (Firefox only recent), blurs, affects `vh`/popover math; ×0.8 hardcodes more magic px that new CSS must remember |
| D4 | `DashboardHealth` fields | Keep all (`uptimeSec`, `node`, `jobs`, `runs`, `platform`) | Drop unused | `/health` is the same object; `probeHealth`, `health.test.ts`, and exported public type use it; dropping saves nothing user-visible |
| D5 | Header badge on success | Hidden | Neutral "ok" badge | Brief: drop "up Xm"; absence of badge = healthy |
| D6 | Port 0 in config | Valid, means OS-assigned, silent | Reject 0 | Needed for tests; matches old env semantics |
| D7 | Test isolation | Per-home `config.json` helper | Hidden test-only env var; global default change | Env var removal is the point; config is the real mechanism |
| D8 | Stale-config reporting | `daemon status`/`info` note when running port ≠ config port | Silent | Covers config-edited-while-running race with ~no cost |

## Risks / Open Questions

- [OPEN-1] Compose with SP03's template: SP03/this PRD both touch `config.ts`/`schemas/config.ts`. SP02 lands first; SP03 must treat `daemon` as a known section and exclude `daemon.port` from writable keys. Confirm SP03 reads `PersistedDaemonConfigSchema` from here.
- [OPEN-2] Guard against tests forgetting the helper: add a unit test scanning `tests/` for `dist/daemon/index.js` spawns lacking `writeTestConfig`, or accept degraded-but-working fallback? Leaning: helper only, no scan. [DEFERRED to implementer]
- [OPEN-3] Windows: EADDRINUSE vs EACCES for excluded port ranges (Hyper-V reserved). Explicit port in a reserved range errors EACCES, not "in use"; message should still name the port and config key. Untested on Windows.
- [OPEN-4] A foreign process may hold the port with probe timeout (1s) - error says "not crontick" even if it is a slow crontick; acceptable.
- [RESOLVED: same-data-dir daemon on explicit port] not an error; ensureDaemon connects, single-instance check blocks a second daemon.
- [RESOLVED: running daemon after config edit] no live rebind; restart required, status shows mismatch.
- [RESOLVED: CHANGELOG mentions] historical entries left as is.
- [OPEN-5] Exact scale factor after eyeballing (0.8 vs narrower table text); one-variable change so cheap. Needs owner glance at a screenshot.

## Acceptance Criteria

- `grep -r CRONTICK_DAEMON_PORT src tests vitest.config.ts docs` (excluding CHANGELOG/agent_files) → 0 matches.
- `config.json` `{"daemon":{"port":N}}` validates; `{"daemon":{"port":70000}}` and unknown `daemon.*` keys are rejected.
- Unit: unset + busy → falls back with existing messages; explicit + busy (foreign and crontick occupant) → `DAEMON_PORT_IN_USE` naming port and occupant; explicit 0 → binds, no notice; EACCES rethrown.
- Integration (real daemon): explicit busy port → `crontick daemon start` exits non-zero and prints the DAEMON_PORT_IN_USE text; second invocation for same data dir connects to the running daemon (no error).
- `describeDaemonPort`/`doctor`/`daemon status`/`info` tests updated to config-based inputs; mismatch note shown when config port ≠ running port.
- Full suite passes with no vitest port env (tests isolate via `writeTestConfig`); `npm run validate` green; surface-drift test unaffected (no new capability).
- Dashboard: computed body font-size ≈14.4px, h1 ≈17.6px; no px font-sizes remain except 1px borders; header renders exactly `v<ver> · pid <pid>`; with daemon down the red badge shows the error; no `node`, job count, or uptime text anywhere in header [verified manually via screenshot + dashboard tests updated].
- Docs: `configuration.md` `daemon.port` section, spec R-004-1/1a, implementation + troubleshooting updated; changeset added.
