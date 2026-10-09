# Daemon Lifecycle

Audience: users and contributors reasoning about daemon startup, shutdown, and downtime.
Non-duplication: see [specs/004-daemon.md](../specs/004-daemon.md) for the contract and
[implementation/daemon.md](../implementation/daemon.md) for implementation steps and HTTP routes.

After reading this page: how the daemon starts, how shims find it, and what happens to scheduled jobs while it's stopped.

## Demand-started, not supervised

The daemon is not a system service, launchd agent, or systemd unit -- it's a regular Node.js
process started **on demand** the first time a shim needs it, with no persistent supervisor.
See [ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

## How a shim starts/finds the daemon

`ensureDaemon()` (`src/daemon/ensure.ts`): if an explicit URL (`CRONTICK_DAEMON_URL`/`daemonUrl`)
is set, probe `/health` and never start a new one on failure. Otherwise read the port file and
probe `/health`; if unhealthy, acquire the exclusive `daemon.ensure.lock`, spawn the daemon
binary detached, and poll the port file until `/health` responds or `startupTimeoutMs` (default
10s) expires.

## The loopback HTTP contract

The daemon listens on `127.0.0.1` port `47615` by default; when that port is taken it prints which kind of
process holds it (another crontick daemon or a foreign process) and binds an OS-assigned free port instead.
The real port is always in `daemon.port`. Non-loopback gets HTTP 403.
`GET /health` returns `{ ok, product: "crontick", pid, port }`; the client validates all four
fields, to avoid accidentally connecting to a different service on the same port.

## Pause and resume

`crontick daemon pause` keeps the daemon process, HTTP API and dashboard up but starts no new runs. Fires that come due while paused are not run and not replayed on resume; each is recorded as a run with status `skipped`. In-flight runs continue. `crontick daemon resume` restores scheduling. Paused state lives in memory only: a restart comes up unpaused. This is distinct from `daemon stop`, which exits the process. Config saves use pause internally for the "wait for in-flight runs" choice; see [configuration.md](../reference/configuration.md#editing-config).

## Port, PID, and lock files

`daemon.port` (text) lets clients find the API without configuration; `daemon.pid` (text) is the
single-instance guard and stop target; `daemon.ensure.lock` (JSON `{ pid, createdAt }`) prevents
concurrent start races. On startup the daemon reads `daemon.pid`: if that PID is alive
(`process.kill(pid, 0)` succeeds), it logs an error and exits; if stale, the file is overwritten.

## Shutdown

`crontick daemon stop` (`stopDaemon()`) prefers an **in-process HTTP shutdown** over OS
signals, because it's the only mechanism that behaves identically on every platform. `POST
/api/daemon/stop` responds `200 { ok, stopping: true, pid, activeRuns }` *before* the daemon
actually tears down (close HTTP server, unschedule jobs, drain 100 ms, close SQLite, remove
`daemon.pid`/`daemon.port`, exit 0) -- so a `200` confirms shutdown has *started*, not that the
process has exited. `stopDaemon()` then polls for the PID to die and returns `{ mode: 'graceful'
}`. If the route accepts the request but the process never exits (stalled), or the route is
unreachable at all (older daemon, stale port file), it escalates to `SIGTERM` then `SIGKILL`,
reporting `{ mode: 'hard-kill' }` either way rather than a bare "not stopped."

The daemon also registers `SIGINT`/`SIGTERM` handlers running the identical shutdown function, as
a POSIX-only fallback: Windows has no real user-space `SIGTERM` (`process.kill(pid, 'SIGTERM')`
from another process there unconditionally terminates the target without invoking any handler),
which is exactly why the HTTP route is primary. See
[implementation/daemon.md](../implementation/daemon.md#shutdown) and
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

In-flight child processes are deliberately left running across shutdown (see the next section);
the stop response's `activeRuns: [{ id, jobId }]` means a stop never silently leaves work running
without saying so.

## What happens while the daemon is down

- **No ticks fire.** The core trade-off of demand-start (see
  [ADR 0001](../decisions/0001-architecture-and-runtime-model.md)) -- not a defect, but a gap that needs
  surfacing.
- **Missed fires are recorded and reported, not replayed.** The daemon persists a per-job "last
  seen ticking" watermark. On the next start, it computes which fires each enabled job's schedule
  *would* have produced since then and records each as a terminal `missed` run (capped at 500 per
  job). `crontick info` / `GET /api/daemon/status` summarizes this as `missedFires`, and
  `crontick runs list --status missed` lists the rows. crontick deliberately does **not** run the
  missed fires -- see [ADR 0001](../decisions/0001-architecture-and-runtime-model.md). A job
  never observed live yet has its watermark seeded, with no gap computed.
- **Orphan runs are reconciled by checking real process liveness, not assumed dead.** `queued`
  runs are always canceled (never spawned). `running` runs are checked against the OS process
  table: confirmed dead -> canceled; alive with a start time consistent with `startedAt`
  (guarding against pid reuse) -> **adopted** back into the runner so overlap policy keeps
  holding; undetermined -> also adopted, since a false "still running" costs less than a false
  cancellation.
- **Child processes survive daemon shutdown, with one exception.** Every spawned child is
  `detached: true`, decoupled from the daemon's process tree. The exception is a PowerShell
  engine command on Windows, spawned attached to get output at all -- trading survival across a
  Ctrl+C shutdown for that (an abrupt crash still leaves it running). See
  [ADR 0001](../decisions/0001-architecture-and-runtime-model.md).
- **Jobs are safe.** Job definitions live in JSON files on disk and are never lost when the daemon stops.

## Why not a system service

No elevated privileges to install/update/uninstall; identical behavior across OSes without
platform-specific plumbing; avoids waking a daemon on laptop resume only to find targets stale.
OS startup registration was removed in favor of pure demand-start; see
[ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

## Further reading

- [State and storage](./state-and-storage.md), [Error model](./error-model.md), [Architecture](../architecture.md)
- [ADR 0001: Architecture and runtime model](../decisions/0001-architecture-and-runtime-model.md)


## Explicit start

The daemon demand-starts on first use, but `crontick daemon start` starts it explicitly (background by default, `--foreground` to run it in the terminal), `crontick daemon status` reports whether it is running, and `crontick daemon restart` cycles it. This is a manual start only; crontick does not register itself to start at login or boot.
