# 004: Daemon

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors changing the daemon process, its HTTP API, or its lifecycle.
Non-duplication: this spec is the normative contract. For the demand-start/shutdown narrative
and rationale, see [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md); for the
route table and startup-sequence implementation, see
[implementation/daemon.md](../implementation/daemon.md).

## Summary

The crontick daemon is a single-instance Node.js process that listens on a loopback HTTP API,
manages the scheduler and runner, and persists state to SQLite and JSON files. It is
demand-started by clients and communicates via a port file.

## Motivation

A background daemon decouples job scheduling from the CLI/MCP lifecycle, enabling jobs to fire
on time even when no interactive session is open, without requiring OS service registration.

## Terminology

| Term | Definition |
|------|-----------|
| Demand-start | Automatic daemon launch by clients when no running daemon is detected. |
| Port file | A file containing the daemon's listening port, used for discovery. |
| PID file | A file containing the daemon's process ID, used for single-instance guard. |
| Health check | GET /health returning `{ ok, product, pid, port }`. |
| Loopback enforcement | Only connections from 127.0.0.1/::1 are accepted. |

## Requirements

### Functional requirements

- **R-004-1**: The daemon MUST listen on `127.0.0.1` only. It MUST prefer port `47615` (`daemon.port` in `config.json` overrides the preferred port; `0` means OS-assigned). If the preferred port is in use it MUST probe `/health` on it, report to stderr and the daemon log either `Port <p> is in use by another crontick daemon (pid N, data dir D); starting on a free port` or `Port <p> is in use by another process (not crontick); starting on a free port`, and bind an OS-assigned free port.
- **R-004-1a**: `daemon start`/`restart` MUST print `started on fallback port N; default 47615 is in use` when the daemon is not on the preferred port; `GET /api/daemon/status` MUST include `dashboardUrl` and `portNote`; `crontick info` MUST show the port and dashboard URL; `crontick doctor` MUST include a `daemon port` check.
- **R-004-2**: The daemon MUST write its port to the port file (`<dataDir>/daemon.port`) immediately after binding (the actual bound port, which may be a fallback).
- **R-004-3**: The daemon MUST write its PID to the PID file (`<dataDir>/daemon.pid`) before binding.
- **R-004-4**: The daemon MUST enforce single-instance: if a PID file exists and the process is alive, it MUST exit with code 1.
- **R-004-5**: If the PID file references a dead process, the daemon MUST remove the stale PID file and continue startup.
- **R-004-6**: The daemon MUST enforce loopback-only connections; requests from non-loopback addresses MUST receive 403 FORBIDDEN.
- **R-004-7**: GET /health MUST return `{ ok: true, product: "crontick", pid, port, version, startedAt, uptime, jobCount }`.
- **R-004-8**: On startup, the daemon MUST call `store.reconcileOrphanRuns(check)` to resolve any runs left in `running`/`queued` state by a prior process: `queued` runs are canceled unconditionally; `running` runs are checked against real process liveness via the recorded `pid` and adopted back into the `Runner` if alive (or inconclusive). A confirmed-dead run follows the completion-marker rule in R-004-34, then falls back to orphan cancellation.
- **R-004-34**: When restart reconciliation confirms a `running` process has exited, a valid Claude completion marker with the run's persisted session ID and integer exit status MUST determine `success`/`failed` and exit code; without a valid marker, orphan cancellation applies. The same check precedes the unknown-exit fallback when an adopted process later exits.
- **R-004-9**: On startup, the daemon MUST call `store.loadJobsFromDisk()` to reload job definitions.
- **R-004-10**: `POST /api/daemon/stop` MUST be the primary graceful shutdown mechanism, responding `200 { ok: true, stopping: true, pid, activeRuns }` before running the shutdown sequence in-process. `SIGINT`/`SIGTERM` handlers MUST invoke the same sequence as a POSIX-only fallback (Windows signal delivery to another process does not invoke handlers; callers MUST prefer the HTTP route, see R-004-22).
- **R-004-11**: On `uncaughtException` (unless EPIPE), the daemon MUST log the error, clean up PID/port files, and exit with code 1.
- **R-004-12**: The daemon MUST run SQLite in WAL journal mode with foreign keys enabled.
- **R-004-13**: On Node < 24, the daemon MUST re-exec itself with `--experimental-sqlite` if that flag is absent.
- **R-004-14**: Demand-start (`ensureDaemon`) MUST acquire an exclusive file lock (`daemon.ensure.lock`) before spawning a new daemon process.
- **R-004-15**: Demand-start MUST poll for a healthy daemon with bounded timeout (`startupTimeoutMs`, default 10s).
- **R-004-16**: If the lock cannot be acquired within `lockTimeoutMs` (default 15s), demand-start MUST throw `DAEMON_START_LOCK_TIMEOUT`.
- **R-004-17**: If the daemon process exits before becoming healthy, demand-start MUST throw `DAEMON_START_FAILED` with a stderr excerpt.
- **R-004-18**: If the daemon does not become healthy within `startupTimeoutMs`, demand-start MUST throw `DAEMON_TIMEOUT`.
- **R-004-19**: The health probe MUST validate `product === "crontick"`, that `pid`/`port` are positive integers, and that `port` matches the expected port.
- **R-004-20**: The daemon MUST log to `<dataDir>/logs/daemon-YYYY-MM-DD.log` (JSON lines).
- **R-004-21**: `POST /api/daemon/reload` MUST re-read config, unschedule all jobs, reload from disk, apply any changed retention caps, and reschedule enabled jobs. A config read failure MUST abort the reload with the prior schedule intact.
- **R-004-35**: The CLI MUST offer an explicit `crontick daemon start [--foreground]` (plus `daemon stop|restart|status|reload`). It is a manual, one-off start of the same demand-started daemon: it MUST NOT register the daemon with the OS to run at login or boot (that removed capability stays removed; see `tests/unit/autostart-removal.test.ts`). `daemon start`, `status`, and `restart` are CLI conveniences over library-only client methods (`daemonStart`, `daemonStatus`, `daemonRestart`) and are intentionally not MCP tools, because MCP clients already demand-start the daemon.
- **R-004-22**: `stopDaemon()` MUST prefer the graceful `POST /api/daemon/stop` route, escalating to `SIGTERM` then `SIGKILL` if the route stalls or is unreachable. It MUST report which path was used via `mode: 'already-stopped' | 'graceful' | 'hard-kill'`, and include `activeRuns` whenever available.
- **R-004-23**: `startDaemon=false` (option or env `CRONTICK_MCP_START_DAEMON=0`) MUST prevent demand-start from spawning; it MUST throw `DAEMON_NOT_RUNNING` instead.
- **R-004-24**: Stale lock files (older than `lockTimeoutMs` or held by a dead process) MUST be cleaned up by waiting clients.
- **R-004-27**: `POST /api/daemon/stop` MUST respond `200` before the shutdown sequence tears down the server; it MUST respond `501 NOT_IMPLEMENTED` if graceful shutdown is not wired for the context.
- **R-004-28**: On startup, before scheduling jobs, the daemon MUST compute and record any fires each enabled job missed while no daemon was running, using its `job_schedule_state` watermark and `Scheduler.enumerateFiresBetween()`, capped at `MISSED_FIRE_CAP_PER_JOB` (500) per job. Each missed fire MUST be recorded as a terminal `missed` run and MUST NOT be executed. Results MUST be summarized as `missedFireSummary` and returned by `GET /api/daemon/status`, which MUST also expose `port` and `baseUrl`.
- **R-004-29**: A job with no recorded watermark (never observed ticking live) MUST have its watermark seeded from the current time on startup rather than have a gap computed against it.
- **R-004-30**: On startup, and again on reload, the daemon MUST prune daily log files beyond `retention.maxLogFiles` (default 30, range 1..3650), best-effort.
- **R-004-31**: `DELETE /api/jobs/:id` MUST cancel the job's in-flight run, if any, and report `canceledRun: boolean`.
- **R-004-32**: `POST /api/jobs` MUST reject a duplicate job ID with HTTP 409 / `JOB_ALREADY_EXISTS` unless `force` is passed. Both create and update MUST validate the schedule and, when `action.envFile` is present, preflight it before any call to `Store.upsertJob()`.
- **R-004-33**: `crontick daemon stop`/`reload` MUST emit human-readable output; the CLI has no global `--json` mode.

### Non-functional requirements

- **R-004-25**: Daemon startup SHOULD complete within 5 seconds on typical hardware.
- **R-004-26**: The daemon SHOULD NOT require elevated/administrator privileges.

## Behavior

See [implementation/daemon.md](../implementation/daemon.md) for the full 18-step startup sequence and the
HTTP route table. In brief: guard single-instance -> open store -> prune logs -> load jobs ->
compute missed fires -> reconcile orphans -> schedule enabled jobs -> bind HTTP -> write port
file -> wire shutdown. Demand-start and shutdown mechanics (why HTTP-first, why POSIX signals are
a fallback only) are described in
[concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md).

## Inputs and outputs

**Daemon process input**: Environment variables (`CRONTICK_HOME`, `CRONTICK_VERBOSE`).
**Daemon process output**: Log file (JSON lines), port file, PID file.
**HTTP API**: Loopback REST; request/response is JSON.
**`ensureDaemon` output**: `DaemonInfo { baseUrl, port, pid, started }`.

## Edge cases and failure modes

- Port file exists but daemon is dead: health probe fails; demand-start proceeds.
- Two clients demand-start simultaneously: lock serializes; second client waits then finds a healthy daemon.
- Lock file left by a crashed process: cleaned up after `lockTimeoutMs` or if the PID is dead.
- Daemon script not found (not built): `NOT_BUILT` error with actionable message.
- Duplicate create without `force`: 409 / `JOB_ALREADY_EXISTS`, stored job unchanged.
- Invalid schedule, or missing/unreadable `action.envFile`, on create/update: rejected before any persistence.
- Health response with wrong product name: treated as unhealthy.

## Acceptance criteria

- [x] Single-instance guard rejects second daemon (test file: `tests/unit/daemon.ensure.test.ts`)
- [x] Demand-start spawns daemon and returns healthy info; stale PID file cleaned up (test file: `tests/unit/daemon.ensure.test.ts`)
- [x] Loopback enforcement returns 403 for non-local (test file: `tests/unit/security.test.ts`)
- [x] Health endpoint returns correct shape (test file: `tests/unit/health.test.ts`)
- [x] Orphan runs reconciled on startup, liveness-checked and adopted or canceled accordingly (test file: `tests/unit/store.test.ts`; `tests/unit/integration.persistence.test.ts`)
- [x] Lock timeout throws `DAEMON_START_LOCK_TIMEOUT`; `NOT_BUILT` thrown when daemon script missing (test file: `tests/unit/daemon.ensure.test.ts`)
- [x] `POST /api/daemon/stop` responds before the process exits and reports `activeRuns` (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] `stopDaemon` reports `mode: 'graceful'` on success and escalates to `SIGTERM`/`SIGKILL` (`mode: 'hard-kill'`) when the route stalls or is unreachable (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] `DELETE /api/jobs/:id` cancels the job's active run, reporting `canceledRun` (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] `POST /api/jobs` rejects duplicate IDs unless `force` is explicit; create/update validate schedules and `envFile` before persistence (test files: `tests/unit/job-create-duplicate.test.ts`, `tests/unit/job-create-atomicity.test.ts`, `tests/unit/env-file.test.ts`)
- [x] Startup prunes daemon log files beyond `retention.maxLogFiles`; reload applies a lowered cap without restart (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] Missed fires across a crash/restart are recorded as `missed` runs and surfaced in `info`'s `missedFires` summary (test files: `tests/unit/integration.daemon-lifecycle.test.ts`, `tests/unit/api.test.ts`, `tests/unit/daemon-status-fields.test.ts`)
- [x] Reload reschedules all jobs from disk, aborting cleanly on invalid config (test file: `tests/unit/integration.daemon-lifecycle.test.ts`)
- [x] `crontick daemon stop`/`reload` use human-readable CLI output (test file: `tests/unit/cli-daemon-json.test.ts`)

## Out of scope

- OS service registration (autostart was removed).
- Remote/network access (loopback only by design).
- TLS/authentication (trust boundary is localhost).

## Open questions

None.

## Related

- [003-execution.md](003-execution.md)
- [006-state-and-persistence.md](006-state-and-persistence.md)
- [../concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md)
- [../implementation/daemon.md](../implementation/daemon.md)
