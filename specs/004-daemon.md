# 004: Daemon

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-28

## Summary

The crontick daemon is a single-instance Node.js process that listens on a loopback
HTTP API, manages the scheduler and runner, and persists state to SQLite and JSON files.
It is demand-started by clients and communicates via a port file.

## Motivation

A background daemon decouples job scheduling from the CLI/MCP lifecycle, enabling jobs
to fire on time even when no interactive session is open. Demand-start eliminates the
need for OS service registration while ensuring the daemon is available when needed.

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

- **R-004-1**: The daemon MUST listen on `127.0.0.1` on a random available port (port 0).
- **R-004-2**: The daemon MUST write its port to the port file (`<dataDir>/daemon.port`) immediately after binding.
- **R-004-3**: The daemon MUST write its PID to the PID file (`<dataDir>/daemon.pid`) before binding.
- **R-004-4**: The daemon MUST enforce single-instance: if a PID file exists and the process is alive, it MUST exit with code 1.
- **R-004-5**: If the PID file references a dead process, the daemon MUST remove the stale PID file and continue startup.
- **R-004-6**: The daemon MUST enforce loopback-only connections; requests from non-loopback addresses MUST receive 403 FORBIDDEN.
- **R-004-7**: GET /health MUST return `{ ok: true, product: "crontick", pid: <number>, port: <number>, version, startedAt, uptime, jobCount }`.
- **R-004-8**: On startup, the daemon MUST call `store.reconcileOrphanRuns(check)` to resolve any runs left in `running` or `queued` state by a prior process (crash recovery): `queued` runs (never spawned) are canceled unconditionally, while `running` runs are checked against real process liveness via the recorded `pid` and adopted back into the `Runner` if the check finds the process still alive (or the check is inconclusive), or canceled if the check confirms the process is dead.
- **R-004-9**: On startup, the daemon MUST call `store.loadJobsFromDisk()` to reload job definitions from the jobs directory.
- **R-004-10**: `POST /api/daemon/stop` MUST be the primary graceful shutdown mechanism: it computes any `activeRuns` (runs still `status: 'running'`) and responds `200 { ok: true, stopping: true, pid, activeRuns }` before running the shutdown sequence in-process (stop accepting connections, unschedule all jobs, close the store, remove PID/port files, exit 0), working identically on every platform, since it does not depend on OS signal delivery. The daemon MUST also register `process.on('SIGINT'/'SIGTERM', ...)` handlers that invoke the same shutdown sequence, as a POSIX-only fallback path: on POSIX, `process.kill(pid, 'SIGINT'|'SIGTERM')` delivers a real signal and the handler runs; on Windows, `process.kill(pid, 'SIGINT'|'SIGTERM')` from another process unconditionally terminates the target without invoking any registered handler, so the signal path cannot be relied on there — callers on every platform MUST prefer the HTTP route (see R-004-22) and treat a `SIGTERM`/hard-kill as a fallback only.
- **R-004-11**: On uncaughtException (unless EPIPE), the daemon MUST log the error, clean up PID/port files, and exit with code 1.
- **R-004-12**: The daemon MUST run SQLite in WAL journal mode with foreign keys enabled.
- **R-004-13**: On Node < 24, the daemon MUST re-exec itself with `--experimental-sqlite` if that flag is absent.
- **R-004-14**: Demand-start (`ensureDaemon`) MUST acquire an exclusive file lock (`daemon.ensure.lock`) before spawning a new daemon process to prevent concurrent starts.
- **R-004-15**: Demand-start MUST poll for a healthy daemon (port file + health check) with bounded timeout (`startupTimeoutMs`, default 10s).
- **R-004-16**: If the lock cannot be acquired within `lockTimeoutMs` (default 15s), demand-start MUST throw `DAEMON_START_LOCK_TIMEOUT`.
- **R-004-17**: If the daemon process exits before becoming healthy, demand-start MUST throw `DAEMON_START_FAILED` with stderr excerpt.
- **R-004-18**: If the daemon does not become healthy within `startupTimeoutMs`, demand-start MUST throw `DAEMON_TIMEOUT`.
- **R-004-19**: The health probe MUST validate that `product === "crontick"`, `pid` and `port` are positive integers, and `port` matches the expected port.
- **R-004-20**: The daemon MUST log to `<dataDir>/logs/daemon-YYYY-MM-DD.log` (JSON lines).
- **R-004-21**: Daemon reload (POST /api/daemon/reload) MUST unschedule all jobs, reload from disk, and reschedule enabled jobs.
- **R-004-22**: `stopDaemon()` (`src/daemon/lifecycle.ts`, used by `crontick daemon stop`/`daemon restart`) MUST prefer the graceful `POST /api/daemon/stop` route (see R-004-10), reading the PID file to confirm a daemon is even claimed to be running, then issuing the HTTP request and polling for the process to exit. If the route accepts the request but the process does not exit within the poll timeout, or if the route is unreachable at all (connection refused, timeout, stale/missing port file), it MUST escalate: send `SIGTERM`, poll again, then send `SIGKILL` if the process still has not exited. It MUST report which path was used via a `mode: 'already-stopped' | 'graceful' | 'hard-kill'` result field, and MUST include the `activeRuns` reported by the daemon (see R-004-10) in the result whenever available.
- **R-004-23**: `startDaemon=false` (option or env `CRONTICK_MCP_START_DAEMON=0`) MUST prevent demand-start from spawning; it MUST throw `DAEMON_NOT_RUNNING` instead.
- **R-004-24**: Stale lock files (older than `lockTimeoutMs` or held by dead process) MUST be cleaned up by waiting clients.
- **R-004-27**: `POST /api/daemon/stop` MUST respond `200 { ok: true, stopping: true, pid, activeRuns }` before the shutdown sequence tears down the server, so the HTTP response is delivered to the caller; it MUST respond `501 NOT_IMPLEMENTED` if graceful shutdown is not wired for the context (e.g. a test harness without a real shutdown closure).
- **R-004-28**: On startup, before scheduling jobs, the daemon MUST compute and record any fires each enabled job missed while no daemon process was running, using its `job_schedule_state` watermark and `Scheduler.enumerateFiresBetween()`, capped at `MISSED_FIRE_CAP_PER_JOB` (500) per job. Each missed fire MUST be recorded as a terminal `missed` run (see R-006 series) and MUST NOT be executed. The results MUST be summarized as `missedFireSummary: { jobsWithMissedFires, missedRunsRecorded, jobsCapped, capPerJob }` and returned by `GET /api/daemon/status`.
- **R-004-29**: A job with no recorded `job_schedule_state` watermark (never observed ticking live) MUST have its watermark seeded from the current time on startup rather than have a gap computed against it, since there is no prior observation to diff against.
- **R-004-30**: On startup, and again on `POST /api/daemon/reload`, the daemon MUST prune daily log files under `<dataDir>/logs/` beyond `retention.maxLogFiles` (default 30, range 1..3650), deleting the oldest first and keeping the newest. Pruning MUST be best-effort: a failure MUST be logged but MUST NOT block startup or reload.
- **R-004-31**: `DELETE /api/jobs/:id` MUST cancel the job's in-flight run, if any, as part of the delete, and MUST report whether it did so via a `canceledRun: boolean` field in the response.
- **R-004-32**: `POST /api/jobs` MUST reject a duplicate job ID with HTTP 409 / `JOB_ALREADY_EXISTS` unless the caller passes `force=1` or `force=true` on the query string. Both `POST /api/jobs` and `PUT /api/jobs/:id` MUST validate the candidate schedule before any call to `Store.upsertJob()`; on failure they MUST return `VALIDATION_ERROR` and leave persisted job state unchanged.
- **R-004-33**: The CLI `crontick daemon start` and `crontick daemon restart` commands MUST honor the global `--json` flag the same way the other daemon lifecycle commands do, emitting exactly one structured JSON object on stdout for successful background operations. `crontick daemon start --foreground --json` MUST be rejected with `VALIDATION_ERROR` before launch because foreground mode streams daemon logs to stdout rather than producing one finite JSON object.

### Non-functional requirements

- **R-004-25**: Daemon startup SHOULD complete within 5 seconds on typical hardware.
- **R-004-26**: The daemon SHOULD NOT require elevated/administrator privileges.

## Behavior

**Startup sequence**:
1. Ensure data directories exist.
2. Initialize logger with daily log file.
3. Check single-instance guard (PID file).
4. Write PID file.
5. Open store (SQLite WAL mode, schema created in one idempotent pass -- no migrations).
6. Prune daily log files beyond `retention.maxLogFiles` (best-effort; R-004-30).
7. Load jobs from disk.
8. Create scheduler; compute and record missed fires per enabled job (R-004-28/R-004-29).
9. Create runner; reconcile orphan runs via process-liveness check, adopting live/inconclusive runs and canceling dead ones (R-004-8).
10. Schedule all enabled jobs.
11. Create HTTP API server.
12. Bind to 127.0.0.1:0; write port file.
13. Wire graceful shutdown into `POST /api/daemon/stop` and register signal handlers as a POSIX fallback (R-004-10).
14. Log "Daemon ready".

**Demand-start (ensureDaemon)**:
1. If explicit URL provided, probe health and return or throw.
2. Probe port file + health.
3. If not healthy and startDaemon=true, acquire lock.
4. Spawn daemon as detached child (`node <daemonScript>`).
5. Poll port file + health until healthy or timeout.
6. Return `DaemonInfo { baseUrl, port, pid, started: true }`.

**Shutdown sequence** (triggered by `POST /api/daemon/stop`, or by `SIGINT`/`SIGTERM` as a POSIX fallback — R-004-10):
1. Compute `activeRuns` (runs still `status: 'running'`) and respond to the caller (R-004-27).
2. Close HTTP server.
3. Unschedule all jobs.
4. Wait 100ms for in-flight I/O.
5. Close store.
6. Remove PID and port files.
7. Exit 0.

If the caller (`stopDaemon()`) finds the process still alive after polling for it to exit --
whether because the graceful route stalled or because it was unreachable in the first place --
it escalates: `SIGTERM`, poll again, then `SIGKILL` if still alive, reporting `mode: 'hard-kill'`
either way (R-004-22).

In-flight run processes are deliberately left running (they were spawned `detached: true`, except
the pwsh-on-Windows exception in R-003-25); the next daemon start's orphan reconciliation (R-004-8)
adopts or cancels them based on liveness.

## Inputs and outputs

**Daemon process input**: Environment variables (`CRONTICK_HOME`, `CRONTICK_VERBOSE`).
**Daemon process output**: Log file (JSON lines), port file, PID file.
**HTTP API**: Loopback REST; request/response is JSON.
**`ensureDaemon` input**: `EnsureDaemonOptions` (timeouts, scripts, env).
**`ensureDaemon` output**: `DaemonInfo { baseUrl, port, pid, started }`.

## Edge cases and failure modes

- Port file exists but daemon is dead: Health probe fails; demand-start proceeds.
- Two clients demand-start simultaneously: Lock serializes; second client waits then finds healthy daemon.
- Lock file left by crashed process: Cleaned up after `lockTimeoutMs` or if PID is dead.
- EPIPE on stderr (parent detached): Swallowed silently.
- Daemon script not found (not built): `NOT_BUILT` error with actionable message.
- Port file contains non-integer: Treated as absent.
- Duplicate create without `force`: API returns 409 / `JOB_ALREADY_EXISTS` and leaves the stored job unchanged.
- Invalid schedule on create/update: API returns `VALIDATION_ERROR` before any persistence, so create writes nothing and update preserves the prior job.
- Health response with wrong product name: Treated as unhealthy (not our daemon).

## Acceptance criteria

- [x] Single-instance guard rejects second daemon (test file: `tests/daemon.ensure.test.ts`)
- [x] Demand-start spawns daemon and returns healthy info (test file: `tests/daemon.ensure.test.ts`)
- [x] Stale PID file is cleaned up (test file: `tests/daemon.ensure.test.ts`)
- [x] Loopback enforcement returns 403 for non-local (test file: `tests/security.test.ts`)
- [x] Health endpoint returns correct shape (test file: `tests/health.test.ts`)
- [x] Orphan runs reconciled on startup, liveness-checked and adopted or canceled accordingly (test file: `tests/store.test.ts` reconcileOrphanRuns liveness variants; `tests/integration.persistence.test.ts`)
- [x] Lock timeout throws DAEMON_START_LOCK_TIMEOUT (test file: `tests/daemon.ensure.test.ts`)
- [x] NOT_BUILT thrown when daemon script missing (test file: `tests/daemon.ensure.test.ts`)
- [x] `POST /api/daemon/stop` responds before the process exits, and the shutdown sequence runs identically on POSIX and Windows since it does not depend on signal delivery (test file: `tests/integration.daemon-lifecycle.test.ts`, "POST /api/daemon/stop responds before exit...")
- [x] `POST /api/daemon/stop` reports `activeRuns` still in progress instead of silently abandoning them (test file: `tests/integration.daemon-lifecycle.test.ts`, "POST /api/daemon/stop reports runs still in progress instead of silently abandoning them (Major 4)")
- [x] `crontick daemon stop` reports `mode: 'graceful'` when the HTTP route succeeds and exits promptly, and escalates to `SIGTERM` then `SIGKILL` (reporting `mode: 'hard-kill'`) when the route stalls or is unreachable (test file: `tests/integration.daemon-lifecycle.test.ts`, "stopDaemon escalates to SIGTERM/SIGKILL when the graceful HTTP route accepts the stop but the process never exits (Major 3)")
- [x] `DELETE /api/jobs/:id` cancels the job's active run instead of orphaning its process, reporting `canceledRun` (test file: `tests/integration.daemon-lifecycle.test.ts`, "DELETE /api/jobs/:id cancels the job's active run instead of orphaning its process (Major 4)")
- [x] `POST /api/jobs` rejects duplicate IDs unless `force` is explicit, and `POST`/`PUT` validate schedules before persistence (test files: `tests/job-create-duplicate.ctd-005.test.ts`, `tests/job-create-atomicity.ctd-004.test.ts`)
- [x] Startup prunes daemon log files beyond `retention.maxLogFiles`, keeping the newest, and a reload applies a newly-lowered cap without a restart (test file: `tests/integration.daemon-lifecycle.test.ts`, "startup prunes old daemon log files beyond retention.maxLogFiles, keeping the newest"; "reload applies a newly-lowered retention.maxLogFiles without a daemon restart")
- [x] Missed fires across a crash/restart are recorded as `missed` runs and surfaced in `daemon status`'s `missedFires` summary (test file: `tests/integration.daemon-lifecycle.test.ts`, "records missed fires across a crash/restart and surfaces them in status"; `tests/api.test.ts`, "GET /api/daemon/status includes missedFires summary")
- [x] Reload reschedules all jobs from disk (test file: `tests/integration.daemon-lifecycle.test.ts`)
- [x] `crontick daemon start --json` / `crontick daemon restart --json` emit structured lifecycle JSON, and `crontick daemon start --foreground --json` is rejected before launch (test file: `tests/cli-daemon-json.ctd-013.test.ts`)

## Out of scope

- OS service registration (autostart was removed).
- Remote/network access (loopback only by design).
- TLS/authentication (trust boundary is localhost).

## Open questions

None.

## Related

- [003-execution.md](003-execution.md)
- [006-state-and-persistence.md](006-state-and-persistence.md)
- `../docs/reference/`
- `../docs/concepts/`
