# 0003: Demand-started local daemon instead of OS service

- Status: Accepted
- Date: 2026-07-25

## Context

crontick needs a long-running process to fire scheduled jobs on time. Traditional
cron implementations run as system services (systemd units, launchd agents, Windows
services). crontick targets developer workstations across Windows, macOS, and Linux
where installing a system service requires elevated privileges and platform-specific
packaging (MSI, .plist, .service units).

## Decision

The daemon is demand-started: the first CLI command, MCP tool call, or library method
that needs the daemon will start it transparently via `ensureDaemon()` in
`src/daemon/ensure.ts`. The daemon is a regular user-mode Node.js process with:

- A PID file (`daemon.pid`) for single-instance guarding.
- An exclusive file lock (`daemon.ensure.lock`) to serialize concurrent startup attempts.
- Health polling after spawn before returning to the caller.
- `crontick daemon start` for explicit manual lifecycle control.

No OS-level service registration, no init system integration, no elevated privileges.

## Alternatives considered

**OS service per platform.** Write a systemd unit, launchd plist, and Windows Service
wrapper. Pros: survives user logout, managed restarts. Cons: three platform-specific
code paths, elevated install, harder to iterate during development, poor fit for the
"developer laptop" deployment model.

**Always-on supervisor (PM2, nodemon).** Offloads process management but adds a runtime
dependency, complicates `npm install -g`, and still does not survive logout without an
OS service underneath.

**Watchdog/keepalive with OS autostart at login.** Previously implemented via Windows
Registry Run key and launchd agent (see ADR-0008 for removal rationale). Removed because
it was unreliable and surprising to users.

**No daemon -- in-process scheduling.** Each CLI invocation would calculate the next
tick, sleep, and fire. Not viable for cron-style "fire while I'm away" semantics
because the user's terminal session would need to stay open.

## Consequences

**Easier:**

- `npm install -g crontick` is the only install step on any platform.
- No privileged escalation, no platform packaging.
- Users can kill the daemon with a simple `crontick daemon stop` or `kill <pid>`.
- Testing is straightforward (spawn a process, probe health, tear down).

**Harder:**

- If no crontick command runs, the daemon does not start -- jobs scheduled for a future
  time will not fire until something triggers the daemon.
- Surviving user logout requires the user to arrange their own keep-alive (e.g., tmux,
  screen, or a systemd user unit).
- Crash recovery depends on the next demand-start re-launching the daemon.

**Impossible:**

- Firing jobs while the daemon is stopped and no client triggers it (by design -- we
  document this trade-off in getting-started.md).

## Revisit when

- Users report frequent missed ticks due to daemon not running. At that point, offer an
  optional opt-in `crontick install-service` command that writes platform service configs
  without making it the default path.
- crontick targets server/headless deployments where an OS service is expected.
