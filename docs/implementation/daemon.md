# Daemon

Implements: `src/daemon/index.ts`, `src/daemon/api.ts`, `src/daemon/ensure.ts`,
`src/daemon/lifecycle.ts`

Audience: contributors changing daemon startup, the HTTP API, or shutdown mechanics.
Non-duplication: for *why* the daemon is demand-started and not supervised, and the full
shutdown rationale, see [concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md) -- this
page covers only the implementation steps and routes.

The daemon is a long-lived Node.js process that owns the scheduler, runner, and SQLite store. It
exposes a loopback-only HTTP API and is demand-started by clients when needed.

---

## Startup sequence (`src/daemon/index.ts`)

1. **SQLite shim**: on Node < 24 without `--experimental-sqlite`, re-spawn self with that flag.
2. Create the daily log file.
3. **Single-instance guard**: if `daemon.pid` is alive, exit 1; otherwise remove the stale file.
4. Write own PID to `daemon.pid`.
5. Read `retention.maxRunsPerJob`/`maxLogFiles` from config.
6. Prune daily log files beyond `retention.maxLogFiles` (best-effort).
7. Open `Store` (idempotent schema pass, no migrations -- see [storage.md](./storage.md#schema)).
8. `pruneAllJobsRunHistory()` -- reconcile any job whose retention cap was lowered while the daemon was down (best-effort).
9. `loadJobsFromDisk()` -- validate and upsert every `<dataDir>/jobs/*.json`.
10. Create `Scheduler`.
11. **Missed-fire reporting**: for each enabled job with a `job_schedule_state` watermark, enumerate fires it would have produced up to now (capped at `MISSED_FIRE_CAP_PER_JOB` = 500) and record each as a terminal `missed` run. See [storage.md](./storage.md#missed-fire-reporting) and [scheduler.md](./scheduler.md#enumerating-past-fires-enumeratefiresbetween).
12. Create `Runner`.
13. **Orphan reconciliation**: liveness-check every leftover `queued`/`running` run and adopt or cancel it -- see [storage.md](./storage.md#orphan-reconciliation).
14. Schedule every enabled job.
15. Wire `scheduler.on('tick', ...)` to insert a run and fire `runner.run()`.
16. Create the HTTP server and bind loopback via `bindPort` (`src/daemon/bind-port.ts`): the preferred port, else an OS-assigned free port.
17. Write the actual bound port to the port file.
18. Wire graceful shutdown into `POST /api/daemon/stop` and register `SIGINT`/`SIGTERM` as a POSIX fallback (see [Shutdown](#shutdown)).

## Port selection and discovery

The daemon prefers `DEFAULT_DAEMON_PORT` = `47615` (`src/constants/daemon.ts`; override with `daemon.port`
in `config.json`; `0` = always OS-assigned). `bindPort(preferred, { listen, probe, notify })`
is pure and injectable: it tries `listen(preferred)`; on `EADDRINUSE` it probes `GET /health` on that port
with the crontick signature check and emits one notice (stderr and the daemon log), then binds `listen(0)`:

- `Port 47615 is in use by another crontick daemon (pid N, data dir <dir>); starting on a free port`
- `Port 47615 is in use by another process (not crontick); starting on a free port`

The process owner of a foreign listener is not detected. The actual bound port is written as plain text
to `<dataDir>/daemon.port`, so clients always discover the real port from that file and never assume the default.
`GET /health` returns `{ ok: true, product: "crontick", pid, port, dataDir, ... }`; clients verify `product`
and `port` before trusting an existing daemon. `describeDaemonPort(port)` yields the note
`started on fallback port N; default 47615 is in use` shown by `daemon start|restart`, `daemon status` (`portNote`),
`info`, and `doctor` ("daemon port" check).

## HTTP API routes

All routes enforce localhost-only via a `LOOPBACK` set check on `req.socket.remoteAddress`;
non-loopback gets 403 `FORBIDDEN`.

| Method | Path | Purpose | Status |
|--------|------|---------|--------|
| GET | `/health` | Health/readiness check | 200 |
| GET/POST | `/api/jobs[/:id]` | List/create/get job | 200/201/404 |
| PUT/DELETE | `/api/jobs/:id` | Update/delete job (delete cancels an in-flight run: `canceledRun`) | 200/404 |
| POST | `/api/jobs/:id/enable\|disable` | Enable/disable a job | 200/404 |
| GET | `/api/runs/:id/output` | Cleaned output view (`RunOutput`): final result, error, full stderr, plus `logFile` (path of the per-job crontick log file) | 200/404 |
| POST | `/api/jobs/:id/run-now` (alias `/run`) | Run a job once now, even if disabled, without changing `enabled` or the schedule; overlap policy applies. `202 { runId }` | 202/404 |
| GET/POST | `/api/runs[/:id][/cancel]` | List/get/cancel runs. The list accepts `jobId`/`status` (comma-separated for several), `limit`, `since`, and `q` (substring search over run fields, job alias and stored run output) | 200/404 |
| POST | `/api/schedules/validate\|preview` | Validate a schedule / preview next N fires | 200 |
| GET | `/api/stats/summary\|jobs/:id` | Aggregate / per-job stats | 200/404 |
| GET | `/api/daemon/status` | PID, `port`/`baseUrl`/`dashboardUrl`, `portNote` (set when on a fallback port), version, uptime, job count, `missedFires` | 200 |
| POST | `/api/daemon/reload` | Reload jobs from disk (see [Reload](#reload)) | 200 |
| POST | `/api/daemon/stop` | Graceful in-process shutdown (see [Shutdown](#shutdown)) | 200/501 |
| GET/POST | `/api/export`, `/api/import` | Export/import jobs (schema 1, jobs only; never run history) | 200 |
| GET | `/api/dashboard[/status]` | Dashboard data / connection info; `/api/dashboard` accepts `runsLimit`, `jobId`/`status` (comma-separated) and `q` for the runs list | 200 |
| GET | `/` or `/dashboard{/*}` | Static dashboard assets | 200 |

Error responses are JSON: `{ error: { code, message, details? } }`.

## Reload

`POST /api/daemon/reload` reads and validates config **before** mutating the live schedule: a
throw from `loadConfig()` (e.g. an out-of-range `retention.maxRunsPerJob`) aborts the reload with
the previous schedule fully intact. On success: unschedule all -> `loadJobsFromDisk()` ->
`setRunRetentionCap()` -> prune logs to the reloaded `maxLogFiles` -> reschedule every enabled
job. This lets job files and `retention.*` be edited externally and applied without a restart.

## Shutdown

`POST /api/daemon/stop` is the primary mechanism because it runs in-process, identically on every
platform (unlike OS signal delivery, which Windows only half-supports for cross-process use):

1. Compute `activeRuns` and respond `200 { ok, stopping: true, pid, activeRuns }` **before**
   tearing anything down, so the caller gets confirmation even though the process is about to
   exit mid-response.
2. `shutdown()`: stop accepting connections, unschedule all timers, wait 100 ms for in-flight I/O,
   close SQLite, delete `daemon.pid`/`daemon.port`, `process.exit(0)`.
3. In-flight child processes are deliberately left running -- they were spawned `detached: true`
   for exactly this reason (see
   [prompt-execution.md](./prompt-execution.md#detached-child-exception)); their `runs` rows stay
   `running` until the next startup's orphan reconciliation.

`stopDaemon()` (`src/daemon/lifecycle.ts`) polls for the PID to die after a `200`; if it doesn't
within the timeout (or the route was unreachable at all), it escalates to `SIGTERM` then
`SIGKILL`, reporting `mode: 'hard-kill'`. `SIGINT`/`SIGTERM` handlers run the identical `shutdown()`
closure as a POSIX-only fallback. See
[concepts/daemon-lifecycle.md](../concepts/daemon-lifecycle.md#shutdown) for the full rationale and
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

`uncaughtException` (non-EPIPE) logs a fatal error, cleans up PID/port files, and exits 1; stderr
EPIPE is swallowed (detached daemon, closed parent). A daemon start tolerates and overwrites stale
PID/port files left by a prior hard-kill.

## Lifecycle helpers (`src/daemon/lifecycle.ts`)

| Function | Behavior |
|----------|----------|
| `startDaemon(options)` | Foreground: `spawnSync` with `stdio: 'inherit'`. Background: delegates to `ensureDaemon()`. |
| `stopDaemon(options)` | Graceful `POST /api/daemon/stop` first, escalating to `SIGTERM`/`SIGKILL` on stall or unreachability. Returns `mode` and `activeRuns?`. |
| `restartDaemon(options)` | `stopDaemon` then `ensureDaemon`. |
| `readLiveDaemonPid(env)` | Read the PID file, verify liveness with `process.kill(pid, 0)`. |
