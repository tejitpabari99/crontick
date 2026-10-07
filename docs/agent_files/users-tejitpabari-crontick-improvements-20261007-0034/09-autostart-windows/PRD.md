---
status: draft
summary: SP09 - Windows autostart backend for the SP07 interface - Task Scheduler logon task \crontick\daemon registered from an XML definition via schtasks, launcher-style action (node.exe cli daemon start) to avoid a lingering console window, XML-based inspect, EDR/Defender answer, and two proposed core deltas.
date: 2026-10-07
---

# PRD: AutoStart Windows backend (SP09)

**Repo/branch:** /root/projects/crontick-wt-improvements, `users/tejitpabari/crontick-improvements`
**Depends on:** SP07 (`AutostartBackend`, `AutostartService`, factory), SP08 alignment on `CRONTICK_SUPERVISED`
**Owns:** `src/autostart/{schtasks,taskxml}.ts` (new), one `case 'win32'` in `src/autostart/index.ts`, `tests/unit/autostart-schtasks*.test.ts`, `tests/integration/autostart-schtasks.test.ts` (Windows CI only), Windows section of `docs/reference/cli.md`, `docs/concepts/daemon-lifecycle.md`, ADR 0034 (Windows section), rewrite of the `docs/security.md` Windows paragraphs, changeset (if SP07's not reused).

## TL;DR

Implement `AutostartBackend` with `mechanism: 'schtasks'`. `install` writes a Task Scheduler XML definition (UTF-16LE, temp file) and runs `schtasks /create /tn "\crontick\daemon" /xml <file> /f`; `uninstall` runs `schtasks /delete /tn "\crontick\daemon" /f`; `inspect` parses `schtasks /query /tn ... /xml` (locale-independent element names). Current user, `LeastPrivilege`, LogonTrigger only, no admin, no Run key/registry/VBS/`reg.exe`. The action is `node.exe <cli> daemon start` (a short-lived launcher that spawns the existing detached daemon), not the long-running daemon in a console: this avoids a permanent console window that the user could close (killing the daemon) and sidesteps the exit-75 problem. Whether Task Scheduler leaves that detached child alive is the one make-or-break unknown; a Windows-CI test decides it before anything else is built (see [OPEN] 1).

## Problem

- SP07 returns `undefined` for win32, so `autostart enable` throws `AUTOSTART_UNSUPPORTED` on Windows.
- The removed implementation used `registry-js`, an HKCU Run key and a hidden `wscript` + `cmd /c` VBS shim `[verified: git show f24ae58:src/autostart/win32.ts]`. Its own security doc admits EDR persistence-alert risk (Run key) and recommends a manual WDSI submission of a `crontick.exe` that never existed `[verified: git show f24ae58:docs/security.md]`. Hidden-wscript-spawning-cmd is also the classic LOLBin chain.
- `node.exe` is a console-subsystem exe, so a logon task shows a console window `[inferred: standard PE subsystem; owner eyeball in Manual steps]`.
- Task Scheduler defaults would hurt a daemon: tasks are stopped after 72 h, and start-on-battery/stop-on-battery are default-on `[https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-settingstype-complextype ; schtasks-create docs verbose example "Stop Task If Runs X Hours and X Mins: 72:0"]`.

## Goals / Non-Goals

**Goals:** opt-in, no admin, no new deps, transparent task (named, described, readable XML), idempotent install/uninstall, locale-independent inspect, fully unit-testable via injected exec/fs, one real-schtasks CI test.
**Non-Goals:** start before logon (S4U/SYSTEM/boot trigger), "run whether logged on or not" (needs a stored password or S4U), Authenticode-signing anything of ours, multiple data dirs, removing the empty `\crontick` folder (schtasks cannot delete folders), group-policy/MDM deployment.

## Requirements

| # | Requirement |
|---|---|
| R1 | `schtasks.ts` exports a backend, `mechanism: 'schtasks'`, selected by `case 'win32'`. Shared files change only per the deltas below. |
| R2 | `available()`: `schtasks.exe` runs (`/query /tn \crontick\daemon` exit 0 or a "not found" exit both prove it works; other failures, e.g. policy-disabled task creation, return unavailable with stderr as reason). Resolve `schtasks.exe` as `%SystemRoot%\System32\schtasks.exe` (absolute, no PATH lookup). |
| R3 | `install(spec)`: render XML (below), write UTF-16LE with BOM to `<dataDir>\autostart\task.xml` (declaration `encoding="UTF-16"`), run `/create /tn "\crontick\daemon" /xml <file> /f`, delete the temp file in `finally`. `/f` makes re-install an overwrite. `/create` makes the folder implicitly. |
| R4 | `uninstall()`: `/query` first; if absent return `{removed:false}`; else `/delete /tn "\crontick\daemon" /f`, return `{removed:true}`. Does not stop a running daemon (it is detached; `crontick daemon stop` is separate, ADR 0014). |
| R5 | `inspect()` read-only: `/query /tn "\crontick\daemon" /xml`. Missing task (non-zero exit, no `<Task` in stdout) is `{registered:false}`, never a throw. Parse with tolerant regexes on element names only. Fills `command {nodePath,args}`, `enabledInManager` from `Settings/Enabled`, `definitionPath` = `\crontick\daemon` (a task path, not a file), `notes`. |
| R6 | `active` and last result come from `/query /tn ... /fo csv /v /nh` parsed by **column index** (values are localized, column order is not); numeric "Last Result" and a status cell. Any parse failure yields `active: undefined` plus a note. Never parse `/fo LIST` labels. |
| R7 | All XML values escaped (`& < > " '`); pure `renderTaskXml`/`parseTaskXml` round-trip tested. No string passes through a shell (`exec(file, args)`, `shell:false`). |
| R8 | The user is identified by SID (`whoami /user /fo csv /nh`, second column) and written as `<UserId>` in trigger and principal, independent of locale or domain/name format. |
| R9 | Status hints: Task Scheduler UI path (`taskschd.msc` > `\crontick`), flash-at-logon caveat, node-path staleness (core drift). |

## Architecture

**Why XML, not flags.** `schtasks /create /sc onlogon /tr ...` cannot express `ExecutionTimeLimit`, battery settings, `MultipleInstancesPolicy`, or a trigger `UserId` (only `/delay`, `/rl`, `/it`, `/np` exist) `[verified: parameter list, https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create]`. `/xml` is a documented option, combinable with `/f`. Quoting becomes trivial: `<Command>` and `<Arguments>` are XML fields, not a `/tr` string (262-char path limit, nested-quote rules). Remaining trap: the file must really be UTF-16 if the declaration says so `[https://windowsforum.com/threads/schtasks-the-task-xml-is-malformed.251090/]`.

**Task definition** (settings per schema `[https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-settingstype-complextype]`):

```xml
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>crontick</Author><URI>\crontick\daemon</URI>
    <Description>Starts the crontick scheduler daemon at logon. Created by `crontick autostart enable`; remove with `crontick autostart disable`.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-...</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-21-...</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>false</StartWhenAvailable><Hidden>false</Hidden><Enabled>true</Enabled>
    <AllowStartOnDemand>true</AllowStartOnDemand></Settings>
  <Actions Context="Author"><Exec><Command>C:\...\node.exe</Command><Arguments>"C:\...\cli\index.js" daemon start</Arguments></Exec></Actions>
</Task>
```

`PT0S` disables the time limit. `Hidden` stays false on purpose: it only hides the task in the UI, and hiding is what malware does. `RestartOnFailure` is omitted: the action exits quickly (see below), so there is no long-lived instance to restart; crash recovery stays with demand-start.

**Console window (critical).** Task Scheduler has no `windowsHide`; an interactive logon task running a console exe shows a console. Options:

| Option | Window | Verdict |
|---|---|---|
| `node.exe daemon.js` directly, interactive | Persistent console for the daemon's life; closing it kills the daemon | Reject |
| `conhost.exe --headless node.exe ...` | Still flashes on Win11 `[https://claudeissues.com/issue/57769-conhost-window-flash-despite-headless-flag-on-windows]`; also a published detection rule (proxy execution via conhost) `[https://www.elastic.co/guide/en/security/current/proxy-execution-via-console-window-host.html]` | Reject (LOLBin) |
| S4U ("run whether logged on or not", no stored password) | None (non-interactive desktop) | No network or encrypted-file (DPAPI) access, so Credential Manager-backed tools (git credential manager, gh) would fail inside jobs, unlike a demand-started daemon `[https://learn.microsoft.com/windows/win32/taskschd/principal-logontype ; https://learn.microsoft.com/windows/desktop/api/taskschd/ne-taskschd-task_logon_type]` |
| Password logon type | None | Needs user password; reject |
| **Interactive + launcher: `node.exe <cli> daemon start`** | Sub-second flash while the launcher runs; the daemon is the existing detached, console-less process `ensureDaemon` spawns `[verified: src/daemon/ensure.ts:190-196 detached, stdio to log file]` | **Recommend** |

The launcher also makes a second start harmless: `daemon start` reports "Daemon already running" and exits 0 `[verified: src/cli/index.ts:639-653]`, so Windows needs neither exit 75 nor `CRONTICK_SUPERVISED`. Honest limitation: a sub-second console flash at logon (30 s after, from the trigger delay) cannot be removed without a GUI-subsystem binary, which we will not ship.

**Job-object risk.** Ending a task ends the process it launched but does not reliably end descendants `[https://yomotherboard.com/?p=575749 (weak source)]`; what happens to a detached child when the launcher exits normally is undocumented. If the daemon dies with the task instance the design fails; fallback is the S4U direct-daemon action, or interactive foreground daemon with a visible console (both worse). AC4 settles this first.

**Inspect and drift.** Core compares `inspect().command` to the spec. The Windows command is `[cliScript,'daemon','start']`, not `[daemonScript]`, so two deltas are needed (Risks).

**Idempotency / locale.** Create uses `/f`; delete uses `/f`; existence is decided from XML presence plus exit code, never from localized stderr. XML element names, SIDs and numeric result codes are locale-independent; the only localized text handled is the status cell, recorded only as a note.

**Paths.** `<Command>` takes the raw path (no quotes), `<Arguments>` quotes each path; UTF-16 file avoids non-ASCII username breakage. [OPEN: real test with `C:\Users\Test User\` and a non-ASCII name.]

**Testing.** Unit (every OS, injected `platform:'win32'`, fake exec/fs): XML snapshot (every setting above, nothing else), round-trip, argv sequences (fresh install, reinstall, uninstall absent/present), inspect against canned XML/CSV (localized status text, garbage, empty), `available()` failure, factory returns schtasks for win32. Integration (only `process.platform==='win32'` and CI, like the old gated registry test): enable, query, status non-stale, rerun enable, disable, absent; test-only task-name override so it never collides with a real install; `afterAll` delete. GitHub-hosted Windows runners run as admin, so this does not prove the non-admin claim `[inferred]`.

## Security tools: the owner's question

"Official way to ensure security tools don't flag AutoStart": **there is none.** Microsoft and EDR vendors publish no registration or signing program that pre-clears a persistence mechanism; detections are behavioural plus reputation-based, and scheduled-task creation is itself a detection point (MITRE T1053.005; Security event 4698; `schtasks.exe` command lines) `[https://attack.mitre.org/detectionstrategies/DET0441 ; https://www.manageengine.com/log-management/mitre-attack/persistence/scheduled-task-job-t1053.html]`. What we control is looking like what we are:

| Lever | What we do |
|---|---|
| No LOLBin chain | No wscript/cmd/powershell/conhost; the only launched process is `node.exe` (schtasks.exe at enable time only) |
| Signed binary | `node.exe` from nodejs.org is Authenticode-signed by OpenJS Foundation `[third-party listing https://www.freefixer.com/library/file/node.exe-321126/ ; owner can confirm with Get-AuthenticodeSignature]`. crontick ships JS only: **nothing of ours to sign or submit** |
| Honest metadata | `Author crontick`, plain `Description` stating origin and removal, `Hidden=false`, own `\crontick` folder, visible in `taskschd.msc` |
| User scope | `LeastPrivilege`, current-user SID, no elevation, no SYSTEM, no HKLM/Run key, no registry writes |
| No obfuscation | Plain-text args, no encoded commands; warn on `_npx`/temp paths (SP07 R7) |
| Opt-in | Created only on explicit `enable` |

If a tool flags it anyway:
1. **Defender, unmanaged machine:** submit at https://www.microsoft.com/wdsi/filesubmission as "Software developer" with a behaviour description; Microsoft adjusts definitions if clean `[https://learn.microsoft.com/en-us/answers/questions/5929545/microsoft-defender-false-positive-and-wdsi-submiss (community thread; portal quirks reported)]`. Nothing to submit unless the flagged file is ours.
2. **Corporate Defender for Endpoint:** the tenant admin adds an *allow* file-hash or certificate indicator (OpenJS Foundation `.cer`/`.pem`) or an exclusion `[https://learn.microsoft.com/defender-endpoint/indicator-file]`; other EDRs have equivalent allowlists. Exceptions should match exact path, parent and command line, not a bare filename `[https://www.elastic.co/guide/en/security/current/proxy-execution-via-console-window-host.html]`. Docs give the exact `node.exe ... daemon start` command line to allowlist.
3. Policy can prohibit task creation outright `[https://learn.microsoft.com/en-us/answers/questions/2198556/group-policy-prohibit-new-task-creation-is-applied]`; `available()` then returns unavailable with stderr and writes nothing.

## Decisions

| # | Decision | Choice | Alternatives | Why |
|---|---|---|---|---|
| D1 | Definition | XML via `schtasks /create /xml /f` | flags only; `Register-ScheduledTask`; COM | Flags lack settings; PowerShell is a LOLBin; no deps allowed |
| D2 | Action | `node.exe <cli> daemon start` launcher | daemon directly; conhost headless; S4U | No persistent window, no DPAPI loss, no exit 75 |
| D3 | Logon type | InteractiveToken, LeastPrivilege | S4U; Password | No password; full user token for jobs |
| D4 | Trigger | LogonTrigger(user SID) + 30 s delay | boot; any user | Login-only per brainstorm; delay avoids logon storm |
| D5 | Time limit | `PT0S` | default 72 h | Default kills long-lived instances |
| D6 | Hidden | false | true | Transparency |
| D7 | Inspect | `/query /xml` + csv by column | `/fo LIST /v` | Locale-independent |
| D8 | Identity | SID | `DOMAIN\user` | Locale/format independent |
| D9 | Folder cleanup | Leave empty `\crontick` | COM delete | schtasks cannot; harmless |

## Manual steps (owner-only)

1. Real Windows 10/11 check as a **standard (non-admin) user**: `enable`; log off/on; `crontick status` shows daemon up; note the flash; `taskschd.msc` shows `\crontick\daemon` with author/description; demand-start first then `enable` causes no second daemon; `disable` removes it.
2. Repeat on a Defender-for-Endpoint/corporate device if available; record any alert and the allowlist entry used.
3. Non-English Windows and a profile path with space/non-ASCII: `status` sanity check.
4. Sign off the core deltas below.

## Risks / Open Questions

- [OPEN] **1 (blocking): does the detached daemon survive the task instance ending?** Windows-CI test (run task, wait for completion, assert daemon pid alive and API answers); fallback per Architecture.
- [OPEN] **2: standard users creating the `\crontick\` folder/task.** No source found states it either way: ITaskFolder::CreateFolder docs list no privilege requirement, and "only Administrators can schedule tasks" in the schtasks docs sits under `/ru System` `[https://learn.microsoft.com/windows/win32/api/taskschd/nf-taskschd-itaskfolder-createfolder ; schtasks-create]`. Self-owned tasks are commonly created by standard users but this is untested here; CI runners are admin. If folder creation fails, fall back to root-level `\crontick-daemon` (changes a locked decision; owner sign-off).
- [OPEN] **3:** `/query /xml` stdout code page/BOM; tolerant parser, test on non-English host.
- [OPEN] **4:** `/xml` with SID `UserId` for a non-admin registering for itself; `LogonTrigger` behaviour for domain/Azure AD accounts.
- [OPEN] **5:** No OS-level user toggle (Settings > Startup apps) appears to cover tasks; `Settings/Enabled` is all we can detect. Confirm.
- [OPEN] **Core delta A (SP07 sign-off):** `AutostartSpec` gains `cliScript: string` (absolute `dist/cli/index.js`), used only by this backend. Confirm it runs directly under `node.exe` (not via the bin shim).
- [OPEN] **Core delta B:** drift compares `inspect().command` to `backend.expectedCommand(spec)` (new optional method, default `[daemonScript]`).
- [OPEN] **CRONTICK_SUPERVISED / env:** Windows does not use it. Task actions have no env block, so `CRONTICK_HOME` set at enable time would be lost at logon. Options: pass via a CLI dir arg (SP01 `--dir`, if it applies to `daemon start`), or document the limitation and flag drift. Needs decision.
- [DEFERRED] S4U or boot start; GUI-subsystem launcher to remove the flash; deleting the empty folder; node.exe signature check as a status note.

## Acceptance Criteria

1. Factory returns the schtasks backend for `win32`; `crontick autostart enable|disable|status` work on Windows via SP07's service with only deltas A/B.
2. XML snapshot contains exactly the settings above (`PT0S`, battery flags false, `IgnoreNew`, `LeastPrivilege`, SID-scoped `LogonTrigger`, `Hidden=false`).
3. Unit tests (fake exec/fs) pass on ubuntu and windows CI per the Testing list; no code path calls `reg.exe`, PowerShell, `wscript` or `conhost`; rewritten guard test passes.
4. Windows-only integration test: enable/disable round trip leaves no task, and a launcher-survival test proves [OPEN] 1 (or the fallback is chosen and this PRD re-specified).
5. `inspect()` never throws on missing task, empty output, garbage or localized text; reinstall and double uninstall are idempotent.
6. Docs (`security.md` EDR section rewritten from the table above, reference, lifecycle, ADR) state login-only, brief console flash, no admin, no signing needed, how to allowlist.
7. `npm run validate` passes; Manual steps 1-3 results recorded on the PR.
