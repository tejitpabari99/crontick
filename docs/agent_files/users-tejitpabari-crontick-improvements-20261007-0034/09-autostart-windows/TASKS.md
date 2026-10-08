---
status: draft
summary: Seven tasks - launcher-survival CI gate first, then task XML renderer/parser, schtasks install/uninstall, inspect/status, win32 factory wiring with expectedCommand/--home, Windows CI integration test, docs/ADR/changeset.
date: 2026-10-08
---
# Tasks: SP09 AutoStart Windows backend
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/09-autostart-windows/PRD.md. No [OPEN] items remain. Every [RESOLVED] item (core deltas A/B, `daemon start --home`) is binding and already delivered by SP07. [DEFERRED: verify during implementation] items are folded into the Done-when of the task they belong to. No new runtime dependencies; no admin, Run key, registry, `reg.exe`, PowerShell, `wscript` or `conhost`. Depends on SP07 (backend interface, `AutostartSpec.cliScript`, `expectedCommand`, `daemon start --home`, ADR 0034).

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Launcher-survival gate on Windows CI (Open Question 1) | SP07 | todo |
| 2 | Task XML renderer/parser (pure) | 1 | todo |
| 3 | schtasks backend: available, install, uninstall | 2 | todo |
| 4 | Inspect, active/last-result parsing, status hints | 3 | todo |
| 5 | win32 factory case, `expectedCommand`, `--home` arguments | 3, 4 | todo |
| 6 | Windows-only integration test and CI wiring | 5 | todo |
| 7 | Docs, security.md rewrite, ADR 0034 Windows section, changeset, validate | 1-6 | todo |

## Task 1 — Launcher-survival gate on Windows CI (Open Question 1)
What it is / what it means: The make-or-break unknown behind D2. If Task Scheduler kills the detached daemon when the launcher's task instance ends, the whole design fails, so this is proven before anything else is built.
What changes at a high level: A minimal Windows-CI-only test registers a throwaway task whose action is `node.exe <cli> daemon start`, runs it, waits for the instance to finish, then asserts the daemon pid is alive and its API answers. Cleans up the task and daemon afterwards. Throwaway scaffolding only; it is hardened into the real integration test in Task 6.
Done when: Verify the detached daemon survives the task instance ending, on a GitHub-hosted Windows runner. If it fails, use the PRD Architecture fallback (S4U direct-daemon action, or interactive foreground daemon with visible console), STOP, and re-spec the PRD before any further task starts.

## Task 2 — Task XML renderer/parser (pure)
What it is / what it means: The task definition as pure functions (D1, D3-D6, D8, R3, R7), unit-testable on every OS.
What changes at a high level: `renderTaskXml` emits exactly the PRD definition: SID-scoped `LogonTrigger` with 30 s delay, `InteractiveToken` + `LeastPrivilege`, `IgnoreNew`, battery flags false, `PT0S`, `Hidden=false`, honest Author/Description, plain Command and quoted Arguments. All values XML-escaped. `parseTaskXml` is tolerant, element-name based only. A UTF-16LE-with-BOM encoder helper is included.
Done when: Snapshot test contains exactly the specified settings and nothing else; render/parse round-trip passes; escaping covers `& < > " '`; paths with spaces and non-ASCII round-trip. Verify (owner, real Windows) a real `C:\Users\Test User\` and a non-ASCII username (deferred path item; also see Task 5).

## Task 3 — schtasks backend: available, install, uninstall
What it is / what it means: The `mechanism: 'schtasks'` backend lifecycle (R1-R4, R8, D1, D9).
What changes at a high level: `schtasks.ts` resolves `%SystemRoot%\System32\schtasks.exe` absolutely, runs via injected `exec(file, args)` with no shell. `available()` treats exit 0 or "not found" as working and other failures (e.g. policy-disabled) as unavailable with stderr as reason. Identity via `whoami /user /fo csv /nh` second column. `install` writes the temp XML under the data dir, runs `/create ... /xml ... /f`, deletes the file in `finally`. `uninstall` queries first, returns `removed:false` if absent, else `/delete /f`. Leaves the empty `\crontick` folder.
Done when: Fake-exec/fs tests cover fresh install, reinstall, uninstall absent/present, unavailable writing nothing, temp file removed on failure. Verify (owner, real Windows, standard non-admin user) that a standard user can create the `\crontick\` folder and task; if not, fall back to root-level `\crontick-daemon` (owner pre-approved). Verify `/xml` with a SID `UserId` works for a non-admin registering for itself, and note LogonTrigger behaviour on domain/Azure AD accounts.

## Task 4 — Inspect, active/last-result parsing, status hints
What it is / what it means: Read-only, locale-independent inspection (R5, R6, R9, D7).
What changes at a high level: `inspect()` runs `/query /tn ... /xml`; missing task (non-zero exit, no `<Task`) gives `{registered:false}`, never a throw. Fills command, `enabledInManager`, `definitionPath` as the task path, and notes. Active and Last Result come from `/query ... /fo csv /v /nh` parsed by column index; any parse failure gives `active: undefined` plus a note. Status hints: `taskschd.msc` > `\crontick`, flash-at-logon caveat, node-path staleness.
Done when: Tests against canned XML/CSV cover localized status text, garbage, empty output, and missing task without throwing. Verify `/query /xml` stdout code page/BOM handling with a tolerant parser, tested on a non-English host (owner, real Windows). Confirm there is no OS-level user toggle for tasks (Settings > Startup apps) so `Settings/Enabled` is all that can be detected.

## Task 5 — win32 factory case, `expectedCommand`, `--home` arguments
What it is / what it means: Plugs the backend into SP07 core using the signed-off deltas A/B (D2, R1).
What changes at a high level: One `case 'win32'` in the factory. The action is `node.exe <cliScript> daemon start`. When `CRONTICK_HOME` was set at enable time, Arguments end with `--home "<dir>"`; `expectedCommand(spec)` returns `[cliScript,'daemon','start']` plus `'--home', dir` in that case so drift compares correctly. The backend ignores `spec.env` (task actions carry none).
Done when: Factory test shows schtasks for injected `win32`; drift tests show no false stale with and without `--home`, and stale on node/cliScript change; a guard test confirms no code path references `reg.exe`, PowerShell, `wscript` or `conhost`.

## Task 6 — Windows-only integration test and CI wiring
What it is / what it means: One real-schtasks test (AC4), gated like the old registry test, hardening Task 1's scaffolding.
What changes at a high level: Runs only on `win32` in CI: enable, query, status non-stale, re-enable, disable, assert absent, plus the launcher-survival check from Task 1. Uses a test-only task-name override so it never collides with a real install; `afterAll` deletes the task. Unit tests run on ubuntu and windows CI. No release-workflow changes.
Done when: Integration test passes on the Windows runner and leaves no task behind. Note that runners are admin, so the non-admin claim is not proven here (see manual steps).

## Task 7 — Docs, security.md rewrite, ADR 0034 Windows section, changeset, validate
What it is / what it means: Close-out per AGENTS.md documentation rules and AC6-7.
What changes at a high level: Windows section of `docs/reference/cli.md` and `docs/concepts/daemon-lifecycle.md`; rewrite of the `docs/security.md` Windows paragraphs from the PRD security table (no official pre-clearing program, levers, Defender/WDSI and corporate allowlist steps incl. the exact `node.exe ... daemon start` command line, policy-disabled case); ADR 0034 Windows section (login-only, sub-second console flash, no admin, nothing of ours to sign, empty `\crontick` folder left); changeset unless SP07's is reused.
Done when: `npm run validate` passes, docs match behavior, and the PR description records manual-step results.

## Manual steps
Owner (real Windows): (1) as a standard non-admin user, `enable`, log off/on, `crontick status` shows the daemon up, note the console flash, check `\crontick\daemon` in `taskschd.msc` with author/description, demand-start then `enable` yields no second daemon, `disable` removes it. (2) Repeat on a Defender-for-Endpoint/corporate device if available; record any alert and allowlist entry. (3) Non-English Windows plus a profile path with a space and non-ASCII name: `status` sanity check. (4) Confirm the standard-user folder-creation outcome (Task 3) and the node.exe Authenticode signature if desired.
