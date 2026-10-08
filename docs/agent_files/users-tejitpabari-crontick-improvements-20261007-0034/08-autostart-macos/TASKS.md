---
status: draft
summary: Five tasks - plist renderer/parser, launchd install/uninstall/availability, read-only inspect with disabled-by-user detection, darwin factory case, docs/ADR macOS section/changeset/validate.
date: 2026-10-08
---
# Tasks: SP08 AutoStart macOS backend
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/08-autostart-macos/PRD.md. No [OPEN] items remain. The [DEFERRED: verify during implementation] items are folded into Tasks 1, 2, 3 and 5 as explicit verify steps; those needing a real Mac are marked "(real Mac, owner)" and repeated in the closing note. Out of scope: Developer ID signing/SMAppService, LaunchDaemon boot start, Full Disk Access management, `plutil -lint` CI job, legacy `load/unload/list`. No new runtime dependencies. Builds on SP07's `AutostartBackend`, `AutostartSpec`, `CRONTICK_SUPERVISED=1` contract, core `buildSpec` PATH and ADR 0034.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Plist renderer and parser | - | todo |
| 2 | launchd backend: available, install, uninstall | 1 | todo |
| 3 | launchd inspect and disabled-by-user detection | 1, 2 | todo |
| 4 | Darwin factory case | 2, 3 | todo |
| 5 | Docs, ADR 0034 macOS section, changeset, validate | 1-4 | todo |

## Task 1 — Plist renderer and parser
What it is / what it means: The pure, dependency-free plist layer (R6, D3, D4, D5, D6, D9).
What changes at a high level: A new `renderPlist(spec,label,paths)` and `parsePlist(xml)` under `src/autostart/`. The label is `dev.crontick.daemon`. The plist has exactly the PRD key table and nothing else: `ProgramArguments` from the spec, `EnvironmentVariables` copied from `spec.env` unchanged (no PATH added by the backend), `RunAtLoad`, `KeepAlive{SuccessfulExit:false}`, `ThrottleInterval 30`, `AbandonProcessGroup`, stdout/stderr paths in `logsDir` derived from `spec.env.CRONTICK_HOME` via `src/paths.ts`, and `WorkingDirectory` set to the data dir. No `ProcessType`, `Disabled`, `LimitLoadToSessionType` or `AssociatedBundleIdentifiers`. All strings are XML-escaped.
Done when: Snapshot tests cover every key, escaping of `& < > " '`, and optional `CRONTICK_HOME`; `parsePlist(renderPlist(x))` round-trips to `command {nodePath,args,env}`. Verify `logsDir` is derivable from `spec.env.CRONTICK_HOME` with no further interface delta (if not, report the delta instead of changing SP07 silently). Verify on a real Mac that `AbandonProcessGroup` keeps detached runs alive across `daemon stop` and `bootout`, and note the TCC responsible-process attribution after a daemon restart (real Mac, owner).

## Task 2 — launchd backend: available, install, uninstall
What it is / what it means: The mutating half of the `mechanism: 'launchd'` backend (R1-R4, D1, D2).
What changes at a high level: `src/autostart/launchd.ts` with an injected `exec` and fs. `available()` requires `process.getuid`, a runnable `/bin/launchctl` and `launchctl print gui/<uid>` exiting 0; otherwise it returns `{ok:false, reason}` and writes nothing. `install` creates `~/Library/LaunchAgents` and the logs dir, writes the plist (0644), then reconciles without ever blind-bootstrapping: check loaded, `bootout` if loaded, `bootstrap gui/<uid>`, `enable`. On bootstrap failure with a disable record it runs `enable` and retries once, else surfaces stderr in `CrontickError`. `uninstall` runs `bootout` (ignoring "not loaded"), deletes the plist and returns `{removed}`. No legacy `load/unload/list`.
Done when: Fake-exec tests assert exact argv sequences for install-fresh, install-when-loaded, install-with-disable-record (enable plus retry), uninstall-missing and uninstall-loaded, plus unavailable-GUI writing nothing and an identical re-install not erroring. Verify on a real Mac whether disabling the item in Login Items makes `bootstrap` fail with error 5 on re-enable, and that the `enable` retry path handles it (real Mac, owner).

## Task 3 — launchd inspect and disabled-by-user detection
What it is / what it means: The read-only half of the backend, honest about what macOS lets us see (R5, R7, D7).
What changes at a high level: `inspect()` parses the plist if present, runs `launchctl print gui/<uid>/<label>` for loaded, pid and last exit code, and `launchctl print-disabled gui/<uid>` for the disabled flag. It fills `registered`, `enabledInManager` (not in the disabled list), `active`, `definitionPath` and `notes`. If registered with `RunAtLoad` and not loaded, it adds the note pointing at System Settings > General > Login Items & Extensions. Status hints cover Login Items visibility and stale registration after node/nvm moves. No `sfltool`. Parsing of the "NOT API" `print` output is minimal and tolerant: unparseable output gives `active: undefined` plus a note, never a throw.
Done when: Tests against canned `print`/`print-disabled` outputs, including garbage, a missing plist and an unloaded service, never throw and yield the expected fields. Verify `inspect()` fits `BackendInspection` with no interface delta. Verify on real macOS 13+ and ideally 15 that a Login Items toggle-off appears (or not) in `print-disabled`, and that `print` output parses across versions; if not, keep the note-only fallback (real Mac, owner).

## Task 4 — Darwin factory case
What it is / what it means: Wire the backend in with the single permitted shared-file change (R1, AC1).
What changes at a high level: One `case 'darwin'` in the `src/autostart/index.ts` factory returning the launchd backend; other platforms unchanged. The SP07 service, CLI and MCP surfaces need no edits.
Done when: Factory tests with injected `platform:'darwin'` return the launchd backend and still return `undefined` for unsupported platforms. A guarded test runs `plutil -lint` on the rendered plist only when `process.platform==='darwin'`. Tests pass on ubuntu and windows.

## Task 5 — Docs, ADR 0034 macOS section, changeset, validate
What it is / what it means: Close out per AGENTS.md documentation rules and AC5-6 (R7, D8).
What changes at a high level: Add macOS notes to `docs/reference/cli.md` and a macOS section to `docs/concepts/daemon-lifecycle.md`. Fill the macOS section of ADR 0034. State login-only start, Login Items visibility and its unsigned "node" appearance, the TCC caveat (grant Full Disk Access to node or keep job dirs outside protected folders) and the keychain caveat. Document the Claude "Not logged in" fallback of setting the OAuth token through engine env config, not the plist. Add a changeset unless SP07's is reused. Run `npm run validate`.
Done when: `npm run validate` passes and docs match behavior. Verify on a real Mac whether the Claude engine reports "Not logged in" under an autostarted daemon, and record the outcome in the docs (real Mac, owner).

## Manual steps
Owner, all on a real Mac (macOS 13+, ideally 15), results recorded on the PR before release:
1. Checklist: `crontick autostart enable` shows the plist, the "Background Items Added" notification, and `launchctl print gui/$UID/dev.crontick.daemon` running. After logout/login the daemon is up. A second `enable` is a no-op, `status` shows enabled, and `disable` removes the plist and Login Items entry. Demand-start then `enable` leaves no respawn loop in `launchd.err.log`.
2. Approve the item in Login Items if asked. Toggle it off and confirm status reports not running with the note. Record the displayed name/developer. Verify BTM toggle vs `print-disabled` and the error 5 re-enable behavior (Tasks 2-3).
3. Run a job with cwd in `~/Documents` and a Claude-engine job under autostart. Record TCC and "Not logged in" outcomes (Task 5).
4. Verify `daemon stop` / `bootout` leaves a detached job alive and note TCC attribution after restart (Task 1).
5. Confirm `launchctl print` parsing on each macOS version available (Task 3).
6. Optional, $99/yr: signed+notarized helper bundle or `SMAppService`; tracked in `futures.md`, not in scope.
