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
name, and `tests/surface-drift.test.ts` fails CI if the client prototype, the built
CLI's `--help` output, or the live MCP tool listing disagree with that table. The CLI
itself is organized by noun (`jobs`, `runs`, `stats`, `share`, plus `daemon`/`info`/`mcp`)
rather than as a flat command list; job creation assigns a server-side GUID automatically
(see [ADR 0002](0002-prompt-only-jobs-and-engine-adapters.md)) rather than taking a
user-supplied id positional, and most read/admin operations (`doctor`, daemon
stop/reload, storage paths, dashboard URL) are folded under `crontick info` rather than
kept as separate top-level commands.

### Demand-started daemon, no reboot autostart

The daemon is not an OS service. The first CLI command, MCP call, or library method that
needs it starts it transparently (`ensureDaemon()`), guarded by a PID file and an
exclusive startup lock, with health polling before control returns to the caller. There
is no systemd unit, launchd agent, Windows service, or login-item/registry autostart
mechanism -- an earlier, native-dependency-based autostart feature was removed and is
guarded against reintroduction by `tests/unit/autostart-removal.test.ts`
(see `AGENTS.md` rule 8). That guard test intentionally scans only product and
packaging paths (`src/`, `plugin/`, `scripts/`, `README.md`, `package.json`,
`package-lock.json`, `tsup.config.ts`) and not `docs/`/`CHANGELOG.md`, so that this ADR
and the changelog can keep discussing the removed feature by name without tripping CI --
every real reappearance vector still lives in a scanned path. The trade-off is explicit:
if nothing invokes crontick, scheduled jobs simply do not fire until something does.

### Loopback HTTP as the only IPC transport

The daemon exposes a plain HTTP/1.1 API bound to `127.0.0.1:0` (OS-assigned port,
recorded in a `daemon.port` file for client discovery). The server rejects any
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
the source of truth for what is scheduled. Run history and logs live in a WAL-mode
SQLite database (`node:sqlite`, no native addon), because that access pattern is
append-heavy and query-heavy in a way flat files are not. `runs`/`run_logs` are capped
per job (`retention.maxRunsPerJob`, default 100): only terminal runs are eviction
candidates, oldest evicted first, in batches of 500 (SQLite's bound-parameter limit
forces batching), best-effort so a pruning failure never blocks a run insert or daemon
startup. The full schema is created in one idempotent `CREATE TABLE/INDEX IF NOT EXISTS`
pass on every `open()` -- there is no migration framework, no schema-version table, and
no `ALTER TABLE` upgrade path. Pre-1.0, this is a deliberate simplification, not an
oversight: crontick has no released schema and no real installs to preserve compatibility
with, so a `runs.db`/job file from an earlier crontick version is unsupported input, and
a capability that is removed is deleted outright rather than kept behind a compatibility
shim (no dead code, no legacy branches -- see `docs/tech/design-principles.md` #6). Both
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
`src/logger.ts`, not per-surface masking rules. Persisted run-log capture uses a
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

Deleting a job removes its runs, run logs, schedule state and per-job log file in one
transaction instead of archiving the runs; orphans left by older versions are purged at
daemon start. This keeps `runs list`, `runs get`, stats and the dashboard consistent (the
earlier archive behavior only hid runs from some of them). Share files (`schema: 1`) carry
job definitions only: no run history and no ids, so an import always mints new ids and
suffixes alias collisions rather than overwriting. Cron schedules fire in machine local time
(the per-job `tz` field was removed), and `config.json` is created with the full defaults on
first use and never overwritten (trade-off: later built-in default changes do not reach
users who already have the file).

## Consequences

**Easier:** one place to add a capability (client method, then a drift-test-checked
mechanical addition to CLI/MCP/table); no privileged install step on any platform;
`runs.db` growth is bounded without manual cleanup; a user can always tell whether a
scheduled fire actually happened; a daemon restart has one cross-platform answer for
in-flight work; redaction behavior is consistent everywhere and testable as a corpus.

**Harder:** surface-specific affordances need an explicit allowlist entry
(`NON_PARITY_CLIENT_METHODS`); if nothing triggers the daemon, jobs silently do not fire
until something does; a `runs.db`/job file from before 1.0.0 is not supported input;
diagnosing "why is my run gone" requires knowing about the retention cap; a truly bare,
context-free AWS secret may not be redacted.

**Impossible (by design):** a surface-only feature without core support; jobs firing
while the daemon is fully stopped and nothing has triggered it since; automatic
replay/catch-up of a missed fire; opening a pre-1.0.0 database and having it work;
reintroducing OS-level autostart or removed legacy/migration code without the explicit
sign-off `AGENTS.md` rule 8 requires.

## Revisit when

- The number of capabilities exceeds ~80-100 and the monolithic client class becomes
  unwieldy, or a surface needs execution semantics that cannot be request/response.
- Users report frequent missed ticks from the daemon not running, at which point an
  opt-in `install-service` command (not a changed default) could be considered.
- crontick ships a schema- or identity-breaking change after it has real 1.x installs --
  at that point, introduce a minimal schema-version marker and a real migration
  mechanism scoped forward from that release, not a resurrection of the pre-1.0 approach.
- A future transport replaces loopback HTTP, or repeated reports show the 2-second
  graceful-stop timeout is wrong for real workloads.
- Users repeatedly ask for opt-in catch-up of the most recent missed fire, or crontick
  gains a new high-confidence secret-detection signal that doesn't risk false positives.
