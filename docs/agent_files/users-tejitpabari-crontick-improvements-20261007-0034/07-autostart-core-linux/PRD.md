---
status: draft
summary: SP07 - opt-in `crontick autostart enable|disable|status` (client and CLI; MCP status only; no daemon route), shared platform-backend interface, Linux systemd --user backend, and a proper reversal of the removal guards.
date: 2026-10-07
---

# PRD: AutoStart core + Linux (SP07)

**Repo/branch:** /root/projects/crontick-wt-improvements, `users/tejitpabari/crontick-improvements`
**Depends on:** none (SP08 macOS and SP09 Windows plug into this)
**Owns:** `src/autostart/{types,index,service,systemd,unit}.ts` (new), `src/client.ts` (3 methods), `src/cli/index.ts` (`autostart` group), `src/mcp/index.ts` (1 tool: status), `src/surface.ts`, `src/index.ts` (types), `src/constants/daemon.ts` (`CRONTICK_SUPERVISED` name), `src/daemon/index.ts` (already-running exit 0 when supervised), `daemon start --home` option, `tests/unit/autostart-removal.test.ts`, `tests/unit/autostart-*.test.ts`, `docs/reference/{cli,mcp,library}.md`, ADR 0034 + README index row, ADR 0001 section, `docs/tech/mission.md`, `docs/concepts/daemon-lifecycle.md`, `docs/specs/004-daemon.md`, changeset.

## TL;DR

Reintroduce autostart as an explicit opt-in: `crontick autostart enable` registers the daemon with the OS user-level service manager so it starts at login. A platform-neutral core (`AutostartService` + `AutostartBackend` interface) does spec-building, drift detection and error mapping once; the Linux backend writes `~/.config/systemd/user/crontick.service` and drives `systemctl --user`. No daemon API route (it is a local OS registration and must work with the daemon down). The owner has signed off rule 8 reintroduction; this PRD defines the guard rewrite and ADR that record it.

## Problem

- Demand-start (`ensureDaemon`) only fires when something calls crontick; after reboot, schedules do nothing until then `[verified: docs/tech/mission.md:17]`.
- Autostart was removed in PR #16 because of native `registry-js`, a Windows Run key + hidden VBS shim (EDR T1547.001), and surprise background processes. darwin/linux were stubs `[verified: git show f24ae58:src/autostart/index.ts]`.
- Guards now block any reintroduction: `tests/unit/autostart-removal.test.ts` bans `autostart`, `login item`, `registry-js`, `reg.exe` in `src/`, `scripts/`, `README.md`, package files; ADR 0001 ("no reboot autostart"), mission.md, daemon-lifecycle.md:101, spec R-004-35 `[verified: grep]`.

## Goals / Non-Goals

**Goals:** opt-in, admin-free, no new deps, transparent (a plain unit file the user can read); idempotent enable/disable; status that detects stale registrations; one backend interface SP08/SP09 implement without touching the core.
**Non-Goals:** macOS/Windows internals (SP08/09); start before login / linger management; system-wide (root) units; multiple data dirs per user; auto-enable on install or first run; any native dependency.

## Requirements

| # | Requirement |
|---|---|
| R1 | `client.autostartEnable()`, `autostartDisable()`, `autostartStatus()`; CLI `crontick autostart enable\|disable\|status`; MCP `crontick_autostart_status` ONLY (deliberate surface-parity exception, owner decision: an agent must not create login persistence, so enable/disable are not exposed over MCP); three `SURFACE_CAPABILITIES` entries (`cliCommand: ['autostart','enable']` etc.) of which enable/disable carry an explicit MCP exemption, and `tests/unit/surface-drift.test.ts` must encode that exception (it must still fail on any other missing surface). |
| R2 | Enable is idempotent: rewrites the definition, reloads the manager, ensures enabled. Disable is idempotent: nothing registered returns `{removed:false}`, not an error. |
| R3 | Status returns `AutostartStatus` (below) on every platform; on unsupported platforms `supported:false` with a reason (never throws). Enable/disable on unsupported throw `CrontickError('AUTOSTART_UNSUPPORTED', ...)` with an actionable message. |
| R4 | Status reports drift (`stale:true` + reasons) when the registered command differs from what `enable` would write now (node path, daemon script path, `CRONTICK_HOME`). Fix is re-running `enable`. |
| R5 | `daemon start` stays a manual one-off and MUST NOT register anything; only `autostart enable` registers (reworded R-004-35). |
| R6 | All fs/exec/platform/homedir access injected; unit tests never touch real systemd. |
| R7 | `enable` refuses with a clear error when the daemon script does not exist (unbuilt/dev checkout) and also refuses when the path looks ephemeral (`_npx`; owner decision). |
| R8 | New `crontick daemon start --home <dir>` option (core, owned here; used by SP09 task arguments): sets `CRONTICK_HOME` for the daemon it starts, so the data dir survives where the registration cannot carry env (Windows). Shim passes it to the client; no logic in the CLI. |

## Architecture

**No daemon route.** Registration is a local OS side effect that must work when the daemon is down, and the daemon cannot register itself usefully. Client methods call `AutostartService` directly. Shims stay thin: CLI formats the returned object; MCP returns it as JSON. Surface-drift test only needs client/CLI/MCP/`SURFACE_CAPABILITIES`, so no API column `[verified: src/surface.ts header]`.

**Backend interface** (`src/autostart/types.ts`; types exported via `src/index.ts`):

```ts
interface AutostartSpec { nodePath: string; daemonScript: string; cliScript: string /* absolute dist/cli/index.js; used only by SP09 */; env: Record<string,string> } // absolute paths
interface AutostartDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string;
  exec(file: string, args: string[]): Promise<{code:number; stdout:string; stderr:string}>;
  fs: { readFile; writeFile; mkdir; rm }  /* promise fs subset */ }
interface BackendInspection { registered: boolean; enabledInManager?: boolean; active?: boolean;
  definitionPath?: string; command?: { nodePath: string; args: string[]; env: Record<string,string> }; notes?: string[] }
interface AutostartBackend { readonly mechanism: 'systemd-user'|'launchd'|'schtasks';
  available(): Promise<{ok:true}|{ok:false; reason:string}>;
  install(spec: AutostartSpec): Promise<{definitionPath:string}>;   // idempotent
  uninstall(): Promise<{removed:boolean}>;                          // idempotent
  inspect(): Promise<BackendInspection>;                            // read-only; "not registered" is a value, not a throw
  expectedCommand?(spec: AutostartSpec): string[]; }                // optional; what drift compares inspect().command against; default [spec.daemonScript]
```

`createAutostartBackend(deps)` in `index.ts` switches on `deps.platform` (`linux` -> systemd; SP08/09 add `darwin`, `win32`; else `undefined`). `AutostartService` (core, shared) builds the spec, calls `available()` first, maps failures to `CrontickError`, and computes status:

```ts
interface AutostartStatus { supported: boolean; enabled: boolean; mechanism?: string; definitionPath?: string;
  command?: string /* human-readable registered command line */; active?: boolean;
  stale: boolean; staleReasons: string[]; reason?: string; hints: string[] }
```

Drift = deep-compare `inspect().command` with `backend.expectedCommand?.(spec) ?? [spec.daemonScript]` and `buildSpec()` (env keys are compared only when `inspect()` reports an env); backends only report what they find, they never compare. SP08/09 implement `AutostartBackend` (install, uninstall, inspect parsing) and add one factory case; no other shared file changes.

**What is registered.** `nodePath = process.execPath`, `daemonScript = defaultDaemonScript()` (`dist/daemon/index.js`), env = `CRONTICK_SUPERVISED=1` (always, all platforms), `CRONTICK_HOME` only if set at enable time, and a `PATH` snapshot. The `PATH` snapshot is built here, in core `buildSpec`, for all platforms; SP08/SP09 backends do not add PATH themselves, and a backend that cannot carry env (Windows task actions) ignores it. `cliScript` is `dist/cli/index.js`, only used by the SP09 backend. The daemon script takes no argv and always runs in the foreground; `ensureDaemon` detaches it itself `[verified: ensure.ts spawn detached; client.ts defaultDaemonScript]`, so service managers launch the script directly with no `--foreground` flag. SP02's `daemon.port` is read from config at daemon start, nothing to capture.

**Interaction with demand-start.** Single-instance is a PID-file liveness check; a second daemon logs "Daemon already running" and exits non-zero `[verified: daemon/index.ts:115-130]`. Under a supervisor that restarts on non-zero exit (systemd `Restart=on-failure`, launchd `KeepAlive{SuccessfulExit:false}`) that would crash-loop if the user demand-started first. So when `CRONTICK_SUPERVISED=1` is set (core puts it in `spec.env` on all platforms; name constant in `src/constants/daemon.ts`) the already-running branch logs and exits 0; an unsupervised manual start keeps the non-zero exit. SP08 uses the same contract with no extra backend code; the Windows launcher already gets exit 0 from `daemon start`.

**`daemon start --home <dir>` (R8).** Task Scheduler actions carry no env, so SP09 passes `CRONTICK_HOME` as `--home` in the task arguments; the option sets `CRONTICK_HOME` for the daemon `daemon start` spawns. Linux/macOS keep using `Environment=`/`EnvironmentVariables` and do not need it.

**Linux backend** (`systemd.ts` + pure `unit.ts` renderer/parser):

```ini
[Unit]
Description=crontick daemon
[Service]
Type=simple
ExecStart="/abs/node" "/abs/dist/daemon/index.js"
Environment="CRONTICK_SUPERVISED=1"
Environment="CRONTICK_HOME=..."   # only if set
Environment="PATH=..."            # snapshot at enable
Restart=on-failure
RestartSec=5
KillMode=process
[Install]
WantedBy=default.target
```

- Path: `${XDG_CONFIG_HOME:-~/.config}/systemd/user/crontick.service`.
- install: mkdir, write unit (0644), `systemctl --user daemon-reload`, `systemctl --user enable --now crontick.service`; if unit content changed and it is active, `restart`.
- uninstall: `disable --now`, remove file, `daemon-reload`. inspect: parse unit, `is-enabled`, `is-active`; `loginctl show-user -p Linger` feeds a hint.
- available(): `systemctl --user show-environment` exit 0. Missing binary or no user bus (WSL1, containers) gives `{ok:false, reason}` and nothing is written.
- `KillMode=process` because runs are detached and re-adopted after daemon restart (`adoptRun`); default cgroup kill would terminate running jobs on `stop` `[verified: daemon/index.ts:271-272]`.
- Values escaped per systemd rules (quoted args; `%` -> `%%`, `$` -> `$$`).

**Lifecycle caveat (documented):** without linger, the user manager stops at last logout and SIGTERMs the daemon, so jobs pause while fully logged out. A demand-started daemon survives logout; this differs. Linger is out of scope; status prints the `loginctl enable-linger` hint.

**Stale paths.** `npm update`/nvm switch changes `nodePath` or `daemonScript`; status shows `stale` and a hint to re-run `enable`. Uninstalling the package leaves the unit (failing start is bounded by systemd start limits); docs say run `autostart disable` first.

**SP10 note.** A login start is a normal daemon start; catch-up runs in the existing startup path. No SP07/SP10 interface.

**Guard reversal.** Rewrite `autostart-removal.test.ts`: keep the `registry-js` dependency check and the unrelated needles (`allowstart`, `no-daemon-start`, `crontick_mcp_no_daemon_start`, `maxtokensperrun`); drop `autostart` and `login item`; add `hkcu`, `currentversion\run`, `wscript`, `.vbs`. Update the failure message and the stale comment at `src/cli/index.ts:635`.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| D1 | Daemon API route | None; client calls core directly | `/api/autostart` | Must work with daemon down; no persistence via HTTP |
| D2 | Where drift is computed | Core service compares `inspect()` vs `buildSpec()` | Per-backend | Tested once; 08/09 only parse |
| D3 | Process launched | `node daemon/index.js` directly on Linux/macOS (SP09 launches `cliScript daemon start` via `expectedCommand`) | `crontick daemon start --foreground` (needs CLI path too) | Fewer moving paths; script already foreground |
| D4 | Already-running exit | `CRONTICK_SUPERVISED=1` in `spec.env` -> exit 0 | Dedicated exit 75 + `SuccessExitStatus` (launchd cannot express it); `Restart=always`; stop daemon before enable | One contract for systemd and launchd; avoids crash loop, no disruption |
| D5 | Env captured | `CRONTICK_SUPERVISED` + `CRONTICK_HOME` + `PATH` snapshot (built in core) | Whole env; login-shell PATH | Engines (claude) need PATH; no secrets in a unit file |
| D6 | `KillMode` | `process` | default control-group | Preserves detached runs/adoption |
| D7 | MCP exposure | status only; enable/disable not exposed over MCP | all three (parity) | Owner decision: an agent must not create login persistence. Deliberate surface-parity exception, encoded in `SURFACE_CAPABILITIES` and `surface-drift.test.ts`; CLI and library keep all three |
| D8 | ADR | New 0034 (README index row, body as section in 0001) | New standalone file | Matches consolidated ADR layout `[verified: decisions/README.md]` |
| D9 | Unsupported platform | status ok, enable throws | silent no-op | Never lie about registration |

## Manual steps

- Owner: sign off rule 8 reintroduction in the PR description (already decided).
- Owner: enable/disable/reboot check on a real Linux desktop (systemd --user, no linger).

## Risks / Open Questions

- [DEFERRED: verify during implementation] Daemon exit code on SIGTERM must be 0 so graceful stop is not restarted; verify shutdown path in `daemon/index.ts`, add test.
- [RESOLVED: accept; status/enable output shows a "re-run `crontick autostart enable`" hint] `PATH` snapshot goes stale when engines are installed later.
- [RESOLVED: MCP exposes autostart status only; no enable/disable via MCP. Deliberate surface-parity exception, see R1/D7; `SURFACE_CAPABILITIES` and `surface-drift.test.ts` encode it] MCP `enable` would let an agent create login persistence.
- [RESOLVED: numbers assigned up front: 0034 autostart (SP07-09), 0035 trigger dispatch (SP05), 0036 webhook relay (SP06)] ADR 0034 number collision.
- [RESOLVED: superseded by `CRONTICK_SUPERVISED=1` exit 0; exit 75 and `SuccessExitStatus`/`RestartPreventExitStatus` are no longer used (C1)]
- [RESOLVED: refuse enable on an ephemeral (`_npx`) path] Ephemeral path policy.
- [DEFERRED] Linger management; multiple data dirs (second unit name); `systemd-analyze verify` in CI.
- [RESOLVED: no route] Daemon API route not needed (D1).

## Acceptance Criteria

1. `crontick autostart enable|disable|status` and the MCP `crontick_autostart_status` tool exist; enable/disable are absent from MCP by design and `surface-drift.test.ts` encodes that exception (still green, still fails on any other drift).
2. Unit tests (fake exec/fs) cover: unit rendering/escaping, install/uninstall idempotency, unavailable systemd, drift on node/script/CRONTICK_HOME change, unsupported platform status vs enable error.
3. Rewritten guard test passes, and fails on a planted `registry-js`/`reg.exe`/Run key/`.vbs`.
4. With `CRONTICK_SUPERVISED=1` a second daemon start exits 0 (non-zero without it); regression test. `daemon start --home <dir>` sets `CRONTICK_HOME` for the spawned daemon; test.
5. Docs/ADR/spec/mission/lifecycle updated; R-004-35 says `daemon start` does not register, `autostart enable` does.
6. `npm run validate` passes; changeset added; manual Linux login test recorded.
