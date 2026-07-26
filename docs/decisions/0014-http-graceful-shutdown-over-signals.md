# 0014: HTTP-based graceful shutdown, with signals as a POSIX-only fallback

- Status: Accepted
- Date: 2026-07-26

## Context

Before this decision, the daemon's only shutdown path was a process signal: `crontick
daemon stop` sent `SIGTERM` (POSIX) and the daemon's `process.on('SIGTERM'/'SIGINT', ...)`
handlers ran the shutdown sequence. Windows has no equivalent of `SIGTERM` delivered to an
arbitrary external process from a CLI; `child_process.kill()` on Windows terminates the
process immediately rather than requesting cooperative shutdown. As a result, `crontick
daemon stop` on Windows always hard-killed the daemon: in-flight runs lost their tracking
state, the HTTP listener was not closed cleanly, and the CLI could not tell the caller
whether the daemon shut down gracefully or was killed.

## Decision

Add `POST /api/daemon/stop` to the daemon's own HTTP API (`src/daemon/api.ts`). The route
handler responds `200 { ok: true, stopping: true, pid }` on the `res.on('finish', ...)`
callback -- i.e. only after the HTTP response has actually been flushed to the client --
and then invokes the same `shutdown()` closure that `SIGTERM`/`SIGINT` already triggered.
`stopDaemon()` (`src/daemon/lifecycle.ts`) tries this HTTP route first
(`HTTP_STOP_TIMEOUT_MS = 2000`); only if the request fails outright (daemon unreachable,
connection refused) does it fall back to `process.kill(pid, 'SIGTERM')`. The result is
reported to the caller as `mode: 'graceful' | 'hard-kill' | 'already-stopped'`.

This makes graceful shutdown a same-process, cross-platform HTTP request-response instead
of an OS primitive that Windows cannot express in the same way POSIX can. Signal handlers
remain registered and still perform the identical shutdown sequence -- they are a fallback
for the case where the HTTP server itself is unreachable (e.g. wedged event loop before
the listener bound), not a second, differently-behaved shutdown path.

## Alternatives considered

**Keep signals only; document that Windows does a hard kill.** This was the status quo.
Rejected because it meant a real, user-visible platform asymmetry: identical commands
(`crontick daemon stop`) had different safety guarantees depending on OS, and there was no
way for the CLI to detect or report which one happened.

**A Windows named pipe or platform-specific IPC just for stop.** Would fix the platform gap
but introduces a second IPC mechanism alongside the loopback HTTP API that already exists
for every other daemon operation (ADR 0004). No reason to add a second transport for one
operation when the existing one already works everywhere.

**Simulate `SIGTERM` on Windows via `taskkill` or `GenerateConsoleCtrlEvent`.** These are
best-effort, console-attached mechanisms with their own platform quirks (e.g. affects the
whole console process group) and still would not let the CLI observe whether shutdown was
cooperative or forced. Rejected as more fragile than reusing the daemon's existing HTTP API.

## Consequences

**Easier:**

- `crontick daemon stop` has one code path and one observable contract
  (`mode: "graceful" | "hard-kill" | "already-stopped"`) on every platform.
- The CLI, MCP tool, and library API all get a real answer to "did it shut down cleanly"
  instead of assuming success.
- Testing shutdown no longer requires sending real OS signals; it is an ordinary HTTP call.

**Harder:**

- The daemon must keep its HTTP listener alive and responsive up to the moment shutdown is
  requested; if the listener never bound (e.g. it crashed during startup before binding),
  `POST /api/daemon/stop` cannot be used and the caller falls back to the signal path -- so
  the fallback still has to exist and be tested, not just the primary path.
- There are now two distinct shutdown entry points (`POST /api/daemon/stop` and the signal
  handlers) that must be kept behaviorally identical; a change to the shutdown sequence has
  to be verified from both.

**Impossible:**

- Shutdown cannot be forced to be graceful when the daemon process is completely
  unresponsive (event loop blocked, listener down). In that case `hard-kill` is still the
  only recourse, on every platform -- this decision narrows when a hard kill is needed, it
  does not eliminate the possibility of one.

## Revisit when

- A future transport replaces loopback HTTP as the daemon's IPC mechanism (see ADR 0004);
  the stop route would need to move with it.
- Repeated reports surface of the 2-second HTTP stop timeout being too aggressive or too
  lax for real workloads; the timeout value would need to become configurable.
