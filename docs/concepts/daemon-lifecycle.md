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

Shutdown is triggered by `SIGINT` or `SIGTERM`, **when the signal is genuinely
delivered to the process by the OS.** The daemon:

1. Closes the HTTP server (stops accepting connections).
2. Unschedules all jobs (stops timers).
3. Waits 100 ms for in-flight requests to drain.
4. Closes the SQLite database.
5. Deletes `daemon.pid` and `daemon.port`.

`crontick daemon stop` sends SIGTERM to the PID from the PID file, then polls until the process exits or a 5-second timeout elapses.

**Windows caveat.** On POSIX, `process.kill(pid, 'SIGTERM')` from another process delivers a
real signal and the sequence above runs. On Windows, the same call unconditionally terminates
the target process without invoking any registered signal handler; the handler only runs for a
genuine Ctrl+C console event, which does not apply to `crontick daemon stop`. On Windows,
`crontick daemon stop` therefore cannot rely on PID/port file cleanup or graceful in-flight run
persistence — the only cross-platform guarantee is "process no longer alive," and the next
daemon start tolerates and overwrites stale PID/port files. See
[internals/daemon.md](../internals/daemon.md#signal-handling-and-shutdown).

## What happens while the daemon is down

- **No ticks fire.** The scheduler only runs inside the daemon process. Missed ticks are not caught up.
- **Orphan reconciliation.** On next startup, any runs left in `running` or `queued` state are set to `canceled` with `error` set to the stored value `DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running` via `Store.reconcileOrphanRuns()`.
- **Jobs are safe.** Job definitions live in JSON files on disk; they are not lost when the daemon stops.
- **Nothing tells you it stopped.** Demand-start means the daemon exists only because something invoked crontick; if nothing does, it never starts and no job ever fires, silently. A reboot, a logout, or the daemon process dying on its own (crash, out-of-memory kill, etc.) all stop every scheduled job with no notification, no missed-tick record, and no alert -- see [Limitations and known gaps](#limitations-and-known-gaps).

## Limitations and known gaps

crontick is a local, unsupervised, demand-started daemon. This section states plainly what that
model does not give you, so you can decide whether it fits your reliability requirements.

- **No supervision, no notification.** There is no system service, watchdog, or external monitor.
  If the daemon is not running -- because nothing has invoked a crontick command since the last
  reboot/logout, or because it crashed -- scheduled jobs simply do not fire. Nothing emails,
  pages, or otherwise alerts you; the only evidence is the absence of expected runs.
- **Overlap-policy state does not survive a restart.** `skip`/`cancel-previous`/`queue` tracking
  lives only in the daemon process's memory (see [execution.md](./execution.md#overlap-enforcement)).
  If the daemon restarts while a run is still alive, the new process has no memory of it, so the
  overlap guarantee you configured for that job can be violated across the restart.
- **Runs are not verified against the OS process table.** A run row in `runs.db` does not record
  the OS PID of its child process. Orphan reconciliation (above) assumes any run left
  `running`/`queued` after a restart is dead and marks it `canceled`; it has no way to confirm the
  underlying process actually exited, so the database and reality can diverge if a child process
  outlives the daemon that spawned it.
- **Child-process survival on daemon kill differs by platform, and this is not configurable.** On
  Windows, killing the daemon process also kills its in-flight child job process: Node's child
  processes are placed in an OS Job Object tied to the parent by default, and closing that job
  terminates the whole tree. On POSIX (macOS/Linux), killing the daemon does not automatically
  kill an in-flight child; without `detached`/process-group handling, the child is typically
  reparented to init and keeps running as an orphan. Nothing in crontick reconciles this
  divergence today.

**Practical mitigation available today:** there is no built-in alerting, so visibility is manual.
Run `crontick daemon status` or `crontick doctor` periodically (e.g. from your own monitoring, a
separate scheduler, or just a habit) to confirm the daemon is up and jobs are firing as expected.
Keeping a terminal or script that periodically invokes any crontick command also keeps the
demand-started daemon alive, since that is what starts it in the first place. See
[troubleshooting.md](../troubleshooting.md#my-schedule-silently-stopped-running) for the concrete
commands.

## Why not a system service

- No elevated privileges required to install, update, or uninstall.
- Works identically on Windows, macOS, and Linux without platform-specific plumbing.
- Developer machines often sleep; a demand-start model avoids waking the daemon on resume only to find all targets are stale.
- Startup registration has been removed in favor of pure demand-start (see ADR 0009).

## Further reading

- [State and storage](./state-and-storage.md) - where the daemon persists data
- [Error model](./error-model.md) - daemon startup failure codes
- [Architecture](../architecture.md) - high-level component diagram
