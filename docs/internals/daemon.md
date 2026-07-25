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
5. Open `Store` (SQLite WAL). Call `reconcileOrphanRuns()` to cancel any runs
   left in `queued`/`running` state from a prior crash.
6. `loadJobsFromDisk()` -- reads `<dataDir>/jobs/*.json`, validates with
   `JobSchema`, upserts into SQLite.
7. Create `Scheduler` and `Runner`. Schedule all enabled jobs.
8. Wire `scheduler.on('tick', ...)` to insert a run and fire `runner.run()`.
9. Create HTTP server via `createApiServer(ctx)`, listen on `127.0.0.1:0`
   (OS-assigned port).
10. Write port to `daemon.port`.
11. Register `SIGINT`/`SIGTERM` handlers for graceful shutdown.

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
| DELETE | `/api/jobs/:id` | Delete job | 200/404 |
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
| GET | `/api/daemon/status` | Daemon PID, version, uptime, job count | 200 |
| POST | `/api/daemon/reload` | Reload jobs from disk | 200 |
| GET | `/api/export` | Export all jobs | 200 |
| POST | `/api/import` | Import jobs array | 200 |
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
`src/daemon/index.ts`: unschedules all jobs, re-reads jobs from disk via
`store.loadJobsFromDisk()`, then re-schedules enabled jobs. This enables
editing job JSON files externally and applying changes without a full restart.

---

## Signal Handling and Shutdown

- `SIGINT`, `SIGTERM`: set `shuttingDown` flag, close HTTP server, unschedule
  all timers, wait 100 ms for in-flight work, close SQLite, delete `daemon.pid`
  and `daemon.port`, exit 0.
- `uncaughtException` (non-EPIPE): log fatal error, cleanup files, exit 1.
- `stderr` EPIPE errors are swallowed (detached daemon with closed parent).

---

## Lifecycle Helpers (`src/daemon/lifecycle.ts`)

| Function | Behavior |
|----------|----------|
| `startDaemon(options)` | Foreground: `spawnSync` with `stdio: 'inherit'`. Background: delegates to `ensureDaemon()`. |
| `stopDaemon(options)` | Read PID from file, send `SIGTERM`, poll for death up to 5 s. |
| `restartDaemon(options)` | `stopDaemon` then `ensureDaemon`. |
| `readLiveDaemonPid(env)` | Read PID file, verify alive with `process.kill(pid, 0)`. |
