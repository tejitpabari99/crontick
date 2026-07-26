# 004: Daemon

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

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
- **R-004-8**: On startup, the daemon MUST call `store.reconcileOrphanRuns()` to cancel any runs left in `running` or `queued` state (daemon crash recovery).
- **R-004-9**: On startup, the daemon MUST call `store.loadJobsFromDisk()` to reload job definitions from the jobs directory.
- **R-004-10**: The daemon MUST register `process.on('SIGINT'/'SIGTERM', ...)` handlers that close the HTTP server, unschedule all jobs, close the store, remove PID/port files, and exit cleanly. **This graceful sequence is only reachable when the signal is genuinely delivered to the process by the OS.** On POSIX, `process.kill(pid, 'SIGINT'|'SIGTERM')` delivers a real signal and the handler runs, so PID/port files are removed. On Windows, `process.kill(pid, 'SIGINT'|'SIGTERM')` from another process unconditionally terminates the target process without invoking any registered handler (verified empirically); the handler only has a chance to run for a genuine Ctrl+C console event, which does not apply to `crontick daemon stop`. Callers on Windows MUST NOT rely on PID/port file cleanup or in-flight run persistence after `crontick daemon stop`/`stopDaemon()`; they should instead treat "process no longer alive" as the sole cross-platform guarantee, and expect the next daemon start to tolerate and overwrite stale PID/port files.
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
- **R-004-22**: Daemon stop is a client-side operation (`stopDaemon()` in `src/daemon/lifecycle.ts`), not an HTTP endpoint: it reads the PID file and sends `process.kill(pid, 'SIGTERM')`, then polls until the PID is no longer alive (or a timeout elapses). **There is no `POST /api/daemon/stop` route in `src/daemon/api.ts`**; a prior version of this spec incorrectly documented one. See R-004-10 for the resulting cross-platform caveat on how gracefully that SIGTERM is actually handled.
- **R-004-23**: `startDaemon=false` (option or env `CRONTICK_MCP_START_DAEMON=0`) MUST prevent demand-start from spawning; it MUST throw `DAEMON_NOT_RUNNING` instead.
- **R-004-24**: Stale lock files (older than `lockTimeoutMs` or held by dead process) MUST be cleaned up by waiting clients.

### Non-functional requirements

- **R-004-25**: Daemon startup SHOULD complete within 5 seconds on typical hardware.
- **R-004-26**: The daemon SHOULD NOT require elevated/administrator privileges.

## Behavior

**Startup sequence**:
1. Ensure data directories exist.
2. Initialize logger with daily log file.
3. Check single-instance guard (PID file).
4. Write PID file.
5. Open store (SQLite WAL mode, run migrations).
6. Reconcile orphan runs.
7. Load jobs from disk.
8. Schedule all enabled jobs.
9. Create HTTP API server.
10. Bind to 127.0.0.1:0; write port file.
11. Register signal handlers.
12. Log "Daemon ready".

**Demand-start (ensureDaemon)**:
1. If explicit URL provided, probe health and return or throw.
2. Probe port file + health.
3. If not healthy and startDaemon=true, acquire lock.
4. Spawn daemon as detached child (`node <daemonScript>`).
5. Poll port file + health until healthy or timeout.
6. Return `DaemonInfo { baseUrl, port, pid, started: true }`.

**Shutdown sequence** (reachable only when the handler actually runs — see R-004-10):
1. Close HTTP server.
2. Unschedule all jobs.
3. Wait 100ms for in-flight I/O.
4. Close store.
5. Remove PID and port files.
6. Exit 0.

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
- Health response with wrong product name: Treated as unhealthy (not our daemon).

## Acceptance criteria

- [x] Single-instance guard rejects second daemon (test file: `tests/daemon.ensure.test.ts`)
- [x] Demand-start spawns daemon and returns healthy info (test file: `tests/daemon.ensure.test.ts`)
- [x] Stale PID file is cleaned up (test file: `tests/daemon.ensure.test.ts`)
- [x] Loopback enforcement returns 403 for non-local (test file: `tests/security.test.ts`)
- [x] Health endpoint returns correct shape (test file: `tests/health.test.ts`)
- [x] Orphan runs reconciled on startup (test file: `tests/integration.persistence.test.ts`)
- [x] Lock timeout throws DAEMON_START_LOCK_TIMEOUT (test file: `tests/daemon.ensure.test.ts`)
- [x] NOT_BUILT thrown when daemon script missing (test file: `tests/daemon.ensure.test.ts`)
- [x] Graceful shutdown removes PID/port files on POSIX; on Windows the process still dies and a subsequent daemon start tolerates the stale files (test file: `tests/integration.daemon-lifecycle.test.ts`)
- [x] Reload reschedules all jobs from disk (test file: `tests/integration.daemon-lifecycle.test.ts`)

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
