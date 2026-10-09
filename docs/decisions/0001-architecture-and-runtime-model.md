# 0001: Architecture and runtime model

- Status: Accepted
- Date: 2026-10-01 (amended; originally 2026-09-28)
- Supersedes: former ADRs 0001, 0003, 0004, 0005, 0011 (surface-drift portion only; the
  vitest tooling choice moves to [ADR 0003](0003-toolchain-and-distribution.md)), 0012,
  0013, 0014, 0015, 0016, 0017, 0020 (the generic detached-spawn exception only; the
  PowerShell script-job portion is obsolete -- see [ADR 0002](0002-prompt-only-jobs-and-engine-adapters.md)),
  0022, 0023, 0024, 0026, 0027.

## Context

crontick is a single-machine, single-user local scheduler shipped as one npm package
with three public surfaces (CLI, MCP server, library) and one background daemon. Between
2026-07-18 and 2026-08-03, thirty-plus individually-numbered ADRs accumulated to record
this shape one decision at a time: how the surfaces stay in sync, how the daemon starts
and stops, how it talks to clients, how it persists state, how it reports gaps, and how
it protects secrets in output. Read individually, those records are accurate; read as a
set, they fragment one coherent runtime model into many small documents, several of
which have since been narrowed, amended, or partially superseded by a later one (e.g.
0016 by 0020, 0022 by 0023). The owner asked for the ADR set to be compressed to the
decisions that are still load-bearing today, consolidated by theme, with historical
detail that no longer matters to a reader dropped.

This ADR is the architecture/runtime consolidation. It covers everything about *how
crontick is built and run*, independent of what a job's action actually does (that is
[ADR 0002](0002-prompt-only-jobs-and-engine-adapters.md)) and independent of which
specific third-party libraries implement a given layer (that is
[ADR 0003](0003-toolchain-and-distribution.md)).

## Decision

### Single core, thin shims, mechanical surface parity

All business logic lives in one core module, `CrontickClient` (`src/client.ts`). The
CLI (`src/cli/`), MCP server (`src/mcp/`), and library export (`src/index.ts`) are thin
adapters: each parses its own transport's input, calls one client method, and formats
the response. None contains its own validation, orchestration, or error construction.
Parity is enforced mechanically, not by review discipline alone: `SURFACE_CAPABILITIES`
(`src/surface.ts`) maps every capability to its client method, CLI command, and MCP tool
name, and `tests/unit/surface-drift.test.ts` fails CI if the client prototype, the built
CLI's `--help` output, or the live MCP tool listing disagree with that table. The CLI
itself is organized by noun (`jobs`, `runs`, `stats`, `share`, plus `daemon`/`info`/`mcp`)
rather than as a flat command list; job creation assigns a server-side GUID automatically
(see [ADR 0002](0002-prompt-only-jobs-and-engine-adapters.md)) rather than taking a
user-supplied id positional, and most read/admin operations (`doctor`, daemon
stop/reload, storage paths, dashboard URL) are folded under `crontick info` rather than
kept as separate top-level commands.

### Demand-started daemon, opt-in autostart

The daemon is not an OS service. The first CLI command, MCP call, or library method that
needs it starts it transparently (`ensureDaemon()`), guarded by a PID file and an
exclusive startup lock, with health polling before control returns to the caller. There
is no default systemd unit, launchd agent, Windows service, or login-item/registry
autostart: nothing registers with the OS unless the user runs the explicit, opt-in
`crontick autostart enable` (see "OS autostart (ADR 0034)" below). An earlier,
native-dependency-based autostart feature was removed; the replacement is guarded by
`tests/unit/autostart-removal.test.ts` (see `AGENTS.md` rule 8), which still bans
`registry-js`, `reg.exe`, Run-key and `.vbs` shim mechanisms. That guard test intentionally scans only product and
packaging paths (`src/`, `plugin/`, `scripts/`, `README.md`, `package.json`,
`package-lock.json`, `tsup.config.ts`) and not `docs/`/`CHANGELOG.md`, so that this ADR
and the changelog can keep discussing the removed feature by name without tripping CI --
every real reappearance vector still lives in a scanned path. The trade-off is explicit:
unless the user opts in to autostart, if nothing invokes crontick, scheduled jobs simply do
not fire until something does.

### Loopback HTTP as the only IPC transport

The daemon exposes a plain HTTP/1.1 API bound to `127.0.0.1` on the default port `47615`, falling back to an OS-assigned
free port when it is taken (amended by SP04: originally always OS-assigned). The actual port is
recorded in a `daemon.port` file for client discovery. The server rejects any
connection whose `remoteAddress` is not a loopback address; there is no TLS and no auth
token, because the loopback restriction is the entire trust boundary. Shutdown is
graceful and cross-platform through this same channel: `POST /api/daemon/stop` responds
only after flushing, then runs the identical shutdown sequence signal handlers use, and
`stopDaemon()` tries this route first before falling back to `SIGTERM` (a fallback that
matters only when the HTTP listener itself is unreachable). This gives every platform,
including Windows (which has no cooperative-shutdown signal), the same observable
contract: `mode: "graceful" | "hard-kill" | "already-stopped"`.

### State: SQLite WAL plus JSON job files, capped and unmigrated

Job definitions are human-editable, diffable JSON files (`<dataDir>/jobs/<id>.json`) --
the source of truth for what is scheduled. Run history and parsed run output live in a WAL-mode
SQLite database (`node:sqlite`, no native addon), because that access pattern is
append-heavy and query-heavy in a way flat files are not. `runs`/`run_outputs` are capped
per job (`retention.maxRunsPerJob`, default 100): only terminal runs are eviction
candidates, oldest evicted first, in batches of 500 (SQLite's bound-parameter limit
forces batching), best-effort so a pruning failure never blocks a run insert or daemon
startup. The full schema is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS`
pass on every `open()` -- there is no migration framework, no schema-version table, and
no `ALTER TABLE` upgrade path. Pre-1.0, this is a deliberate simplification, not an
oversight: crontick has no released schema and no real installs to preserve compatibility
with, so a `runs.db`/job file from an earlier crontick version is unsupported input, and
a capability that is removed is deleted outright rather than kept behind a compatibility
shim, deprecated alias or tolerant reader (no dead code, no legacy branches -- see `docs/tech/design-principles.md` #6). Both
policies are revisited together once crontick has real 1.x installs to protect.

### Process lifecycle: detached children, reported not replayed

Every job process is spawned `detached: true, windowsHide: true`, unconditionally and
identically on POSIX and Windows, so the daemon exiting (gracefully or via crash) never
kills in-flight job work as a side effect; a restart reconciles surviving children by pid
and start-time liveness instead of losing track of them. The one narrow, permanent
exception: when the resolved spawn command's basename is `pwsh`/`powershell.exe` on
Windows, the process is spawned attached instead, because a fully detached process gets
no console on Windows and a PowerShell host writes nothing without one -- this exception
is keyed off the command basename, not the job's action kind, so it still applies to any
future command (including a prompt-engine binary) that happens to be a PowerShell host.
Separately, because the daemon only fires jobs while running, a fire that happened during
a stopped period is unrecoverable after the fact -- crontick does not pretend otherwise.
On startup, every fire that provably should have happened since the last recorded tick
becomes a terminal `missed` run (capped at 500 per job), visible in `daemon status` and
`runs list --status missed`. Missed fires are reported, never replayed: crontick will not
guess whether a stale action is still safe to run, and will not queue a burst of
catch-up executions for a job that was due many times during a long gap.

### Shared, precision-first secret redaction

Every surface that emits user-visible text (CLI, MCP, dashboard, config reads, exports,
daemon logs, persisted run output) redacts secrets through one shared contract in
`src/logger.ts`, not per-surface masking rules. Captured engine output uses a
streaming redactor so a private-key block is still recognized when its `BEGIN`/body/`END`
lines arrive in separate stdout/stderr chunks; read-time redaction remains as defense in
depth. Key-hint matching uses precise, high-confidence suffixes (`api_key`,
`client_secret`, `private_key`, etc.) and explicitly excludes broad substring traps
(`NON_SECRET`, `monkey`). AWS secret-access-key redaction fires only on key-hint or
access-key-id-proximity context; the earlier standalone 40-character heuristic was
removed after it redacted a benign base64 payload in real output, exports, and the
dashboard. crontick chooses precision over recall here deliberately: silently corrupting
benign user data is itself a data-integrity bug, worse than occasionally leaving an
unlabeled bare secret unredacted.

### Amendment (2026-10-01): deleting a job deletes its history

Deleting a job removes its runs, stored run output, schedule state and per-job log file in one
transaction instead of archiving the runs. This keeps `runs list`, `runs get`, stats and the dashboard consistent (the
earlier archive behavior only hid runs from some of them). Share files (`schema: 1`) carry
job definitions only: no run history and no ids, so an import always mints new ids and
suffixes alias collisions rather than overwriting. Cron schedules fire in machine local time
(there is no per-job `tz` field; a `tz` in a stored job file is silently ignored, with no warning or log), and `config.json` is created with the full defaults on
first use and never overwritten (trade-off: later built-in default changes do not reach
users who already have the file).

### Amendment (2026-10-01): crontick stores only its own logs

The engine (e.g. Claude) already keeps its own transcript, so crontick no longer copies the
engine's raw stdout/stderr anywhere: the `run_logs` table, `appendLog`/`getLogs`/`tailLogs`, the
`/api/runs/:id/logs` and `/logs/stream` routes and the per-job mirror of engine output are removed.
While a run executes, the runner parses the engine stream line by line as it arrives and keeps
in memory only the final `result` event and the full stderr (plain stdout of non-stream engines
is still bounded by `retention.maxOutputBytesPerRun`, and stderr by a fixed 1,000,000-byte cap); when the run finishes it stores just that
result, error and stderr in `run_outputs`. Assistant text segments are not kept. For Claude,
`transcriptPath` is the path reported by the SessionEnd hook once the run ends, else the computed
`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl`; crontick never reads
the transcript. crontick's own scheduling and execution events are written to one per-job file
`<logsDir>/<jobId>.log` (one timestamped, run-id-tagged line per event). Every surface that
displays logs (`runs get`, the dashboard run detail, `GET /api/runs/:id/output`) shows only the
log file and transcript absolute paths as plain text (a Copy button in the dashboard, `file not
found` when missing), never file contents; there is no route serving them. Total run counts were
dropped from stats and the dashboard, and the remaining legacy/back-compat code (orphan purge at
daemon start, `avgDurationMs`) was deleted. Trade-off: output of a run that is still executing is
not visible until it finishes, and the output of a run adopted after a daemon restart is not
captured.

### OS autostart (ADR 0034, 2026-10-09)

**Status:** accepted. Rule 8 reintroduction signed off by the owner; this section is the recorded rationale. SP08 (macOS) and SP09 (Windows) subsections follow.

**Context.** Demand-start only fires when something calls crontick, so after a reboot schedules do nothing until then. The earlier autostart was removed (PR #16) because of a native `registry-js` dependency, a Windows Run key plus a hidden VBS shim (EDR-flagged persistence), and surprise background processes.

**Decision.** Reintroduce autostart as an explicit opt-in, never a default and never automatic on install or first run: `crontick autostart enable|disable|status` (CLI and library). It registers the daemon with the OS *user-level* service manager so it starts at login. The design:

- *Platform-neutral core, pluggable backends.* `AutostartService` builds the spec (Node path, daemon script, `CRONTICK_SUPERVISED=1`, optional `CRONTICK_HOME`, `PATH` snapshot), checks availability, maps failures to `AUTOSTART_*` errors and computes drift (`stale`) once. Each platform implements the small `AutostartBackend` interface (`available`, `install`, `uninstall`, `inspect`, optional `expectedCommand`); `createAutostartBackend` switches on platform. No new dependencies, no admin rights, no system-wide units.
- *No daemon API route.* Registration is a local OS side effect that must work with the daemon down; the client calls the core directly and shims stay thin.
- *MCP exposes status only.* An agent must not create login persistence, so enable/disable are not MCP tools. This is a deliberate surface-parity exception encoded as `mcpExemption` in `SURFACE_CAPABILITIES` and in `tests/unit/surface-drift.test.ts`; the CLI and library keep all three.
- *Coexists with demand-start.* The registration sets `CRONTICK_SUPERVISED=1`; a supervised daemon that finds another already running exits 0 (unsupervised still exits non-zero), so `Restart=on-failure`-style supervisors do not crash-loop. Alternatives rejected: a dedicated exit code with `SuccessExitStatus` (launchd cannot express it), `Restart=always`, stopping the running daemon before enable.
- *Transparent.* The Linux backend writes a readable `crontick.service` unit; `status` detects stale registrations (moved Node or package, changed `CRONTICK_HOME`); fix is re-running `enable`.
- *Guard reversal.* `tests/unit/autostart-removal.test.ts` keeps the `registry-js` dependency check and now also bans `hkcu`, `currentversion\run`, `wscript` and `.vbs` in shipped paths, but no longer bans the word "autostart".

**Linux backend (SP07).** `systemd --user` unit at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/crontick.service` with `Restart=on-failure`, `RestartSec=5` and `KillMode=process` (detached runs are re-adopted after a daemon restart; the default cgroup kill would terminate them). `daemon start --home <dir>` was added so platforms that cannot carry environment variables in the registration (Windows task actions) can still select a data directory.

**Consequences / trade-offs.** Harder: without `loginctl enable-linger`, the user manager stops at last logout and jobs pause while fully logged out (a demand-started daemon survives logout); the `PATH` snapshot goes stale when an engine is installed later; uninstalling the package leaves the unit unless `autostart disable` is run first. Deferred: linger management, multiple data directories per user, `systemd-analyze verify` in CI.

#### macOS (launchd) (SP08)

**Mechanism.** A user LaunchAgent, label `dev.crontick.daemon`, file `~/Library/LaunchAgents/dev.crontick.daemon.plist`, loaded with `launchctl bootstrap gui/$UID` and removed with `bootout`. Login only (`RunAtLoad`), no admin, no signing, no new dependencies. The plist is rendered by string with XML escaping (`src/autostart/plist.ts`) and holds the `ProgramArguments` (node path, daemon script), the core-built `EnvironmentVariables` (`CRONTICK_SUPERVISED=1`, optional `CRONTICK_HOME`, `PATH` snapshot), `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 30`, `AbandonProcessGroup true` (analogue of systemd `KillMode=process`), `WorkingDirectory` = data dir, and `StandardOut/ErrorPath` = `<logsDir>/launchd.{out,err}.log`. `ProcessType` is omitted because `Background` would throttle engine runs.

**Idempotency.** `install` never blind-bootstraps: it checks whether the label is loaded, boots it out, bootstraps, then runs `enable`; a failure with a lingering disable record is retried once after `enable`. `uninstall` boots out (ignoring "not loaded") and deletes the plist. `inspect` is read-only and tolerant: `launchctl print` output is documented as not-an-API, so only `pid`/`state` are parsed and unparseable output yields an unknown state plus a note, never a throw.

**Caveats.** macOS 13+ surfaces every third-party plist in Login Items with a "Background Items Added" notification; unsigned items appear as a generic "node" entry from an unidentified developer, and the user can toggle it off. That BTM toggle is separate from launchd's disable database and cannot be read without `sfltool dumpbtm` (undocumented, needs sudo), so status infers it from `print-disabled` and "registered but not loaded" with a note. A launchd-started `node` has no Full Disk Access (TCC), so protected-folder job directories may be denied; and Claude may report "Not logged in" under launchd, in which case `CLAUDE_CODE_OAUTH_TOKEN` is set through the engine env config rather than the plist.

**Rejected.** LaunchDaemon (needs root, boot start, no GUI keychain); legacy `launchctl load/unload/list` (exit 0 on failure); `SMAppService` or a signed/notarized helper bundle (US$99/yr, tracked in `futures.md`); `sfltool` for BTM state; `ProcessType=Background`. There is no macOS CI runner, so correctness rests on injected-exec unit tests (`platform: 'darwin'`) plus the owner checklist below.

**Owner real-Mac checklist (macOS 13+, ideally 15; record results on the PR before release; not verified on Linux).**
1. `crontick autostart enable` writes the plist, shows the "Background Items Added" notification, and `launchctl print gui/$UID/dev.crontick.daemon` shows running. After logout/login the daemon is up. A second `enable` is a no-op, `status` shows enabled, and `disable` removes the plist and the Login Items entry. Demand-start then `enable` leaves no respawn loop in `launchd.err.log`.
2. Approve the item in Login Items if asked; toggle it off and confirm `status` reports not running with the note. Record the displayed name/developer. Verify whether a BTM toggle appears in `print-disabled` and the error 5 re-enable behavior.
3. Run a job with cwd in `~/Documents` and a Claude-engine job under autostart; record the TCC and "Not logged in" outcomes here.
4. Verify `daemon stop` / `bootout` leaves a detached job alive, and note TCC attribution after restart.
5. Confirm `launchctl print` parsing on each available macOS version.
6. Optional: signed+notarized helper or `SMAppService` (out of scope).

**Outcome of items 1-5: pending (owner, real Mac).**

#### Windows (Task Scheduler) (SP09)

**Mechanism.** A per-user logon task `\crontick\daemon` created with `schtasks /create /tn "\crontick\daemon" /xml <file> /f` (XML written UTF-16LE under `<data dir>\autostart\task.xml`, deleted afterwards) and removed with `schtasks /delete ... /f`. XML rather than flags because flags cannot express `ExecutionTimeLimit`, battery settings, `MultipleInstancesPolicy` or a trigger `UserId`; Task Scheduler's defaults (72 h stop, stop on battery) would hurt a daemon. The user is identified by SID (locale and domain-format independent). Inspect reads `/query /xml` (element names) and `/query /fo csv /v /nh` by column index; localized text is never relied on.

**Registered command.** `node.exe <dist>\cli\index.js daemon start` (plus `--home "<dir>"` when `CRONTICK_HOME` was set), a short-lived launcher that spawns the existing detached daemon. This avoids a permanent console window the user could close (killing the daemon) and the already-running exit-code problem, since `daemon start` exits `0` when a daemon is up. Drift compares against `backend.expectedCommand(spec)`.

**Login only, no admin, nothing to sign.** `LogonTrigger` for the current user (30 s delay), `InteractiveToken`, `LeastPrivilege`; no boot start, no "run whether logged on or not". crontick ships JavaScript only, so there is nothing of ours to Authenticode-sign or submit; `node.exe` is signed by the OpenJS Foundation. No Run key, registry, wscript, cmd, PowerShell or conhost.

**Console flash.** The logon task runs a console-subsystem `node.exe`, so a console window may flash for under a second while the launcher runs. Removing it needs a GUI-subsystem binary, which we will not ship. `Hidden` stays `false` on purpose (hiding is what malware does).

**Survival gate.** Whether a detached child outlives the task instance was the make-or-break unknown; a Windows CI test (84a1b9d) proved it before the backend was built [verified: https://github.com/tejitpabari99/crontick/actions/runs/37876631912]. The backend integration test also passes on CI [verified: https://github.com/tejitpabari99/crontick/actions/runs/37879341731], but GitHub-hosted runners are administrators, so the non-admin claim is not proven by CI.

**Security tools.** There is no official pre-clearing program; see `SECURITY.md` (Windows autostart and security tools) for the levers and allowlisting steps.

**Rejected.** `node.exe daemon.js` directly (persistent closable console); `conhost.exe --headless` (still flashes, published detection rule); S4U / password logon (no network or DPAPI access, or needs a password); `schtasks /sc onlogon /tr` flags; PowerShell `Register-ScheduledTask` or COM (LOLBin, dependencies); the removed `registry-js` Run-key + VBS shim; deleting the empty `\crontick` folder (schtasks cannot, harmless, left behind).

**Known risk.** Creating the `\crontick\` folder and task as a standard user is unverified (no source states it either way; CI runners are admin). The pre-approved fallback is a root-level `\crontick-daemon` task; it is **not implemented**. If the owner check fails, implement it.

**Owner real-Windows checklist (record results on the PR before release).**
1. As a standard (non-admin) user: `enable`, log off/on, `crontick status` shows the daemon up; note the console flash; check `\crontick\daemon` in `taskschd.msc` (author, description); demand-start then `enable` yields no second daemon; `disable` removes it. This also settles the folder-creation risk above.
2. Repeat on a Defender-for-Endpoint/corporate device if available; record any alert and the allowlist entry used, or a WDSI submission.
3. Non-English Windows and a profile path with a space and a non-ASCII name: `status` sanity check.
4. Optionally confirm the `node.exe` Authenticode signature.

**Outcome of items 1-4: pending (owner, real Windows).**

<!-- ADR 0034 platform sections: SP08 added "macOS (launchd)" and SP09 added "Windows (Task Scheduler)" above this line, each covering mechanism, registered command, caveats and rejected alternatives. -->

## Consequences

**Easier:** one place to add a capability (client method, then a drift-test-checked
mechanical addition to CLI/MCP/table); no privileged install step on any platform;
`runs.db` growth is bounded without manual cleanup; a user can always tell whether a
scheduled fire actually happened; a daemon restart has one cross-platform answer for
in-flight work; redaction behavior is consistent everywhere and testable as a corpus.

**Harder:** surface-specific affordances need an explicit allowlist entry
(`NON_PARITY_CLIENT_METHODS`); unless autostart is enabled, if nothing triggers the daemon, jobs silently do not fire
until something does; a `runs.db`/job file from before 1.0.0 is not supported input;
diagnosing "why is my run gone" requires knowing about the retention cap; a truly bare,
context-free AWS secret may not be redacted.

**Impossible (by design):** a surface-only feature without core support; jobs firing
while the daemon is fully stopped and nothing has triggered it since; automatic
replay/catch-up of a missed fire; opening a pre-1.0.0 database and having it work;
reintroducing the removed mechanisms (native dependencies, Run key / VBS shim) or removed
legacy/migration code without the explicit sign-off `AGENTS.md` rule 8 requires;
creating login persistence from an MCP tool.

## Revisit when

- The number of capabilities exceeds ~80-100 and the monolithic client class becomes
  unwieldy, or a surface needs execution semantics that cannot be request/response.
- Users want autostart on by default or while logged out (linger), or system-wide units; autostart is deliberately opt-in and user-level today (ADR 0034).
- crontick ships a schema- or identity-breaking change after it has real 1.x installs --
  at that point, introduce a minimal schema-version marker and a real migration
  mechanism scoped forward from that release, not a resurrection of the pre-1.0 approach.
- A future transport replaces loopback HTTP, or repeated reports show the 2-second
  graceful-stop timeout is wrong for real workloads.
- Users repeatedly ask for opt-in catch-up of the most recent missed fire, or crontick
  gains a new high-confidence secret-detection signal that doesn't risk false positives.
