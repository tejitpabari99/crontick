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

Shutdown is triggered by `SIGINT` or `SIGTERM`. The daemon:

1. Closes the HTTP server (stops accepting connections).
2. Unschedules all jobs (stops timers).
3. Waits 100 ms for in-flight requests to drain.
4. Closes the SQLite database.
5. Deletes `daemon.pid` and `daemon.port`.

`crontick daemon stop` sends SIGTERM to the PID from the PID file, then polls until the process exits or a 5-second timeout elapses.

## What happens while the daemon is down

- **No ticks fire.** The scheduler only runs inside the daemon process. Missed ticks are not caught up.
- **Orphan reconciliation.** On next startup, any runs left in `running` or `queued` state are set to `canceled` with error `daemon-restart` via `Store.reconcileOrphanRuns()`.
- **Jobs are safe.** Job definitions live in JSON files on disk; they are not lost when the daemon stops.

## Why not a system service

- No elevated privileges required to install, update, or uninstall.
- Works identically on Windows, macOS, and Linux without platform-specific plumbing.
- Developer machines often sleep; a demand-start model avoids waking the daemon on resume only to find all targets are stale.
- Autostart registration (formerly via `registry-js`) has been removed in favor of pure demand-start.

## Further reading

- [State and storage](./state-and-storage.md) - where the daemon persists data
- [Error model](./error-model.md) - daemon startup failure codes
- [Architecture](../architecture.md) - high-level component diagram
