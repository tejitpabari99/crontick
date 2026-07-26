# Daemon Lifecycle

After reading this page you will understand how the crontick daemon starts, how shims find it, what contract exists between the daemon and its clients, and what happens to scheduled jobs while it is stopped.

## Demand-started, not supervised

The daemon is not a system service, launchd agent, or systemd unit. It is a regular Node.js process started **on demand** the first time a shim (CLI, MCP, or library) needs it. There is no persistent supervisor keeping it alive.

Why: crontick targets developer machines where installing a system service requires elevated privileges and complicates uninstallation. Demand-start keeps the setup zero-configuration.

## How a shim starts/finds the daemon

The `ensureDaemon()` function in `src/daemon/ensure.ts` implements the full discovery and start protocol:

1. **Explicit URL** - if `CRONTICK_DAEMON_URL` or the `daemonUrl` option is set, probe its `/health` endpoint. If healthy, return immediately. If not, fail (do not start a new one).
2. **Port-file probe** - read `<dataDir>/daemon.port`, construct `http://127.0.0.1:<port>`, probe `/health`. If healthy, return.
3. **Lock and start** - acquire the exclusive `daemon.ensure.lock` (via `openSync('wx')`), spawn the daemon binary detached, then poll the port file until `/health` responds or a timeout fires.

Default timeouts:

| Parameter | Default |
|-----------|---------|
| `startupTimeoutMs` | 10,000 ms |
| `healthTimeoutMs` | 2,000 ms |
| `lockTimeoutMs` | 15,000 ms |

## The loopback HTTP contract

The daemon listens on an OS-assigned port bound to `127.0.0.1`. Only loopback connections are accepted; non-loopback addresses receive HTTP 403.

The health endpoint (`GET /health`) returns:

```json
{ "ok": true, "product": "crontick", "pid": <number>, "port": <number> }
```

The client validates `ok === true`, `product === "crontick"`, and that `pid` and `port` are positive integers. This prevents accidentally connecting to a different service on the same port.

## Port and PID discovery files

| File | Content | Purpose |
|------|---------|---------|
| `daemon.port` | Port number (text) | Lets clients find the API without configuration |
| `daemon.pid` | PID (text) | Single-instance guard and stop target |
| `daemon.ensure.lock` | JSON `{ pid, createdAt }` | Prevents concurrent start races |

## Single-instance guard

On startup the daemon reads `daemon.pid`. If the PID is alive (`process.kill(pid, 0)` succeeds), it logs an error and exits. If the PID is stale, the file is overwritten.

## Shutdown

`crontick daemon stop` (`stopDaemon()` in `src/daemon/lifecycle.ts`) prefers an **in-process
HTTP shutdown** over OS signals, because it is the only mechanism that behaves identically on
every platform:

1. Read the PID from `daemon.pid`. If none is alive, return `{ mode: 'already-stopped' }`.
2. `POST /api/daemon/stop` on the daemon's own base URL. The daemon responds `200
   { ok: true, stopping: true, pid }` *before* it starts shutting down (via a `res.on('finish')`
   hook), so the HTTP response only confirms shutdown has begun, not that the process has exited.
3. The route invokes the same shutdown sequence the daemon would run on a signal: close the HTTP
   server, unschedule all jobs, wait 100 ms for in-flight requests to drain, close the SQLite
   database, remove `daemon.pid`/`daemon.port`, and exit 0.
4. `stopDaemon()` then polls for the PID to die (default timeout 5 s) and returns
   `{ mode: 'graceful' }`, including any `activeRuns: [{ id, jobId }]` still in progress (parsed
   from the stop response body) so nothing is abandoned silently.
5. **If the graceful route accepts the request but the process does not actually exit within the
   poll timeout** (stalled/wedged shutdown), `stopDaemon()` escalates: it sends `SIGTERM`, and if
   that still does not stop it, `SIGKILL`, reporting `{ mode: 'hard-kill' }` either way rather than
   returning `stopped: false` with no recovery.
6. **Only if the HTTP route is unreachable in the first place** (an older pre-1.0 daemon binary, a
   stale/corrupt port file, connection refused) does `stopDaemon()` skip straight to
   `process.kill(pid, 'SIGTERM')`, escalating to `SIGKILL` under the same stall condition, and
   report `{ mode: 'hard-kill' }`. This path exists for a broken or foreign daemon, not as the
   normal case.

The daemon also still registers `SIGINT`/`SIGTERM` handlers that run the identical shutdown
function, so a genuine POSIX signal (e.g. an operator's own `kill`) triggers the same graceful
sequence. Windows has no real user-space `SIGTERM`: `process.kill(pid, 'SIGTERM')` from another
process there unconditionally terminates the target without invoking any handler, and a handler
only runs for a true Ctrl+C console event. That asymmetry is exactly why the HTTP route, not the
signal, is the primary shutdown path -- it gives identical, verifiable graceful-shutdown behavior
on Windows, macOS, and Linux. See
[internals/daemon.md](../internals/daemon.md#signal-handling-and-shutdown) and
[ADR 0014](../decisions/0014-http-graceful-shutdown-over-signals.md).

In-flight child processes are deliberately left running across shutdown (with the one Windows
PowerShell exception noted below) -- see [the next section](#what-happens-while-the-daemon-is-down)
for why, and how they are reconciled on the next start. `POST /api/daemon/stop`'s response
includes any runs still `running` at the moment of shutdown (`activeRuns: [{ id, jobId }]`), and
`crontick daemon stop` folds that into its message, so a stop never silently leaves work running
without saying so.

## What happens while the daemon is down

- **No ticks fire while the daemon is not running.** The scheduler only runs inside the daemon
  process, and the daemon only runs when something has demand-started it. This is the core
  trade-off of the demand-started design (see [ADR 0003](../decisions/0003-demand-started-daemon.md))
  and is not itself a defect -- but a gap in coverage would be invisible without a mechanism to
  surface it, which is what missed-fire reporting (below) provides.
- **Missed fires are recorded and reported, not replayed.** The daemon persists a per-job "last
  seen ticking" watermark (`job_schedule_state.last_tick_at`, via `Store.recordTick()`). On the
  next start, for every enabled job with a prior watermark, the daemon works out which fires the
  schedule *would* have produced between that watermark and now and records each one as a
  terminal `missed` run (`Store.recordMissedRun()`), capped at 500 per job to bound startup work
  for a long-idle install. `crontick daemon status` / `GET /api/daemon/status` summarizes this as
  `missedFires: { jobsWithMissedFires, missedRunsRecorded, jobsCapped, capPerJob }`, and
  `crontick runs list --status missed` (or `crontick_run_list` with `status: "missed"`) lists the
  individual rows. crontick deliberately does **not** run the missed fires -- see
  [ADR 0015](../decisions/0015-report-missed-fires-not-replay.md) for why replaying is the wrong
  default. Jobs that have never been observed live (no watermark yet) have nothing to compute a
  gap against, so no missed-fire pass runs for them; their watermark is simply seeded.
- **Orphan runs are reconciled by checking real process liveness, not assumed dead.** On startup,
  `Store.reconcileOrphanRuns()` inspects every run left `running`/`queued` from before the
  restart. `queued` runs are always canceled (a process was never actually spawned for them).
  `running` runs are checked against the OS process table using the run's recorded `pid`
  (`src/process-liveness.ts`): if the pid is confirmed dead, the run is canceled with the stored
  `ORPHAN_RUN_ERROR_MESSAGE`; if the pid is alive **and** its OS-reported start time is consistent
  with the run's `startedAt` (guarding against the pid having been reused by an unrelated process
  since), the run is **adopted** back into the runner instead of canceled, so a configured
  `skip`/`cancel-previous` overlap policy keeps holding for it; if liveness cannot be determined
  at all (e.g. the platform tool to read process start time is unavailable), the run is also
  adopted -- inconclusive evidence favors not double-running a job over a false cancellation.
- **Child processes survive daemon shutdown on every platform, with one narrow exception.** Every
  spawned child is `detached: true` with `windowsHide: true`: on POSIX the child is reparented to
  init; on Windows it runs in its own process group, decoupled from the daemon's job object, so
  it is no longer killed when the daemon exits, crashes, or restarts. The one exception is a
  `script` job whose resolved shell is PowerShell (`pwsh`/`powershell.exe`, including the
  `shell: "auto"` default) on Windows: that child is spawned attached instead, trading survival
  for output capture, because Windows's detached/no-console process creation leaves PowerShell
  unable to write output at all. It still survives an abrupt daemon crash (Windows does not
  cascade-kill on its own), but not the daemon being stopped via Ctrl+C through a shared console.
  See [ADR 0016](../decisions/0016-detached-children-cross-platform.md) and
  [ADR 0020](../decisions/0020-no-detach-powershell-script-jobs-windows.md).
- **Jobs are safe.** Job definitions live in JSON files on disk; they are not lost when the daemon stops.

## Why not a system service

- No elevated privileges required to install, update, or uninstall.
- Works identically on Windows, macOS, and Linux without platform-specific plumbing.
- Developer machines often sleep; a demand-start model avoids waking the daemon on resume only to find all targets are stale.
- OS startup registration (login items, registry Run keys, systemd units) was removed in favor of
  pure demand-start; see [ADR 0003](../decisions/0003-demand-started-daemon.md).

## Further reading

- [State and storage](./state-and-storage.md) - where the daemon persists data
- [Error model](./error-model.md) - daemon startup failure codes
- [Architecture](../architecture.md) - high-level component diagram
- [ADR 0003](../decisions/0003-demand-started-daemon.md) - why demand-start instead of a service
- [ADR 0014](../decisions/0014-http-graceful-shutdown-over-signals.md) - HTTP shutdown over signals
- [ADR 0015](../decisions/0015-report-missed-fires-not-replay.md) - report, don't replay, missed fires
