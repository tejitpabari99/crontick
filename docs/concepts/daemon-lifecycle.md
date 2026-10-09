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
The default stays pure demand-start. An earlier native-dependency autostart was removed; login autostart returned as an explicit opt-in without native dependencies (`crontick autostart enable`); see [ADR 0001](../decisions/0001-architecture-and-runtime-model.md) and [Opt-in autostart](#opt-in-autostart-at-login).

## Further reading

- [State and storage](./state-and-storage.md), [Error model](./error-model.md), [Architecture](../architecture.md)
- [ADR 0001: Architecture and runtime model](../decisions/0001-architecture-and-runtime-model.md)


## Explicit start

The daemon demand-starts on first use, but `crontick daemon start` starts it explicitly (background by default, `--foreground` to run it in the terminal), `crontick daemon status` reports whether it is running, and `crontick daemon restart` cycles it. This is a manual start only; `daemon start` never registers anything to start at login or boot. `--home <dir>` sets `CRONTICK_HOME` for the daemon it starts.

## Opt-in autostart at login

`crontick autostart enable` registers the daemon with the OS user-level service manager (Linux: a `systemd --user` unit at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/crontick.service`); `autostart disable` removes it and `autostart status` reports it, including stale registrations after a Node or crontick upgrade. It is a local OS registration that works with the daemon down, so there is no daemon API route, and MCP exposes only `crontick_autostart_status`.

- **Coexists with demand-start.** The registered unit sets `CRONTICK_SUPERVISED=1`. The daemon is single-instance (PID file); with that variable set, finding a daemon already running logs and exits `0` instead of `1`, so a supervisor using `Restart=on-failure` does not crash-loop when something demand-started first. An unsupervised duplicate start still exits non-zero. A SIGTERM from the manager is a graceful stop (exit `0`) and is not restarted.
- **Runs survive stops.** The unit uses `KillMode=process`, so detached job runs are not killed when the daemon stops and are re-adopted on the next start.
- **Linger caveat.** Without `loginctl enable-linger`, the user manager stops at the last logout and stops the daemon, so jobs pause while you are fully logged out (a demand-started daemon survives logout). Linger is not managed by crontick; `status` prints the hint.
- **Stale registrations.** The unit captures the Node path, the daemon script path, `CRONTICK_HOME` (if set) and a `PATH` snapshot at enable time. `status` reports `stale` when these drift; re-run `autostart enable` to fix it (also after installing an engine later).
- **Uninstalling.** Run `crontick autostart disable` before uninstalling the package; otherwise the unit stays and keeps failing to start (bounded by systemd start limits).
- A login start is a normal daemon start, so startup behavior such as recording missed fires is unchanged.
