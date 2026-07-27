# Daemon

Implements: `src/daemon/index.ts`, `src/daemon/api.ts`, `src/daemon/ensure.ts`, `src/daemon/lifecycle.ts`

The daemon is a long-lived Node.js process that owns the scheduler, runner, and
SQLite store. It exposes a loopback-only HTTP API and is demand-started by the
client when needed.

---

## Startup Sequence (`src/daemon/index.ts`)

1. **SQLite shim**: if `process.versions.node` major < 24 and
   `--experimental-sqlite` is not in `execArgv`, re-spawn self with that flag
   and exit when the child exits.
2. Create daily log file at `<dataDir>/logs/daemon-YYYY-MM-DD.log`.
3. **Single-instance guard**: read `daemon.pid`; if PID is alive, exit 1.
   Otherwise remove stale PID file.
4. Write own PID to `daemon.pid`.
5. Read `retention.maxRunsPerJob` from config (`loadConfig()`).
6. **Log retention**: `pruneOldDaemonLogs(logsDir(), retention.maxLogFiles, logger)` deletes the
   oldest daily log files beyond `retention.maxLogFiles` (default 30), keeping the newest.
   Best-effort — wrapped in try/catch; a failure is logged but never blocks startup.
7. Open `Store` (SQLite WAL, schema created in one idempotent pass — no migrations, see
   [storage.md](./storage.md#schema)) with the retention cap from step 5.
8. `pruneAllJobsRunHistory()` — reconcile any job whose retention cap was
   lowered via `crontick daemon reload` while the daemon was down. Wrapped
   in try/catch: a failure is logged but never blocks startup — see
   [storage.md](./storage.md#run-retention) for the retention algorithm.
9. `loadJobsFromDisk()` -- reads `<dataDir>/jobs/*.json`, validates with
   `JobSchema`, upserts into SQLite.
10. Create `Scheduler`.
11. **Missed-fire reporting**: for each enabled job with a
    `job_schedule_state` watermark, call `scheduler.enumerateFiresBetween()`
    from that watermark to now (capped at `MISSED_FIRE_CAP_PER_JOB` = 500) and
    record each fire as a terminal `missed` run via
    `store.recordMissedRun()`; a job with no watermark yet has one seeded
    instead. Aggregate into `missedFireSummary: { jobsWithMissedFires,
    missedRunsRecorded, jobsCapped, capPerJob }`. See
    [storage.md](./storage.md#missed-fire-reporting) and
    [scheduler.md](./scheduler.md#enumerating-past-fires-enumeratefiresbetween).
12. Create `Runner`.
13. **Orphan reconciliation**: `createProcessLivenessCheck()` (see
    [executors.md](./executors.md#process-liveness)), then
    `store.reconcileOrphanRuns(livenessCheck)` — resolves every leftover
    `queued`/`running` run from a prior daemon process by checking real pid
    liveness, canceling dead/queued-never-spawned runs and adopting live or
    inconclusive ones. Adopted runs are handed to `runner.adoptRun()` so
    overlap tracking resumes. See
    [storage.md](./storage.md#orphan-reconciliation).
14. Schedule every enabled job.
15. Wire `scheduler.on('tick', ...)` to insert a run and fire `runner.run()`.
16. Create HTTP server via `createApiServer(ctx)`, listen on `127.0.0.1:0`
    (OS-assigned port).
17. Write port to `daemon.port`.
18. Define the graceful `shutdown(signal)` closure and wire it into
    `ctx.shutdown` (so `POST /api/daemon/stop` can call it) and into
    `SIGINT`/`SIGTERM` handlers (POSIX fallback path) — see
    [Shutdown](#shutdown) below.

---

## Port Selection and Discovery

The daemon listens on `127.0.0.1:0` (random ephemeral port). The actual port is
written to `<dataDir>/daemon.port` as plain text. Clients discover it via
`readPortFile()` in `src/daemon/ensure.ts`.

The health probe (`GET /health`) returns `{ ok: true, product: "crontick",
pid, port }`. Clients verify both `product` and `port` match the expected
values before trusting an existing daemon.

---

## HTTP API Routes

All routes enforce localhost-only via `LOOPBACK` set check on
`req.socket.remoteAddress`. Non-loopback -> 403 FORBIDDEN.

| Method | Path | Purpose | Status |
|--------|------|---------|--------|
| GET | `/health` | Health/readiness check | 200 |
| GET | `/api/jobs` | List all jobs | 200 |
| POST | `/api/jobs` | Create job | 201 |
| GET | `/api/jobs/:id` | Get single job | 200/404 |
| PUT | `/api/jobs/:id` | Update job | 200/404 |
| DELETE | `/api/jobs/:id` | Delete job; cancels its in-flight run if any (`canceledRun` in response) | 200/404 |
| POST | `/api/jobs/:id/enable` | Enable job | 200/404 |
| POST | `/api/jobs/:id/disable` | Disable job; unschedule | 200/404 |
| POST | `/api/jobs/:id/run` | Trigger immediate run | 202/404 |
| GET | `/api/runs` | List runs (query: jobId, limit, since) | 200 |
| GET | `/api/runs/:id` | Get single run | 200/404 |
| POST | `/api/runs/:id/cancel` | Cancel active run | 200/404 |
| GET | `/api/runs/:id/logs` | Get run log entries | 200/404 |
| GET | `/api/runs/:id/logs/stream` | SSE log stream | 200/404 |
| POST | `/api/schedules/validate` | Validate a schedule object | 200 |
| POST | `/api/schedules/preview` | Preview next N fire times | 200 |
| GET | `/api/stats/summary` | Aggregate stats | 200 |
| GET | `/api/stats/jobs/:id` | Per-job stats | 200/404 |
| GET | `/api/daemon/status` | Daemon PID, version, uptime, job count, `missedFires` summary | 200 |
| POST | `/api/daemon/reload` | Reload jobs from disk | 200 |
| POST | `/api/daemon/stop` | Graceful in-process shutdown; responds with any `activeRuns` before exiting | 200/501 |
| GET | `/api/export` | Export all jobs (optionally `?includeRuns=1`) | 200 |
| POST | `/api/import` | Import jobs array (optionally a `runs` array) | 200 |
| GET | `/api/dashboard/status` | Dashboard connection info | 200 |
| GET | `/api/dashboard` | Full dashboard data payload | 200 |
| GET | `/` or `/dashboard{/*}` | Serve static dashboard HTML/CSS/JS | 200 |

Error responses are JSON: `{ error: { code, message, details? } }`.

---

## SSE Log Streaming

`GET /api/runs/:id/logs/stream` opens a `text/event-stream` connection.
Existing logs are sent immediately; new logs are polled every 200 ms
(`SSE_POLL_MS`). The stream closes when the run reaches a terminal status
(`success`, `failed`, `canceled`, `timeout`) or the client disconnects.

---

## Reload

`POST /api/daemon/reload` calls the `reload()` closure defined in
`src/daemon/index.ts`. As of the retention fix, config is read and validated
**before** any mutation of the live schedule: `loadConfig()` (which throws a
`CrontickError` on a malformed or out-of-bounds config, e.g.
`retention.maxRunsPerJob` outside `1..100000`) runs first, so a reload that
fails on bad config leaves the previous schedule fully intact rather than
leaving the daemon with zero scheduled jobs until the next successful reload
or a restart. The sequence is:

1. `loadConfig()` — read the reloaded `retention.maxRunsPerJob` and
   `retention.maxLogFiles`. Any throw here aborts the reload with the schedule untouched.
2. `scheduler.unscheduleAll()`.
3. `store.loadJobsFromDisk()` — re-read `<dataDir>/jobs/*.json`.
4. `store.setRunRetentionCap(reloadedCap)` — apply a changed retention cap
   immediately, without a daemon restart (see [storage.md](./storage.md)).
5. `pruneOldDaemonLogs(logsDir(), reloadedConfig.retention.maxLogFiles, logger)` — apply a
   changed log-file cap immediately as well, same best-effort/never-blocking treatment as at
   startup.
6. Re-schedule every enabled job from the freshly loaded set.

This enables editing job JSON files (and `retention.maxRunsPerJob`/`retention.maxLogFiles`)
externally and applying changes without a full restart.

---

## Shutdown

`POST /api/daemon/stop` is the primary graceful shutdown mechanism, and works identically on
every platform because it runs in-process rather than depending on OS signal delivery:

1. The handler computes `activeRuns` (`ctx.store.listRuns({ status: 'running' }).map(...)`,
   `{ id, jobId }` per run) and responds `200 { ok: true, stopping: true, pid, activeRuns }`
   **before** tearing anything down (via `res.on('finish', ...)`), so the caller gets
   confirmation the request was received — and which runs will keep running — even though the
   process is about to exit mid-response-cycle. Callers should treat a `200` as "shutdown has
   started," not "the daemon has exited" — poll for the PID/port files disappearing, or a
   connection-refused health probe, to confirm the process is actually gone.
2. `shutdown(signal)` then runs: stop accepting new connections (`server.close()`), unschedule
   every timer (`scheduler.unscheduleAll()`), wait a brief 100ms drain window, close the SQLite
   handle, delete `daemon.pid`/`daemon.port`, and `process.exit(0)`.
3. **In-flight runs are deliberately left alone**, with one exception. Shutdown does not kill or
   wait for running child processes — they were spawned `detached: true` (see
   [executors.md](./executors.md#detached-child-processes)) precisely so they keep running
   independently of the daemon process, except for the narrow `pwsh`/`powershell.exe`-on-Windows
   case documented there, which trades that survival for output capture. Their `runs` rows stay
   `'running'`; the next daemon start's [orphan reconciliation](./storage.md#orphan-reconciliation)
   pass adopts them if they're still alive, or cancels them if not.

`stopDaemon()` (`src/daemon/lifecycle.ts`) does not treat a `200` from the route as the end of the
story: if the process is still alive after polling for up to `timeoutMs` (stalled/wedged
mid-shutdown), it escalates — sends `SIGTERM`, waits again, then sends `SIGKILL` if the process
still hasn't exited — and reports `mode: 'hard-kill'` for whichever escalation step actually
stopped it (or, if none did, describes that in the message). This is the same escalation path used
when the HTTP route is unreachable in the first place (see below), so a stalled daemon is never
left running indefinitely by either code path.

`SIGINT`/`SIGTERM` handlers call the same `shutdown(signal)` closure and remain registered as a
**POSIX fallback path** — a real signal delivered by the OS still triggers the identical
sequence above. This matters because Windows has no true signal delivery for another process to
send: `process.kill(pid, 'SIGTERM')` from another process unconditionally terminates the target
without invoking any registered handler on Windows, so a caller cannot rely on the signal path
there at all. `crontick daemon stop` (`stopDaemon()` in `src/daemon/lifecycle.ts`) therefore
tries the HTTP route first on every platform. If the route is unreachable at all (older daemon
build, stale/missing port file, connection refused), it falls straight to the same
`SIGTERM`-then-`SIGKILL` escalation described above. The result's `mode` field
(`'already-stopped' | 'graceful' | 'hard-kill'`) tells the caller which path was actually used,
and `activeRuns` (when present) lists runs still in progress — see
[cli.md](../reference/cli.md#daemon-stop) for the CLI-facing behavior and
[ADR 0014](../decisions/0014-http-graceful-shutdown-over-signals.md) for the full rationale.

`uncaughtException` (non-EPIPE) still logs a fatal error, cleans up files, and exits 1;
`stderr` EPIPE errors are swallowed (detached daemon with closed parent). A daemon start
tolerates and overwrites stale PID/port files left by a prior hard-kill.

---

## Lifecycle Helpers (`src/daemon/lifecycle.ts`)

| Function | Behavior |
|----------|----------|
| `startDaemon(options)` | Foreground: `spawnSync` with `stdio: 'inherit'`. Background: delegates to `ensureDaemon()`. |
| `stopDaemon(options)` | Read PID from file; try graceful `POST /api/daemon/stop` first (2s timeout), waiting up to 5s for the process to exit. If it stalls (or the HTTP route is unreachable), escalate to `SIGTERM` then `SIGKILL`. Returns `mode: 'already-stopped' \| 'graceful' \| 'hard-kill'` and `activeRuns?: { id, jobId }[]` (runs still in progress). |
| `restartDaemon(options)` | `stopDaemon` then `ensureDaemon`. |
| `readLiveDaemonPid(env)` | Read PID file, verify alive with `process.kill(pid, 0)`. |
